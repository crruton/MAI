# Архитектура

## Процессы

```
┌─────────────────────────────── Electron ───────────────────────────────┐
│                                                                        │
│  main (Node)                              renderer (Chromium)          │
│  ├─ окно, меню, диалоги                   ├─ index.html                │
│  ├─ IPC-обработчики                       ├─ app.js  (UI + состояние)  │
│  ├─ агентный цикл (lib/agent.js)          ├─ markdown.js (рендер)      │
│  ├─ инструменты (lib/tools/*)             └─ styles.css                │
│  ├─ MCP-клиенты (lib/mcp.js)                                           │
│  └─ настройки, сессии, навыки, плагины                                 │
│                          ▲                                             │
│                          │ preload.cjs → window.mai (contextBridge)    │
└──────────────────────────┼─────────────────────────────────────────────┘
                           │
                    api-ai.mai.ru/v1
```

Контекст изолирован (`contextIsolation: true`, `nodeIntegration: false`), рендерер общается
с Node только через `preload.cjs`.

## Файлы

| Файл | Ответственность |
|---|---|
| `electron/main.js` | окно, все IPC-каналы, запуск агента, подтверждения |
| `electron/preload.cjs` | мост `window.mai`, список каналов |
| `electron/lib/config.js` | настройки, ключ, каталог данных |
| `electron/lib/models.js` | `GET /v1/models`, фильтр чат-моделей, кэш 5 мин |
| `electron/lib/sessions.js`, `session-store.js` | `sessions/<id>.json`, `sessions/index.json` (ADR 0034) |
| `electron/lib/agent.js` | цикл агента, стриминг, вызов инструментов |
| `electron/lib/skills.js` | навыки, `AGENTS.md` |
| `electron/lib/mcp.js` | MCP-менеджер (stdio, streamable HTTP, SSE; инструменты, ресурсы, промпты) |
| `electron/lib/plugins.js` | загрузка локальных плагинов |
| `electron/lib/tools/fs.js` | чтение, поиск, запись, правка файлов |
| `electron/lib/tools/shell.js` | `run_shell` |
| `electron/lib/tools/skills.js` | `load_skill` |
| `electron/lib/tools/memory.js` | `memory_read`, `memory_append` |
| `electron/lib/memory.js` | версии памяти и откат |
| `electron/lib/attachments.js` | вложения: копирование, разбор DOCX/XLSX/PPTX/PDF/ZIP, манифест |
| `electron/lib/ocr.js` | OCR: четыре движка за одним интерфейсом (WinRT, Vision, tesseract, шлюз MAI) |
| `electron/lib/permissions.js` | режимы разрешений: вручную, принимать правки, план, только разрешённое, без вопросов |
| `electron/lib/policy.js`, `tool-runner.js` | PolicyEngine: решение о каждом вызове инструмента (ADR 0027) |
| `renderer/app.js` | состояние UI, события, модальные окна |
| `renderer/markdown.js` | безопасный минимальный Markdown |

## Цикл агента

1. На каждой итерации заново читаются режим и правила, собираются инструменты
   (в «Плане» — только класс `read`) и системный промпт: базовые правила, режим,
   `AGENTS.md`/`AGENTS.local.md` с импортами и память (только доверенная папка),
   навыки, статус MCP.
2. Сообщения из очереди пользователя встают в историю; при 80% контекста ранняя
   часть сжимается в сводку (ADR 0032). Модели уходит `activeHistory` —
   сводка и сообщения после неё; `trimMessages` — страховка.
3. Запрос в `chat/completions` (`stream: true`, `stream_options.include_usage`)
   или в Responses API (ADR 0026); изображения — частями `image_url`.
4. Дельты уходят в рендерер событиями `delta` / `reasoning`; `tool_calls` собираются по индексу;
   `usage` и `context` — после ответа.
5. Если инструментов нет — хук `Stop` и ревизор могут вернуть агента к работе;
   иначе `done`.
6. Если есть — каждый вызов идёт через `runToolCall`: precheck → PolicyEngine →
   хук `PreToolUse` → подтверждение → выполнение → `PostToolUse`. Субагенты
   только для чтения — параллельно, остальное по очереди. История сохраняется
   после каждого вызова; цикл повторяется до `maxIterations` (30).

## События в рендерер

`chat:event` с полем `type`:

| type | Когда |
|---|---|
| `delta` | кусок текста ответа |
| `reasoning` | кусок размышлений |
| `assistant` | собранное сообщение ассистента (с `tool_calls`) |
| `tool_call` | инструмент вызван, ещё не выполнен |
| `tool_result` | результат инструмента (`ok: true/false`) |
| `approval` | нужно подтверждение (`id`, `name`, `summary`) |
| `done` | цикл завершён, приходит финальная история |
| `error` | ошибка или остановка |
| `saved` | сессия сохранена |

## Подтверждения

`write_file`, `edit_file`, `run_shell` вызывают `ctx.approve(name, summary)`. Это Promise:
main кладёт резолвер в `state.approvals` и отправляет событие `approval`; рендерер показывает
модальное окно и отвечает `chat:approval` с `allow`. Отклонение возвращает инструменту строку
«Пользователь отклонил…», и агент продолжает работу.

## Изоляция путей

`resolveInside(ctx, target)` в `tools/fs.js`:

- абсолютный или относительный путь разрешается от корня проекта;
- если `allowOutsideProject` выключен и путь выходит за корень — ошибка;
- проверка через `path.relative`, а не по префиксу строки.

## MCP

`McpManager` держит по клиенту на сервер. Имена инструментов нормализуются в
`mcp__<server>__<tool>`, чтобы не конфликтовать с встроенными. При вызове имя разбирается
обратно, ищется сервер и оригинальное имя инструмента.

Ресурсы и промпты (ADR 0071): `listResources`/`readResource`, `listPrompts`/
`getPrompt`. Локальные коннекторы (ADR 0072): `local-connectors.js` →
`connectors:local` (проверки repowise/multica/infra с пределом 8 с),
`connectors:localToggle`; окно «Хранилища» принимает `focus: 'tab:…'`.
`chat:start` → `resolveResourceMentions` (commands.js) → текст
ресурса в рамке `wrapData`; `commands:list` добавляет промпты (`source: 'mcp'`),
`commands:expand` → `promptArgs` → `getPrompt`. IPC `mcp:resources` — для
подсказки `@`. Транспорт — `declaredTransport(config)` (`transport` или `type`),
без указания — streamable HTTP с переходом на SSE, если `initialize` упал не
из-за входа.

