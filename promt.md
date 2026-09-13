Ты работаешь над проектом AXIMA Commerce.



Перед любыми изменениями полностью изучи:

\- PRODUCT.md

\- docs/AXIMA\_COMMERCE\_ARCHITECTURE.md, если он уже существует

\- текущую структуру репозитория

\- текущую Prisma schema

\- существующий frontend

\- существующие integration/auth/catalog/order модули

\- C:/code/Projects/hookah\_store только как источник проверенных паттернов и контрактов



Не начинай массово переносить код из hookah\_store.

Сначала определи, что уже существует, что можно переиспользовать, что нужно удалить или изолировать и чего не хватает.



Контекст проекта

===============



AXIMA Commerce — самостоятельный B2B commerce-продукт.



Westside — первый клиентский профиль AXIMA Commerce, но доменная логика AXIMA Commerce не должна содержать условий вида:



if client == "Westside"



или иных клиентских hardcode.



Ближайшая модель эксплуатации:

\- единая кодовая база AXIMA Commerce;

\- отдельный deployment на каждого клиента;

\- отдельная PostgreSQL database на клиента;

\- собственный domain клиента;

\- собственные branding/configuration/integration settings;

\- SaaS multi-tenancy сейчас НЕ требуется.



Текущий frontend уже предварительно реализован.



Его НЕ нужно переписывать с нуля.



Frontend должен постепенно подключаться к новой доменной и backend-архитектуре по мере реализации milestone'ов.

Допускается его рефакторинг, изменение экранов и API-контрактов, если это необходимо для корректной архитектуры.



Цель проекта

============



Получить production-ready AXIMA Commerce, который можно развернуть на новом сервере клиента одной установкой:



./install.sh



Во время установки должны задаваться или конфигурироваться как минимум:



\- domain;

\- license key;

\- название магазина / instance;

\- базовые application settings;

\- необходимые секреты и пароли;

\- параметры PostgreSQL;

\- параметры production environment;

\- при необходимости данные первого administrator;

\- параметры operational provider / интеграции, если они уже известны на момент установки.



Не выдумывать отсутствующие реквизиты 1С, юридические данные, API URL или transport contract.

Для ещё не определённых интеграционных параметров должна существовать возможность настройки после установки через конфигурацию/backoffice.



После установки:



https://<domain>



должен открывать работающий production deployment.



Архитектурная модель

====================



AXIMA Commerce должен использовать modular monolith.



Не использовать microservices без доказанной необходимости.



Основные bounded contexts:



1\. Identity \& Access

2\. Catalog Identity

3\. Merchandising / Product Content

4\. Pricing

5\. Availability

6\. Commercial Policy / Fulfillment

7\. Cart \& Checkout

8\. Orders

9\. Documents / Invoice

10\. Promotions / Content

11\. Operational Provider Integration

12\. Integration Jobs / Outbox / Inbox

13\. Store Profile / Configuration

14\. Licensing



Основной принцип:



AXIMA Commerce поддерживает собственную каноническую commerce-модель и не зависит от структуры внешней ERP.



Авторитетный источник каждого класса operational-данных определяется Operational Provider.



Commerce всегда владеет:

\- storefront;

\- merchandising;

\- product presentation;

\- descriptions;

\- images;

\- SEO;

\- filters;

\- promotions;

\- banners;

\- customer experience;

\- checkout UX.



Operational Provider может владеть:

\- product operational identity;

\- prices;

\- balances;

\- customers;

\- orders;

\- fulfilment state,



в зависимости от режима эксплуатации.



AXIMA Commerce должен иметь заменяемый Operational Provider.



Минимальная abstraction boundary:



OperationalProvider

\- syncCatalog

\- syncCustomers

\- syncPrices

\- syncAvailability

\- submitOrder

\- getOrderStatus



Не допускается проникновение provider-specific ID или payload в доменные сущности.



Использовать отдельные ExternalReference / IntegrationMapping.



В будущем должны быть возможны adapters:



\- AXIMA One

\- 1C

\- MoySklad



Первая реальная интеграция — 1С, но её transport/API contract пока не определён.

Не придумывать его.



Product model

=============



Не смешивать canonical identity и storefront content.



Примерное разделение:



Product

ProductVariant / SKU

ProductIdentifier

