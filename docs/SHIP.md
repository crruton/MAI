# MAI Ship для GitLab

Актуально на 26.11.2026. Решения — [ADR 0108](adr/0108-mai-ship-gitlab-ispolnenie-v-ci.md),
[0109](adr/0109-politika-apruva-v-repozitorii.md), [0110](adr/0110-razdelenie-provayderov-v-ship.md),
[0119](adr/0119-ship-approver-bez-okna.md), [0120](adr/0120-ship-revyuer.md), [0122](adr/0122-ship-steward-i-agent-bez-electron.md). Спека — `openspec/changes/mai-ship-gitlab/`.

MAI Ship — механика Claude Ship на GitLab: ревью, steward и approver по политике-файлу.
Готовы **ревьюер**, **steward** и **approver**.

## /ship в MAI

`/ship [ключ задачи]` в чате MAI доводит работу до Draft MR: проверки проекта до push, коммит
отдельной командой `git commit` (MAI добавит трейлеры `Agent-Model` и `Agent-User`, ADR 0116 —
по ним approver проверяет независимость модели), ветка, push, Draft MR через `glab` (или Draft
PR через `gh`) с описанием по навыку `to-mr`. Draft не снимается, merge не делается — дальше
ревьюер и approver в CI.

## Как работает ревьюер

1. Берёт diff MR и `AGENTS.md` target branch (секреты маскируются).
2. Ищет проблемы по направлениям: `review.level` — quick (корректность), standard (плюс
   безопасность и тесты, по умолчанию), deep (плюс ADR и стандарты); или `review.lenses`.
3. Каждую находку отдельный вызов модели пытается опровергнуть — остаются подтверждённые.
4. Находки разных направлений на одной строке склеивает в одну (серьёзность — максимальная).
5. Публикует обсуждения на строках diff (повтор не дублирует), одну сводку и метку
   `ship::blocking`, если есть blocking-находка. Approver по этой метке блокирует MR.
   Свои находки, которых в новом прогоне нет, закрывает.

Модель — `providers.reviewer`; переменные `SHIP_REVIEWER_BASE_URL`, `SHIP_REVIEWER_API_KEY`.

## Как работает steward

Включается `steward.enabled: true` в `ship.yaml`; джоба `ship:steward` запускается, когда в pipeline
что-то упало. Steward собирает упавшие джобы с логами, нерешённые blocking-находки ревью и
указания `@mai …` (от участников с ролью Developer и выше) и запускает цикл агента MAI:
правка файлов и команды проверки из `steward.commands`, без `git push` и без загрузки
`AGENTS.md`, навыков и MCP из ветки MR. Потом коммитит от бота `mai-ship-steward` с трейлером
`Agent-Model`, пушит в ветку MR и пишет комментарий: файлы и `git revert <sha>`.

- `@mai <указание>` — задание steward'у; `@mai stop` / `@mai resume` — пауза.
- Не больше `steward.max_rounds` раундов (по умолчанию 3), дальше — `ship::needs-human`.
- Правки конфигурации Ship, CI, `CODEOWNERS` и путей, где политика требует человека, steward не
  коммитит — ставит `ship::needs-human`.
- Сбой раннера, таймаут или сетевая ошибка в логе — не повод править код: steward один раз
  перезапускает джобу. Упала снова на том же коммите — `ship::needs-human`.
- Конфликт с target: steward вливает target в ветку MR. Без конфликтов — push; с конфликтом —
  слияние отменяется, в комментарии список файлов, метка `ship::needs-human`.
- После исправления находки ревью steward отвечает в её обсуждении «исправлено в `<sha>`».
  Закрывает обсуждение ревьюер на следующем прогоне, если находка не подтвердилась.
- Переменные: `MAI_SHIP_STEWARD_TOKEN` (бот: push в ветки MR, без апрува), `SHIP_STEWARD_BASE_URL`,
  `SHIP_STEWARD_API_KEY`; модель — `providers.steward`.

## Как работает approver

