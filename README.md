# MAI Code

Десктопный агент для вайбкодинга на моделях [MAI](https://api-ai.mai.ru) — собственный чат-клиент
на Electron с инструментами для работы с файлами, `AGENTS.md`, навыками, MCP-серверами и плагинами.

![Скриншот MAI Code](docs/screenshot.png)

## Возможности

- **Модели MAI** — список подтягивается из `GET /v1/models`, в дропдауне только чат-модели
  с человеческими названиями и размером контекста.
- **Несколько провайдеров** — MAI, AgentRouter и любой другой OpenAI-совместимый шлюз
  (OpenAI, DeepSeek, Anthropic в режиме совместимости). Модели в дропдауне сгруппированы
  по провайдерам и записываются как `провайдер/модель`, у каждого свой ключ и кэш моделей.
- **Внешние рантаймы** — OpenCode, herdr и любая своя команда: процесс запускается в папке
  проекта, вывод стримится в чат, есть кнопка «Остановить» и шаблоны `{prompt}`, `{model}`,
  `{projectDir}`, `{target}`.
- **Чат с агентом** — потоковые ответы, блок «Размышления», история чатов, переключение сессий,
  остановка генерации.
- **Инструменты агента**:
  - `read_file`, `list_files`, `grep` — чтение проекта;
  - `write_file`, `edit_file` — правки (с подтверждением);
  - `run_shell` — команды в папке проекта (с подтверждением, таймаут 180 с);
  - `load_skill` — загрузка навыка по имени;
  - `mcp__<server>__<tool>` — инструменты MCP-серверов;
  - инструменты из плагинов.
- **AGENTS.md** — проектный и глобальный, подмешиваются в системный промпт.
- **Навыки** — `<проект>/.mai-code/skills/<имя>/SKILL.md`, создание и удаление из интерфейса.
- **MCP** — локальные (stdio) и удалённые (streamable HTTP) серверы.
- **Плагины** — `<проект>/.mai-code/plugins/*.js`: свои инструменты и хук `transformMessages`.
- **Изоляция путей** — инструменты работают только внутри папки проекта, пока не включён
  доступ вне проекта.

## Быстрый старт

Требования: Windows 10/11, Node.js 20+.

```powershell
git clone https://github.com/crruton/mai-code.git
cd mai-code
npm.cmd install
npm.cmd start
```

> В PowerShell `npm` может блокироваться политикой выполнения — используйте `npm.cmd`.
> Если npm 11 не запускает install-скрипты Electron:
> `npm.cmd install-scripts approve electron` и `npm.cmd rebuild electron`.

Ярлык на рабочем столе:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-shortcut.ps1
```

### Ключи и адреса шлюзов

При первом запуске приложение ищет ключ в таком порядке:

1. `%APPDATA%\mai-code\.env`;
2. `%USERPROFILE%\Desktop\dev\.env`;
3. `<папка приложения>\.env`;
4. `mai-api-key.txt` рядом с проектом;
5. переменные окружения процесса.

Формат `.env` — обычный `KEY=value`, также поддерживается табуляция (`KEY\t=value`):

```dotenv
LLM_BASE_URL=https://api-ai.mai.ru/v1
LLM_MODEL=deepseek-v4.1-flash
LLM_API_KEY=sk-...
AGENTROUTER_BASE_URL=https://agentrouter.org/v1
AGENTROUTER_MODEL=claude-opus-5-5
AGENTROUTER_API_KEY=sk-...
```

Из `LLM_*` создаётся провайдер MAI, из `AGENTROUTER_*` — провайдер AgentRouter.
Дальше ключи и адреса правятся в панели «Провайдеры» и хранятся в `%APPDATA%\mai-code\settings.json`.

| Параметр | Значение по умолчанию |
|---|---|
| Base URL | `https://api-ai.mai.ru/v1` |
| Модель | `deepseek-v4.1-flash` |
| Температура | `0.3` |
| Максимум шагов агента | `30` |

### Корпоративные сертификаты

Шлюз MAI использует корпоративный корневой сертификат, которого нет в стандартном наборе Node.
Приложение при старте само перезапускается с флагом `--use-system-ca` через `NODE_OPTIONS`,
поэтому вручную ничего настраивать не нужно.

## Где что лежит

| Что | Путь |
|---|---|
| Настройки | `%APPDATA%\mai-code\settings.json` |
| Чаты | `%APPDATA%\mai-code\sessions.json` |
| Глобальные навыки | `%APPDATA%\mai-code\skills\` |
| Глобальный AGENTS.md | `%APPDATA%\mai-code\AGENTS.md` |
| Глобальные плагины | `%APPDATA%\mai-code\plugins\` |
| Навыки проекта | `<проект>/.mai-code/skills\` |
| Плагины проекта | `<проект>/.mai-code/plugins\` |

## Провайдеры

Кнопка «Провайдеры» в верхней панели. Каждый провайдер — это `Base URL` + `API-ключ` +
необязательный статический список моделей. Модели в дропдауне показываются группами:

```
MAI · DeepSeek V4.1 Flash
AgentRouter · Claude Opus 5.5
```

«Проверить» дергает `GET {baseURL}/models` и показывает HTTP-статус и число моделей.
Ключ хранится локально и наружу отдаётся только как `sk-abc…`.

Подходит любой OpenAI-совместимый шлюз: OpenAI, DeepSeek, Anthropic (в режиме
совместимости), OpenRouter, локальный Ollama/LM Studio. GitHub Copilot требует отдельной
OAuth-авторизации и пока не поддержан.

## Рантаймы

Список рядом с моделью переключает между встроенным агентом и внешним CLI:

- **OpenCode** — `opencode run --format json {prompt}`, вывод разбирается из JSON-событий;
- **herdr** — `herdr agent prompt {target} {prompt} --wait`;
- **Claude Code** — `claude -p {prompt}`;
- **Codex CLI** — `codex exec {prompt}`;
- **Gemini CLI** — `gemini -p {prompt}`;
- **Своя команда** — любые `command` + `args` с подстановками `{prompt}`, `{model}`,
  `{projectDir}`, `{target}`.

Процесс запускается в папке проекта, вывод идёт в чат потоком, кнопка «Остановить»
убивает дерево процессов. Ответ сохраняется в историю как сообщение рантайма.

## Плагин: пример

```js
export default {
  name: 'example-plugin',
  tools: [
    {
      schema: {
        type: 'function',
        function: {
          name: 'project_time',
          description: 'Текущее время',
          parameters: { type: 'object', properties: {} },
        },
      },
      async run() {
        return new Date().toLocaleString('ru-RU');
      },
    },
  ],
};
```

Кнопка «Создать пример» в панели «Плагины» кладёт такой файл в проект.

## MCP: пример

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work\\project"]
    }
  }
}
```

Добавляется через панель «MCP» (имя + команда + аргументы) или правится в `settings.json`.

## Документация

- [Архитектура](docs/ARCHITECTURE.md) — слои, IPC, цикл агента, инструменты.
- [Каталог моделей MAI](docs/mai-models.md) — 16 моделей, контексты, примеры запросов.
- [Провайдеры и рантаймы](docs/PROVIDERS.md) — как подключать другие модели и агентов.
- [Планы](docs/ROADMAP.md) — что дальше.

## Ограничения

- Инструменты работают только внутри папки проекта, если не включён доступ вне проекта.
- Каждая запись файла и каждая команда оболочки требуют подтверждения.
- Контекст длинного чата обрезается по размеру — старые ходы удаляются.
- Приложение пока запускается из папки, установщика нет.

## Безопасность

Ключи и токены не попадают в репозиторий: `.env`, `*.key`, `mai-api-key.txt`, `settings.json`
и `sessions.json` в `.gitignore`. Ключ MAI хранится локально в `%APPDATA%`.

## Лицензия

[MIT](LICENSE)