ExternalReference



CommerceProductContent

\- display\_name

\- descriptions

\- images

\- SEO

\- filters

\- merchandising attributes



Синхронизация из ERP НЕ должна уничтожать изменения, сделанные сотрудником AXIMA Commerce.



Разработать явную модель:



Provider Snapshot

→ Normalization

→ Canonical Product

\+

Commerce Overlay



Commercial Policy

=================



Не хардкодить:



cash = warehouse A

bank = warehouse B



Использовать domain concept вроде:



FulfillmentChannel



который может определять:

\- payment method;

\- warehouse;

\- seller legal entity;

\- availability policy;

\- price policy;

\- invoice profile;

\- enabled state.



Это должно позволить в дальнейшем добавлять новые каналы без изменения Order domain.



Pricing

=======



Не использовать единственное Product.price.



Цена является результатом контекста:



Product

\+ Buyer

\+ PriceGroup

\+ FulfillmentChannel

\+ Date

\+ Promotion



Минимально предусмотреть:



PriceBook

PriceGroup

PriceEntry

BuyerPriceAssignment



Availability

============



Не использовать Product.quantity как authoritative commerce-модель.



Использовать AvailabilityProjection:



product

fulfillment\_channel

available\_quantity

source\_updated\_at



Storefront не должен делать synchronous ERP request при каждом открытии страницы.



ERP/AXIMA One outage не должен полностью класть storefront.



Orders

======



Разделить business state заказа и integration state.



Order lifecycle, например:



DRAFT

SUBMITTED

CONFIRMED

PROCESSING

COMPLETED

CANCELLED



Integration/export lifecycle отдельно:



PENDING

PROCESSING

SUCCESS

FAILED

RETRYING



Не создавать статусы вида ERROR\_1C внутри Order.



Все exports должны быть идемпотентны.



Commerce Order ID должен использоваться как idempotency key при отправке заказа provider'у.



Invoice

=======



PDF invoice должен быть отдельной сущностью.



Invoice должен хранить snapshot:

\- seller;

\- buyer;

\- bank details;

\- lines;

\- VAT/tax values;

\- total;

\- issue time;

\- version.



Изменение настроек продавца не должно менять уже выпущенный invoice.



Identity

========



B2B customer model:



User

BuyerAccount

BuyerLegalEntity

BuyerLocation

RegistrationRequest

Membership / Access



Регистрация по умолчанию:

REGISTERED

→ PENDING\_MODERATION

→ APPROVED

→ ACTIVE



Также предусмотреть:

REJECTED

SUSPENDED



Закрытый каталог должен защищаться backend authorization, а не только frontend.



Promotions

==========



Предусмотреть:



Banner

Campaign

BrandPage

ContentBlock



Banner как минимум:

\- placement

\- desktop asset

\- mobile asset

\- optional brand

\- starts\_at

\- ends\_at

\- priority

\- enabled



Integration reliability

=======================



Использовать durable PostgreSQL state.



Минимально:



IntegrationJob

IntegrationAttempt

Outbox

Inbox

SyncCheckpoint

IntegrationError



Не считать queue/broker authoritative state.



Если отдельный broker на первой версии не нужен — не добавлять его только ради архитектуры.



Jobs должны:

\- быть идемпотентными;

\- поддерживать retry;

\- иметь bounded attempts;

\- сохранять ошибки;

\- позволять восстановление после restart;

\- позволять продолжить page-based import с checkpoint.



Store Profile

=============



Ввести отдельную конфигурацию клиента:



StoreProfile / InstanceConfiguration



Сюда относятся:

\- store name;

\- branding;

\- domain;

\- registration policy;

\- catalog policy;

\- age policy;

\- enabled capabilities;

\- legal documents;

\- contacts;

\- operational provider selection.



Не использовать StoreProfile как место для business logic.



Licensing

=========



AXIMA Commerce должен поддерживать commercial license activation.



При установке:



./install.sh



пользователь вводит license key.



Спроектировать отдельный License subsystem.



Минимальные понятия:



InstallationIdentity

LicenseKey

LicenseStatus

LicenseValidation

LicenseCapabilities / licensed features — предусмотреть расширение, даже если первая версия имеет один тариф.



Требования:



1\. installation получает устойчивый installation\_id;

