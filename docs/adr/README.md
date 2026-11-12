# Architecture Decision Records (ADR)

ADR фиксируют решения, которые дорого менять: архитектуру, модель угроз,
форматы данных, внешние зависимости и способ эксплуатации.

## Правила

1. Один файл — одно решение. Имя: `NNNN-kratkoe-imya.md`.
2. Номер не переиспользуется. Следующий номер — максимальный + 1.
3. Статус меняется, текст решения — нет. Если решение устарело, создаётся
   новый ADR со статусом `accepted`, а старый получает `superseded` и ссылку.
4. ADR создаётся одновременно с изменением в `CHANGELOG.md`.
5. Шаблон: [`0000-template.md`](0000-template.md).

## Реестр

| № | Решение | Статус | Дата |
|---|---|---|---|
| [0001](0001-dvuhryadnaya-verhnyaya-panel.md) | Двухрядная верхняя панель | accepted | 2026-11-04 |
| [0002](0002-gitbook-vnutri-prilozheniya.md) | GitBook-документация внутри приложения | accepted | 2026-11-04 |
| [0003](0003-openspec-i-multica.md) | OpenSpec как вход, Multica как доска | accepted | 2026-11-04 |
| [0004](0004-docker-pesochnicy.md) | Docker-песочницы с публикацией портов | accepted | 2026-11-04 |
| [0005](0005-keycloak-postgres.md) | Keycloak на Postgres | accepted | 2026-11-04 |
| [0006](0006-revizor-vtoraya-model.md) | Ревизор: вторая модель проверяет ответ | accepted | 2026-11-04 |
| [0007](0007-offline-distributiv.md) | Офлайн-дистрибутив с node_modules | accepted | 2026-11-04 |
| [0008](0008-kubernetes-i-dns.md) | Kubernetes и DNS как отдельный слой | accepted | 2026-11-04 |
| [0009](0009-openscion-ne-zamena-git.md) | OpenScion не заменяет локальный git | accepted | 2026-11-04 |
| [0010](0010-pesochy-kak-papka.md) | Песочница-папка остаётся режимом по умолчанию | accepted | 2026-11-04 |
| [0011](0011-guardrails.md) | Guardrails встроенного агента | accepted | 2026-11-06 |
| [0012](0012-observability-otel.md) | Observability на OpenTelemetry | accepted | 2026-11-06 |
| [0013](0013-vneshnie-rantajmy-v-kontejnerah.md) | Внешние рантаймы в отдельных контейнерах | accepted | 2026-11-06 |
| [0014](0014-harbor-registry.md) | Harbor как registry, а не среда запуска | accepted | 2026-11-06 |
| [0019](0019-limity-pamyati-docker.md) | Лимиты памяти для локальных Docker-стеков | accepted | 2026-11-08 |
| [0020](0020-mav-servis-ozvuchki.md) | Сервис озвучки MAV и подбор голоса | accepted | 2026-11-08 |
| [0021](0021-golosovoj-vvod-cherez-mas.md) | Голосовой ввод через локальный MAS | accepted | 2026-11-12 |
