# Каталог навыков команды

Актуально на 26.11.2026. Решение — [ADR 0111](adr/0111-katalog-navykov-komandy.md).

Каталог — это навыки, которые команда использует повторно. Он лежит в этом репозитории:
индекс `mai-marketplace.json` в корне, пакеты — в `catalog/`.

## Подключить

«Подключения ▾» → «Пакеты и плагины» (`/packages`) → «Каталоги» → адрес
`https://github.com/crruton/MAI.git` → «Добавить». У навыка в каталоге — «Установить»,
у новой версии — «Обновить». Добавлять каталог и ставить пакеты может только admin (ADR 0042).

## Что в каталоге

| Навык | Для чего | Источник |
|---|---|---|
| `architecture` | ADR: выбор технологии, фиксация решения | команда |
| `code-review` | ревью: безопасность, производительность, корректность | команда |
| `debug` | воспроизвести, локализовать, исправить | команда |
| `diagnosing-bugs` | диагностика трудных багов и регрессий производительности | mattpocock/skills, MIT |
| `documentation` | техническая документация | команда |
| `grilling` | допрос по плану или решению до общего понимания | mattpocock/skills, MIT |
| `incident-response` | разбор инцидента и postmortem | команда |
| `ponytail` | минимальное изменение кода без лишних абстракций | DietrichGebert/ponytail, MIT |
| `ponytail-review` | ревью на лишний код и переусложнение | DietrichGebert/ponytail, MIT |
| `release-notes` | заметки к релизу | команда |
| `standup` | сводка по недавней активности | команда |
| `stop-slop` | чистка текста от шаблонов AI-письма | hardikpandya/stop-slop, MIT |
| `system-design` | проектирование систем и сервисов | команда |
| `tdd` | разработка через тесты | mattpocock/skills, MIT |
| `tech-debt` | поиск и приоритизация техдолга | команда |
| `testing-strategy` | стратегия и план тестирования | команда |
| `to-mr` | доведение ветки до GitLab MR с доказательствами и Draft-статусом | команда |
| `ub-mode` | дисциплина TDD и чистого кода по Uncle Bob | unclebob/ub-mode, MIT |

## Добавить или изменить навык

1. Папка `catalog/<имя>/` с `mai-package.json`:

   ```json
   { "name": "<имя>", "version": "1.0.0", "description": "Одна фраза", "owner": "<github-логин>", "license": "MIT" }
   ```

2. Навык `catalog/<имя>/skills/<имя>/SKILL.md`. Во frontmatter: `name`, `description`,
   `version` (как в манифесте), `owner`. Справки и скрипты — рядом (ADR 0043).
3. Чужой навык — с `LICENSE` и `UPSTREAM.md`: репозиторий, путь, коммит, наши правки.
4. Запись в `mai-marketplace.json`: `name`, `version`, `description`, `source: "catalog/<имя>"`.
5. При изменении навыка поднимите версию в трёх местах: frontmatter, манифест, индекс.
6. Проверка:

   ```powershell
   node scripts/test-catalog.mjs
   ```

## Отдать навыки в Multica MAI

Панель «Multica» → **Навыки → Multica**: MAI покажет план и спросит подтверждение. Из
терминала:

```powershell
npm.cmd run multica:skills -- --dry-run
npm.cmd run multica:skills
npm.cmd run multica:skills -- grilling tdd
```

Навыки попадают в workspace проекта ([MULTICA.md](MULTICA.md)). Повторный запуск меняет
только навыки с новой версией или правкой. Навык с тем же именем, созданный в Multica
вручную, не перезаписывается. `--prune` удаляет из Multica навыки каталога, которых
больше нет в каталоге ([ADR 0113](adr/0113-navyki-kataloga-v-multica.md)).

## Экспорт в Claude Code, OpenCode и Codex

```powershell
npm.cmd run skills:export -- --target claude --dry-run
npm.cmd run skills:export -- --target claude,opencode,codex
npm.cmd run skills:export -- --target claude --project C:workapp grilling tdd
```

Без `--project` навыки идут в папку пользователя (`~/.claude/skills`,
`~/.config/opencode/skills`, `~/.codex/skills`), с ним — в папку проекта. В каждой папке
навыка — метка `.mai-catalog.json`; папку без метки экспорт не трогает. Повтор меняет только
новые версии, `--prune` удаляет навыки, которых больше нет в каталоге
([ADR 0114](adr/0114-eksport-navykov-v-drugie-agenty.md)).

## Что не попадает в каталог

Репозиторий публичный. Проверка не пропускает токены, приватные ключи, хосты из
`catalog/catalog-policy.json` и email вне списка разрешённых. Навыки с данными людей,
внутренними адресами и своими трекерами храните в приватном каталоге того же формата и
подключайте его так же, по адресу репозитория.

## Ограничения

- Правка навыка в папке другого агента перезапишется при экспорте новой версии: править нужно в каталоге.
- Наборов по ролям пока нет (E1.7): навыки ставятся по одному.
