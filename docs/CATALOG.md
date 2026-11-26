# Каталог навыков команды

Актуально на 26.11.2026. Решение — [ADR 0111](adr/0111-katalog-navykov-komandy.md).

Каталог — это навыки, которые команда использует повторно. Он лежит в этом репозитории:
индекс `mai-marketplace.json` в корне, пакеты — в `catalog/`.

## Подключить

«Подключения ▾» → «Пакеты и плагины» (`/packages`) → «Каталоги» → адрес
`https://github.com/crruton/MAI.git` → «Добавить». У навыка в каталоге — «Установить»,
у новой версии — «Обновить». Добавлять каталог и ставить пакеты может только admin (ADR 0042).

## Что в каталоге

43 навыка.

| Навык | Для чего | Источник |
|---|---|---|
| `architecture` | ADR: выбор технологии, фиксация решения | команда |
| `code-review` | ревью: безопасность, производительность, корректность | команда |
| `debug` | воспроизвести, локализовать, исправить | команда |
| `diagnosing-bugs` | диагностика трудных багов и регрессий производительности | mattpocock/skills, MIT |
| `documentation` | техническая документация | команда |
| `grilling` | допрос по плану или решению до общего понимания | mattpocock/skills, MIT |
| `incident-response` | разбор инцидента и postmortem | команда |
| `ponytail` | минимальное изменение кода без лишних абстракций | DietrichGebert/ponytail, MIT |
| `ponytail-review` | ревью на лишний код и переусложнение | DietrichGebert/ponytail, MIT |
| `release-notes` | заметки к релизу | команда |
| `standup` | сводка по недавней активности | команда |
| `stop-slop` | чистка текста от шаблонов AI-письма | hardikpandya/stop-slop, MIT |
| `system-design` | проектирование систем и сервисов | команда |
| `tdd` | разработка через тесты | mattpocock/skills, MIT |
| `tech-debt` | поиск и приоритизация техдолга | команда |
| `testing-strategy` | стратегия и план тестирования | команда |
| `to-mr` | доведение ветки до GitLab MR с доказательствами и Draft-статусом | команда |
| `ub-mode` | дисциплина TDD и чистого кода по Uncle Bob | unclebob/ub-mode, MIT |

Продуктовый цикл (работают вместе; `<docs>` — репозиторий документации продукта или `docs/`):

| Навык | Для чего |
|---|---|
| `request-triage` | разбор входящего запроса: brief, доработка, баг, техзадача, вопрос |
| `product-discovery` | рынок, конкуренты, пользователи, продуктовые гипотезы |
| `customer-interview` | интервью заказчика по PRD методом grilling |
| `product-prd` | формат и правила PRD: документы, user stories с Gherkin, чек-лист |
| `pbc` | разбиение PRD на Packaged Business Capabilities |
| `change-request` | доработка вне PBC: постановка, проверка, OpenSpec |
| `use-cases` | тест-кейсы по PBC и проверка влитых задач |
| `openspec` | OpenSpec change по PBC: delta specs, строгая проверка, архив; задачи в Multica — `openspec-multica` |
| `task-breakdown` | нарезка PBC на задачи разработки по логике, порядок и зависимости |

## Добавить или изменить навык

1. Папка `catalog/<имя>/` с `mai-package.json`:

   ```json
   { "name": "<имя>", "version": "1.0.0", "description": "Одна фраза", "owner": "<github-логин>", "license": "MIT" }
   ```

2. Навык `catalog/<имя>/skills/<имя>/SKILL.md`. Во frontmatter: `name`, `description`,
   `version` (как в манифесте), `owner`. Справки и скрипты — рядом (ADR 0043).
3. Чужой навык — с `LICENSE` и `UPSTREAM.md`: репозиторий, путь, коммит, наши правки.
4. Запись в `mai-marketplace.json`: `name`, `version`, `description`, `source: "catalog/<имя>"`.
5. При изменении навыка поднимите версию в трёх местах: frontmatter, манифест, индекс.
6. Проверка:

   ```powershell
   node scripts/test-catalog.mjs
   ```

## Отдать навыки в Multica MAI

Панель «Multica» → **Навыки → Multica**: MAI покажет план и спросит подтверждение. Из
терминала:

