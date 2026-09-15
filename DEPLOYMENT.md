# Развёртывание AXIMA Commerce

Пошаговый runbook: выпуск лицензии, установка на сервер, проверка и день-2 операции
(обновление, бэкап, восстановление). Модель лицензии — **бессрочная, анти-копирование**,
привязанная к installation identity; активация происходит **один раз при разворачивании**,
дальше приложение проверяет grant **офлайн** (без сети и heartbeat).

Роли:
- **Издатель (вендор)** — держит приватный ключ, выпускает лицензии, поднимает сервер активации.
- **Инсталляция (сервер клиента)** — активируется один раз и работает автономно.

---

## 0. Предварительные требования

- Целевой сервер: **Linux + Docker Engine + docker compose v2**.
- На хосте установки нужен **Node.js** (для шага активации внутри `install.sh`).
- Домен, указывающий на сервер (для HTTPS через Let's Encrypt).

Для локальной **разработки лицензия не нужна**: enforcement выключен, пока не задан
`LICENSE_ENFORCE=1` (или `NODE_ENV=production`).

---

## 1. Сторона издателя (один раз)

```bash
# 1.1 Ключевая пара издателя. Приватный ключ — секрет, публичный раздаётся инсталляциям.
npm run license:keygen
#   → services/license-server/keys/publisher-private.pem (0600)
#   → services/license-server/keys/publisher-public.pem  (раздать клиенту)

# 1.2 Выпуск лицензии клиенту. Activation key печатается ОДИН РАЗ — сохраните его.
npm run license:issue -- --customer westside \
  --modules commerce-core,commerce-b2b,content,invoices \
  --production-seats 1 --staging-seats 0
#   → services/license-server/data/licenses.json
#   → печатает: axm_XXXXXXXXXXXXXXXXXXXX   (это AXIMA_ACTIVATION_KEY)

# 1.3 Сервер активации (нужен только в момент установки инсталляции).
npm run license:server
#   → слушает http://127.0.0.1:4010
```

`--modules` — то, что клиенту разрешено включать (лицензия только сужает набор из профиля).
`--production-seats` ограничивает число боевых активаций (защита от копирования проекта).

---

## 2. Установка на сервер клиента (одна команда)

`install.sh` сам активирует лицензию (если grant'а ещё нет) **до** старта приложения,
поэтому прод не может подняться без лицензии по ошибке.

```bash
export AXIMA_DATABASE_URL="postgresql://user:pass@host:5432/db"   # ваша БД (если внешняя)

./install.sh \
  --domain shop.example.com \
  --admin-email admin@example.com \
  --store-code westside --store-name "Westside" \
  --modules commerce-core,commerce-b2b,content,invoices \
  --provider one-c \
  --activation-key axm_XXXXXXXXXXXXXXXXXXXX \
  --license-server http://127.0.0.1:4010 \
  --publisher-key ./services/license-server/keys/publisher-public.pem
```

Порядок шагов: `checks → secrets → profile → license activate → compose build →
postgres → migrate deploy → bootstrap → app → nginx → https → health`.

Активация: генерируется installation identity → запрос к license-server → **локальная
проверка подписи и привязки** → в `deployment/config/license.json` и
`deployment/secrets/installation-private-key.pem`. `install.sh` пишет `.env` с
`LICENSE_ENFORCE=1` и путями к grant'у; compose монтирует `deployment/` в приложение.

Флаги активации можно не указывать в командной строке:
- `AXIMA_ACTIVATION_KEY` — вместо `--activation-key`;
- предпросмотр без записи: `./install.sh --plan …` (ключ в выводе скрыт).

**Идемпотентность:** повторный запуск не пересоздаёт секреты, профиль, админа и **не
переактивирует** существующую лицензию.

> Если на хосте нет Node.js, активацию можно выполнить отдельно, а затем запустить
> `install.sh` (он увидит готовый grant и пропустит активацию):
> ```bash
> AXIMA_ACTIVATION_KEY=axm_... AXIMA_DATABASE_URL=... \
>   node scripts/install.mjs apply --config install.config.json
> ```

---

## 3. Проверка

```bash
# Статус лицензии из артефактов на диске
node scripts/license-check.mjs \
  deployment/config/license.json \
  deployment/secrets/installation-private-key.pem \
  deployment/config/publisher-public.pem
#   → license status = ACTIVE
```

Также:
- **Health:** `GET /api/health` → `license: { status: "ACTIVE", enforced: true }`.
- **Backoffice:** раздел «Лицензия» — статус, поля grant'а, лицензированные модули.

При не-`ACTIVE` и включённом enforcement блокируются **мутации** (оформление заказов,
импорт, изменения в backoffice); витрина, чтение и health продолжают работать —
данные не портятся.

---

## 4. День-2 операции

### Обновление (health-gated, с откатом)
```bash
./update.sh
#   git pull → build → migrate deploy → рестарт → проверка health;
#   при нездоровом app — откат к предыдущему образу. БД мигрирует только вперёд.
```

### Бэкап
```bash
./backup.sh --out backups
#   БД (pg_dump) + secrets + config + media + installation identity → backups/axima-backup-<ts>.tar.gz (0600)
```

### Восстановление (в т.ч. на другом сервере)
```bash
./restore.sh --archive backups/axima-backup-<ts>.tar.gz --confirm
#   перезапись БД + возврат secrets/config/media.
```
После восстановления installation identity присутствует снова, поэтому лицензия
**реактивируется без нового seat**: перезапустите приложение **или** backoffice →
«Лицензия» → «Перечитать лицензию» (действие пишется в audit как `LicenseReactivated`).

---

## 5. Симуляция приёмки (docker)

```bash
sh scripts/acceptance.sh            # на Linux/в контейнере node:*-alpine
```
Прогоняет lifecycle: keygen → issue → server → activate → **ACTIVE** →
копия с чужим ключом → **INVALID** → reactivation → **ACTIVE** + синтаксис deploy-скриптов.
App-доменные шаги (регистрация/каталог/заказ/экспорт/счёт/retry) покрыты
`npm run test:integration`.

---

## 6. Диагностика

| Симптом | Причина | Решение |
|---|---|---|
| `install.sh`: `no license grant and no --activation-key` | нет grant'а и не передан ключ | выпустить лицензию (§1) и передать `--activation-key` |
| `install.sh`: `node is required on the host` | нет Node.js на хосте | поставить Node или выполнить активацию отдельно (§2) |
| `license status = INVALID (belongs to another installation)` | grant от другой инсталляции (копия) | активировать заново на этом сервере (§2) или восстановить свою identity из бэкапа |
| API отвечает `403 license_invalid` | enforcement включён, лицензия не ACTIVE | проверить `/api/health`, при необходимости «Перечитать лицензию» после восстановления |
| Auth-роуты `500 NO_SECRET` | нет `NEXTAUTH_SECRET` в окружении | `install.sh` генерирует его в `.env`; для ручного запуска задать переменную |

Архитектура лицензирования: [`docs/security/licensing-hardening/hardening.md`](./docs/security/licensing-hardening/hardening.md).