OAuth (ADR 0041): `new McpManager({ oauth: { store, openBrowser, callbackPort } })`.
`connect()` передаёт HTTP-транспорту `authProvider` без `onAuthorize` — при 401
статус `needs_auth`, браузер не открывается. `login(name, config)` поднимает
`startCallbackServer` (127.0.0.1, проверка `state`), провайдер с `onAuthorize`
открывает браузер, после кода — `transport.finishAuth(code)` и новый `connect()`.
Хранилище — `createOAuthStore(<данные>/mcp-oauth.json, secretBox)`. IPC:
`mcp:login`, `mcp:logout` (admin); `mcp:status` отдаёт `loggedIn`.

Каталог (ADR 0052): `listConnectors({ managed, onlyManaged })`,
`connectorServerConfig(connector, { token })` в `electron/lib/connectors.js`;
IPC `connectors:list` (any), `connectors:add | remove` (admin; для OAuth — сразу
`mcp.login`). Секреты `mcpServers.*.headers.*`, `mcpServers.*.env.*` — в
`SECRET_PATHS`; `publicSettings` маскирует их, `saveSettings` восстанавливает `***`.

Области (CC9.5): `mcpSources(dir)` в main собирает `global → package → project →
local` (`.mai-code/mcp.local.json`, только доверенная папка) с полем `scope`;
`mcpConfigs` — их слияние. IPC `mcp:scopes`, `mcp:saveLocal` (через
`updateLocalMcp` из `settings-levels.js`), `mcp:remove(name, projectDir)` удаляет и
локальную запись.

## Плагины

Плагины исполняются в отдельном процессе (ADR 0030). `loadPlugins(projectDir)`
собирает `*.js` из `<проект>/.mai-code/plugins` (только для доверенной папки,
ADR 0028) и `%APPDATA%/mai-code/plugins` и передаёт их хосту
`electron/plugin-host/worker.mjs`, запущенному через `utilityProcess.fork`.
main получает манифест и обёртки: `tools[].run` и `transforms[]` отправляют
сообщение хосту и ждут ответ с таймаутом (загрузка 15 с, вызов 120 с, хук 10 с).

Плагин может вернуть:

- `tools: [{ schema, run, kind }]` — `kind` задаёт класс действия для PolicyEngine;
- `transformMessages(messages)` — хук перед каждым запросом, может быть async.

Хост переиспользуется, пока не изменились файлы; изменились — запускается новый,
старый останавливается после текущих вызовов. Зависший хост убивается по
таймауту, упавший пересоздаётся при следующей загрузке. Ошибка плагина не ломает
диалог: она попадает в список загруженных с полем `error`.

Окружение хоста — копия окружения без переменных с `KEY`, `TOKEN`, `SECRET`,
`PASSW`, `AUTH` и подобными. Модель разрешений Node (`--permission`) в
`utilityProcess` Electron 38 не включалась (на Electron 45 не перепроверено, ADR 0104),
поэтому считаем, что файловая система и процессы доступны плагину с правами пользователя.

Окна (A2.5): `sandbox: true`, CSP `script-src 'self'` без inline и eval.
Буфер обмена — через `app:clipboard`, модуля `clipboard` в песочнице нет.

## Режимы разрешений

Решение о вызове инструмента принимает PolicyEngine (ADR 0027, первая версия —
ADR 0017). Инструменты сами `approve` не вызывают: цикл агента вызывает
`runToolCall` (`electron/lib/tool-runner.js`) для любого источника —
встроенного инструмента, MCP или плагина.

Режим хранится **в сессии** (`session.permissionMode`), `settings.permissionMode` —
значение по умолчанию. Сохранённое `auto` читается как `bypass`. Решение
классификатора режима `smart` помечается `source: 'classifier'` и уходит в
карточку как `decisionSource`; для внешних CLI `permissionPlan` читает `smart`
как `acceptEdits`.

| Режим | read | write | memory | exec | external (MCP, плагин) |
|---|---|---|---|---|---|
| `manual` | да | спросить | спросить | спросить | спросить |
| `acceptEdits` | да | да | спросить | спросить | спросить |
| `smart` («Авто», ADR 0039) | да | `classifyAuto`: в проекте — да | да | `classifyAuto`: без высокого риска и путей вне проекта — да | спросить |
| `plan` | да | запрет | запрет | запрет | запрет |
| `dontAsk` | да | запрет | запрет | запрет | запрет |
| `bypass` | да | да | да | да | да |

Prompt injection (ADR 0053): `toApiMessage` оборачивает результаты
`isDataTool` в `wrapData`; после такого шага `detectInjection` ставит `taint`
прогона (`policyCtx.getTaint`), и `runToolCall` превращает `allow` классификатора
в `ask` с `source: 'injection'` для всех классов, кроме `read`.

Класс `send` (ADR 0048) — MCP-инструмент с глаголом отправки в имени
(`isSendTool`) или плагин с `kind: 'send'`: спросить во всех режимах, включая
`bypass`; `dontAsk` и `plan` — запрет; без вопроса — только явное `allow`.
`suggestRules` для него пуст; карточка показывает аргументы блоком
«Будет отправлено».

Класс `delete` (`delete_file`, ADR 0044) — вне таблицы: спросить во всех режимах,
кроме `bypass` (разрешено), `plan` и `dontAsk` (запрет без правила `allow`).
Корзина — `electron/lib/trash.js` (`moveToTrash`, `listTrash`, `restoreFromTrash`,
`purgeTrash`), путь передаётся инструменту как `ctx.trashDir` из `agentSettings`;
IPC `trash:list` (any), `trash:restore` (замена — admin), `trash:purge` (admin).

Порядок проверки: guardrails → `deny` → «План» → `ask` → чтение → `allow` → режим.
Правила: `settings.permissions` и `session.permissionRules`, синтаксис
`инструмент(маска)`. MCP-инструмент — `read` только при `readOnlyHint`.

`policyFor(sessionId)` в `main.js` читает режим и правила на каждый вызов,
поэтому переключение действует сразу, в том числе на список инструментов
следующей итерации. Роль `guest` не может включить `bypass`: `permissions:set`
отказывает, `effectiveMode` понижает режим до `manual`.

В режиме `plan` модели передаются только инструменты класса `read`.

IPC-каналы:

- `permissions:modes(sessionId)` — `current`, `fallback`, `role`, список режимов
  с флагом `disabled`, правила чата и глобальные;
- `permissions:set({ mode, sessionId })` — пишет в сессию, без `sessionId` — в настройки;
- `permissions:rules({ sessionId, scope, kind, add, remove })` — правила чата или
  глобальные (глобальные — только admin);
- `permissions:audit({ limit })` — последние записи `audit.jsonl`, только admin;
- `chat:approval({ id, allow, remember, rules, feedback })` — ответ на запрос.

## Ключи и диалоговые инструменты

