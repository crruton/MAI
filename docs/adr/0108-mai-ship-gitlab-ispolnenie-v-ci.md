# 0108. MAI Ship для GitLab: агенты ревью, steward и approver в GitLab CI

- **Статус:** proposed
- **Дата:** 2026-11-26
- **Контекст:** `openspec/changes/mai-ship-gitlab/`, бэклог платформы E3.A1, E3.A4, E3.A5

## Контекст

Агенты пишут код быстрее, чем люди успевают его апрувить. Узким местом стал ручной апрув.
Anthropic описывает тот же вывод в Claude Ship (23.11.2026). Claude Ship состоит из трёх
агентов: Code Review, PR Steward и Claude Approvals. Он работает только с GitHub. Репозитории,
MR и хаб скиллов Raft живут в GitLab, поэтому Claude Ship нам не подходит.

В MAI уже есть безголовый режим `mai -p` (ADR 0077), ревизор `approve`/`revise` (ADR 0006),
PolicyEngine (ADR 0027), субагенты (ADR 0075) и `/signoff` (ADR 0097). Серверного режима у
MAI нет. Electron-окно нельзя запустить на сервере как сервис.

## Решение

MAI Ship — три роли агента на безголовом движке MAI. Для MVP они исполняются в GitLab CI,
своего сервера нет.

- **Движок.** `AgentLoop`, PolicyEngine, провайдеры и навыки выносятся в пакет без Electron.
  Команда — `mai ship <review|steward|approve> --mr <url>`. Образ собирается в CI и хранится
  в Harbor.
- **CI-шаблон.** `ci/mai-ship.gitlab-ci.yml` подключается в проект через `include`. Джобы
  `ship:review`, `ship:steward` и `ship:approval` запускаются на `merge_request_event`.
- **События вне pipeline.** Комментарий `@mai …`, апрув человека и конфликт приходят вебхуком
  в pipeline trigger проекта (`/projects/:id/ref/:ref/trigger/pipeline`). Тело события
  приходит в джобу как `TRIGGER_PAYLOAD`. Работу этого механизма на нашей версии GitLab
  нужно проверить до реализации.
- **Учётки.** `mai-ship-steward` — роль Developer, push только в feature-ветки, апрувить не
  может. `mai-ship-approver` — право апрува, push не может. Токены хранятся в CI/CD variables
  группы с флагами protected и masked. Ни одна учётка не мержит.
- **Апрув.** На Premium approver вызывает `POST /merge_requests/:iid/approve` с параметром
  `sha`. В проекте включено «Remove all approvals when commits are added». На Free вместо
  апрува есть обязательная джоба `ship:approval` и настройка «Pipelines must succeed». Джоба
  проходит, если политика дала `approve` или человек с ролью Maintainer апрувил текущий SHA.
- **Точка входа разработчика.** `/ship` в MAI проверяет изменения локально, делает commit,
  push и `glab mr create --draft` по навыку `to-mr`. Статус MR MAI показывает в ленте.

## Альтернативы

| Вариант | Плюсы | Минусы | Почему не выбран |
|---|---|---|---|
| Claude Ship | готовый продукт | только GitHub, beta, нет ZDR | GitLab не поддержан; используем как эталон на `crruton/MAI` |
| Сервис `mai-ship` на вебхуках в k8s | реакция < 1 мин, состояние между событиями | сервер, деплой, дежурство, хранение токенов | второй шаг, если латентность CI мешает (E3.H5) |
| GitLab Duo | встроен в GitLab | один провайдер, нет нашей политики и мультипровайдерности | не даёт разделения провайдеров (ADR 0110) |
| Скрипты без движка MAI | просто | вторая реализация PolicyEngine, навыков и провайдеров | дублирование и расхождение правил |

## Последствия

- Проще: нет сервера. Права и секреты берутся из механизмов GitLab. Раскатка идёт через
  `include` и хаб Multica.
- Сложнее: латентность реакции равна времени старта джобы. Состояние между событиями
  хранится только в MR: метки `ship::*`, комментарии с маркером, журнал-артефакт.
- Нужно проверить: pipeline trigger из вебхука и `TRIGGER_PAYLOAD` на нашей версии GitLab;
  наличие Premium; лимиты раннеров.
- Риски: петля steward ↔ CI, prompt injection, рост затрат. Снижение — ADR 0109 (политика,
  бюджет, kill-switch) и ADR 0110 (разделение провайдеров).

## Ссылки

- [ADR 0006](0006-revizor-vtoraya-model.md), [ADR 0027](0027-policy-engine.md),
  [ADR 0077](0077-bezgolovyj-rezhim-cli.md), [ADR 0097](0097-signoff.md)
- [ADR 0109](0109-politika-apruva-v-repozitorii.md), [ADR 0110](0110-razdelenie-provayderov-v-ship.md)
- Claude Ship: https://claude.com/resources/articles/introducing-claude-ship
- GitLab: Merge request approvals API, Trigger pipelines by using a webhook