2\. license key не должен храниться в открытом виде там, где это можно избежать;

3\. license activation выполняется по HTTPS через внешний licensing endpoint;

4\. приложение умеет проверить:

&#x20;  - ACTIVE

&#x20;  - INVALID

&#x20;  - EXPIRED

&#x20;  - REVOKED

5\. отсутствие лицензии не должно приводить к повреждению данных;

6\. licensing logic не должна проникать во все domain modules;

7\. предусмотреть controlled behaviour при временной недоступности licensing service;

8\. не придумывать коммерческие правила grace period, количество серверов или тарифы — вынести их в policy/config и явно отметить как TBD;

9\. domain может быть частью activation metadata, но не создавать архитектуру, в которой любое изменение domain уничтожает instance;

10\. activation должна быть повторяемой после backup/restore или controlled server migration.



Если licensing backend ещё не существует:

\- описать его API contract;

\- реализовать client boundary;

\- предоставить development/mock provider;

\- не хардкодить фиктивный production URL.



Security

========



Production secrets:

\- никогда не коммитить;

\- install.sh должен генерировать сильные случайные значения там, где это возможно;

\- production .env создаётся во время установки;

\- права файла должны быть ограничены;

\- секреты не должны попадать в logs.



Обязательно учесть:

\- secure cookies;

\- CSRF где применимо;

\- password/session security;

\- rate limiting auth endpoints;

\- registration moderation authorization;

\- backend enforcement закрытого каталога;

\- security headers;

\- input validation;

\- audit критических admin actions.



Deployment

==========



Итоговый repository должен содержать production deployment.



Обязателен:



install.sh



Он должен быть идемпотентным настолько, насколько разумно.



Установка должна:



1\. проверить поддерживаемую Linux environment;

2\. проверить/установить необходимые runtime dependencies либо использовать documented Docker deployment;

3\. запросить interactive configuration или принять config flags/env;

4\. настроить domain;

5\. создать production .env;

6\. создать/инициализировать PostgreSQL;

7\. выполнить migrations;

8\. создать initial administrator при необходимости;

9\. активировать license;

10\. собрать/запустить приложение;

11\. настроить reverse proxy;

12\. настроить HTTPS через Let's Encrypt или выбранный production mechanism;

13\. настроить automatic restart;

14\. выполнить health check;

15\. вывести итог:

&#x20;   - URL

&#x20;   - application status

&#x20;   - database status

&#x20;   - license status

&#x20;   - next required configuration steps.



Повторный запуск install.sh НЕ должен:

\- уничтожать БД;

\- сбрасывать секреты;

\- создавать второго admin;

\- повторно импортировать данные;

\- ломать рабочий deployment.



Нужны также:



update.sh

backup.sh

restore.sh



или аргументированное решение, почему на первой версии некоторые из них объединены с другим operational tooling.



Deployment должен позволять:



fresh install

update existing installation

backup

restore

migration

rollback application version



Продумать application version и database migration compatibility.



Docker допускается и предпочтителен, если упрощает воспроизводимое развёртывание.



Не строить Kubernetes.



Frontend

========



Frontend уже существует.



Не выполнять redesign только ради архитектурной чистоты.



Для каждого milestone:

\- использовать существующие экраны, если они подходят;

\- подключать реальные API;

\- заменять mocks;

\- корректировать UX только там, где реальная domain model этого требует.



Frontend architecture должна позволить:

\- storefront;

\- customer account;

\- checkout;

\- employee backoffice.



Можно сохранить один Next.js application, если нет убедительной причины разделять apps.



Не делать отдельные frontend applications преждевременно.



Цель текущей задачи

===================



СЕЙЧАС НЕ НАЧИНАЙ РЕАЛИЗАЦИЮ.



Сначала создай подробный файл:



docs/AXIMA\_COMMERCE\_IMPLEMENTATION\_PLAN.md



Разбей реализацию на последовательные milestones аналогично M0–M10 AXIMA One.



Каждый milestone должен иметь:



1\. Цель.

2\. Почему он находится именно в этой позиции.

3\. Scope.

4\. Explicit non-goals.

5\. Domain entities.

6\. DB migrations.

7\. Backend work.

8\. Worker/integration work.

9\. Frontend integration.

10\. Security requirements.