Секреты в `settings.json` (`providers.*.apiKey`, `infra.vaultToken`,
`mas.token`) хранятся как `enc:v1:<base64>` через `safeStorage`
(`electron/lib/secrets.js`, ADR 0031). `loadSettings` расшифровывает,
`saveSettings` шифрует и пишет атомарно, `migrateSecrets` при старте шифрует
старые открытые ключи. `publicSettings` отдаёт `secretsProtection`
(`os` / `weak` / `none`) и список нерасшифрованных путей.

`ask_user` и `exit_plan` (`electron/lib/tools/interactive.js`) зовут
`ctx.ask`: `makeAsker` в main шлёт окну событие `question`, ответ приходит
через `chat:answer({ id, answer })`. Одобрение плана меняет режим сессии
(`setSessionMode`) и шлёт `mode:changed`. Таймаут — 10 минут, «Стоп»
отвечает `cancelled`.

### Подтверждение в ленте и diff

`runToolCall` вызывает `preview(ctx, args)` у инструментов записи и строит
unified diff (`electron/lib/diff.js`: LCS по строкам, общие начало и конец
отсекаются, не больше 400 строк). Diff уходит в запрос разрешения (`approval.diff`)
и в результат (`tool_result.diff`, в истории — до 120 строк). Окно показывает
запрос карточкой в ленте (`state.approval`), карточки инструментов — с
заголовком по смыслу (`toolTitle`).

### Очередь, живой вывод, задачи

- Очередь (CC7.5): `chat:queue({ text })` кладёт сообщение в `state.queue`
  окна, `runAgent({ pullQueued })` забирает очередь перед каждой итерацией
  после первой и перед завершением ответа — сообщение встаёт после результатов
  инструментов и продлевает прогон. События `queued:consumed`,
  `queued:returned` (не взятые возвращаются в поле ввода). `chat:unqueue({ id })`
  убирает сообщение, пока его не взял агент.
- Живой вывод (CC7.4): `execute(command, cwd, { onData, signal })`, событие
  `tool_progress`; abort останавливает процесс с дочерними.
- Задачи (CC1.5): `todo_write` (класс `read`) заменяет список целиком,
  событие `todos`; окно восстанавливает список из последнего вызова в истории.

### Слэш-команды и @файл

`electron/lib/commands.js`: встроенные команды выполняет окно (`runSlash` в
`app.js`), свои команды и навыки разворачивает main —
`commands:list(projectDir)`, `commands:expand({ projectDir, name, args })`.
Команды проекта читаются только в доверенной папке (ADR 0028); встроенные имена
не переопределяются. `files:search({ projectDir, query })` ищет по списку
файлов проекта (без `node_modules`, `.git`, сборок; кэш 30 с, до 20 000
файлов). `chat:start` находит в тексте `@путь`, проверяет, что путь внутри
проекта, и дописывает ссылку «прочитай через read_file».

### Контекст и компакция

ADR 0032. `runAgent({ contextWindow })` перед каждым шагом считает занятость
(`contextBreakdown`: usage провайдера + оценка) и шлёт событие `context`. С 80%
окна вызывает `compactHistory` — сводка моделью, маркер `role: 'compaction'` в
истории. Запрос строится из `activeHistory(history)`: сводка и сообщения после
последнего маркера. IPC: `chat:compact({ sessionId, instructions })`,
`context:stats({ sessionId, projectDir, model })`.

### Чекпоинты и откат

ADR 0033. `runAgent({ checkpoint })` получает регистратор `createRecorder`;
`write_file`/`edit_file` зовут `ctx.beforeWrite(file)` до записи. IPC:
`checkpoints:turns(sessionId)`, `checkpoints:plan({ sessionId, turn })`,
`checkpoints:rewind({ sessionId, turn, mode: 'both' | 'code' | 'conversation' })`.

### Чаты и инструкции проекта

ADR 0034: `session-store.js` — `sessions/<id>.json` и `sessions/index.json`,
`sessions:list({ projectDir, query })`. ADR 0074: `shell:direct` (`!команда`,
`execute` из tools/shell.js, guardrails, аудит, сообщение `direct: true`),
`git:branch` для статусной строки; тема — `nativeTheme.themeSource` из
`settings.theme`, CSS по `prefers-color-scheme`, `windowColors` в window.js;
`openModal` — dialog, фокус, Esc, Tab. ADR 0073: `renameSession` (`titleManual`
защищён в `saveSession`), `forkSession({ upTo })`, `importSession`,
`expiredSessions(days)` (очистка при запуске); `suggestTitle` в agent.js и
`cleanTitle` в titles.js — автозаголовок после первого ответа. IPC
`sessions:rename`, `sessions:fork`, `sessions:exportFile`, `sessions:importFile`.
`instructions.js`: `projectInstructions`
(AGENTS.md + AGENTS.local.md с `@`-импортами, глубина 3, только внутри проекта)
и `nestedInstructions` — вложенные AGENTS.md дописываются к результату
инструмента с полем `path` один раз за прогон. `memory:append({ scope, text })`
— быстрая запись из поля ввода.

### Хуки

ADR 0035. `createHookRunner` в `hookRunnerFor` (main) на каждый прогон;
`runToolCall({ hooks })` — `PreToolUse` после PolicyEngine и `PostToolUse` после
выполнения; `runAgent({ hooks })` — `Stop` перед завершением и `PreCompact` перед
автокомпакцией; `chat:start` — `UserPromptSubmit` и `SessionStart` до записи
сообщения. IPC `hooks:list(projectDir)`.

### Агент схем

ADR 0086. `diagram-agent.js` — `editDiagram` возвращает `proposal`, `baseHash`
(`modelHash`), `diff`; `applyDiagram` (IPC `boards:diagramApply`) проверяет
отпечаток и модель и пишет `boards.json`. В board.js — `proposalBlock`,
действия `diagram-apply`/`diagram-reject`.

### Автосинхронизация хранилища

ADR 0087. `artifacts.js` — `onArtifactWrite` (слушатели новых версий);
`sync-queue.js` — `createSyncQueue` (debounce, один прогон на проект, повторы
30 с / 2 мин / 10 мин, `flush`, `stop`); `infra.autoSync` — Postgres и SeaweedFS
без Vault. В main.js очередь подписана на запись артефактов при `infra.autoSync`;
IPC `infra:syncStatus` (ANY) и `infra:syncNow` (ADMIN). В board.js —
`autoSyncLine`, опрос `pollSyncStatus` раз в 3 с на вкладке «Инфраструктура».

### Перезапуск зависшего MCP

