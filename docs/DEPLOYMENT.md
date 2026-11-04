# Развёртывание MAI Code

Документ описывает четыре независимых слоя: приложение, инфраструктуру хранения,
доступ через Keycloak и VPN-хаб. Каждый слой можно поднять отдельно.

## 1. Приложение

### Из исходников

```powershell
npm.cmd install
npm.cmd start
```

Нужны Node.js 20+ и Windows/Linux/macOS с графической средой. На Windows PowerShell
может блокировать `npm` — используйте `npm.cmd`.

### Установщики

```powershell
npm.cmd run dist:win     # NSIS + portable .exe в dist/
npm.cmd run dist         # текущая платформа
npm.cmd run pack:tar     # dist/mai-code-<версия>.tar.gz с исходниками
```

Конфигурация — `electron-builder.yml`. Релиз собирается GitHub Actions по тегу `v*`:
`.github/workflows/release.yml` создаёт черновик релиза с артефактами.

### Ограничения

- Сборка под macOS возможна только на macOS (подпись и notarization не настроены).
- Установщик не подписан сертификатом: Windows SmartScreen покажет предупреждение.
- `pack:tar` требует системный `tar` (есть в Windows 10+, Linux, macOS).

## 2. Инфраструктура хранения

```powershell
npm.cmd run infra:up
npm.cmd run infra:logs
npm.cmd run infra:down
```

`infra/docker-compose.yml` поднимает:

| Сервис | Адрес | Назначение |
| --- | --- | --- |
| Postgres 17 + pgvector | `127.0.0.1:5433` | история артефактов, эмбеддинги |
| Vault (dev) | `http://127.0.0.1:8200` | KV v2, dev-режим |
| SeaweedFS | `127.0.0.1:8888`, S3 `:8333` | файловое хранилище |

Все порты привязаны к `127.0.0.1`. Vault в dev-режиме не годится для продакшена:
токен `root`, данные в памяти контейнера. SeaweedFS запущен без аутентификации.
Это локальный стенд, а не продакшен.

## 3. Keycloak и роли

```powershell
cd infra/keycloak
docker compose up -d
```

Realm `mai-code` импортируется из `realm-mai-code.json`:

- клиент `mai-code-desktop` — публичный, включён Device Authorization Grant и PKCE
  (`S256`): приложение присылает `code_challenge` на шаге device и `code_verifier`
  при обмене кода на токен;
- роли `admin` и `guest`;
- тестовые пользователи `admin/admin` и `guest/guest` — пароли по умолчанию,
  их нужно сменить или удалить пользователей перед продакшеном.

Первый запуск Keycloak занимает 1–2 минуты: Quarkus собирает приложение и
инициализирует схему БД. Если контейнер падает с `Database operation failed` и
`IO Exception ... keycloakdb.mv.db`, удалите контейнер (`docker compose down`) и
запустите заново — H2-файл мог остаться заблокированным после аварийной остановки.

В MAI Code откройте «Доступ», укажите issuer:

```
http://localhost:8080/realms/mai-code
```

и Client ID `mai-code-desktop`, затем «Войти через Keycloak». Приложение откроет
браузер, дождётся подтверждения и сохранит токены через `safeStorage` (DPAPI на Windows).

### Что действительно защищено

- В режиме Keycloak роль берётся из `realm_access.roles` / `resource_access`.
- В локальном режиме роли `admin`/`guest` — это разграничение интерфейса.
  Владелец машины может отредактировать `%APPDATA%\mai-code\auth.json`.
- Ограничения применяются в main-процессе для опасных IPC: настройки провайдеров,
  рантаймы, навыки, AGENTS.md, память, восстановление и удаление артефактов.
- Чат и чтение досок доступны обеим ролям. Инструменты агента не имеют отдельной
  песочницы на уровне ОС: guest всё ещё может попросить агента изменить файлы.
  Для настоящей изоляции нужен серверный режим с отдельным пользователем ОС.

### Продакшен

Для внешних пользователей не используйте `start-dev`. Нужны:

- HTTPS и reverse proxy (Caddy/Traefik/nginx);
- `KC_HOSTNAME`, `KC_PROXY_HEADERS`, реальная БД Postgres;
- отключённые тестовые пользователи и временные пароли;
- короткоживущие токены и refresh-политика.

## 4. VPN-хаб

```powershell
cd infra/vpn
$env:WG_HOST = "vpn.example.com"
$env:WG_PASSWORD_HASH = "<bcrypt-хеш>"
docker compose up -d
```

- UDP `51820` должен быть доступен из интернета.
- Веб-панель слушает только `127.0.0.1:51821`; наружу её не выставляйте без HTTPS.
- Хеш пароля: `docker run --rm ghcr.io/wg-easy/wg-easy:15 node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "<пароль>"`.
- Это собственный хаб, а не сервис обхода блокировок. Соблюдайте закон страны,
  где размещён сервер.

## 5. Домен и сайт

Статический лендинг лежит в `site/`, публикуется workflow `.github/workflows/pages.yml`.
Бесплатный вариант — `https://crruton.github.io/mai-code/`. Инструкция по своему
домену и бесплатным поддоменам — `docs/DOMAIN.md`.

## 6. Песочницы проектов

Кнопка «＋ Новый проект» создаёт папку в `%APPDATA%\mai-code\sandboxes\<slug>`:

- свой `.mai-code`, `memory.md`, `docs/`, `.gitignore`, загрузки;
- локальный git и начальный коммит;
- опционально remote через GitHub CLI (`gh`), GitLab CLI (`glab`) или инструкцию
  по импорту в OpenScion;
- глобальные навыки, `AGENTS.md` и профили моделей остаются общими.

OpenScion — серверная SCM-система, а не git-хостинг. MAI Code создаёт локальный git
и памятку `docs/OPENSCION.md`; сервер и импорт пользователь делает сам.

## 7. Чего пока нет

- Серверного режима с изоляцией процессов и файловой системы по пользователю.
- Подписи установщиков и автообновления.
- Проверенного продакшен-профиля Keycloak и Vault.
- Автоматического DNS/TLS для домена.
- Полной синхронизации с Multica: доска локальная.
