# Design: MAI Ship для GitLab

Решения: [ADR 0108](../../../docs/adr/0108-mai-ship-gitlab-ispolnenie-v-ci.md),
[ADR 0109](../../../docs/adr/0109-politika-apruva-v-repozitorii.md),
[ADR 0110](../../../docs/adr/0110-razdelenie-provayderov-v-ship.md).

## Соответствие Claude Ship

| Claude Ship | MAI Ship | Примитив GitLab |
|---|---|---|
| `/ship` | `/ship` в MAI | `git push`, `glab mr create --draft` |
| Code Review (Quick/Standard/Deep) | `ship:review`, `review.level` | discussions с позицией в diff |
| PR Steward, `@claude`, `@claude stop` | `ship:steward`, `@mai`, `@mai stop` | push бот-учёткой, Note hook, метка `ship::paused` |
| Claude Approvals, policy file | `ship:approval`, `approval-policy.yaml` | approve API с `sha` (Premium) или обязательная джоба (Free) |
| observe-only | `mode: observe` | комментарий-решение без approve |
| лимит затрат на репозиторий | `budget` в `ship.yaml` | — |

## Поток

```
разработчик или агент
  └─ /ship ─ preflight → commit (трейлер Agent-Model) → push → Draft MR
                                                       │
GitLab: merge_request_event / trigger(TRIGGER_PAYLOAD) ▼
  ship:review   контекст (diff, AGENTS.md, ADR по Applies To, OpenSpec)
                → направления (субагенты) → состязательная проверка → discussions
  ship:steward  триггер: pipeline failed | конфликт | blocking | @mai
                → классификация → фикс → push → комментарий «что / как откатить»
                ограничения: max_rounds, require_human-пути, нет approve/merge/undraft
  ship:approval гейты → правила (first match, строгие сильнее) → классификаторы
                → default → проверка семейств (ADR 0110) → решение
                observe: комментарий + журнал | enforce: approve(sha) или needs-human
```

## Модули

| Модуль | Что делает | Новый / есть |
|---|---|---|
| `electron/lib/ship/policy.js` | разбор и оценка политики, чистая функция `evaluate(policy, mrFacts)` | новый |
| `electron/lib/ship/gitlab.js` | MR, discussions, approve, метки, pipelines через REST GitLab | новый |
| `electron/lib/ship/roles/{review,steward,approve}.js` | роли агента на `AgentLoop` | новый |
| `electron/lib/ship/journal.js` | журнал решений JSONL, артефакт джобы | новый |
| `electron/lib/model-families.js` | семейства моделей | новый |
| `electron/lib/cli.js` | подкоманда `ship` | есть, ADR 0077 |
| `electron/lib/reviewer.js` | вердикт `approve`/`revise` | есть, ADR 0006 |
| `ci/mai-ship.gitlab-ci.yml` | шаблон джоб | новый |

`evaluate` не вызывает модель. Классификаторы считаются заранее и приходят в `mrFacts` как
`{ name: boolean }`. Поэтому детерминированная часть тестируется без провайдера.

## Состояние между событиями

Своего хранилища нет. Состояние живёт в MR:

- метки `ship::reviewing`, `ship::needs-human`, `ship::blocked`, `ship::paused`, `ship::observe`;
- комментарии с маркером `<!-- mai-ship:<role>:<sha> -->`. По маркеру роль находит свой
  прошлый комментарий и обновляет его, а не создаёт дубль;
- счётчик раундов steward — число комментариев steward с маркером в этом MR;
- журнал решений — артефакт джобы `ship-journal.jsonl`, сбор в Grafana (ADR 0094).

## Модель угроз

| Угроза | Защита |
|---|---|
| MR ослабляет политику | чтение из target branch; самозащита путей (ADR 0109, п. 2) |
| Injection в diff или описании | данные отдельным блоком (ADR 0053); классификатор возвращает только boolean; `evaluate` без модели |
| `@mai` от постороннего | роль автора комментария ≥ Developer |
| Самоапрув | разные семейства моделей; разные учётки steward и approver |
| Апрув старого кода | `sha` в approve API; сброс апрувов при push |
| Петля и рост затрат | `max_rounds`, `budget`, kill-switch |
| Утечка токенов | protected + masked переменные группы; фильтр секретов в запросах (ADR 0099) |
