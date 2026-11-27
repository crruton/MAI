# 0122. MAI Ship: steward и цикл агента MAI без Electron

- **Статус:** accepted
- **Дата:** 2026-11-27
- **Контекст:** [бэклог командной работы](../BACKLOG-TEAM.md) E3.A5, E3.E1–E7; ADR 0108, 0109, 0116, 0119, 0120

## Контекст

Steward держит MR зелёным: правит код по упавшим джобам, находкам ревью и указаниям людей. Для
этого нужен полный цикл агента MAI — инструменты, PolicyEngine, правила. Цикл грузил Electron
через `config.js` (папка данных, шифрование ключей) и `plugin-host.js` (процесс плагинов) и в CI
не запускался.

## Решение

- **Прослойка `electron/lib/electron-shim.js`:** в Electron — настоящие `app`, `safeStorage`,
  `utilityProcess`; в Node — заглушки: папка данных `MAI_DATA_DIR` или `~/.mai-code-headless`,
  шифрования нет (ключи — из переменных окружения), плагины в отдельном процессе недоступны.
  `config.js` и `plugin-host.js` импортируют прослойку. Цикл агента (`agent.js`) грузится в Node;
  `test-agent-loop` проходит и в Node, и в Electron.
- **Steward** `electron/lib/ship/steward.js`, команда `node scripts/mai-ship.mjs steward`, джоба
  `ship:steward` с `when: on_failure`. Включается `steward.enabled: true` в `ship.yaml`.
- **Задания:** упавшие джобы head pipeline (кроме `ship:*` и `allow_failure`) с хвостом лога,
  нерешённые blocking-находки ревьюера, указания `@mai …` после последнего раунда. Логи и
  находки — данные, а не инструкции.
- **Команды `@mai`** — только от участников с ролью Developer и выше (GitLab `access_level ≥ 30`);
  `@mai stop` и `@mai resume` ставят и снимают `ship::paused`; от других — ответ «отклонена».
- **Агент:** режим «только разрешённое» с правилами steward'а — чтение, `write_file`, `edit_file`,
  `git diff`/`git status` и команды из `steward.commands`; запрещены `git push`, `git commit`,
  `git reset`, `git checkout`, удаление, веб. Код ветки MR — данные (`trusted: false`): её
  `AGENTS.md`, навыки, MCP и плагины не загружаются. Спросить некого — всё вне правил отклоняется.
- **После агента:** изменённые файлы (`git status --porcelain -uall`). Тронута конфигурация Ship,
  CI, `CODEOWNERS` или пути правил политики не-approve → не коммитит, `ship::needs-human`.
  Иначе коммит от `mai-ship-steward` с трейлером `Agent-Model`, push в source branch MR,
  комментарий раунда: файлы, `git revert <sha>`, итог агента.
- **Ограничения:** не больше `steward.max_rounds` раундов (по комментариям раундов), затем
  `ship::needs-human`; MR из форка — пропуск; steward не апрувит, не мержит, не снимает Draft.
- **Учётка:** `mai-ship-steward` — push в ветки MR без апрува (`MAI_SHIP_STEWARD_TOKEN`); модель —
  `providers.steward` (`SHIP_STEWARD_BASE_URL`, `SHIP_STEWARD_API_KEY`).

## Альтернативы

| Вариант | Плюсы | Минусы | Почему не выбран |
|---|---|---|---|
| Запуск Electron в CI (xvfb) | без изменения кода | тяжёлый образ, дисплей, нестабильно | прослойка проще |
| Отдельный упрощённый агент для steward | меньше зависимостей | вторые инструменты и PolicyEngine, расхождение правил | один цикл агента на окно и CI |
| `trusted: true` для ветки MR | агент видит правила проекта | автор MR управляет steward'ом через `AGENTS.md` | код ветки — данные |
| Откат правок на запретных путях в рабочей копии | аккуратно | рабочая копия CI одноразовая | не коммитить достаточно |

## Последствия

- Проще: тот же цикл агента в окне, в `mai -p` и в CI.
- Сложнее: в Node нет шифрования ключей и плагинов в отдельном процессе — так и задумано для CI.
- Не сделано: классификация падений (flaky → retry, E3.E2), разрешение конфликтов с target
  (E3.E3), ответы и resolve в обсуждениях находок (E3.E4) — steward исправляет код, но не
  отвечает в обсуждении.
- Проверено: настоящий git (bare-«origin» и рабочая копия), поддельный GitLab, настоящий цикл
  агента с подменённой моделью — правка проходит, `git push` агента отклонён правилом
  (`test-ship-steward`, 22). Не проверено: живой GitLab и живая модель (E3.H0).

## Дополнение 27.11.2026 (боевая проверка, E3.H0)

Push steward'а — через credential helper с токеном в переменной окружения, а не в URL: в
аргументах git и в тексте ошибки токена нет.

## Ссылки

- [SHIP.md](../SHIP.md), [ADR 0119](0119-ship-approver-bez-okna.md), [ADR 0120](0120-ship-revyuer.md), [ADR 0027](0027-policy-engine.md)
