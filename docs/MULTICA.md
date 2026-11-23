# Multica

Multica — self-hosted workspace, где задачи назначаются AI-агентам. MAI Code
использует её как доску задач, а OpenSpec — как источник спецификаций.

## Что синхронизируется

Из `openspec/changes/<name>/tasks.md` берутся незавершённые задачи `- [ ]`.
Для каждой задачи создаётся issue:

- заголовок: `[OpenSpec] <change>: <текст задачи>`;
- описание: название изменения, краткое описание, файл и строка;
- маркер `<!-- openspec:<change>:<task> -->` для идемпотентности.

Повторный запуск находит issue по маркеру и обновляет заголовок и описание.
Завершённые задачи `- [x]` пропускаются.

## Локальный запуск

Официальный установщик для Windows:

```powershell
# Только CLI
irm https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.ps1 | iex

# CLI + self-hosted сервер
$env:MULTICA_MODE="with-server"
irm https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.ps1 | iex
```

Установщик кладёт CLI в `%USERPROFILE%\.multica\bin` и добавляет эту папку в
пользовательский PATH. Уже запущенное приложение PATH не видит: перезапустите
MAI Code или нажмите **Установить CLI** в панели Multica (после установки
приложение ищет CLI и в `%USERPROFILE%\.multica\bin`).

Сервер разворачивается официальным compose-файлом:

```powershell
cd $env:USERPROFILE\.multica\server
Copy-Item .env.example .env
# задайте JWT_SECRET, POSTGRES_PASSWORD и свободные порты
docker compose -f docker-compose.selfhost.yml up -d
```

В этом репозитории есть упрощённый `infra/multica/docker-compose.yml` для
демонстрации, но для реальной работы используйте официальный
`docker-compose.selfhost.yml`.

Сервисы (значения по умолчанию; порты можно изменить в `.env`):

| Что | Переменная | Адрес |
|---|---|---|
| Web UI | `FRONTEND_PORT` | http://localhost:3000 |
| API | `PORT` / `BACKEND_PORT` | http://localhost:8080 |

Без `RESEND_API_KEY` код входа можно взять из базы self-host:

```powershell
docker exec multica-postgres-1 psql -U multica -d multica -tAc `
  "select code from verification_code order by created_at desc limit 1;"
```

Для детерминированного локального входа задайте `APP_ENV=development` и
`MULTICA_DEV_VERIFICATION_CODE=888888`. Не используйте это на публичном сервере.

## CLI

```powershell
multica config set server_url http://localhost:8080
multica config set app_url http://localhost:3000
multica login          # браузерный OAuth
# или вход по PAT:
multica login --token mul_...
multica auth status
multica issue list --limit 20
```

`multica setup self-host --server-url ... --app-url ...` делает то же самое
интерактивно. Если браузер недоступен, создайте PAT: Web UI → **Settings →
Tokens** → **Create token**, затем `multica login --token mul_...`.

В приложении настройки Multica:

```json
{
  "multica": {
    "url": "http://localhost:8080",
    "appUrl": "http://localhost:3000",
    "workspaceId": "",
    "command": "multica"
  }
}
```

## Синхронизация

В приложении: панель **Multica** → **Синхронизировать OpenSpec**.

Или из терминала:

```powershell
npm.cmd run multica:sync
```

Обратно: **Статусы → tasks.md** (или `node scripts/multica-sync.mjs --pull`) —
задачи, закрытые в Multica (`done`, `completed`, `closed`), отмечаются `[x]` в
`tasks.md`. Отменённые в Multica перечисляются в отчёте, галочку не получают;
локальную галочку синхронизация не снимает (ADR 0089).

## Почему CLI, а не REST

Multica — Go-сервер с REST API, но публичная документация описывает CLI
(`multica issue create/list/update`). Внутренний REST может меняться между
версиями. Клиент `electron/lib/multica.js` изолирован: если появится стабильный
API, заменить нужно только этот файл.

## Проверено в этой среде

- CLI v0.8.0 установлен официальным скриптом.
- Self-host backend и frontend подняты официальным compose; `/health` — 200.
- Вход по PAT, `multica auth status`, `multica issue create`, `multica issue list`
  выполнены успешно.
- Кириллица в выводе больше не превращается в «кракозябры»: клиент декодирует
  буфер как UTF-8, затем cp866/cp1251.

## Ограничения

- Нужен установленный и авторизованный CLI.
- Обратно из Multica приходит только «готово» → `[x]`; «в работе» и переоткрытие
  в `tasks.md` не отражаются.
- Дубликаты возможны, если вручную удалить маркер из описания.
- `workspaceId` пока не передаётся в CLI; используется workspace по умолчанию.
- Локальная Multica и MAI Code не обмениваются вложениями и комментариями.
- Телеметрия Multica включена по умолчанию; отключается `DO_NOT_TRACK=1`
  на backend.
- Без PAT или браузерного OAuth доска недоступна; API-ключи и пароли в
  настройках не хранятся.

## Формат задач (ASD-STE100)

- Одна инструкция на предложение.
- Активный залог.
- Короткие предложения.
- Без идиом и жаргона.
- Глагол в начале: «Добавить», «Проверить», «Удалить».

Плохо: «Надо бы прикрутить, чтобы оно само синкалось».
Хорошо: «Добавить синхронизацию задач. Проверить повторный запуск. Обновить документацию.»
