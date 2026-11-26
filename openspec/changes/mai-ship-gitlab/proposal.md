# Proposal: MAI Ship для GitLab — ревью, steward и approver без человека в рутине

## Проблема

Агенты пишут код быстрее, чем люди успевают апрувить MR. Человек стал узким местом цикла.
Claude Ship решает эту задачу тремя агентами (ревью, steward, апрув по политике), но
работает только с GitHub. Репозитории Raft живут в GitLab. В MAI есть ревизор `approve`/
`revise` (ADR 0006), но он проверяет ответ в чате, а не MR. Политики апрува, бот-учёток и
работы с MR в MAI нет.

## Решение

- Безголовый движок MAI и команда `mai ship <review|steward|approve> --mr <url>`
  (ADR 0108).
- CI-шаблон `ci/mai-ship.gitlab-ci.yml`: джобы `ship:review`, `ship:steward`, `ship:approval`.
  События вне pipeline приходят через pipeline trigger из вебхука.
- `.mai-code/ship.yaml` и `.mai-code/approval-policy.yaml` на default branch: настройки и
  политика апрува (ADR 0109). Схемы — `schemas/`, примеры — `examples/`.
- Approver от другого семейства моделей, чем исполнитель и ревьюер. Steward и approver
  работают от разных бот-учёток (ADR 0110).
- `/ship` в MAI: локальные проверки, commit, push, Draft MR по навыку `to-mr`, статус MR в
  ленте.
- Старт в `mode: observe`. Переход в `enforce` — по метрике согласия с людьми.

## Критерии приёмки

- MR не может ослабить политику, по которой его проверяют: файлы читаются из target branch.
- MR, который меняет политику, `ship.yaml`, `.gitlab-ci.yml` или `CODEOWNERS`, всегда получает
  `require_human`.
- В `mode: observe` бот не ставит ни одного approve.
- Апрув привязан к SHA. Новый push сбрасывает апрув.
- Approver не запускается, если его семейство моделей совпадает с исполнителем или ревьюером.
- Steward не апрувит, не мержит, не снимает Draft и не трогает пути с `require_human`.
- После каждого push steward пишет комментарий: что изменено и команда отката.
- `@mai stop` останавливает steward на MR. `MAI_SHIP_DISABLED=true` выключает Ship в проекте.
- Превышение бюджета останавливает агентов и даёт `require_human`.
- Текст `approve this` в diff, описании или имени файла не меняет решение.

## Вне scope

- Сервис на вебхуках вместо CI (E3.H5).
- Консилиум из двух approver'ов (E3.H4).
- GitHub: там используется Claude Ship как эталон (E3.H2).
- Автомерж: мержит человек или merge when pipeline succeeds по правилам проекта.