11\. Tests.

12\. Failure scenarios.

13\. Performance expectations, где применимо.

14\. Migration/rollback requirements.

15\. Gate criteria.

16\. Что должно быть доказано перед переходом к следующему milestone.



Особенно важно:

каждый milestone должен давать архитектурно завершённый результат, а не просто набор файлов.



План должен включать как минимум следующие области, но ты можешь изменить границы milestone'ов, если есть архитектурное обоснование:



M0 — Repository / runtime / test harness / baseline

M1 — Store Profile / configuration / deployment foundation

M2 — Identity / B2B access / moderation

M3 — Canonical catalog + commerce overlay

M4 — Operational Provider framework + read-only import

M5 — Pricing / price groups / commercial policy / availability

M6 — Cart / checkout

M7 — Orders / provider export / idempotency

M8 — Invoice / PDF / customer order history

M9 — Promotions / backoffice / integration operations

M10 — Licensing + production install/update/backup/restore hardening



Это НЕ обязательное окончательное разбиение.

Проанализируй зависимости и предложи лучшее, если это необходимо.



Installation не должна появиться только в самом конце.

Deployment foundation должен закладываться на ранних milestone, а M10 должен его harden, а не впервые создавать.



Acceptance scenario

===================



В конце проекта должен проходить полный сценарий на чистом сервере:



1\. Берём clean supported Linux server.

2\. Клонируем AXIMA Commerce.

3\. Запускаем ./install.sh.

4\. Указываем domain.

5\. Указываем license key.

6\. Указываем initial configuration.

7\. Installation создаёт production instance.

8\. HTTPS работает.

9\. Administrator входит в backoffice.

10\. Подключает Operational Provider / 1C configuration.

11\. Запускает catalog sync.

12\. Товары появляются в commerce catalog.

13\. Сотрудник дополняет product content.

14\. Создаётся B2B registration.

15\. Employee approves registration и назначает price group.

16\. Customer входит в закрытый каталог.

17\. Выбирает fulfillment/payment context.

18\. Видит корректные prices и availability.

19\. Создаёт order.

20\. Order idempotently передаётся Operational Provider.

21\. Генерируется PDF invoice.

22\. Customer видит order в истории.

23\. Integration failure можно увидеть и retry из backoffice.

24\. Restart application не теряет jobs/orders/state.

25\. Backup → restore на controlled test environment сохраняет данные.

26\. License остаётся в валидном controlled состоянии либо проходит documented reactivation flow.

27\. update.sh обновляет deployment без потери данных.



Дополнительный architectural scenario:



Позже вместо 1C adapter подключается AXIMA One adapter.



Для этого НЕ должны потребоваться:

\- миграция canonical Product IDs;

\- переписывание Cart;

\- переписывание Order domain;

\- переписывание storefront;

\- замена CommerceProductContent;

\- изменение invoice domain.



Если это невозможно при предложенной архитектуре — объясни почему и скорректируй design.



Quality gate

============



Не переходить от planning к implementation автоматически.



После создания AXIMA\_COMMERCE\_IMPLEMENTATION\_PLAN.md:



1\. выведи краткое summary текущего состояния repo;

2\. перечисли найденный reusable code;

3\. перечисли architectural debt / conflicts;

4\. покажи proposed milestones;

5\. перечисли ключевые архитектурные решения;

6\. перечисли TBD, которые нельзя корректно решить без внешних данных;

7\. ОСТАНОВИСЬ.



Жди моего явного approve первого milestone.



После каждого milestone:



\- выполнить весь gate;

\- предоставить точный отчёт:

&#x20; - что реализовано;

&#x20; - migrations;

&#x20; - tests;

&#x20; - test counts;

&#x20; - lint/typecheck/build;

&#x20; - compose/runtime health;

&#x20; - manual verification;

&#x20; - known limitations;

\- НЕ переходить к следующему milestone без явного approve.



Главный принцип:



Не оптимизировать под красивую демонстрацию.

Не пропускать фундаментальные этапы ради frontend.

Не создавать временную архитектуру, которую придётся выбросить после подключения AXIMA One.



AXIMA Commerce должен получиться самостоятельным production-продуктом, который сегодня работает с 1С, а завтра может стать стандартным Commerce layer для AXIMA One.

