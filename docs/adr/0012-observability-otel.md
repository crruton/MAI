# 0012. Observability на OpenTelemetry

- **Статус:** accepted
- **Дата:** 2026-11-06

## Контекст

Нужны логи, метрики и трейсы приложения и внешних рантаймов. Срок хранения —
не более 3 дней. Место хранения логов и трейсов — SeaweedFS. Нужен UI для
трейсов (Arize Phoenix) и дашборды (Grafana).

## Решение

Локальный стек в `infra/observability/`:

- OTel Collector принимает OTLP по gRPC 4317 и HTTP 4318;
- трейсы → Tempo → SeaweedFS (bucket `tempo`), retention 72h;
- логи → Loki → SeaweedFS (bucket `loki`), retention 72h;
- метрики → Prometheus, локальный TSDB, retention 72h;
- Grafana читает Prometheus, Loki и Tempo;
- Phoenix принимает OTLP отдельно, метаданные хранит в Postgres,
  retention 3 дня.

MAI Code отправляет данные через `electron/lib/telemetry.js` — минимальный
OTLP/HTTP-экспортёр без зависимостей. Он пишет лог запуска, ошибки и спаны
`runtime.run`. Секреты маскируются.

## Альтернативы

| Вариант | Плюсы | Минусы | Почему не выбран |
|---|---|---|---|
| Только Tempo + Grafana | Меньше сервисов | Нет логов и метрик | Не покрывает требования |
| Prometheus + Loki + Tempo + Grafana | Полный стек | Больше RAM | Выбран |
| Phoenix как единственное хранилище | Один UI | Нет S3-бэкенда, нет метрик | Не подходит |
| Jaeger вместо Tempo | Зрелый | Нет нативного S3 в этой конфигурации | Tempo проще с SeaweedFS |

## Последствия

- Логи и трейсы старше 72 часов удаляются автоматически.
- Prometheus не умеет S3: метрики лежат в локальном TSDB. Это осознанное
  ограничение, а не ошибка конфигурации.
- Phoenix не хранит трейсы в S3; для долгого хранения используется Tempo.
- Стек требует заметной памяти: на 4 ГБ его поднимают по частям.
- Smoke-тест `npm run obs:smoke` проверяет путь OTLP → Tempo.

## Ссылки

- `docs/OBSERVABILITY.md`
- `infra/observability/README.md`
- `scripts/otel-smoke.mjs`
- `electron/lib/telemetry.js`