ADR 0088. `mcp.js` — `entry.config`, `callTimeoutMs`; таймаут вызова у stdio →
`restart(name, reason)` и один повтор для `readOnlyHint`/`retryOnTimeout`;
`checkHealth` — ping; `status()` — `restarts`, `lastRestartAt`, `lastTimeout`.
`repowise.mcpConfig` — 60 с и повтор. IPC `repowise:status` (ping, `mcp`) и
`repowise:restartMcp` (ADMIN). В board.js — `repowiseMcpCard`.

### Статусы Multica → OpenSpec

ADR 0089. `openspec.js` — `parseTaskMarker`, `statusUpdatesFromIssues`,
`applyTaskStatuses` (по id задачи, CRLF, временный файл); `multica.pullStatuses`;
IPC `multica:pullStatuses` (ADMIN); `multica-sync.mjs --pull`. В app.js —
кнопка `.multica-pull` в панели Multica.

### Калибратор

ADR 0090. `calibrator.js` — `buildContext`, `parseReport`, `diffReports`,
`renderMarkdown`, `calibrate`; встроенный субагент `calibrator` в `agent-defs.js`.
В main.js — `gatherCalibration` и IPC `boards:calibrate` (ADMIN) с записью
артефакта `calibration:architecture`. В board.js — вкладка «Калибровка»
(`architectureCalibration`, `runCalibration`).

### Проект в отдельной папке

ADR 0091. Подписи «＋ Новый проект» (меню 📁) и окна «Docker» («Подключения ▾») в `index.html`/`app.js`;
`workspace.js` по-прежнему создаёт проекты в `<данные>/sandboxes/` (совместимость).

### Голосовой ввод

ADR 0092. `voice.js` — `voiceConfig`, `providerVoiceStatus`, `providerTranscribe`;
IPC `voice:status`/`voice:transcribe` выбирают MAS (`mas.js`) или провайдера. В
app.js — `setMicState(kind, message)` с состоянием `error`, `transcribeWav`,
`retryVoice` и кнопкой `#mic-retry` (запись — в `voice.lastWav`).

### Корпоративный вход

ADR 0093. `auth-session.js` (без Electron) — `corporatePolicy`, `tokenState`,
`refreshTokens`, `identityFromToken`, `sessionGate`, `LOGIN_CHANNELS`;
`settings-levels.readManaged` отдаёт `auth`. `auth.js` — роль `none` без сессии,
`sessionGateFor`, `ensureSession` (таймер в main, раз в минуту). `guardIpc` —
опция `sessionGate`, порядок: сессия → роль → схема. В app.js — `showLoginOnly`
до `init`, `watchSession`.

### Метрики агента

ADR 0094. `metrics.js` — `createMetrics` (`fromSpan`, `toOtlp`), `priceOf`,
`METRIC_NAMES`; `telemetry.emitSpan` кормит счётчики, `flushMetrics` — раз в 15 с
и при выходе. Дашборд `infra/observability/grafana/dashboards/mai-code-overview.json`
— строка «Агент».

### Процессы и оболочки

ADR 0096. `proc.js` — `shellFor`, `shellLabel`, `spawnShell` (своя группа на
macOS/Linux), `killTree` (taskkill / сигнал группе + SIGKILL через 3 с). Его
используют `tools/shell.js` (`setShellPreference` из `settings.shell` в
`runAgent`), `hooks.js`, `deploy.js`, `runtimes.js`. Системный промпт — строка
«Система: …; оболочка run_shell: …».

### Главное окно (N9)

ADR 0105. Строка ввода: `#turn-chip` и окно `#turn-pop` (внутри — прежние
`#kind-toggle`, `#mode-select`, `#effort-select`), `renderTurnChip`,
`toggleTurnPop`; `.statusbar` — `#statusline`, `#context-meter`, `#results-btn`.
Шапка: `#runner-chip`/`#runner-pop` (`#model-select`, `#runtime-select`),
`#project-menu`, `#connections-menu` — пункты с `data-panel`; `bindMenus`,
`closeMenus` (одно окно за раз), `renderRunnerChip`, `refreshAttention` (точка
`#settings-dot`). Настройки: метки `.settings-tab-mark` в теле `openSettings`,
`tabifySettings(modal, tab)` раскладывает по `.settings-pane`. Боковая панель:
`#project-btn` открывает `#sidebar-project-menu` (`#project-pick`, `#projects-btn`,
`#new-project-btn`, `#project-trust-item`); `exportChat(anchor)` — «⤓» у строки
чата и скрытая `#export-chat`. Подсказки «/»: `SLASH_GROUPS`, `slashGroup`,
заголовки `.suggest-group` в `renderSuggest`.

### Удаление папок

ADR 0104. `remove-tree.js` — `removeTree(path)`: на Windows снимает «только
чтение» (объекты git), затем `rmSync` с повторами. Все рекурсивные удаления в
приложении идут через него.

### Чистильщик

ADR 0103. `cleaner.js` — `trackVersion`, `isStable`, `planCleanup`, `applyCleanup`,
`formatBytes`. В main — `versionHistory` (`version-history.json`, при старте),
`cleanupPlan`, IPC `cleanup:plan` (ANY) и `cleanup:apply` (ADMIN, план строится
заново). В app.js — `openCleanup`.

### Сканер обновлений

ADR 0102. `update-scan.js` — `bumpKind`, `parseOutdated`, `parseAudit`,
`parseLsProblems`, `skillUpdates`, `toolUpdates`, `scanUpdates`, `scanDue`,
`installArgs`. В main — `runUpdateScan` (отчёт `update-scan.json`),
`scheduleUpdateScan` после старта, IPC `updates:last`/`updates:scan` (ANY) и
`updates:apply` (ADMIN: worktree `mai/update-…`, npm install, тесты). В app.js —
`openUpdates`.

### Встроенные навыки и хуки пакетов

ADR 0101. `skills.js` — `skillVersion`, `compareSkillVersions`,
`installBundledSkills(src, { target })` с обновлением по версии и `.previous/`.
`packages.js` — `expandPackageDir` для `${MAI_PACKAGE_DIR}` в `packageHooks`.
Пример пакета — `examples/packages/impeccable-check`.

### Локальные модели

ADR 0100. `local-models.js` — `LOCAL_SERVERS`, `detectLocalModels`,
`providerFromLocal`, `parseModels`. IPC `localModels:detect` (ANY) и
`localModels:add` (ADMIN). В app.js — блок «Локальные модели» в `openProviders`.

### Фильтр секретов

ADR 0099. `secret-filter.js` — `SECRET_RULES`, `findSecrets`, `createSecretFilter`
(`mask`, `unmask`, `found`), `maskMessages`, `filterNotice`. В `runAgentInner` —
фильтр на прогон: `buildRequest` маскирует запрос, `execCall` делает `unmask`
аргументов; `completeOnce` и `reviewer` маскируют всегда.