1. Читает `.mai-code/ship.yaml` и `.mai-code/approval-policy.yaml` из **target branch** MR.
   MR не может ослабить правила, по которым его проверяют.
2. Собирает факты: изменённые файлы и строки, pipeline, Draft, метки, модель исполнителя из
   трейлера `Agent-Model` в коммитах.
3. Применяет политику: самозащита конфигурации → бюджет → гейты → правила → классификаторы.
   Модель-классификатор вызывается, только когда её ответ может изменить итог.
4. Пишет один комментарий с решением, ставит метку `ship::*`. В `mode: enforce` для разрешённых
   классов — approve на оценённый SHA.

## Подключить к проекту

1. Положите в `main` проекта `.mai-code/ship.yaml` и `.mai-code/approval-policy.yaml`. Примеры —
   `openspec/changes/mai-ship-gitlab/examples/`. Начинайте с `mode: observe`.
2. Заведите бот-учётку `mai-ship-approver`: право апрува, без push.
3. Переменные CI/CD (protected + masked): `GITLAB_TOKEN` (токен бота), `SHIP_APPROVER_BASE_URL`,
   `SHIP_APPROVER_API_KEY` (OpenAI-совместимый шлюз модели approver'а).
4. В `.gitlab-ci.yml`:

   ```yaml
   include:
     - remote: https://raw.githubusercontent.com/crruton/MAI/dev/ci/mai-ship.gitlab-ci.yml
   ```

5. GitLab Free: включите «Pipelines must succeed». Джоба `ship:approval` красная, пока нужен
   человек (код 3) или MR заблокирован (код 2). После апрува человека перезапустите джобу.
   GitLab Premium: approval rule с ботом и «Remove all approvals when commits are added».

Модель approver'а (`providers.approver`) должна быть из другого семейства, чем модель, которая
писала код, и ревьюер (ADR 0110). Иначе решение — «нужен человек».

## Локально

```powershell
$env:GITLAB_URL = "https://gitlab.example.com"; $env:GITLAB_TOKEN = "<токен>"
node scripts/mai-ship.mjs review --project group/app --mr 42 --dry-run
node scripts/mai-ship.mjs approve --project group/app --mr 42 --dry-run
```

`--dry-run` печатает решение и текст комментария, ничего не записывая.

## Статус MR в MAI

Доска «Доставка» показывает открытые MR проекта: pipeline, находки ревьюера, раунды steward,
решение approver'а (и на тот ли SHA), расход моделей и итог — «нужен человек», «CI красный»,
«одобрен». Данные — через `glab api` с вашим входом (`glab auth login`), опрос раз в минуту
([ADR 0125](adr/0125-ship-status-mr-v-mai.md)). Без glab блок пишет причину, доска работает.

## Если нужен человек

Когда approver решил «нужен человек», MR назначается владельцам изменённых файлов по CODEOWNERS
target branch (кроме автора MR; на GitLab Free — один ревьюер), а в канал из `ship.yaml` уходит
уведомление. При «заблокировано» — только уведомление. Повтор того же решения по тому же SHA
людей не дёргает ([ADR 0123](adr/0123-ship-eskalaciya-k-cheloveku.md)).

```yaml
notify:
  channel: telegram        # telegram | rocketchat | webhook | none
  events: [needs_human, blocked]
```

Секреты — переменные CI: `SHIP_NOTIFY_TELEGRAM_TOKEN` и `SHIP_NOTIFY_TELEGRAM_CHAT` для Telegram,
`SHIP_NOTIFY_WEBHOOK_URL` для Rocket.Chat и webhook (Slack, Mattermost, Teams).

## Бюджет и расход

Каждая роль пишет расход моделей в свой комментарий MR: строку «Расход моделей: $…, токенов…»
и запись `mai-ship:cost`. Расход MR — сумма записей, за месяц — по MR текущего месяца.
Бюджет превышен — ревьюер и steward модель не зовут, approver отдаёт «нужен человек», MR
получает `ship::needs-human` ([ADR 0124](adr/0124-ship-uchet-zatrat.md)).

```yaml
budget:
  per_mr_usd: 3
  monthly_usd: 300
pricing:                  # доллары за 1M токенов
  qwen3.8-27b: { input: 0.3, output: 1.2 }
  gpt-5.1: { input: 1.25, output: 10 }
```

Без `pricing` токены считаются, а доллары — нет: бюджет тогда не срабатывает.

## Журнал и переход в enforce

Каждое решение approver'а лежит в его комментарии машиночитаемой записью (ADR 0121); джоба
кладёт копию в артефакт `ship-journal.jsonl`. Отчёт о согласии с людьми:

```powershell
node scripts/mai-ship.mjs report --project group/app --days 30
```

Отчёт показывает по правилам: сколько MR решено, согласие, «approve без слияния» (опасно) и
«лишний вызов человека», а также поток: lead time (медиана и 90%), долю влитых без человека и
revert за 14 дней. Строка «Можно включить в enforce_classes» — правила с ≥ 20 решениями,
согласием ≥ 95% и без approve без слияния. Шаблоны политик для подключения — навык каталога
`ship-setup` (документация, библиотека, сервис, инфраструктура).

## Выключить

`MAI_SHIP_DISABLED=true` в переменных проекта, `enabled: false` в `ship.yaml` или метка
`ship::paused` на MR.

## Боевая проверка (27.11.2026)

GitLab CE 17.3 (self-hosted), приватная песочница, модели шлюза MAI: ревьюер и steward —
`qwen3.8-27b`, approver — `deepseek-v4.1-flash` (разные семейства). Роли запускались CLI против
живых MR: раннеров у инстанса нет, поэтому джобы CI не проверены.

| Что | Итог |
|---|---|
| Ревьюер на MR с ошибками (минус вместо плюса, `eval`) | нашёл обе; 5 обсуждений на строках diff, сводка, `ship::blocking` |
| Approver, observe | approve документации комментарием; блок MR с blocking-находками; запись журнала |
| Approver, enforce | approve поставлен на оценённый SHA (эндпоинт approve работает и на CE) |
| Steward | цикл агента MAI исправил знак и заменил `eval` разбором выражений, добавил тесты; коммит от `mai-ship-steward` с `Agent-Model`, push в ветку MR без токена в URL, комментарий раунда |
| Повторное ревью и approver | 0 blocking, метка снята; крупная правка — «нужен человек», код гейта 3 |
| `@mai stop` / `@mai resume` | пауза и снятие паузы, проверка роли через API |
| `mai-ship report` | отчёт строится, решённых человеком MR пока нет |

Найдено и исправлено:

- `/diffs` с `per_page=100` на GitLab 17.3 отвечает 500 — страница по 20.
- Без отдельной бот-учётки approver апрувит от владельца токена; гейт засчитывал бы это как
  апрув человека — теперь пользователь токена исключается.
- Старые обсуждения ревью оставались открытыми, и steward взялся бы чинить исправленное —
  ревьюер закрывает свои находки, которых больше нет.
- Токен steward'а был в URL `git push` и мог попасть в текст ошибки — теперь credential helper.

Не проверено: джобы CI (нет раннеров), бот-учётки, модели Claude/GPT (ключ AgentRouter — 401).

Уведомление «нужен человек» в Telegram (бот команды, личный чат) доставлено эскалацией
approver'а без ошибок.

## Ограничения

- Джобы CI на живом GitLab не проверены: у инстанса боевой проверки нет раннеров.
- Образа MAI Ship нет: джоба клонирует MAI и ставит зависимости на каждом запуске.
- Уведомление о бюджете в канал не отправляется — только метка и комментарий.
- Статус MR — только на доске «Доставка», карточки в ленте чата нет.
- Ревьюер видит только diff и `AGENTS.md`, без чтения остального кода.
- Steward не разрешает конфликты сам — только чистое слияние target; конфликт без упавших
  джоб он видит лишь при ручном запуске `ship:steward`.
- Качество находок не измерено эталонным набором (E3.D5).
