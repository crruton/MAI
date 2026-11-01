# Провайдеры и рантаймы

В списке «opencode, herdr, deepseek harness, anthropic, openai, hermes, JEV, copilot» смешаны
две разные вещи. Их нельзя делать одним механизмом.

## Два слоя

**Провайдер** — API, откуда берутся ответы модели. Наш агент сам крутит цикл, инструменты
и подтверждения; провайдеру уходит обычный `chat/completions`.

**Рантайм** — чужой агент со своим циклом и своими инструментами (CLI или демон). Мы можем
только запустить его, показать вывод и передать сообщение. Наш UI при этом превращается
в терминал.

| Кандидат | Слой | Что это | Стоимость подключения |
|---|---|---|---|
| Anthropic | провайдер | Claude API, есть OpenAI-совместимый режим | низкая |
| OpenAI | провайдер | нативный OpenAI API | низкая |
| DeepSeek (platform) | провайдер | OpenAI-совместимый API | низкая |
| GitHub Copilot | провайдер | OAuth device flow + `api.githubcopilot.com` | средняя, неофициально |
| OpenCode | рантайм | CLI-агент, уже установлен | средняя |
| herdr | рантайм | менеджер терминалов для агентов, уже установлен | средняя |
| DeepSeek harness | рантайм | CLI-обвязка DeepSeek | средняя |
| Hermes | рантайм | агент Nous Research | средняя |
| JEV | рантайм | сторонний CLI-агент | средняя |

Вывод: провайдеры — дёшево и полезно, их стоит сделать. Восемь нативных интеграций
рантаймов — перебор; нужен один общий механизм «внешняя команда» и пресеты к нему.

## Как сейчас

Провайдер один, но это обычный OpenAI-совместимый шлюз. Достаточно поменять в настройках
`Base URL` и `API-ключ`, чтобы работать с другим совместимым API:

```json
{
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "sk-..."
}
```

Ограничения такого способа:

- одновременно только один провайдер;
- список моделей берётся из текущего шлюза;
- имя модели не содержит провайдера, поэтому в истории чата нельзя смешивать модели
  разных вендоров без переключения настроек.

## План: реестр провайдеров

```json
{
  "providers": {
    "mai": {
      "name": "MAI",
      "baseURL": "https://api-ai.mai.ru/v1",
      "apiKey": "{file:mai-api-key.txt}",
      "models": ["deepseek-v4.1-flash", "DeepSeek-V4-Flash"]
    },
    "openai": {
      "name": "OpenAI",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{env:OPENAI_API_KEY}"
    },
    "anthropic": {
      "name": "Anthropic",
      "baseURL": "https://api.anthropic.com/v1",
      "apiKey": "{env:ANTHROPIC_API_KEY}",
      "compat": "openai"
    },
    "deepseek": {
      "name": "DeepSeek",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "{env:DEEPSEEK_API_KEY}"
    }
  }
}
```

Модель в дропдауне становится `provider/model`, ключи подставляются из файла или переменной
окружения, у каждого провайдера свой кэш списка моделей.

Ограничение: OpenAI-совместимый режим покрывает чат и tool calling, но не всё: у Anthropic
нет `reasoning_content`, у Copilot своя авторизация, у Gemini — свой формат. Поэтому
«совместимость» — это базовый уровень, а не полный паритет.

## План: внешние рантаймы

Вместо восьми отдельных интеграций — одна вкладка «Рантаймы»:

```json
{
  "runtimes": {
    "opencode": {
      "name": "OpenCode",
      "command": "opencode",
      "args": ["run", "--format", "json", "--model", "{model}"],
      "promptVia": "arg"
    },
    "herdr": {
      "name": "herdr",
      "command": "herdr",
      "args": ["agent", "run", "--", "{prompt}"],
      "promptVia": "arg"
    }
  }
}
```

Что нужно реализовать:

1. PTY-процесс (node-pty) с потоковым выводом в панель.
2. Шаблон команды: `{prompt}`, `{model}`, `{projectDir}`.
3. Кнопка «Остановить» и таймаут.
4. Отдельный тип сессии: `kind: "runtime"`, история — сырой лог, а не сообщения.

Пресеты для OpenCode и herdr добавляются первыми, потому что они уже стоят на машине.
Остальные (Codex CLI, Claude Code, Gemini CLI, Copilot CLI, Hermes, JEV) подключаются
как «своя команда» без отдельного кода.

## Рекомендуемый порядок

1. Реестр провайдеров + `provider/model` в дропдауне (OpenAI, Anthropic, DeepSeek).
2. Вкладка «Рантаймы» с generic-командой и пресетами OpenCode / herdr.
3. Copilot — отдельно и последним: device flow, неофициальный API, токены живут час.
