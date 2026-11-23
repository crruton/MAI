# 0104. Electron 45, openai 7 и устранение уязвимостей зависимостей

- **Статус:** accepted
- **Дата:** 2026-11-23
- **Контекст:** первый прогон сканера обновлений (ADR 0102) на самом MAI

## Контекст

Сканер обновлений показал, что приложение отстало: Electron 38.8.6 (последняя —
45.4.1), openai 6.49 (7.62), electron-builder 26.0. `npm audit` нашёл 10
уязвимостей: высокого риска — в самом Electron (≤ 42.11.15) и `extract-zip`,
среднего — `hono`, `@hono/node-server`, `minimatch` 7–11.0.0 в инструментах
сборки.

## Решение

- Electron 38.8.6 → **45.4.1** (встроенный Node 22 → 24), electron-builder
  26.0 → 26.18, openai 6 → **7.62** (несовместимое изменение одно — минимум
  Node.js 22; у нас 22 в CI и 24 в Electron), `npm audit fix` для hono.
- `minimatch` 7–11.0.8 в инструментах сборки (`@electron/universal`,
  `app-builder-lib`) — `overrides` с диапазоном
  `"minimatch@>=7.0.0 <11.0.9": "11.0.9"`. `npm audit fix --force` откатил бы
  electron-builder на 24 — хуже; `minimatch@3` и `@5` у `glob@7` и `filelist`
  (другой API) override не трогает.
- Electron 45 больше не скачивает бинарник при установке (нет `postinstall`,
  загрузка — при первом `require('electron')`). Задача CI на Windows запускает
  `electron.exe` по пути и упала с «файл не найден». В `package.json` добавлен
  `postinstall: install-electron` — `npm ci` снова кладёт бинарник сразу.
- В Node 24 (Electron 45) `fs.rmSync` на Windows не удаляет файлы «только для
  чтения», а такие у git все объекты `.git/objects`. На CI `test-agent-loop`
  «зависал»: ошибка удаления копии репозитория не завершала процесс. То же грозило
  приложению при удалении клона пакета, кеша каталога, рабочей копии, корзины.
  `remove-tree.js` — `removeTree`: на Windows снимает атрибут, затем `rmSync` с
  повторами; заменяет все рекурсивные удаления в приложении. Тест агентного цикла
  перехватывает необработанные ошибки — причина видна сразу, а не через 5 минут.
- Итог: `npm audit` — 0 уязвимостей.

## Проверка

- `npm test`, `test:responses`, `test:export`, `docs:check` — зелёные.
- Electron 45: `test-agent-loop` 177, `test-ui` 313, `test-memory-tools`,
  `test-plugin-host`, `test-secrets-electron`, `test-auth-electron`,
  `test-storage-safety`, `test-telemetry`, `test-pdf`, `test-browser`,
  `smoke-electron` — без ошибок; дымовые scheduler, cli, eval — зелёные.
- Собранное приложение (Linux, `electron-builder --linux dir`) прошло
  `--self-check` без Node.js в PATH: node 24.22.3, electron 45.4.1. Windows —
  задача CI `installer`.

## Последствия

- Изменения Electron 39–45 в API, которыми MAI не пользуется, не проверялись
  отдельно — только тестами выше. Модель разрешений Node (`--permission`) в
  `utilityProcess` на Electron 45 не перепроверялась: считаем, как и раньше, что
  плагин работает с правами пользователя.