### Границы данных

ADR 0098. `data-boundary.js` — `isLocalUrl`, `dataBoundaryReport(settings, {mcp, connectors, schedules})`;
IPC `privacy:report` (ANY) собирает MCP из `mcpConfigs`, коннекторы — серверы с
`connector`, задачи — `scheduleStore`. В app.js — `openPrivacy`.

### Signoff

ADR 0097. `signoff.js` — `statusContext`, `parseSignoffArgs`, `parseGithubRemote`,
`testCommandFor`, `detailsUrl`, `gitState`, `runSignoff` (git, exec, post
инъекцией). В main — IPC `signoff:run` (ADMIN): git через `spawnSync`, тесты —
`spawnShell` с таймаутом, статус — `gh api`. В app.js — `runSignoffCommand`.

### Рантаймы: версия и перенос

ADR 0085. `runtimes.js` — `probeRuntime` (+ `--version`, `versionOf`,
`compareVersions`, `minVersion`), `exportRuntimes` (env без значений),
`importRuntimes` (проверка, слияние, `replace`); IPC `runtimes:export`,
`runtimes:import` (admin).

### «Запомнить?» и ocr

ADR 0084. `suggestLesson`/`cleanLesson` в agent.js; main после прогона с
правками (`runStart`, класс write/delete) шлёт `memory:suggest`, renderer —
`showMemorySuggest` (плашка, `memory:append`). `tools/ocr.js` — инструмент
`ocr`, `ctx.ocr` = `ocrImage` с настройками из `runAgent`.

### Уведомления

ADR 0081. `notify.js` — `notifySettings` (каналы + перенос старого
`webhookUrl`), `normalizeChannel`, `channelRequest` (Telegram, MAX, WhatsApp,
Rocket.Chat, webhook), `createNotifier`; в main один `notify` (фокус — `BrowserWindow`, клик —
`scheduled:open`), вызовы из прогона чата, `makeApprover`, `makeAsker`,
`backgroundFor`, `notifyScheduled`; IPC `notify:test(channelId)`. Токены и
адреса каналов — в `SECRET_PATHS`, маска «***» — в `publicSettings`/`saveSettings`.

### Память, совместимость, кэш, дубли навыков

ADR 0080. `memory-limits.js` — `MEMORY_LIMITS`, `memoryForPrompt` (в
`systemPrompt`); `instructions.js` — `projectInstructions(dir, { compat })`,
`cursorRules`; `capabilities.js` — флаг `cache`, `withCacheControl` (в теле
chat.completions, отказ шлюза → `cacheSupported = false`);
`skill-conflicts.js` — `uniqueSkills` (промпт агента), `skillConflicts`
(`packageSkillWarnings` в main при установке).

### Ноутбуки, диагностика, отложенные инструменты

ADR 0079. `tools/notebook.js` — `renderNotebook` (в `read_file` для
`.ipynb`), `notebook_edit`; `diagnostics.js` — `detectCheckers`,
`runDiagnostics`, парсеры tsc/eslint/ruff/pyright/node/py_compile,
`formatDiagnostics`; инструмент — `tools/diagnostics.js`, автопроверка — в
`execCall` после правки (`settings.autoDiagnostics`). `tool-search.js` —
`splitTools`, `deferredPrompt`, `searchTools`: в `runAgent` `allTools` (что
выполнить) и `tools` (что видит модель) + `tool_search`, `loadedTools` на прогон.

### Набор сценариев

ADR 0082. `evals/tasks.json`, `evals/profiles.json`; `scripts/eval-lib.mjs` —
`writeFiles`, `runCheck`/`gradeTask`, `validateTasks`, `reportMarkdown`;
`scripts/eval.mjs` гоняет профиль × задача через `bin/mai.mjs -p --output json`.

### Безголовый режим

ADR 0077. `cli.js` — `isCliInvocation`, `parseCliArgs`, `resultObject`,
`streamLine`. В main константа `CLI` (разбор `process.argv`) переключает
`whenReady` на `runCli`: окно, планировщик и навыки не запускаются; прогон —
как у плановой задачи (`runAgent` с `policyFor`, хуками, чекпоинтами, сессией,
`acquireProject`), `approve` отказывает, `emit` пишет stream-json. Запасной
перезапуск с `--use-system-ca` (если нет API `tls`, ADR 0095) в CLI наследует
stdio. Лаунчер — `bin/mai.mjs`.

### Субагенты

ADR 0036. `runAgent({ agentDefs })` добавляет инструмент `agent`; его `run`
вызывает `runAgent({ subagent: { def } })` с теми же `policy`, `approve`,
`hooks`, `trusted` и обёрткой `checkpoint`, привязанной к ходу родителя.
`subagent` сужает инструменты (`def.tools`, без `NEVER_FOR_SUBAGENT`) и
отключает ревизор и `Stop`. IPC `agents:defs(projectDir)`.

ADR 0075: `worktree.js` — `repoRoot`, `createWorktree`, `worktreeChanges`,
`applyChanges` (по файлу, `git merge-file`), `removeWorktree({ keepBranch })`;
`executeSubagent` в agent.js запускает субагента в копии и `mergeWorktree`
(вопрос `agent_merge`, чекпоинт, слияние). Фон: `runAgent({ background })` —
реестр `backgroundFor(window, sessionId)` в main (итог в историю, событие
`agent:background`, уведомление), инструмент `agent_result`.

### Вывод консоли на Windows

`electron/lib/encoding.js`: `withUtf8Console` добавляет `chcp 65001` перед
командой `cmd.exe` (`run_shell`, стадии досок); `createOutputDecoder` читает
вывод как UTF-8, а невалидные куски перекодирует из cp866 или cp1251. CI
гоняет всё на `windows-latest` (`scripts/test-windows.mjs` и электронные наборы).

### Пакеты плагинов

ADR 0037. `packagesFor(projectDir)` в main — включённые пакеты (глобальные и,
для доверенной папки, проектные). Загрузчики принимают `extraDirs` из
`packageDirs(packages, kind)`: `listCustomCommands`, `listAgentDefs`,
`listSkills` (и `runAgent({ skillDirs })`), `loadPlugins`; `collectHooks`
получает `packageHooks`, `mcpConfigs` — `packageMcpServers`. IPC:
`packages:list`, `packages:install({ from, replace })`, `packages:uninstall`,
`packages:toggle({ name, enabled })`.

Наборы ролей (ADR 0070): папка `roles/` приложения, `roles.js` — `listRoles`,
`installRole` (своя копия из asar, только commands/skills/agents). IPC
`roles:list`, `roles:install`; мастер `openOnboarding` в renderer открывается
при первом запуске (`settings.onboarding.done`) и по `/onboarding`.

