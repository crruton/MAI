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
  публикация портов, монтирование папки проекта в `/workspace`.
- Kubernetes: `infra/k8s/` (namespace, Postgres, Keycloak, Multica, ingress, PVC),
  `docs/KUBERNETES.md` с локальным k3d/kind и бесплатным облаком.
- `docs/DNS.md`: hosts, локальный домен, A/CNAME, TLS и переезд.
- `docs/OPENSCION.md`: можно ли заменить локальный git и чего это стоит.
- `docs/PRESETS.md`: пресеты DeepSeek Harness, Hermes, JEV.
- `pack:offline`: tar.gz с `node_modules`, Electron и скриптом запуска.
- Ревизор-петля: вторая модель проверяет ответ и возвращает `approve`/`revise`.
- Keycloak переведён на Postgres, добавлен пользователь `letun82@mail.ru`.
- Заполнены память, MCP и плагины базового проекта `mai-code`.

### Changed

- `README.md` и `docs/BACKLOG.md` отражают фактическое состояние, а не планы.
- `package.json`: новые скрипты `pack:offline`, `docs:check`, `multica:*`.

### Fixed

- Упакованное приложение при самоперезапуске больше не теряет первый CLI-аргумент.
- `npm` в PowerShell заменён на `npm.cmd` в инструкциях.

## [0.1.0] — 2026-11-04

### Added

- Десктопный клиент MAI Code: чат, потоковые ответы, история сессий.
- Провайдеры, модели MAI, внешние рантаймы, навыки, MCP, плагины.
- Экспорт схем SVG/PNG/PUML/JSON и агент схем.
- Песочницы проектов, память, роли admin/guest, Keycloak Device Flow + PKCE.
- Установщики electron-builder, TAR с исходниками, инфраструктура Keycloak/VPN.
