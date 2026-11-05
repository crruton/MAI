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
npm.cmd run dist:win       # NSIS + portable .exe в dist/
npm.cmd run dist           # текущая платформа
npm.cmd run pack:offline   # tar.gz с node_modules и Electron (офлайн)
npm.cmd run pack:tar       # tar.gz с исходниками (нужен npm и сеть)
```

| Артефакт | Что внутри | Запуск без Node.js | Размер |
|---|---|---|---|
| `dist/win-unpacked/MAI Code.exe` | portable-сборка | да | ~200 МБ |
| `*-offline-win-x64.tar.gz` | исходники + `node_modules` + Electron | да | ~200 МБ |
| `*.tar.gz` (`pack:tar`) | только исходники | нет | ~0.4 МБ |

Проверено на Windows 10: офлайн-архив распакован в пустую папку, приложение
запущено с отдельным `--user-data-dir` без `npm` и без сети. EXE из
`dist/win-unpacked` также запускается. Сборка portable-цели через 7z на этой
машине занимает больше 15 минут; NSIS-установщик собирается за это время.

Конфигурация — `electron-builder.yml`. Релиз собирается GitHub Actions по тегу `v*`:
`.github/workflows/release.yml` создаёт черновик релиза с артефактами.
Контрольные суммы пишутся в `dist/SHA256SUMS.txt`.

### Ограничения

- Сборка под macOS возможна только на macOS (подпись и notarization не настроены).
- Установщик не подписан сертификатом: Windows SmartScreen покажет предупреждение.
- Автообновления нет: новая версия — новый архив.
- `pack:tar` и `pack:offline` требуют системный `tar` (есть в Windows 10+, Linux, macOS).

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

Compose поднимает Keycloak и Postgres. Пользователи хранятся в Postgres, а не в
H2, поэтому переживают пересоздание контейнера.

Realm `mai-code` импортируется из `realm-mai-code.json`:

- клиент `mai-code-desktop` — публичный, включён Device Authorization Grant и PKCE
  (`S256`): приложение присылает `code_challenge` на шаге device и `code_verifier`
  при обмене кода на токен;
- роли `admin` и `guest`;
- пользователи `admin/admin`, `guest/guest` и `letun82` (`letun82@mail.ru`,
  временный пароль `ChangeMe-letun82!`, роль `admin`).

Первый запуск Keycloak занимает 1–2 минуты: Quarkus собирает приложение и
инициализирует схему Postgres. Данные лежат в томе `keycloak-db`.

Добавить пользователя: Admin Console → realm `mai-code` → Users → Add user,
затем Credentials и Role mapping. Подробности и команды `kcadm.sh`:
`infra/keycloak/README.md`.

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

## 5. Домен, DNS и сайт

Статический лендинг лежит в `site/`, публикуется workflow `.github/workflows/pages.yml`.
Бесплатный вариант — `https://crruton.github.io/mai-code/`. Инструкция по своему
домену и бесплатным поддоменам — `docs/DOMAIN.md`.

Подробно про hosts, A/CNAME, TLS и переезд — `docs/DNS.md`.

## 6. Kubernetes

```powershell
k3d cluster create mai-code --agents 1 -p "8080:80@loadbalancer"
kubectl apply -k infra/k8s
```

Манифесты и бесплатное облако — `docs/KUBERNETES.md`. Секреты создаются
отдельно, `infra/k8s/secrets.example.yaml` — только шаблон.

## 7. Multica

```powershell
docker compose -f infra/multica/docker-compose.yml up -d
npm.cmd run multica:sync
```

Подробности: `docs/MULTICA.md`. Официальный способ — `make selfhost` в
репозитории Multica; локальный compose — упрощённый шаблон.

## 8. Песочницы проектов

Кнопка «＋ Новый проект» создаёт папку в `%APPDATA%\mai-code\sandboxes\<slug>`:

- свой `.mai-code`, `memory.md`, `docs/`, `.gitignore`, загрузки;
- локальный git и начальный коммит;
- опционально remote через GitHub CLI (`gh`), GitLab CLI (`glab`) или инструкцию
  по импорту в OpenScion;
- глобальные навыки, `AGENTS.md` и профили моделей остаются общими.

Панель «Песочницы» запускает Docker-контейнер с папкой проекта в `/workspace`:
read-only корневая ФС, сброс capabilities, лимиты CPU/RAM, публикация портов.
Подробности: `docs/SANDBOXES.md`.

OpenScion — серверная SCM-система, а не git-хостинг. MAI Code создаёт локальный git
и памятку `docs/OPENSCION.md`; сервер и импорт пользователь делает сам.

## 9. Чего пока нет

- Серверного режима с изоляцией процессов и файловой системы по пользователю.
- Подписи установщиков и автообновления.
- Проверенного продакшен-профиля Keycloak, Vault и Kubernetes.
- Автоматического DNS/TLS для домена.
- Двусторонней синхронизации с Multica: только OpenSpec → Multica.
