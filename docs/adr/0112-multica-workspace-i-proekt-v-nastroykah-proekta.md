# 0112. Workspace и проект Multica — в настройках проекта

- **Статус:** accepted
- **Дата:** 2026-11-26
- **Контекст:** [бэклог командной работы](../BACKLOG-TEAM.md) E2.3, OpenSpec → Multica (ADR 0003, 0089), уровни настроек (ADR 0038), доверие к папке (ADR 0028)

## Контекст

Синхронизация OpenSpec → Multica шла в workspace по умолчанию профиля CLI. Поле
`workspaceId` в настройках MAI было, но в CLI не передавалось. Проекта Multica не было
вовсе. Команда, где у каждого свой workspace по умолчанию, раскладывала задачи одного
репозитория по разным workspace.

## Решение

- Цель синхронизации — пара `workspaceId` и `projectId`. Порядок, первое непустое значение
  по каждому ключу:
  1. `.mai-code/settings.local.json` → `multica` — личное, не для git;
  2. `.mai-code/settings.json` → `multica` — общее для команды, в git;
  3. настройки MAI → `multica.workspaceId` — как раньше.
- Файлы проекта читаются только в доверенной папке (ADR 0028).
- `workspaceId` передаётся глобальным флагом `--workspace-id` в каждом вызове CLI. Workspace
  по умолчанию профиля (`multica workspace switch`) не меняется. `projectId` уходит в
  `issue list --project` и `issue create --project`.
- Идентификатор — UUID или slug: латиница, цифры, `-` и `_`, первый символ не `-`. Иначе —
  ошибка, а не аргумент CLI: значение из чужого `settings.json` не станет флагом.
- Панель «Multica» показывает workspace и проекты из CLI (`workspace list`, `project list`)
  и пишет выбор в файл проекта. Запись — только admin и только в доверенную папку. При
  записи в `settings.local.json` файл добавляется в `.mai-code/.gitignore`.
- Модуль `electron/lib/multica-target.js` без Electron и CLI; IPC `multica:target`,
  `multica:workspaces`, `multica:projects` (ANY) и `multica:setTarget` (ADMIN).

## Альтернативы

| Вариант | Плюсы | Минусы | Почему не выбран |
|---|---|---|---|
| `multica workspace switch` перед синхронизацией | ничего не передавать | меняет профиль CLI для всех процессов и daemon | побочный эффект на чужую работу |
| Только личные настройки MAI | уже есть поле | у каждого участника своё значение | команде нужен один workspace на репозиторий |
| Отдельный файл `.mai-code/multica.json` | изоляция | ещё один файл и свой механизм доверия | уровни `settings.json` уже есть (ADR 0038) |

## Последствия

- Проще: workspace репозитория задаётся один раз и приходит всей команде через git.
- Сложнее: при переезде workspace надо поправить `settings.json` и закоммитить его.
- Не проверено на живом сервере: формат JSON ответов `workspace list` и `project list`.
  Разбор принимает массив или объект со списком; запись без `id` отбрасывается.

## Ссылки

- [MULTICA.md](../MULTICA.md)
- [ADR 0028](0028-doverie-k-papke-i-matrica-ipc.md), [ADR 0038](0038-urovni-nastroek.md), [ADR 0089](0089-statusy-multica-v-openspec.md)
