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
| `electron/lib/sessions.js` | `sessions.json` |
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
| `electron/lib/permissions.js` | режимы разрешений: авто, вручную, принимать правки, план |
| `renderer/app.js` | состояние UI, события, модальные окна |
| `renderer/markdown.js` | безопасный минимальный Markdown |

## Цикл агента

1. Собирается системный промпт: базовые правила + папка проекта + `AGENTS.md` (глобальный и
   проектный) + список навыков + статус MCP.
2. История обрезается по размеру (`trimMessages`).
3. Запрос в `chat/completions` со `stream: true` и списком инструментов.
4. Дельты уходят в рендерер событиями `delta` / `reasoning`; `tool_calls` собираются по индексу.
5. Если инструментов нет — `done`, история сохраняется.
6. Если есть — каждый инструмент выполняется, результат добавляется сообщением `role: tool`,
   и цикл повторяется (до `maxIterations`, по умолчанию 30).

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
значение по умолчанию. Сохранённое `auto` читается как `bypass`.

| Режим | read | write | memory | exec | external (MCP, плагин) |
|---|---|---|---|---|---|
| `manual` | да | спросить | спросить | спросить | спросить |
| `acceptEdits` | да | да | спросить | спросить | спросить |
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
