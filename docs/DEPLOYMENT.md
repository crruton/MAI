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
  Если положить сертификат в секреты (`CSC_LINK`, `CSC_KEY_PASSWORD`), electron-builder
  подпишет EXE сам.

### Проверка на чистой машине

Каждый push в CI собирает NSIS и portable на `windows-latest`, тихо ставит,
запускает `MAI Code.exe --self-check` с PATH без Node.js и удаляет
(`scripts/check-installer.ps1`, ADR 0095). То же — вручную на любой машине:

```powershell
& "$env:LOCALAPPDATA\Programs\mai-code\MAI Code.exe" --self-check=$env:TEMP\mai-check.json
Get-Content $env:TEMP\mai-check.json
```

Отчёт перечисляет проверки (ресурсы, модули, папка данных, cmd.exe, DPAPI,
системные сертификаты); код выхода 0 — всё в порядке.
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

В MAI Code откройте «Доступ» (кнопка в шапке или ⚙ → «Доступ»), укажите issuer:

```
http://localhost:8080/realms/mai-code
```

и Client ID `mai-code-desktop`, затем «Войти через Keycloak». Приложение откроет
браузер, дождётся подтверждения и сохранит токены через `safeStorage` (DPAPI на Windows).

### Корпоративный режим: вход обязателен

Чтобы без входа приложение не работало вовсе, администратор кладёт в
`%ProgramData%\mai-code\managed-settings.json` (macOS —
`/Library/Application Support/mai-code/`, Linux — `/etc/mai-code/`):

```json
{ "auth": { "required": true, "issuer": "https://sso.example.com/realms/mai-code", "clientId": "mai-code-desktop" } }
```

Тогда окно показывает только экран входа, локальной роли нет, адрес Keycloak из
окна не меняется, «Выйти» возвращает на экран входа. Access token продлевается по
`refresh_token` раз в минуту, роль пересчитывается из нового токена; отозванная в
Keycloak сессия закрывается и в приложении (ADR 0093). Клиенту нужен
`refresh_token` (стандартный flow) и разумный `SSO Session Idle`.

### Что действительно защищено

- В режиме Keycloak роль берётся из `realm_access.roles` / `resource_access` и
  пересчитывается при каждом продлении токена.
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

Workflow сам включает GitHub Pages (`actions/configure-pages` с
`enablement: true`), если источник ещё не настроен. Если деплой всё равно
падает, проверьте: Settings → Pages → Source = **GitHub Actions** и что у
workflow есть права `pages: write`, `id-token: write`. Файл `site/.nojekyll`
отключает обработку Jekyll.

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
$env:MULTICA_MODE="with-server"
irm https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.ps1 | iex
npm.cmd run multica:sync
```

Подробности: `docs/MULTICA.md`. Для реальной работы используйте официальный
`docker-compose.selfhost.yml` из `%USERPROFILE%\.multica\server`; локальный
`infra/multica/docker-compose.yml` — упрощённый шаблон.

## 8. Песочницы проектов

Кнопка «＋ Новый проект» создаёт папку в `%APPDATA%\mai-code\sandboxes\<slug>`:

- свой `.mai-code`, `memory.md`, `docs/`, `.gitignore`, загрузки;
- локальный git и начальный коммит;
- опционально remote через GitHub CLI (`gh`), GitLab CLI (`glab`) или инструкцию
  по импорту в OpenScion;
- глобальные навыки, `AGENTS.md` и профили моделей остаются общими.

Окно «Docker» («Подключения ▾» → «Docker») запускает Docker-контейнер с папкой проекта в `/workspace`:
read-only корневая ФС, сброс capabilities, лимиты CPU/RAM, публикация портов.
Подробности: `docs/SANDBOXES.md`.

OpenScion — серверная SCM-система, а не git-хостинг. MAI Code создаёт локальный git
и памятку `docs/OPENSCION.md`; сервер и импорт пользователь делает сам.

## 9. Observability

```powershell
Copy-Item infra/observability/.env.example infra/observability/.env
npm.cmd run obs:up
npm.cmd run obs:smoke
```

Grafana — http://localhost:3001, Prometheus — 9090, Loki — 3100, Tempo — 3200,
Phoenix — 6006, OTLP — 4317/4318. Логи и трейсы хранятся 72 часа в SeaweedFS.
Подробности: `docs/OBSERVABILITY.md`.

## 10. Harbor

Harbor — registry для образов, а не среда запуска сервисов. Проверка условий:

```powershell
npm.cmd run harbor:check
```

Шаблон конфигурации и установка из WSL2/Git Bash: `infra/harbor/README.md`.
Требуется ≥ 40 ГБ свободного диска, ≥ 4 ГБ RAM и свободный порт 8088.

## 11. Очистка Docker и память

```powershell
npm.cmd run docker:gc:dry
npm.cmd run docker:gc
```

Скрипт оставляет два последних тега на репозиторий, удаляет dangling-образы,
остановленные песочницы и build cache старше 72 часов. Образы, занятые
контейнерами, не удаляются.

### Память

На машине могут одновременно работать пять стеков: приложение, Keycloak,
Multica, observability и k3d. У каждого сервиса в compose задан `mem_limit`,
`cpus` и `pids_limit`, логи ограничены 10 МБ × 3 файла.

```powershell
npm.cmd run docker:mem          # потребление, лимиты, запас
npm.cmd run docker:mem:check    # код 1 при контейнере без лимита или переподписке
```

Сумма лимитов по стекам:

| Стек | Сумма `mem_limit` |
|---|---|
| Приложение (`infra/docker-compose.yml`) | 1,25 ГБ |
| Keycloak | 1,25 ГБ |
| Multica | 1,25 ГБ |
| Observability | 4,0 ГБ |
| **Все четыре сразу** | **7,75 ГБ** |

### Лимит WSL2

На Windows Docker Desktop работает внутри WSL2. Лимит виртуальной машины
задаётся в `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
memory=8GB
processors=4
swap=4GB
```

**Правило:** `memory` не меньше суммы `mem_limit` одновременно работающих
стеков плюс запас ≈1 ГБ на Docker Desktop и ≈2 ГБ на k3d, если он нужен.

Слишком малое значение останавливает Docker: демон стартует, но контейнеры
падают по OOM. Это уже наблюдалось на практике — лимиты пришлось поднимать
обратно. Поэтому порядок такой:

1. Остановите ненужные стеки (`npm run obs:down`, `npm run infra:down`).
2. Измените `.wslconfig`.
3. `wsl --shutdown`, затем запустите Docker Desktop.
4. `docker info` — демон отвечает.
5. `npm.cmd run docker:mem:check` — код 0.

Если `docker:mem:check` показывает переподписку, поднимите `memory` или
остановите лишний стек. Не уменьшайте `mem_limit` ниже реальной потребности:
контейнер будет убит по OOM.

Признак нехватки памяти: `docker ps` и `docker stats` отвечают дольше минуты
или возвращают `500 Internal Server Error`. В этом случае сначала освободите
память, а не перезапускайте демон.

## 12. Чего пока нет

- Серверного режима с изоляцией процессов и файловой системы по пользователю.
- Подписи установщиков и автообновления.
- Проверенного продакшен-профиля Keycloak, Vault и Kubernetes.
- Автоматического DNS/TLS для домена.
- Двусторонней синхронизации с Multica: только OpenSpec → Multica.
- Готовых образов с DeepSeek Harness/Hermes для docker-режима рантаймов.
- Живого прогона Harbor: на проверочной машине было 19,2 ГБ свободного диска
  вместо рекомендуемых 40 ГБ.
