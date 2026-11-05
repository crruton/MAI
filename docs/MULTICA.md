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

Официальный способ:

```powershell
git clone https://github.com/multica-ai/multica.git
cd multica
make selfhost
```

Либо в этом репозитории:

```powershell
docker compose -f infra/multica/docker-compose.yml up -d
```

Сервисы:

| Что | Адрес |
|---|---|
| Web UI | http://localhost:3000 |
| API | http://localhost:8080 |

Без `RESEND_API_KEY` код входа печатается в лог backend:

```powershell
docker logs -f mai-code-multica-backend | Select-String "Verification code"
```

Для детерминированного локального входа задайте `APP_ENV=development` и
`MULTICA_DEV_VERIFICATION_CODE=888888`. Не используйте это на публичном сервере.

## CLI

```powershell
multica config set server_url http://localhost:8080
multica config set app_url http://localhost:3000
multica login
multica daemon start
multica issue list --limit 20
```

## Синхронизация

В приложении: панель **Multica** → **Синхронизировать OpenSpec**.

Или из терминала:

```powershell
npm.cmd run multica:sync
```

Настройки (`%APPDATA%\mai-code\settings.json`):

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

## Почему CLI, а не REST

Multica — Go-сервер с REST API, но публичная документация описывает CLI
(`multica issue create/list/update`). Внутренний REST может меняться между
версиями. Клиент `electron/lib/multica.js` изолирован: если появится стабильный
API, заменить нужно только этот файл.

## Ограничения

- Нужен установленный и авторизованный CLI.
- Синхронизация односторонняя: OpenSpec → Multica. Изменения статуса в Multica
  не записываются обратно в `tasks.md`.
- Дубликаты возможны, если вручную удалить маркер из описания.
- `workspaceId` пока не передаётся в CLI; используется workspace по умолчанию.
- Локальная Multica и MAI Code не обмениваются вложениями и комментариями.
- Телеметрия Multica включена по умолчанию; отключается `DO_NOT_TRACK=1`
  на backend.

## Формат задач (ASD-STE100)

- Одна инструкция на предложение.
- Активный залог.
- Короткие предложения.
- Без идиом и жаргона.
- Глагол в начале: «Добавить», «Проверить», «Удалить».

Плохо: «Надо бы прикрутить, чтобы оно само синкалось».
Хорошо: «Добавить синхронизацию задач. Проверить повторный запуск. Обновить документацию.»
