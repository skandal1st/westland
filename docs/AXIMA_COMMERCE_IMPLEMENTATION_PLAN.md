# AXIMA Commerce — Implementation Plan

Статус: план реализации. Не является разрешением на старт implementation. Реализация каждого milestone начинается только после явного approve.

Связанные документы:
- `promt.md` — исходный бриф и quality gate.
- `PRODUCT.md` — продуктовое описание Westside как первого профиля.
- `docs/PLATFORM_FOUNDATION.md` — практические правила платформы (слои, StoreProfile, границы конфигурации).
- `docs/AXIMA_COMMERCE_ARCHITECTURE.md` — расширенная архитектурная карта выделения commerce-ядра.
- `docs/security/licensing-hardening/*` — решение по лицензированию.

---

## 0. Как читать этот план

- Каждый milestone даёт **архитектурно завершённый вертикальный результат**, а не набор файлов.
- Deployment foundation закладывается рано (M0–M1) и **hardened** в M10, а не создаётся впервые в конце.
- `hookah_store` используется **только как источник проверенных паттернов и контрактов** (moysklad/onec client, jobs/queue, pdf, auth, deploy.sh, docker-compose). Массовый перенос кода не выполняется.
- Provider-specific ID/payload никогда не проникают в доменные сущности — только через `ExternalReference` / `IntegrationMapping`.
- Каждый milestone обязан сохранять работающий deployment и полный gate-отчёт (см. §Gate в каждом M и quality gate в `promt.md`).

Обозначения: **[есть]** — уже в репозитории; **[рефактор]** — переработка существующего; **[новое]** — создаётся.

---

## 1. Пересмотр границ milestone'ов (обоснование)

Предложенное в брифе разбиение M0–M10 принимается почти без изменений, с уточнениями по зависимостям:

1. **Deployment foundation не откладывается на M10.** M0 даёт docker-compose + first migration + prisma bootstrap; M1 — StoreProfile + reverse proxy/HTTPS scaffold + `install.sh` v1 (fresh install). M10 только **hardens** (update/backup/restore/rollback, license enforcement), а не создаёт установку впервые.
2. **Pricing/Availability (M5) идут перед Cart/Checkout (M6) и Orders (M7)** — корзина не может показывать корректную цену и остаток без контекстной модели цены и проекции доступности. Это соответствует брифу.
3. **Operational Provider framework (M4) идёт перед Pricing/Availability import (M5)** — но M4 доставляет только canonical catalog identity (read-only import + durable job/outbox/inbox/checkpoint слой). Цены и остатки импортируются в M5 поверх уже готового provider-фреймворка. Это разделяет «структуру продукта» и «операционные данные».
4. **Licensing вынесен в M10, хотя часть кода уже прототипирована** (`packages/license-core`, `services/license-server`, `scripts/install.mjs`). M10 интегрирует уже существующий client boundary в runtime enforcement и завершает install/update/backup/restore, а не начинает лицензирование с нуля.

Итоговая последовательность:

| M | Область | Ключевая завершённость |
|---|---|---|
| M0 | Repo / runtime / test harness / DB baseline | `docker compose up` + миграция + health, боль-проверки границ, CI |
| M1 | Store Profile / configuration / deployment foundation | Типизированный StoreProfile + idempotent bootstrap + `install.sh` fresh install + HTTPS scaffold |
| M2 | Identity / B2B access / moderation | Реальный auth, регистрация→модерация→доступ, backend-enforcement закрытого каталога |
| M3 | Canonical catalog + commerce overlay | Product identity/variant + CommerceProductContent overlay, не затираемый синхронизацией |
| M4 | Operational Provider framework + read-only import | Заменяемый provider port + durable jobs/outbox/inbox/checkpoint + mock provider + canonical import |
| M5 | Pricing / commercial policy / availability | PriceBook/PriceEntry/BuyerPriceAssignment, FulfillmentChannel, AvailabilityProjection |
| M6 | Cart / checkout | Корзина/checkout на реальных price+availability+channel |
| M7 | Orders / provider export / idempotency | Business state ≠ integration state, идемпотентный export с Order ID как ключом |
| M8 | Invoice / PDF / order history | Immutable invoice snapshot + PDF + история заказов покупателя |
| M9 | Promotions / backoffice / integration operations | Banner/Campaign/Content + backoffice + retry/observability интеграций |
| M10 | Licensing + install/update/backup/restore hardening | License enforcement + полный операционный tooling + acceptance scenario |

---

## 2. Milestones

Для каждого milestone: (1) Цель, (2) Позиция, (3) Scope, (4) Non-goals, (5) Domain entities, (6) DB migrations, (7) Backend, (8) Worker/integration, (9) Frontend, (10) Security, (11) Tests, (12) Failure scenarios, (13) Performance, (14) Migration/rollback, (15) Gate criteria, (16) Что доказать перед переходом.

---

### M0 — Repository / runtime / test harness / baseline

