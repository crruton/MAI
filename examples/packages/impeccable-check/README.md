# impeccable-check — пример пакета с хуком PostToolUse

После каждой правки UI-файла (`.html`, `.css`, `.jsx`, `.tsx`, `.vue`, `.svelte`…)
хук проверяет частые ошибки интерфейса — по мотивам проверок навыка
`impeccable` (audit, harden) — и дописывает находки к результату правки: агент
видит их сразу и исправляет. Ничего не блокирует, зависимостей нет.

Что ищет: `outline: none` без замены, `transition: all`, шрифт меньше 12px,
`z-index` 1000+, `!important` трижды и больше, `<img>` без `alt`, клик на
`<div>`/`<span>`, поле только с placeholder, запрет масштабирования.

## Установка

Скопируйте папку в `<проект>/.mai-code/packages/impeccable-check/` (проект должен
быть доверенным) или в `%APPDATA%\mai-code\packages\` для всех проектов. Включить
и выключить — `/packages`.

`${MAI_PACKAGE_DIR}` в `hooks.json` MAI заменяет на папку пакета.
