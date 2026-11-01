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

`loadPlugins(projectDir)` импортирует `*.js` из `<проект>/.mai-code/plugins` и
`%APPDATA%/mai-code/plugins` с кэш-бэстером по `mtime`. Плагин может вернуть:

- `tools: [{ schema, run }]` — добавляются к общему списку инструментов;
- `transformMessages(messages)` — хук перед каждым запросом.

Ошибка плагина не ломает диалог: она попадает в список загруженных с полем `error`.

## Сертификаты

Node в Electron не доверяет корпоративному корню Windows, поэтому `main.js` при старте
проверяет `NODE_OPTIONS` и, если флага нет, перезапускает приложение с `--use-system-ca`
(переменная `MAI_CODE_RELAUNCHED` защищает от цикла).