### Длинные задачи

ADR 0051. `session.run` (`setSessionRun`, защищённое поле, в индексе — `run`):
`running` в `chat:start` и `runScheduled`, итог в `finally`. При старте
`markInterrupted()` переводит `running` → `interrupted`. Окно: `renderRunBanner`
(«Продолжить» — `send({ text: CONTINUE_PROMPT })`), «⏸» в списке чатов, текущий
шаг в `renderTodos`.

### Плановые задачи

ADR 0050. `electron/lib/scheduler.js`: `normalizeSchedule`, `nextRunAt`,
`previousRunAt`, `isDue` (пропущенный — один раз в пределах суток),
`describeSchedule`, `createScheduleStore(dataDir)` (`scheduled.json`, журнал
`scheduled-runs.jsonl`). В main: `startScheduler` (проверка раз в 30 с, первая —
через `MAI_SCHEDULER_DELAY_MS` или минуту), `runScheduled(task)` — новый чат,
`runAgent` с `policy.getMode = 'dontAsk'`, `ask: null`, без окна;
уведомление `Notification`. IPC `schedule:list | runs` (any),
`schedule:save | remove | runNow` (admin).

### Файловые инструменты

ADR 0054. `tools/fs.js`: `glob` (`globToRegExp`), `edit_file` через
`planEdits` (precheck/preview/run на одном плане), `readGuard` и `markRead` —
`ctx.readFiles` (Map путь → mtime) создаётся один раз на `runAgent`. Лимит —
`spillOutput` в `tool-runner.js` (`MAX_TOOL_OUTPUT`, папка `ctx.outputDir`,
подключена в `roots` как `@вывод`).

### Git-поток

ADR 0059. `pushViolation(command, { protectedBranches, branchOf })` в
`git-guard.js`; `runToolCall` превращает решение в `deny` (`source:
'protected-branch'`) для класса `exec`. `ctx.protectedBranches` — из
`settings.protectedBranches` (по умолчанию `DEFAULT_PROTECTED`). `/commit` и
`/review` — шаблоны `commitPrompt`/`reviewPrompt` в renderer; `overridable` в
`BUILTIN_COMMANDS` уступает своей команде с тем же именем. ADR 0076: `/pr` и
`/security-review` — `prPrompt`/`securityReviewPrompt`; `/worktree` — IPC
`worktree:list|create|open|remove` поверх `worktree.js` (`listWorktrees`,
`branchPrefix: 'mai/wt-'`), копии в `<данные>/worktrees/`.

### Возможности модели

ADR 0078: `text-tools.js` — `textToolsPrompt`, `parseTextToolCalls`,
`toTextProtocol`, `isToolsUnsupported`; в `runAgent` флаг `textTools`
(`!caps.tools`, отказ шлюза → тот же шаг заново), `buildRequest` переводит
историю в протокол, `takeTextCalls` достаёт вызовы. `planner` (main:
`plannerFor(settings.planModel)`) подменяет client/model/caps на итерациях в
«Плане».

ADR 0058. `modelCapabilities(model, provider)` в `capabilities.js` — флаги
`tools`, `vision`, `reasoning`, `effort`, `temperature`, `transport`, `context`;
`requestOptions(caps, { temperature, effort })` — поля запроса. В `runAgent`:
`caps` определяют транспорт, картинки, `tools` в запросе и `effort`
(параметр прогона из `chat:start`). IPC `models:caps`.

### Повторы и запасная модель

ADR 0057. `electron/lib/retry.js`: `isTransient`, `needsFallback`, `retryDelay`
(Retry-After), `sleep(ms, signal)`. В `runAgent` шаг (`attempt`) обёрнут в цикл
повторов; `fallback` ({ provider, model, label } из `fallbackFor` в main)
заменяет `client`, `model`, `provider` до конца прогона. `clientOptions` — `maxRetries: 0`
для шагов, 2 — для компакции и ревизора.

### Веб

ADR 0056. `electron/lib/web.js`: `isPrivateAddress`, `fetchPage` (проверка
адреса до запроса и на каждом перенаправлении, лимит, `htmlToText`),
`webSearch` (duckduckgo → `parseDuckDuckGo`, searxng, brave). Инструменты —
`tools/web.js`, конфигурация — `ctx.webConfig` из `settings.webSearch`.
Предмет `web_fetch` в `subjectOf` — домен.

Браузер агента (ADR 0069): `browser-agent.js` — `createAgentBrowser` (окно,
сессия `persist:mai-browser`, снимок с `data-mai-ref`, `isSensitiveField`,
`isPaymentAction`); `tools/browser.js` — `browser_*`, `assess` для оплаты;
main создаёт одно окно (`browserFor`) и отдаёт его как `settings.browser` →
`ctx.browser`. Предмет правил — домен (`subjectOf(..., browserHost)`),
`browserSiteRules(settings.browserSites)` добавляются к правилам прогона.
`runToolCall` после политики зовёт `entry.assess`: оплата → вопрос в любом
режиме (`browser-payment`).

### Фоновые команды

ADR 0055. `tools/shell.js`: `spawnCommand` (хост или `docker run`, `kill`),
`startBackground` — реестр `background` (кольцевой буфер, позиция чтения,
код), `backgroundTools` (`shell_output`, `shell_kill`), `disposeBackground` —
в `before-quit` main.

### Документы

ADR 0049. `electron/lib/documents.js`: `buildDocx`, `buildXlsx` (`sheetsToXlsx` в
`export/xlsx.js` — типы ячеек, формулы, закрепление; общая `buildWorkbook`),
`docxToMarkdown`, `readXlsx`, `sheetsToText`; ZIP читается `export/unzip.js`
(лимиты записей и размера). Инструменты — `tools/documents.js`:
`create_document` (write, precheck формата, preview текста), `read_document`
(read; есть в наборе субагентов explore/plan).

PDF-правка (ADR 0083): `tools/pdf.js` на pdf-lib — `parsePages`, `fillForm`
(кириллица → значение + `NeedAppearances`), инструменты `pdf_merge`,
`pdf_fields`, `pdf_form`; `tools/pdf-names.js` — имя итога для политики.

PDF (ADR 0067): `export/html.js` — `markdownToHtml` (A4, CSP); `pdf-render.js` —
`renderPdf(BrowserWindow, html)`: скрытое окно без JS и сети, `printToPDF`.
В инструмент попадает как `ctx.renderPdf` из `agentSettings` main.