```powershell
npm.cmd run multica:skills -- --dry-run
npm.cmd run multica:skills
npm.cmd run multica:skills -- grilling tdd
```

Навыки попадают в workspace проекта ([MULTICA.md](MULTICA.md)). Повторный запуск меняет
только навыки с новой версией или правкой. Навык с тем же именем, созданный в Multica
вручную, не перезаписывается. `--prune` удаляет из Multica навыки каталога, которых
больше нет в каталоге ([ADR 0113](adr/0113-navyki-kataloga-v-multica.md)).

## Экспорт в Claude Code, OpenCode и Codex

```powershell
npm.cmd run skills:export -- --target claude --dry-run
npm.cmd run skills:export -- --target claude,opencode,codex
npm.cmd run skills:export -- --target claude --project C:workapp grilling tdd
```

Без `--project` навыки идут в папку пользователя (`~/.claude/skills`,
`~/.config/opencode/skills`, `~/.codex/skills`), с ним — в папку проекта. В каждой папке
навыка — метка `.mai-catalog.json`; папку без метки экспорт не трогает. Повтор меняет только
новые версии, `--prune` удаляет навыки, которых больше нет в каталоге
([ADR 0114](adr/0114-eksport-navykov-v-drugie-agenty.md)).

DevOps (`devops-context` — с чего начинать; корпоративный профиль сети, зеркал и реестра
организации хранится в приватном каталоге):

| Навык | Для чего |
|---|---|
| `devops-context` | среда, владелец и ограничения до работы с CI, Kubernetes, БД |
| `ci-pipeline-author`, `ci-job-triage`, `ci-security-gates` | GitLab CI: написать, разобрать падение, гейты безопасности |
| `dockerfile-review`, `docker-compose-author` | Dockerfile и Compose |
| `helm-chart-author`, `flux-kustomization` | Helm-чарт приложения, GitOps на Flux |
| `k8s-pod-triage`, `k8s-rightsizing` | разбор подов, ресурсы по метрикам |
| `tf-module-author`, `tf-plan-review`, `tf-drift-check` | Terraform: модуль, ревью плана, дрейф |
| `ansible-role-author`, `harbor-cli` | роли Ansible, Harbor через CLI |
| `ship-setup` | подключить MAI Ship: шаблоны политик апрува для четырёх типов репозиториев |

## Наборы по ролям

Поле `roles` в `mai-marketplace.json` перечисляет навыки роли ([ADR 0115](adr/0115-nabory-navykov-po-rolyam.md)):

| Роль | Навыки |
|---|---|
| developer | code-review, debug, diagnosing-bugs, tdd, ponytail, to-mr, documentation, tech-debt, openspec, stop-slop |
| analyst | request-triage, product-discovery, customer-interview, product-prd, pbc, openspec, change-request, use-cases, grilling, system-design, stop-slop |
| pm | request-triage, product-discovery, customer-interview, product-prd, task-breakdown, standup, release-notes, grilling, stop-slop |
| qa | use-cases, testing-strategy, code-review, ponytail-review, diagnosing-bugs, incident-response |
| lead | architecture, system-design, code-review, task-breakdown, tech-debt, standup, grilling, incident-response |
| devops | все 15 devops-навыков и incident-response |

Мастер первого запуска (`/onboarding`) ставит вместе с набором роли её навыки из каталога.
Из терминала:

```powershell
npm.cmd run skills:export -- --target claude --role analyst
npm.cmd run multica:skills -- --role developer
```

## Ссылки между навыками

Фраза «навык `имя`» или «скилл `имя`» в навыке каталога должна вести на навык каталога или
на встроенный навык MAI (`skills/`). Иначе проверка каталога не проходит.

## Что не попадает в каталог

Репозиторий публичный. Проверка не пропускает токены, приватные ключи, хосты из
`catalog/catalog-policy.json` и email вне списка разрешённых. Навыки с данными людей,
внутренними адресами и своими трекерами храните в приватном каталоге того же формата и
подключайте его так же, по адресу репозитория.

## Ограничения

- Правка навыка в папке другого агента перезапишется при экспорте новой версии: править нужно в каталоге.
