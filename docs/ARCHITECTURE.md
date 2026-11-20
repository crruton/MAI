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
| `electron/lib/mcp.js` | MCP-менеджер (stdio + streamable HTTP) |
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
`utilityProcess` Electron 38 не включается, поэтому файловая система и процессы
доступны плагину с правами пользователя.

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
`sessions:list({ projectDir, query })`. `instructions.js`: `projectInstructions`
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

### Субагенты

ADR 0036. `runAgent({ agentDefs })` добавляет инструмент `agent`; его `run`
вызывает `runAgent({ subagent: { def } })` с теми же `policy`, `approve`,
`hooks`, `trusted` и обёрткой `checkpoint`, привязанной к ходу родителя.
`subagent` сужает инструменты (`def.tools`, без `NEVER_FOR_SUBAGENT`) и
отключает ревизор и `Stop`. IPC `agents:defs(projectDir)`.

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
проверяет `NODE_OPTIONS` и, если флага нет, перезапускает приложение с `--use-system-ca`
(переменная `MAI_CODE_RELAUNCHED` защищает от цикла).