1. **Цель.** Превратить текущий demo-репозиторий в воспроизводимую runtime-среду: приложение запускается через Docker Compose с реальной PostgreSQL, применяется первая миграция, работает health endpoint, есть unit+integration test harness и проверка архитектурных границ.
2. **Позиция.** Всё остальное требует запускаемого приложения с БД и тестов. Сейчас: Prisma schema есть, но **нет миграций, нет DB-слоя, нет API, нет тестов кроме `packages/license-core`**.
3. **Scope.** Prisma client singleton (`src/lib/db.ts` по паттерну hookah_store); baseline-миграция из текущей schema; `docker-compose.yml` (app + postgres) по паттерну hookah_store; `/api/health` (app+db); vitest unit + integration config (по образцу `vitest.integration.config.mts`, `scripts/test-db-setup.mjs`); `scripts/commerce-boundaries.mjs` — линтер запрета `if (client==='westside')` и импорта provider-specific кода в домен; базовый CI (lint/typecheck/build/test).
4. **Non-goals.** Никакой доменной логики, auth, реальных данных, install.sh (это M1). Не переносить код hookah_store — только паттерны конфигурации.
5. **Domain entities.** Нет новых. Фиксируется текущая schema как baseline.
6. **DB migrations.** `0000_baseline` — генерируется из текущей `schema.prisma` (`prisma migrate dev --name baseline`). С этого момента `db push` запрещён вне разработки; только versioned migrations.
7. **Backend.** `src/lib/db.ts` (PrismaClient singleton, dev hot-reload guard); `/api/health/route.ts` (SELECT 1 + версия миграции); типизированный `env` loader (zod) с fail-fast на отсутствующие переменные.
8. **Worker/integration.** Каркас `src/lib/jobs/` (пустой контракт runner, без реализации провайдеров) — заготовка под M4. Ничего не запускается по расписанию.
9. **Frontend.** Без изменений экранов. Только вынести хардкод префикса `westside-commerce-v1` из стора за конфиг-константу (подготовка к StoreProfile).
10. **Security.** `.env` не в git (уже в `.gitignore` — проверить); секреты только через env; security headers baseline в `next.config.mjs`; запрет логирования секретов (обёртка logger).
11. **Tests.** Unit: env loader, health handler. Integration: миграция применяется на чистую БД, health возвращает ok. Boundary: `commerce-boundaries.mjs` проходит.
12. **Failure scenarios.** Нет БД → health=503, приложение стартует, но помечает degraded. Отсутствует env → fail-fast при старте с понятным сообщением.
13. **Performance.** Health < 200ms. Cold `docker compose up` до готовности документирован (baseline метрика).
14. **Migration/rollback.** Baseline-миграция обратима откатом до пустой БД в dev. Документировать, что baseline нельзя пересоздавать после первого клиентского deployment.
15. **Gate criteria.** `docker compose up` → `/api/health` = ok; `npm run lint && typecheck && build && test && test:integration` зелёные; boundary-check зелёный; CI настроен.
16. **Доказать перед M1.** Чистый клон → `docker compose up` → зелёный health и все проверки без ручных шагов, кроме `.env`.

---

### M1 — Store Profile / configuration / deployment foundation

