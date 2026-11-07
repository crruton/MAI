# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).
Версии следуют [Semantic Versioning](https://semver.org/lang/ru/).

Правило проекта: любое изменение поведения, инфраструктуры или публичных
интерфейсов попадает сюда и в `docs/adr/` (см. `AGENTS.md`).

## [Unreleased]

### Added

- Двухрядная верхняя панель: модель и рантайм в первом ряду, панели — во втором.
- Встроенная документация в стиле GitBook: боковое оглавление, TOC страницы,
  поиск по всем markdown-файлам, кнопка «Открыть папку».
- `CHANGELOG.md`, `docs/adr/` и правило ведения ADR/changelog в `AGENTS.md`.
- OpenSpec: `openspec/` с первым изменением, навык `openspec-multica`,
  документация `docs/OPENSPEC.md`.
- Multica: локальный docker-compose, синхронизация задач из OpenSpec через
  официальный CLI, панель «Multica» и документация `docs/MULTICA.md`.
- Docker-песочницы: `electron/lib/container.js`, IPC, панель «Песочницы»,
  публикация портов, монтирование папки проекта в `/workspace`. Проверено на
  Docker 29.9.2: запуск, порт, список, остановка.
- Kubernetes: `infra/k8s/` (namespace, Postgres, Keycloak, Multica, ingress, PVC),
  `docs/KUBERNETES.md` с локальным k3d/kind и бесплатным облаком.
- `docs/DNS.md`: hosts, локальный домен, A/CNAME, TLS и переезд.
- `docs/OPENSCION.md`: можно ли заменить локальный git и чего это стоит.
- `docs/PRESETS.md`: пресеты DeepSeek Harness, Hermes, JEV.
- `pack:offline`: tar.gz с `node_modules`, Electron и скриптом запуска.
- Ревизор-петля: вторая модель проверяет ответ и возвращает `approve`/`revise`.
- Keycloak переведён на Postgres, добавлен пользователь `letun82@mail.ru`.
- Заполнены память, MCP и плагины базового проекта `mai-code`.
- Guardrails: `electron/lib/guardrails.js` — разрушительные команды, pipe-to-shell,
  защита `.env`/ключей/.ssh/.npmrc, лимит длины, пользовательские запреты,
  маскирование секретов. Интеграция в shell, файловые инструменты и деплой.
- Рантаймы: проверка доступности CLI/образа (`runtimes:probe`), включение и
  выключение, docker-режим с образом и `/workspace`, параллельный запуск
  `runtimes:runMany` и пункт «Все включённые (параллельно)».
- OTLP-экспортёр `electron/lib/telemetry.js`: лог запуска, ошибки и спаны
  `runtime.run`; настройка telemetry в UI.
- `infra/observability/`: SeaweedFS S3, Loki 72h, Tempo 72h, Prometheus 72h,
  Grafana, OTel Collector, Phoenix + Postgres; дашборд и smoke-тест.
- Harbor: `infra/harbor/harbor.yml.example`, инструкция и `harbor:check`.
- `scripts/docker-gc.mjs`: очистка старых тегов, dangling-образов, остановленных
  песочниц и build cache; `npm run docker:gc` / `docker:gc:dry`.
- Portable-сборка `dist/MAI Code-0.1.0-portable.exe` (store, 517 МБ), проверен
  запуск; хэш добавлен в `dist/SHA256SUMS.txt`.

### Changed

- Multica CLI: официальная установка, поиск в `%USERPROFILE%\.multica\bin`,
  декодирование UTF-8/cp866/cp1251, кнопка «Установить CLI».
- Документация: `docs/GUARDRAILS.md`, `docs/RUNTIMES.md`,
  `docs/OBSERVABILITY.md`; обновлены `MULTICA.md`, `PRESETS.md`, `SANDBOXES.md`,
  `DEPLOYMENT.md`, `SUMMARY.md` и ADR 0011–0014.
- `README.md` и `docs/BACKLOG.md` отражают фактическое состояние, а не планы.
- `package.json`: новые скрипты `pack:offline`, `docs:check`, `multica:*`.
- `pack:offline`: архив собирается как tar и сжимается gzip level 1. На Windows
  используется `7za` из кеша electron-builder, иначе — `tar` и `zlib` Node.

### Fixed

- Упакованное приложение при самоперезапуске больше не теряет первый CLI-аргумент.
- `npm` в PowerShell заменён на `npm.cmd` в инструкциях.
- Multica CLI больше не считается отсутствующим, если установлен в
  `%USERPROFILE%\.multica\bin`, но PATH ещё не обновился.
- Вывод Multica на Windows больше не превращается в «кракозябры»: буфер
  декодируется как UTF-8, затем cp866/cp1251.
- `multica issue create/update` не ломается на кириллице и переводах строк:
  процесс запускается без `shell: true`.
- Встроенный агент: остальные рантаймы теперь можно включить, а несколько —
  запустить параллельно; выключенные не выбираются.
- Kubernetes: `DATABASE_URL` в Multica собирался с пустым паролем, потому что
  `$(MULTICA_DB_PASSWORD)` раскрывается только для ранее объявленных переменных.
  Переменная перенесена выше `DATABASE_URL`; живой прогон подтвердил `/healthz`.
- Kubernetes: readiness-пробы Postgres/Keycloak/Multica получили
  `timeoutSeconds`, иначе поды мигали `0/1` под нагрузкой.
- Observability: `minio/mc` больше не доступен (Docker Hub 404, quay 401);
  бакеты создаются через `weed shell` из образа SeaweedFS.
- Observability: порты SeaweedFS сдвинуты на `18333/18888/19333`, чтобы не
  конфликтовать с основным SeaweedFS приложения.

## [0.1.0] — 2026-11-04

### Added

- Десктопный клиент MAI Code: чат, потоковые ответы, история сессий.
- Провайдеры, модели MAI, внешние рантаймы, навыки, MCP, плагины.
- Экспорт схем SVG/PNG/PUML/JSON и агент схем.
- Песочницы проектов, память, роли admin/guest, Keycloak Device Flow + PKCE.
- Установщики electron-builder, TAR с исходниками, инфраструктура Keycloak/VPN.