Превью (ADR 0068): `preview_document` → `documentHtml` (docx/pptx/xlsx/csv/md →
HTML, слайды — `slidesToHtml`) → `ctx.renderPng` (`renderPng` в `pdf-render.js`:
окно вне экрана, страницы A4 в PNG); PDF — `pdftoppm`. Инструмент возвращает
`{ content, images }`, `runToolCall` отдаёт `images`, цикл агента прикладывает
их к сообщению инструмента (`attachToolImages`).

### Результаты задачи

ADR 0047. `touchedFiles(dataDir, sessionId)` (checkpoints.js) →
`sessionResults`, `resultFile` (проверка, что файл из результатов чата),
`previewResult`, `canOpen` (белый список расширений) в `electron/lib/results.js`.
IPC `results:list | preview | open | show` принимают `{ sessionId, file }`.

### Режим «Задача»

ADR 0046. `runAgent({ kind })`: при `task` — `TASK_PROMPT` вместо `BASE_PROMPT`
(`systemPrompt({ kind })`), инструменты из `CODE_ONLY_TOOLS` скрыты. Вид —
`session.kind` (`setSessionKind`, защищённое поле) или `settings.defaultKind`
для нового чата; `chat:start({ kind })`. IPC `session:kind`, `session:setKind`.

### Рабочие папки чата

ADR 0045. `electron/lib/workroots.js`: `normalizeRoots(projectDir, extraDirs)`,
`resolveIn(roots, target, { allowOutside })` (`@имя/путь`, относительный — от
проекта), `subjectIn` (предмет для правил), `describeRoots` (промпт).
`runAgent({ extraDirs })` кладёт `roots` в контекст инструментов; `resolveInside`
в `tools/fs.js`, `resolveCwd` в `tools/shell.js`, `subjectOf({ roots })` и
`dockerRunArgs({ roots })` работают от них. Папки — `session.extraDirs`
(`setSessionDirs`, поле защищено от перезаписи прогоном); IPC `session:dirs`,
`session:addDir` (системный диалог, admin), `session:removeDir`.

### Навыки

ADR 0043. `listSkills` читает `allowed-tools`; `skillFiles(skill)` и
`readSkillFile(skill, rel)` (без выхода из папки) — в `skills.js`.
`load_skill({ name, file? })` (`tools/skills.js`) возвращает тело и список файлов
или файл; `grantableRules` отбрасывает широкие правила, `ctx.grantRules(rules, skill)`
(только встроенным инструментам) кладёт их в `skillGrants` прогона, которые
`policyCtx.getRules` в `runAgent` сливает с обычными правилами.

### Маркетплейс пакетов

ADR 0042. `electron/lib/marketplace.js`: `normalizeMarketplace`,
`refreshMarketplace` (клон в `<данные>/marketplaces/<имя>`, замена кеша только
при успехе), `readCatalog` (записи без выхода из каталога), `listMarketplaces`
(с `installedVersion`, `updateAvailable` по `compareVersions`),
`installFromMarketplace` → `installPackage({ from, ref, expect })`. IPC:
`marketplace:list` (any), `marketplace:add | remove | refresh | install` (admin).

### Песочница для команд

ADR 0040. `electron/lib/shell-sandbox.js`: `normalizeShellSandbox` (в
`loadSettings`/`saveSettings`), `hostAllowed(command, masks)`,
`sandboxPlan(command, cfg, { dockerAvailable })` → `host | docker | blocked`,
`dockerRunArgs(...)`. `run_shell` (`tools/shell.js`) получает в контексте
`shellSandbox` и `dockerAvailable()` — main передаёт их через
`agentSettings(settings)` (кеш `docker info` на минуту). `execute(..., { container })`
запускает `docker run` без оболочки хоста и останавливает его `docker kill`.

### Уровни настроек и панель «Разрешения»

ADR 0038. `electron/lib/settings-levels.js`: `readManaged()` (файл организации,
путь — `managedSettingsPath()` или `MAI_MANAGED_SETTINGS`), `readProjectLevels`
(только для доверенной папки), `mergeLevels` (правила и их источник),
`updateLocalRules` (атомарная запись `settings.local.json` и строка в
`.mai-code/.gitignore`). В main: `rulesFor(sessionId, dir)` питает
`policyFor().getRules`; `bypassBlocked(dir)` (гость, недоверенная папка,
`disableBypassMode`) опускает «Без вопросов» до «Вручную» в `policyFor().getMode`,
`runtimeMode`, `makeAsker`, а `permissions:set` его отклоняет; `managedHooks()`
ставится первым в `collectHooks`. `permissions:modes` отдаёт правила по уровням,
файл организации и пути файлов проекта; `permissions:rules` принимает
`scope: 'local'`; `permissions:explain({ sessionId, tool, subject })` возвращает
решение `evaluate` и уровни найденного правила. Ответ на запрос
`remember: 'local'` пишет правило в `settings.local.json` (admin, доверенная папка).

## Проекты

ADR 0065. `createProjectStore(dataDir)` (`projects.json`, `checkDir`),
`projectPrompt`, `connectorAllowed` в `projects.js`. main: `activeProjectFor(dir)`
по `settings.activeProject`; `chat:start` передаёт `project` в `runAgent` и
объединяет его `extraDirs` с папками чата. IPC `projects:list` (any),
`projects:pickDir | save | remove | activate` (admin).

## Ревизор

ADR 0064. После финального ответа: `touched` (файлы `write`/`delete` прогона)
не пуст и `reviewer.verify !== false` — `runAgent` субагента `reviewer`
(`REVIEWER_TOOLS`, режим `plan`, `VERIFY_PROMPT`), вердикт — `parseVerdict`;
иначе `reviewAnswer({ mode, kind, requestOptions })`.

## Трассировка агента

ADR 0063. `runAgent` — обёртка над `runAgentInner`: спан `agent.run`
(`agent.subagent` для субагента, родитель — `parentSpan`), внутри — `agent.step`
вокруг запроса с повторами и `agent.tool` вокруг `runToolCall` (спан доступен
инструменту как `ctx.span`). `tracer` — из `agentTracer()` в main
(`createTracer(emitSpan)` или `NO_TRACER`).

## Доски и артефакты

ADR 0062. `saveBoards` — атомарно, `revs` по секциям; `saveBoardSection(dir,
section, value, rev)` возвращает `{ conflict, boards }` при чужой записи.
`artifacts.js`: `withIndexLock` (через `file-lock.js`) вокруг изменений индекса,
`gcBlobs` после `deleteArtifact`.

## Проверка данных IPC

ADR 0060. `guardIpc` перед матрицей прав вызывает `validateIpc(channel, args)`
из `ipc-schemas.js`: `checkShape` (размеры, глубина, циклы, опасные ключи) и
типы по `IPC_SCHEMAS[channel]`. Отказ — `{ ok: false, invalid: true, error }`.

