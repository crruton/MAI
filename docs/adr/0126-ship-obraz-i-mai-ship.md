# 0126. MAI Ship: `mai ship <роль>` и Docker-образ

- **Статус:** accepted
- **Дата:** 2026-11-27
- **Контекст:** [бэклог командной работы](../BACKLOG-TEAM.md) E3.A5; ADR 0077 (`mai` без окна), 0108 (MAI Ship), 0122 (цикл агента без Electron)

## Контекст

Джобы MAI Ship на каждом запуске ставили git, клонировали MAI и выполняли `npm ci` — минута и
сеть на каждый MR. Запустить роль вручную можно было только `node scripts/mai-ship.mjs` с
`--project` и номером MR, а `mai` запускал Electron.

## Решение

- **`mai ship <review|approve|steward|report>`** — лаунчер `bin/mai.mjs` передаёт аргументы в
  `scripts/mai-ship.mjs` тем же Node, без Electron. `mai ship --help` — справка.
- **`--mr <ссылка>`** — `parseMrUrl`: адрес GitLab, путь проекта (с подгруппами) и номер берутся
  из ссылки. Явные `GITLAB_URL`, `CI_SERVER_URL` и `--project` главнее. GitLab в подпапке по ссылке
  не различим — для него задают `GITLAB_URL` и `--project`.
- **Образ** — `ci/ship.Dockerfile`: `node:24-slim` (аргумент `NODE_IMAGE` — для зеркала или
  прокси-кэша Harbor), git и сертификаты, зависимости `npm ci --omit=dev` без Electron и без
  mermaid (схемы окна), код `electron/`, `bin/`, `scripts/mai-ship.mjs`, команда `mai`
  (обёртка `exec node`, не зависит от CRLF в shebang). ENTRYPOINT не задан — GitLab запускает
  свою оболочку. Контекст — `ci/ship.Dockerfile.dockerignore`.
- **CI-шаблон** — `image: $MAI_SHIP_IMAGE` (по умолчанию `node:24-slim`). Если в образе есть
  `/opt/mai`, джоба не клонирует MAI; иначе — прежний клон по `MAI_SHIP_REF`.
- **Публикация** — workflow `ship-image`: сборка и проверка образа на push в `dev` и `main`,
  публикация в `ghcr.io/<владелец>/mai-ship` (`main`, `sha-<12 знаков>`) — только из `main`.
  Harbor команды — копия из GHCR (`docker pull` → `docker tag` → `docker push`) или сборка в своём
  CI; адрес Harbor в этот публичный репозиторий не пишется.

## Альтернативы

| Вариант | Плюсы | Минусы | Почему не выбран |
|---|---|---|---|
| Подкоманда в `electron/lib/cli.js` | один разборщик флагов | CLI живёт в главном процессе Electron | роли Ship работают без Electron (ADR 0122) |
| Пакет npm `mai-ship` | `npx mai-ship` | отдельная публикация и версия | образ проще для CI |
| Публиковать сразу в Harbor | одно место | адрес и учётка Harbor в публичном репозитории | GHCR бесплатен для публичного репозитория |

## Последствия

- Проще: джоба с образом стартует без клона и `npm ci`; роль вручную — `mai ship review --mr <ссылка>`.
- Сложнее: образ надо обновлять (тег `sha-…` закрепляет версию, `main` — плавающий).
- Образ 709 МБ (база `node:24-slim`, git, зависимости). Можно уменьшить: отдельный список
  зависимостей ролей или многоступенчатая сборка.
- Проверено: тест `test-ship-cli` (15); локальная сборка образа (база с зеркала: Docker Hub из этой
  сети не отвечал), в контейнере — `mai ship --help`, импорт модулей ролей и цикла агента, approver
  `--dry-run --mr <ссылка>` против живого GitLab 17.3. Не проверено: workflow `ship-image` на
  GitHub и джобы с образом на GitLab с раннерами (E3.H0a).

## Ссылки

- [SHIP.md](../SHIP.md), [ADR 0077](0077-bezgolovyj-rezhim-cli.md), [ADR 0122](0122-ship-steward-i-agent-bez-electron.md)
