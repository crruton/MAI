# MAI Ship для GitLab

Актуально на 26.11.2026. Решения — [ADR 0108](adr/0108-mai-ship-gitlab-ispolnenie-v-ci.md),
[0109](adr/0109-politika-apruva-v-repozitorii.md), [0110](adr/0110-razdelenie-provayderov-v-ship.md),
[0119](adr/0119-ship-approver-bez-okna.md), [0120](adr/0120-ship-revyuer.md). Спека — `openspec/changes/mai-ship-gitlab/`.

MAI Ship — механика Claude Ship на GitLab: ревью, steward и approver по политике-файлу.
Готовы **ревьюер** и **approver**. Steward — следующий шаг.

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
4. Публикует обсуждения на строках diff (повтор не дублирует), одну сводку и метку
   `ship::blocking`, если есть blocking-находка. Approver по этой метке блокирует MR.

Модель — `providers.reviewer`; переменные `SHIP_REVIEWER_BASE_URL`, `SHIP_REVIEWER_API_KEY`.

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

## Выключить

`MAI_SHIP_DISABLED=true` в переменных проекта, `enabled: false` в `ship.yaml` или метка
`ship::paused` на MR.

## Ограничения

- Не проверено на живом GitLab и с живой моделью; проверено на поддельном GitLab.
- Образа MAI Ship нет: джоба клонирует MAI и ставит зависимости на каждом запуске.
- Затраты на модель пока не считаются: поле `budget` проверяется, но расход не копится.
- Ревьюер видит только diff и `AGENTS.md`, без чтения остального кода (инструменты — вместе со steward).
- Качество находок не измерено эталонным набором (E3.D5).
