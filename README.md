# Westside Commerce

Закрытый B2B-магазин для юридических лиц на стеке Next.js 14, React 18, TypeScript, PostgreSQL и Prisma.

Westside является первой клиентской конфигурацией общей платформы AXIMA Commerce. Новые магазины должны разворачиваться из той же кодовой базы через профиль, тему и интеграционные адаптеры — без копирования проекта. Практические правила зафиксированы в [`docs/PLATFORM_FOUNDATION.md`](./docs/PLATFORM_FOUNDATION.md).

Целевая поставка — Self-Hosted с install CLI и локально проверяемой лицензией после активации. Архитектурное решение находится в [`docs/security/licensing-hardening/hardening.md`](./docs/security/licensing-hardening/hardening.md). Пошаговый runbook (выпуск лицензии, установка, обновление, бэкап/восстановление) — в [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Уже заложено

- адаптивные storefront, регистрация, корзина, checkout и back office;
- модерация новых регистраций сотрудником магазина;
- торговые точки покупателя и выбор адреса доставки в заказе;
- переключение наличного/безналичного канала с отдельным складским ассортиментом и остатками;
- общие и брендовые баннеры каталога;
- 18+ age gate;
- товары, категории, бренды, юрлица, торговые точки и ценовые группы;
- заказы и PDF-счета как доменные сущности;
- независимые контракты импорта каталога и экспорта заказов;
- внешние идентификаторы, sync cursors и transactional outbox вне commerce-сущностей.

Текущие позиции в UI помечены как демонстрационные. Реальные данные появятся после подключения БД и конкретного ERP-коннектора.

## Запуск

1. Скопировать `.env.example` в `.env`.
2. Запустить PostgreSQL и выполнить `npm run db:migrate`.
3. Запустить `npm run dev`.

Основные маршруты: `/`, `/catalog`, `/login`, `/register`, `/account/locations`, `/checkout`, `/staff`.

## Self-Hosted установка и лицензирование

Поддерживаемый путь: `sh install.sh --image registry/image@sha256:... --config /private/install.config.json`. Скрипт выполняет активацию, миграции, bootstrap и проверяет app/worker; подробности в [DEPLOYMENT.md](DEPLOYMENT.md). Identity и секреты сохраняются при повторном запуске. `scripts/install.mjs` — внутренний helper конфигурации, не самостоятельная установка.

Обновление: `sh update.sh --image sha256:...`; обязательные backup и проверка миграций на изолированной копии БД. Проверка установленной версии: `node scripts/deploy.mjs verify`. Полный Linux drill точного образа: `npm run check:deployment -- sha256:...`.
