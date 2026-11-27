---
name: ship-setup
description: Подключить MAI Ship к GitLab-проекту — выбрать шаблон политики апрува под тип репозитория (документация, библиотека, сервис, инфраструктура), положить .mai-code/ship.yaml и .mai-code/approval-policy.yaml, начать в режиме observe и перевести классы в enforce по отчёту о согласии.
version: 1.0.0
owner: crruton
---

# Подключить MAI Ship

MAI Ship ревьюит MR и решает, можно ли вливать без человека, по политике-файлу в репозитории.
Документация — `docs/SHIP.md` в репозитории MAI.

## 1. Выбери шаблон

Посмотри структуру репозитория и выбери один шаблон из `templates/`:

| Шаблон | Когда |
|---|---|
| `docs.approval-policy.yaml` | репозиторий документации: Markdown, картинки |
| `library.approval-policy.yaml` | библиотека или SDK: публичный API, зависимости |
| `service.approval-policy.yaml` | сервис: БД и миграции, права, внешние вызовы, деплой |
| `infra.approval-policy.yaml` | Terraform, Helm, Flux, Ansible |

Смешанный репозиторий — бери более строгий шаблон и добавь правила по путям.

## 2. Положи файлы

- `templates/ship.yaml` → `.mai-code/ship.yaml`. Впиши модели: `providers.approver` — из другого
  семейства, чем модель, которая пишет код, и ревьюер.
- Выбранный шаблон → `.mai-code/approval-policy.yaml`. Пути в правилах приведи к реальным путям
  проекта: правило, которое ни с чем не совпадает, бесполезно.
- Оставь `mode: observe`. Не включай `enforce` при подключении.
- В `.gitlab-ci.yml` добавь `include` шаблона `ci/mai-ship.gitlab-ci.yml` из репозитория MAI.

Файлы политики меняются только через MR, который апрувит человек: MAI Ship сам требует
человека для правок `.mai-code/ship.yaml`, политики, `.gitlab-ci.yml` и `CODEOWNERS`.

## 3. Проверь

- Переменные CI/CD: `GITLAB_TOKEN` бота `mai-ship-approver`, `SHIP_REVIEWER_*`, `SHIP_APPROVER_*`.
- Локально: `node scripts/mai-ship.mjs approve --project <проект> --mr <номер> --dry-run`.

## 4. Переход в enforce

Через 2–4 недели в observe запусти `node scripts/mai-ship.mjs report --project <проект> --days 30`.
В `enforce_classes` добавляй только правила из строки «Можно включить в enforce_classes»: не меньше
20 решений, согласие ≥ 95%, ни одного approve, который человек не влил как есть. Затем
`mode: enforce` — отдельным MR с апрувом человека.