## Доверие к папке и матрица прав IPC

Доверие (ADR 0028, `electron/lib/trust.js`): `trusted`, `restricted` или
`unknown`, хранится в `%APPDATA%/mai-code/trust.json`, наследуется вложенными
папками; песочницы приложения доверены всегда. Без доверия `mcpConfigs` не
берёт `.mai-code/mcp.json`, `loadPluginsFor` пропускает плагины проекта,
`runAgent({ trusted: false })` не подмешивает `AGENTS.md`, память и навыки
проекта, `boards:stageRun` отказывает. `chat:start`, `runtimes:run`,
`runtimes:runMany`, `boards:correction` при `unknown` возвращают
`{ needTrust: true, found }`, окно спрашивает и повторяет запуск.

IPC: `trust:get(projectDir)`, `trust:set({ projectDir, state })` (`trusted` —
только admin), `trust:list`, `trust:remove(projectDir)` (admin).

Матрица прав (`electron/lib/ipc-permissions.js`): `guardIpc` оборачивает
`ipcMain.handle` до регистрации обработчиков; канал `admin` отказывает гостю
ответом `{ ok: false, forbidden: true }`. Канал вне матрицы считается `admin`.
`scripts/test-ipc-permissions.mjs` падает, если канал не внесён в матрицу.

Блокировка проекта (`electron/lib/project-lock.js`): чат, самокоррекция и
рантайм с правом записи берут папку на время прогона; второй получает
`{ busy: true }`.

## Вложения

Вложение — файл в папке проекта плюс запись манифеста в промпте (ADR 0016).

1. Рендерер передаёт пути файлов: `webUtils.getPathForFile` при drag&drop или
   системный диалог. Изображения из буфера приходят как data URL.
2. `attachments.js` копирует файл в `.mai-code/uploads/<sessionId>/` и
   определяет тип по расширению и сигнатуре.
3. Текст извлекается без внешних библиотек: DOCX/XLSX/PPTX — ZIP + XML, PDF —
   `zlib` + операторы `Tj`/`TJ`, ZIP — встроенный парсер (7-Zip и `tar` —
   запасной путь).
4. В промпт уходит манифест: имя, размер, тип, путь, путь к тексту, счётчики.
   Агент читает файл через `read_file` и `grep`.
5. Изображения (PNG, JPEG, GIF, WebP) модели с поддержкой изображений получают
   частью `image_url` (`electron/lib/vision.js`). В сессии хранится путь
   (`message.images`), base64 собирается на каждый запрос: до 5 МБ на файл,
   20 МБ и 10 картинок на запрос, с последних сообщений. Поддержка — флаг
   `vision` у модели провайдера или эвристика по имени. Если шлюз отвечает 400
   на картинку, шаг повторяется без неё.

IPC-каналы: `attachments:add`, `attachments:addImage`, `attachments:pick`,
`attachments:remove`, `attachments:open`. Удаление и открытие проверяют, что
путь лежит внутри папки вложений. Секретные имена отклоняются по исходному
имени до очистки: `safeName` срезает ведущие точки, и `.env` стал бы `env`.

### OCR изображений

Текст с картинки достаёт `electron/lib/ocr.js` (ADR 0023). Четыре движка за одним
интерфейсом: `winrt` (Windows), `vision` (macOS), `tesseract` (любая ОС) и `mai`
(шлюз, `hunyuan-ocr`). В режиме `auto` локальные движки идут первыми, сеть —
последней. `attachments.js` не знает про конкретные движки: он вызывает
`recognizeAttachment()`, которая пишет `.txt` рядом с изображением.

OCR не входит в `describe()`: `saveFromPaths` остаётся синхронным и быстрым, а
распознавание запускается отдельным IPC-каналом. Ошибка OCR не отменяет
вложение — файл остаётся доступен агенту.

IPC-каналы: `ocr:status`, `ocr:recognize`. Подробности — [OCR](OCR.md).

### Экспорт ответа

Ответ агента скачивается в MD, TXT, DOCX и XLSX (ADR 0025). Модуль
`electron/lib/export/` чистый: не знает про Electron и файловую систему.

| Файл | Назначение |
|---|---|
| `zip.js` | писатель ZIP: CRC-32, записи без сжатия и с `deflate` |
| `markdown.js` | разбор Markdown в блоки и Markdown → простой текст |
| `docx.js` | WordprocessingML: заголовки, таблицы, код моношрифтом |
| `xlsx.js` | SpreadsheetML: каждая таблица — отдельный лист |
| `pptx.js` | PresentationML: слайды из списка или Markdown (ADR 0066) |
| `html.js` | Markdown → HTML для печати в PDF (ADR 0067) |
| `index.js` | выбор формата, безопасное имя файла, сборка чата |

DOCX и XLSX собираются без внешних библиотек: это ZIP с XML внутри, а `zlib`
входит в Node. Офлайн-архив не растёт.

IPC-каналы: `export:message` (один ответ) и `export:chat` (весь диалог).
Оба открывают `dialog.showSaveDialog` и пишут файл в main-процессе.
В UI меню «Скачать» появляется у ответа при наведении; кнопка «Скачать чат»
в боковой панели показывает меню форматов.

## Окно и полоса заголовка

Системная полоса заголовка скрыта (`titleBarStyle: 'hidden'`), кнопки окна
рисует Windows поверх страницы в цветах палитры (`titleBarOverlay`, ADR 0022).
Настройка — `titleBarOptions()` в `electron/main.js`, применяется к главному
окну и к окнам досок.

Правила для разметки:

1. Верхняя панель (`.topbar`, `.board-topbar`) — drag-регион: тянет окно.
2. Кнопки, списки и поля внутри панели помечены `no-drag`, иначе нажатие
   двигало бы окно.
3. Правый отступ панели считается от `env(titlebar-area-width)` и
   `env(titlebar-area-x)`, чтобы кнопки окна не накрывали кнопки панели.

## Сертификаты

Node в Electron не доверяет корпоративному корню Windows, поэтому `main.js` при старте
вызывает `applySystemCa()` (`system-ca.js`, ADR 0095): встроенные + системные корни
через `tls.setDefaultCACertificates`. В собранном Electron `NODE_OPTIONS` игнорируется,
поэтому прежний перезапуск с `--use-system-ca` (`MAI_CODE_RELAUNCHED` против цикла)
остался только запасным путём, если API нет (`NEEDS_RELAUNCH`).

### Самопроверка установки

ADR 0095. `self-check.js` — `isSelfCheck`, `selfCheckOut`, `runSelfCheck`; в main
`--self-check` переключает `whenReady` на отчёт и выход. CI: задача `installer`
и `scripts/check-installer.ps1`.