1. **Цель.** Ввести типизированный `StoreProfile` и idempotent bootstrap магазина; заложить `install.sh` (fresh install) с reverse proxy + HTTPS scaffold. Клиентские отличия (имя, тема, политики, выбор провайдера) — из профиля, не из кода.
2. **Позиция.** Идентичность deployment и конфигурация нужны до auth и каталога (они store-scoped). Deployment foundation обязан появиться рано (требование брифа), чтобы M10 его hardened, а не создавал.
3. **Scope.** `StoreProfile` тип+валидация (по контракту из `PLATFORM_FOUNDATION.md`); загрузка профиля из `deployment/config/store-profile.json` (создаётся installer'ом); idempotent bootstrap **только Store + AppSettings + Initial Admin** (никаких доменных FulfillmentChannel/InventoryLocation — их модель фиксируется в M5); `install.sh` v1: проверка Linux/Docker, интерактивный сбор config, генерация `.env` с сильными случайными секретами, `prisma migrate deploy`, bootstrap, reverse proxy (nginx по паттерну `deploy/nginx-*.conf`), HTTPS через Let's Encrypt/certbot, health check, итоговый вывод (URL/app/db/license-статус/next steps). Плюс licensing-slice (см. п.7 ниже): installation identity + client boundary + optional/mock activation, **без runtime enforcement**.
   - **Осознанно НЕ создаём в bootstrap:** `FulfillmentChannel`/`InventoryLocation`. Пока их доменная модель не зафиксирована в M5, не заводим раннюю бизнес-сущность, которую придётся рефакторить. Если install-процессу нужен канал по умолчанию — это **config-level значение** в StoreProfile (напр. `defaultChannelCode`), а не строка в БД. Реальные каналы/склады создаются в M5 (или через backoffice) после фиксации модели.
4. **Non-goals.** Не реализовывать update/backup/restore (M10). Не трогать доменную логику каталога/заказов. Не привязывать профиль к секретам (секреты — только env/secret storage).
5. **Domain entities.** `StoreProfile` (config-объект, не таблица). Уточнение `AppSettings` **[рефактор]**: runtime-настройки, уточняющие профиль в пределах включённой возможности. `InstallationIdentity` **[есть]** (из `packages/license-core`, генерируется install'ом). **Не** заводить `FulfillmentChannel`/`InventoryLocation` как bootstrap-данные (см. п.3).
6. **DB migrations.** `0001_store_bootstrap` — при необходимости индексы/поля для профиля (напр. `Store.profileCode`); без деструктивных изменений baseline.
7. **Backend.** `src/lib/store-profile.ts` (load+validate, zod); `src/lib/bootstrap.ts` (idempotent upsert только Store/AppSettings/admin, guard против второго admin); `/api/health` расширить статусом профиля/лицензии.
   - **Licensing (M1-slice, границы явно зафиксированы):** `InstallationIdentity` + license **client boundary** + **optional/mock activation** (install получает и локально верифицирует подписанный grant). **NO runtime enforcement**: приложение НЕ блокирует функциональность по статусу лицензии в M1 — только генерирует identity, активирует и отображает статус. Реальная activation policy, runtime enforcement, reactivation, grace/revocation/update behaviour — исключительно M10. Это защищает M1 от расползания в половину M10 только потому, что установщику понадобился license key.
8. **Worker/integration.** Нет.
9. **Frontend.** Подключить профиль к metadata, `<title>`, `StorefrontHeader`, `AgeGate`, browser-storage namespace, доступным палитрам — убрать хардкод «Westside»/цветов/брендов из общих компонентов в профиль/тему.
10. **Security.** `install.sh` генерирует `NEXTAUTH_SECRET`, пароли БД и т.п.; права `.env`/secrets = 600; секреты не в git и не в logs; reverse proxy выставляет security headers; HTTPS обязателен в production.
11. **Tests.** Unit: валидация профиля (валид/невалид), bootstrap идемпотентность (двойной запуск не создаёт второго admin). Integration: bootstrap на чистой БД. Smoke: `install.sh --plan` (dry-run) не пишет файлов.
12. **Failure scenarios.** Повторный `install.sh` не уничтожает БД, не сбрасывает секреты, не создаёт второго admin. Невалидный профиль → отказ до записи. Недоступен certbot → deployment остаётся на HTTP c явным предупреждением, не падает.
13. **Performance.** Bootstrap < несколько секунд. `install.sh` на чистом сервере — документированное время.
14. **Migration/rollback.** `install.sh` идемпотентен. Профиль версионируется (`schemaVersion`); несовместимый профиль отклоняется с миграционной подсказкой.
15. **Gate criteria.** На чистом сервере `./install.sh` → `https://<domain>` открывает приложение; повторный запуск безопасен; профиль управляет брендингом; фронт без хардкода клиента.
16. **Доказать перед M2.** Fresh install из чистого сервера доходит до работающего HTTPS-deployment с bootstrap'нутым admin и профилем.

---

### M2 — Identity / B2B access / moderation

1. **Цель.** Реальная аутентификация и B2B-модель доступа: регистрация → модерация → допуск → доступ к закрытому каталогу, обеспеченный backend-авторизацией.
2. **Позиция.** Закрытый каталог и все store-scoped данные требуют идентичности и авторизации до наполнения каталога/цен. Сейчас auth не реализован (`AuthForm` — заглушка, NextAuth не настроен).
3. **Scope.** NextAuth (credentials) по паттерну hookah_store `[новое]`; регистрация юрлица с модерацией; расширение lifecycle; RBAC (BUYER/STAFF/ADMIN); backend-enforcement закрытого каталога (middleware + серверные проверки, не только UI); назначение price group при approve (интеграция с M5 — на этом этапе поле, политика цен позже); опционально INN-валидация (DaData по паттерну `lib/integrations/dadata.ts`) — за портом, mock по умолчанию.
4. **Non-goals.** Не реализовывать реальную ценовую логику (M5). Не мессенджер-логины из hookah_store (Telegram/VK) — вне scope Westside v1.
5. **Domain entities.** Уточнение по брифу: `User`, `BuyerAccount`, `BuyerLegalEntity`, `BuyerLocation`, `RegistrationRequest`, `Membership/Access`. Текущая модель (`User`+`Customer`+`CustomerLocation`) **[рефактор]**: ввести явный `RegistrationRequest` (отделить заявку от активного `User`), расширить статусную модель `REGISTERED → PENDING_MODERATION → APPROVED → ACTIVE` + `REJECTED`, `SUSPENDED`. Решить: оставить `Customer` как объединённый BuyerAccount+LegalEntity или разделить (ADR).
6. **DB migrations.** `0002_identity` — `RegistrationRequest`, расширение `UserStatus`, поля модерации (`moderatedBy/At/Comment` уже есть), индексы для очереди модерации; **`AuditEntry`** (append-only, сквозная таблица — вводится здесь, переиспользуется всеми последующими M, см. §3).
7. **Backend.** `/api/auth/[...nextauth]`, `/api/auth/register`, use cases регистрации/модерации (вынести из React-компонентов — шаг из PLATFORM_FOUNDATION), authorization guards (server-side), session с ролью/статусом/store.
8. **Worker/integration.** Нет (email-уведомление о модерации опционально за портом mail, mock).
9. **Frontend.** Подключить `/login`, `/register`, `AuthForm` к реальному API; экран очереди модерации в `/staff`; редирект неавторизованных с `/catalog`.
10. **Security.** bcrypt (уже в deps); secure/httpOnly cookies; CSRF где применимо; rate limiting auth endpoints; **backend-enforcement закрытого каталога** (главный security-инвариант); **ввод сквозного `AuditEntry`** (append-only, §3) с первым action-типом `RegistrationApproved` (+ reject/suspend); input validation (zod).
11. **Tests.** Unit: переходы статусов, guard-логика. Integration: регистрация→PENDING→approve→login→доступ к каталогу; reject/suspend блокируют доступ; неавторизованный получает 401/403 на API каталога (не только редирект UI).
12. **Failure scenarios.** Повторная регистрация того же INN/email; approve уже approved; доступ suspended-пользователя; попытка обойти UI прямым API-запросом → отказ.
13. **Performance.** Логин/сессия < 300ms; очередь модерации пагинирована.
14. **Migration/rollback.** Расширение статусов обратно совместимо (маппинг старых PENDING/ACTIVE/BLOCKED). ADR по Customer-split фиксирует rollback.
15. **Gate criteria.** Полный путь регистрация→модерация→approve→вход в закрытый каталог; закрытый каталог недоступен без авторизации на уровне API; audit пишется.
16. **Доказать перед M3.** Закрытый каталог невозможно получить в обход frontend; lifecycle регистрации проходит end-to-end с audit.

---

### M3 — Canonical catalog + commerce overlay

1. **Цель.** Каноническая модель товара, отделённая от storefront-контента: синхронизация из провайдера не уничтожает правки сотрудника. Ввести явную модель `Provider Snapshot → Normalization → Canonical Product + Commerce Overlay`.
2. **Позиция.** Каталог — фундамент цен, остатков, корзины и заказов. Разделение identity/overlay нужно **до** импорта из провайдера (M4), иначе импорт затрёт контент. Сейчас `Product` — плоская модель с `importedData`/`contentData` как Json-блобами, без вариантов.
3. **Scope.** Разделить `Product` (canonical identity) / `ProductVariant`(SKU) / `ProductIdentifier`; выделить `CommerceProductContent` (overlay: display_name, descriptions, images, SEO, filters, merchandising) в отдельную сущность; merge-модель snapshot→canonical→overlay; backoffice-редактирование контента; категории/бренды остаются commerce-owned.
4. **Non-goals.** Не подключать реального провайдера (M4). Не реализовывать цены/остатки (M5). Не строить сложный merchandising-движок — только структуру overlay.
5. **Domain entities.** `Product` **[рефактор]** (canonical identity, без display-контента); `ProductVariant`/`SKU` **[новое]**; `ProductIdentifier` **[новое]** (barcode/article); `CommerceProductContent` **[новое]** (overlay, 1:1 или 1:N к product/variant); `ProviderSnapshot` **[новое]** (сырой нормализуемый снимок, отдельно от canonical). `ExternalReference` **[есть]** — связь canonical↔provider.
6. **DB migrations.** `0003_catalog_overlay` — новые таблицы, миграция данных из `Product.contentData`/`importedData` в `CommerceProductContent`/`ProviderSnapshot`; сохранение существующих связей (Category/Brand/Stock/OrderItem) через canonical Product ID (не менять!).
7. **Backend.** Catalog read-model (публичный каталог собирает canonical+overlay); overlay CRUD (backoffice); merge-функция `applySnapshot(canonical, snapshot)` с правилом «overlay wins» для владеемых commerce полей.
8. **Worker/integration.** Контракт normalization (snapshot→canonical) — готовится к M4, реализация нормализатора появляется с provider'ом.
9. **Frontend.** `CatalogClient` **[рефактор]** на реальный catalog read-model (заменить `demo-data.ts`); backoffice-экран редактирования контента карточки.
10. **Security.** Overlay-редактирование — только STAFF/ADMIN; каталог по-прежнему за авторизацией (инвариант M2); валидация изображений/SEO-полей.
11. **Tests.** Unit: merge не затирает overlay-поля при повторном snapshot. Integration: импорт snapshot → canonical создан → сотрудник меняет описание → повторный snapshot не сбрасывает описание. Migration test: данные из старых Json-полей корректно перенесены.
12. **Failure scenarios.** Snapshot без обязательного поля; конфликт SKU; удаление товара в провайдере (soft-archive canonical, не удалять overlay); дубли идентификаторов.
13. **Performance.** Каталог-листинг пагинирован, индексы по (storeId, status, category); N+1 исключён (overlay join).
14. **Migration/rollback.** Данные-миграция обратима (backup Json-полей до дропа). Canonical Product ID **не меняется** — критично для будущей замены провайдера (см. architectural scenario в brief).
15. **Gate criteria.** Каталог рендерится из canonical+overlay; правка контента переживает повторную нормализацию snapshot; canonical ID стабильны.
16. **Доказать перед M4.** Overlay не уничтожается синхронизацией (доказано тестом двойного snapshot); каталог работает без demo-data.

---

### M4 — Operational Provider framework + read-only import

1. **Цель.** Заменяемый `OperationalProvider` port и durable-инфраструктура интеграции; read-only импорт canonical-каталога через mock/dev-провайдер. 1С transport **не выдумывается**.
2. **Позиция.** До цен/остатков (M5) и экспорта заказов (M7) нужен надёжный provider-фреймворк и durable job/outbox/inbox/checkpoint слой. Сейчас есть только контракты (`CatalogImportPort`/`OrderExportPort`) и schema-заготовки (`SyncCursor`/`SyncRun`/`OutboxEvent`), без runtime.
3. **Scope.** `OperationalProvider` boundary (`syncCatalog/syncCustomers/syncPrices/syncAvailability/submitOrder/getOrderStatus`); durable state (`IntegrationJob`/`IntegrationAttempt`/`Outbox`/`Inbox`/`SyncCheckpoint`/`IntegrationError`); job runner (idempotent, bounded retry, resume-from-checkpoint) по паттерну `lib/jobs/queue.ts`; **mock/dev provider** (детерминированный fixture-источник); page-based import каталога с checkpoint. Описать API contract для 1С как **TBD-документ** и реализовать client boundary + mock.
4. **Non-goals.** Не реализовывать реальный 1С transport (contract не определён — brief). Не импортировать цены/остатки (M5). Не экспортировать заказы (M7). Не вводить внешний broker (durable PostgreSQL state — authoritative).
5. **Domain entities.** `IntegrationJob`, `IntegrationAttempt`, `Inbox`, `SyncCheckpoint`, `IntegrationError` **[новое]**; `IntegrationConnection`/`ExternalReference`/`SyncCursor`/`SyncRun`/`OutboxEvent` **[рефактор/есть]** — привести к единой durable-модели.
   - **`ProviderSnapshot` — обязательное provider evidence** (доказуемость происхождения данных). Каждый снимок хранит как минимум: `sourceFingerprint` (хэш нормализуемого payload — дедуп/сравнение без хранения гигантского raw вечно), `providerVersion` / `sourceUpdatedAt` (версия/время изменения на стороне провайдера), `receivedAt` (когда получено нами), `normalizationVersion` (какой нормализатор обработал). Цель: на вопрос клиента «почему товар приехал с таким названием/ценой?» уметь показать, **что именно** прислал provider и **какой** нормализатор это преобразовал. Особенно критично для 1С, где аномалии данных почти гарантированы. Политика retention raw payload — конфигурируемая (fingerprint остаётся всегда, полный payload — ограниченное окно).
6. **DB migrations.** `0004_integration_runtime` — новые durable-таблицы, индексы по (status, availableAt), checkpoint по (connection, entityType).
7. **Backend.** Provider registry (выбор адаптера по StoreProfile.integration); `ExternalReference`/`IntegrationMapping` слой (никаких provider ID в домене); reconciliation-заготовка.
8. **Worker/integration.** Job runner: idempotent, bounded attempts, сохранение ошибок, resume после restart, продолжение page-based import с checkpoint; mock provider отдаёт fixture-каталог постранично; healthcheck.
9. **Frontend.** Backoffice: список connection'ов, запуск sync, статус run'ов и ошибок (базовый; полноценные operations — M9).
10. **Security.** Provider-креды только из secret storage; RBAC на запуск sync (ADMIN/STAFF); payload провайдера не логируется в открытом виде; изоляция ошибок (outage провайдера не роняет storefront).
11. **Tests.** Unit: idempotency ключей, bounded retry, checkpoint resume. Integration: import каталога из mock → canonical создан через M3-нормализацию; повторный запуск идемпотентен; прерывание и resume с checkpoint; провайдер недоступен → job FAILED с сохранённой ошибкой, storefront жив.
12. **Failure scenarios.** Restart во время импорта (resume с checkpoint); частичная страница; недоступность провайдера; дубли внешних ID; отравленное сообщение (bounded attempts → DLQ/IntegrationError).
13. **Performance.** Page-based import с ограниченным batch; storefront не делает synchronous provider-запрос при открытии страницы.
14. **Migration/rollback.** Durable-таблицы аддитивны. Отключение провайдера не повреждает canonical-данные. Замена provider позже не требует миграции canonical ID (ExternalReference изолирует).
15. **Gate criteria.** Mock-провайдер импортирует каталог идемпотентно с resume; provider port заменяем; outage провайдера не кладёт storefront.
16. **Доказать перед M5.** Restart приложения во время импорта не теряет прогресс (resume с checkpoint); provider-специфика не проникла в домен (boundary-check).

---

### M5 — Pricing / price groups / commercial policy / availability

1. **Цель.** Контекстная цена (не единственный `Product.price`) и availability-проекция, развязанная от синхронного ERP-запроса; `FulfillmentChannel` как доменная модель коммерческой политики.
2. **Позиция.** Корзина/checkout (M6) и заказы (M7) требуют корректной цены-в-контексте и остатка-в-канале. Опирается на provider-фреймворк (M4) для импорта цен/остатков и на каталог (M3).
3. **Scope.** `PriceBook`/`PriceGroup`/`PriceEntry`/`BuyerPriceAssignment`; функция цены `price(Product, Buyer, PriceGroup, Channel, Date, Promotion?)`; `FulfillmentChannel` (payment method, warehouse, seller legal entity, availability/price policy, invoice profile, enabled) — без хардкода cash=складA/bank=складB; `AvailabilityProjection`(product, fulfillment_channel, available_quantity, source_updated_at); импорт цен/остатков через M4-провайдер.
4. **Non-goals.** Не реализовывать промо-движок (M9) — только точку расширения в функции цены. Не менять Order domain при добавлении каналов (проверка расширяемости).
5. **Domain entities.** `PriceBook`, `PriceEntry`, `BuyerPriceAssignment`, `AvailabilityProjection` **[новое]**; `PriceGroup` **[есть]**; `FulfillmentChannel` **[рефактор]** (расширить policy-полями); `ProductPrice` **[рефактор→PriceEntry]**; `Stock` **[рефактор]** → источник для проекции.
6. **DB migrations.** `0005_pricing_availability` — новые таблицы; миграция `ProductPrice`→`PriceEntry`/`PriceBook`; перенос назначения группы с `User.priceGroupId` на `BuyerPriceAssignment` (с сохранением обратной совместимости), `AvailabilityProjection` с `source_updated_at`.
7. **Backend.** Pricing service (контекстная цена, кэшируемая); availability read-model (проекция, не live-запрос); channel policy resolver.
8. **Worker/integration.** M4-провайдер импортирует `syncPrices`/`syncAvailability` в PriceEntry/AvailabilityProjection (mock provider); проекция обновляется асинхронно.
9. **Frontend.** Каталог/карточка показывают цену и остаток по выбранному каналу/группе; выбор способа оплаты (канала) меняет ассортимент/остатки (как в PRODUCT.md); убрать хардкод `commerce.ts fulfillmentChannels`.
10. **Security.** Цена рассчитывается только для авторизованного buyer с назначенной группой; нельзя получить цену чужой группы; policy-изменения — под audit.
11. **Tests.** Unit: цена по контексту (группа/канал/дата); отсутствие цены → товар не покупается; проекция независима от live-провайдера. Integration: смена канала меняет остаток/ассортимент; import цен обновляет PriceEntry идемпотентно.
12. **Failure scenarios.** Нет цены для группы; устаревшая проекция (source_updated_at старый → пометка stale, не блок storefront); провайдер остатков недоступен → отдаём последнюю проекцию.
13. **Performance.** Расчёт цены и чтение остатка — из проекций/кэша, без синхронного provider-запроса; листинг каталога с ценами пагинирован без N+1.
14. **Migration/rollback.** Миграция цен обратима; добавление нового канала не требует изменения Order domain (доказать на этом этапе заготовкой).
15. **Gate criteria.** Цена — функция контекста; availability — проекция, переживающая outage провайдера; новый канал добавляется без правки Order domain.
16. **Доказать перед M6.** Outage провайдера остатков не кладёт каталог; смена канала корректно меняет цену и доступность; провайдер-ID не в pricing-домене.

---

### M6 — Cart / checkout

1. **Цель.** Корзина и checkout на реальных цене/остатке/канале, с выбором точки доставки и способа оплаты до наполнения корзины (как в PRODUCT.md).
2. **Позиция.** Требует M5 (цена/остаток/канал) и M2 (buyer). Предшествует Orders (M7) — checkout создаёт draft-заказ.
3. **Scope.** Server-side cart (не только zustand-localStorage) привязанная к buyer+channel; выбор канала/оплаты до корзины; выбор `BuyerLocation` доставки; пересчёт цен/остатков при checkout (server authoritative); переход cart→DRAFT order.
4. **Non-goals.** Не отправлять заказ провайдеру (M7). Не генерировать invoice (M8). Онлайн-эквайринга нет (PRODUCT.md).
5. **Domain entities.** `Cart`/`CartItem` **[рефактор]** (сейчас `cart-store.ts` — клиентский); `Order` в статусе `DRAFT` **[рефактор]**.
6. **DB migrations.** `0006_cart` — серверная корзина (или draft-order как корзина — решение ADR); связь с channel/location.
7. **Backend.** Cart service (add/update/remove, server-side валидация цены/остатка по каналу); checkout use case (снимок цен/остатков, создание DRAFT order); идемпотентное создание корзины на сессию.
8. **Worker/integration.** Нет.
9. **Frontend.** `CartDrawer`/`checkout` **[рефактор]** на серверную корзину и реальные цены; выбор канала/оплаты и точки доставки; сохранить простой плотный UX референса.
10. **Security.** Корзина/цены только для владельца-buyer; server authoritative по цене (клиент не диктует цену); проверка остатка на checkout; CSRF.
11. **Tests.** Unit: пересчёт итога, валидация остатка. Integration: add→checkout создаёт DRAFT с корректными снятыми ценами; изменение цены между add и checkout отражается; недостаточный остаток блокирует.
12. **Failure scenarios.** Цена изменилась при checkout; остаток исчез; смена канала очищает/пересчитывает несовместимые позиции; двойной submit (идемпотентность).
13. **Performance.** Операции корзины < 300ms; пересчёт без N+1.
14. **Migration/rollback.** Серверная корзина аддитивна; клиентский стор может остаться как кэш UI.
15. **Gate criteria.** Полный путь каталог→корзина→checkout(DRAFT) с корректными ценами/остатками/каналом/доставкой.
16. **Доказать перед M7.** Цена/остаток на checkout — server authoritative; DRAFT order корректно сформирован.

---

### M7 — Orders / provider export / idempotency

1. **Цель.** Полный заказ с разделением business state и integration state; идемпотентный экспорт провайдеру с Commerce Order ID как idempotency key.
2. **Позиция.** Требует checkout (M6) и provider-фреймворк (M4). Предшествует invoice (M8).
3. **Scope.** Order lifecycle `DRAFT→SUBMITTED→CONFIRMED→PROCESSING→COMPLETED→CANCELLED`; отдельный integration/export lifecycle `PENDING→PROCESSING→SUCCESS→FAILED→RETRYING`; export через `OperationalProvider.submitOrder` (mock); idempotency по Order ID; `getOrderStatus` reconciliation.
4. **Non-goals.** Не реализовывать реальный 1С submit (contract TBD). Не создавать статусы вида `ERROR_1C` внутри Order (запрет брифа).
5. **Domain entities.** `Order` **[рефактор]** (business status); `OrderExport`/`OrderIntegrationState` **[новое]** (integration lifecycle, отдельно от Order.status); `OutboxEvent` **[рефактор]** как транспорт экспорта.
6. **DB migrations.** `0007_orders_export` — export-state таблица, idempotency-ключ (unique по order+provider), индексы очереди экспорта.
7. **Backend.** Order submit use case (DRAFT→SUBMITTED + запись в outbox); order state machine (валидные переходы); reconciliation через getOrderStatus.
8. **Worker/integration.** Export worker: idempotent submit (Order ID key), bounded retry, RETRYING/FAILED, сохранение ошибок; повторный submit того же заказа не создаёт дубль у провайдера.
9. **Frontend.** Подтверждение заказа (buyer); backoffice — список заказов с business+integration статусом раздельно.
10. **Security.** Submit только владельцем; изменение статуса — RBAC; audit переходов и экспортов; idempotency защищает от двойной отправки.
11. **Tests.** Unit: валидные/невалидные переходы; idempotency. Integration: submit→export SUCCESS (mock); двойной submit идемпотентен; провайдер FAILED→RETRYING→SUCCESS; restart во время экспорта не теряет заказ и не дублирует.
12. **Failure scenarios.** Провайдер недоступен при submit (заказ SUBMITTED, export PENDING/RETRYING); повторная отправка; частичный успех; restart worker'а.
13. **Performance.** Submit-ответ пользователю не блокируется экспортом (async outbox).
14. **Migration/rollback.** Export-state аддитивна; business Order status не зависит от integration status (замена провайдера не переписывает Order domain — architectural scenario).
15. **Gate criteria.** Заказ идемпотентно экспортируется; business и integration статусы раздельны; restart не теряет/не дублирует заказы.
16. **Доказать перед M8.** Идемпотентность экспорта (двойной submit = один заказ у провайдера); restart-устойчивость; Order domain не содержит provider-специфичных статусов.

---

### M8 — Invoice / PDF / customer order history

1. **Цель.** PDF-счёт как отдельная сущность с immutable snapshot; история заказов покупателя.
2. **Позиция.** Требует заказов (M7). Завершает основной покупательский путь (PRODUCT.md success = заказ + PDF-счёт).
3. **Scope.** `Invoice` сущность со snapshot (seller, buyer, bank details, lines, VAT/tax, total, issue time, version); PDF-рендер (по паттерну `@react-pdf/renderer`/`lib/pdf` из hookah_store); история заказов buyer; изменение настроек продавца **не меняет** выпущенный invoice.
4. **Non-goals.** Не выдумывать реальные реквизиты продавца/банка/юр.тексты (brief — TBD, заполняются через backoffice). Не онлайн-оплата.
5. **Domain entities.** `Invoice` **[рефактор]** (сейчас минимальна: number/status/pdfPath) → добавить immutable snapshot + version; `InvoiceProfile` (из FulfillmentChannel.invoice profile, M5).
6. **DB migrations.** `0008_invoice_snapshot` — snapshot-поля/таблица строк invoice, version, seller/bank snapshot; сохранить существующую связь Order↔Invoice.
7. **Backend.** Invoice issue use case (снимок из заказа+seller requisites на момент выпуска); PDF generation service; повторный выпуск = новая version, старая неизменна.
8. **Worker/integration.** PDF-генерация может быть async job (по паттерну jobs); хранение файла за media-портом.
9. **Frontend.** `/account` история заказов + скачивание PDF; backoffice — просмотр/перевыпуск invoice.
10. **Security.** Invoice доступен только владельцу-buyer и staff; PDF за авторизацией; snapshot неизменен (audit перевыпуска); реквизиты продавца — из настроек, не хардкод.
11. **Tests.** Unit: snapshot фиксирует значения на момент выпуска. Integration: выпуск invoice→PDF; изменение seller requisites не меняет ранее выпущенный invoice; перевыпуск создаёт новую version.
12. **Failure scenarios.** Сбой PDF-рендера (invoice выпущен, PDF retry); изменение заказа после выпуска (invoice не меняется); отсутствие реквизитов продавца → блок выпуска с понятной ошибкой.
13. **Performance.** PDF-генерация async, не блокирует ответ; кэш готового PDF.
14. **Migration/rollback.** Snapshot аддитивен; старые invoice без snapshot помечаются legacy.
15. **Gate criteria.** Заказ→invoice→PDF; snapshot immutable; история заказов у покупателя.
16. **Доказать перед M9.** Изменение настроек продавца не искажает выпущенный invoice (доказано тестом); покупатель видит заказ и PDF.

---

### M9 — Promotions / backoffice / integration operations

1. **Цель.** Промо/контент (Banner/Campaign/BrandPage/ContentBlock), полноценный backoffice и операции интеграции (видимость и retry ошибок из backoffice).
2. **Позиция.** Опирается на каталог/цены/заказы/интеграцию (M3–M7). Завершает employee-опыт до финального hardening.
3. **Scope.** `Banner` (placement, desktop/mobile asset, optional brand, starts_at/ends_at, priority, enabled), `Campaign`, `BrandPage`, `ContentBlock`; промо в функции цены (точка расширения из M5); backoffice для каталога/контента/регистраций/групп/заказов/интеграций; integration operations — просмотр jobs/attempts/errors, ручной retry, reconciliation.
4. **Non-goals.** Не строить сложный CMS. Не аналитический модуль (задел на будущее из PRODUCT.md, не в v1).
5. **Domain entities.** `Banner` **[рефактор]** (`SiteBanner` уже близок); `Campaign`, `BrandPage`, `ContentBlock`, `Promotion` **[новое]**.
6. **DB migrations.** `0009_promotions_content` — новые таблицы; расширение `SiteBanner` при необходимости.
7. **Backend.** Promotion resolver в pricing (M5-hook); content read-model для storefront; backoffice CRUD; integration ops API (retry/inspect).
8. **Worker/integration.** Ручной retry job'ов из backoffice; reconciliation-запуск; DLQ-просмотр.
9. **Frontend.** Storefront баннеры/брендовые страницы; backoffice-разделы (контент, промо, интеграции с retry-кнопками и статусами).
10. **Security.** Backoffice — RBAC (STAFF/ADMIN); retry/reconciliation под audit; промо-правила валидируются (даты, приоритеты).
11. **Tests.** Unit: активность баннера по датам/приоритету; применение промо в цене. Integration: баннер бренда показывается; failed job виден и retry возвращает SUCCESS.
12. **Failure scenarios.** Пересекающиеся промо (приоритет); истёкший баннер; retry уже успешного job (идемпотентность).
13. **Performance.** Баннеры/контент кэшируются; backoffice-списки пагинированы.
14. **Migration/rollback.** Промо/контент аддитивны; отключаемы флагом без потери данных.
15. **Gate criteria.** Управляемые баннеры/контент на storefront; integration failure виден и retry-able из backoffice (сценарий 23 acceptance).
16. **Доказать перед M10.** Integration failure можно увидеть и retry из backoffice; промо корректно влияет на цену.

---

### M10 — Licensing + production install/update/backup/restore hardening

1. **Цель.** Завершить и hardened операционную поставку: license enforcement в runtime + полный `install.sh`/`update.sh`/`backup.sh`/`restore.sh` + acceptance scenario на чистом сервере.
2. **Позиция.** Финальный milestone. Часть уже прототипирована (`packages/license-core`, `services/license-server`, `scripts/install.mjs`) — здесь интегрируется в runtime и завершается deployment tooling, заложенный в M1.
   - **Явное разделение с M1** (чтобы licensing не расползался):
     - **M1 (уже сделано к этому моменту):** `InstallationIdentity`, license client boundary, optional/mock activation, **NO runtime enforcement**.
     - **M10 (здесь):** real activation policy, **runtime enforcement**, reactivation, grace / revocation / update behaviour.
3. **Scope.** License subsystem: `InstallationIdentity`/`LicenseKey`/`LicenseStatus`/`LicenseValidation`/`LicenseCapabilities`; runtime-проверка (ACTIVE/INVALID/EXPIRED/REVOKED); controlled behaviour при недоступности licensing service; reactivation после backup/restore/migration. Deployment: `update.sh` (git pull/pull image, migrate deploy, rollback версии), `backup.sh`/`restore.sh` (БД + secrets + media), health-gated deploy, версионирование app↔migration совместимости. Полный acceptance scenario (27 шагов brief) на чистом сервере.
4. **Non-goals.** Не выдумывать commercial rules (grace period/seat count/тарифы — TBD в policy/config, явно помечены). Не хардкодить production licensing URL. Не Kubernetes.
5. **Domain entities.** License-модель **[есть/рефактор]** (использует `packages/license-core`); `InstallationIdentity` **[есть]** (генерируется install'ом). Licensing изолирован (не проникает во все domain modules — отдельный guard-слой).
6. **DB migrations.** `0010_licensing_runtime` (при необходимости хранения license state/audit); миграции должны быть forward-совместимы с rollback стратегией.
7. **Backend.** License validation middleware/service (локальная проверка подписанного grant, без обязательного heartbeat — по выбранной hybrid-модели); capability-gating включённых модулей (не замена авторизации); отсутствие лицензии → controlled degraded, **без повреждения данных**.
8. **Worker/integration.** Периодическая (опциональная) revalidation; graceful при недоступности licensing service (кэш + policy grace, помечено TBD).
9. **Frontend.** Backoffice: license status, reactivation flow, capability-индикация.
10. **Security.** License key не хранится в открытом виде где можно избежать; activation по HTTPS; secrets 600, не в git/logs; `install.sh` генерирует сильные секреты; audit license-действий; threat model из architecture doc.
11. **Tests.** Unit: license state transitions, grant verify (уже есть в `license-core/index.test.ts` — расширить). Integration: install→activate→ACTIVE; expired/revoked→controlled block без порчи данных; backup→restore→reactivation; update.sh миграция без потери данных; rollback версии.
12. **Failure scenarios.** Licensing service недоступен (controlled grace); повреждённый/поддельный grant (reject); повторный install (no data loss); backup/restore на другом сервере (reactivation flow); неудачный update (rollback).
13. **Performance.** License-проверка локальна и быстра (без сетевого вызова в hot path); update/backup документированы по времени.
14. **Migration/rollback.** `update.sh` с health-gate и rollback приложения; app↔DB migration compatibility матрица; повторный `install.sh`/`update.sh` не деструктивен.
15. **Gate criteria.** Полный acceptance scenario (27 шагов brief) проходит на чистом сервере: install→HTTPS→admin→provider→sync→товары→контент→регистрация→approve→каталог→канал→цены/остатки→order→export→invoice→история→retry→restart-устойчивость→backup/restore→license valid→update без потери данных.
16. **Доказать (финал).** Весь acceptance scenario зелёный; замена 1С-adapter на AXIMA One не требует миграции canonical Product ID / переписывания Cart/Order/storefront/CommerceProductContent/invoice (доказано архитектурно на mock AXIMA One provider).

---

## 3. Сквозные требования (все milestones)

- **Boundary-инвариант:** нет `if (client==='westside')`; нет provider-ID/payload в домене (`commerce-boundaries.mjs` в CI).
- **Store-scoping:** все бизнес-сущности и unique-ограничения учитывают `storeId` (даже при одном активном store на deployment).
- **Idempotency:** bootstrap, install, import, export — идемпотентны.
- **Durable state:** интеграционное состояние — в PostgreSQL, не в брокере.
- **Security:** secure cookies, CSRF, rate limiting auth, backend-enforcement закрытого каталога, security headers, input validation (zod), секреты не в git/logs.
- **Audit — единый append-only механизм `AuditEntry`.** Это НЕ аналитические domain events, а фиксация «кто руками что изменил» по критическим staff/admin-действиям. Единая таблица (actor, action, targetType/targetId, before/after diff или снимок, timestamp, storeId), append-only (без update/delete). Вводится как сквозная утилита (ориентировочно в M2 вместе с RBAC) и переиспользуется всеми последующими milestone'ами вместо разрозненных решений. Обязательные покрываемые действия минимум: `RegistrationApproved` (M2), `PriceGroupChanged` / `FulfillmentChannelChanged` (M5), `OrderStatusChanged` (M7), `InvoiceReissued` (M8), `IntegrationRetried` (M9), `LicenseReactivated` (M10). Каждый milestone добавляет свои action-типы к тому же механизму.
- **Gate после каждого M:** реализовано / migrations / tests + counts / lint+typecheck+build / compose+runtime health / manual verification / known limitations → **стоп до approve**.

---

## 4. Architectural scenario: замена 1С → AXIMA One

Предложенная архитектура удовлетворяет требованию brief: подключение AXIMA One вместо 1С НЕ требует:
- миграции canonical Product ID — обеспечено `ExternalReference`/`IntegrationMapping` (M3/M4), canonical ID не выводится из provider ID;
- переписывания Cart — Cart зависит от canonical Product + pricing/availability read-model, не от провайдера (M6);
- переписывания Order domain — business status отделён от integration status; export за портом `OperationalProvider.submitOrder` (M7);
- переписывания storefront — читает canonical+overlay+проекции, не провайдера (M3/M5);
- замены CommerceProductContent — overlay commerce-owned, независим от снапшота (M3);
- изменения invoice domain — invoice — immutable snapshot, независим от провайдера (M8).

Доказывается в M10 на mock AXIMA One provider, реализующем тот же `OperationalProvider` port.
