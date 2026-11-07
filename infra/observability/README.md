# Observability: OpenTelemetry, Loki, Prometheus, Tempo, Grafana, Phoenix

Стек поднимается одним compose-файлом и хранит логи и трейсы не дольше
**72 часов**. Логи и трейсы лежат в **SeaweedFS (S3)**, метрики — в локальном
TSDB Prometheus (нативного S3-бэкенда у Prometheus нет).

## Быстрый старт

```powershell
Copy-Item infra/observability/.env.example infra/observability/.env
npm run obs:up
npm run obs:smoke
```

| Сервис | Адрес | Назначение |
|---|---|---|
| Grafana | http://localhost:3001 | Дашборды, Explore |
| Prometheus | http://localhost:9090 | Метрики, 72h |
| Loki | http://localhost:3100 | Логи, 72h |
| Tempo | http://localhost:3200 | Трейсы, 72h |
| Arize Phoenix | http://localhost:6006 | Трейсы/eval UI |
| OTel Collector | localhost:4317 (gRPC), localhost:4318 (HTTP) | Приём OTLP |
| SeaweedFS S3 | http://localhost:18333 | Бакеты `loki`, `tempo`, `phoenix` |

Порты SeaweedFS у стека наблюдаемости сдвинуты на `18333/18888/19333`, чтобы не
конфликтовать с основным SeaweedFS приложения (`8333/8888/9333` из
`infra/docker-compose.yml`). Внутри compose-сети адрес остаётся
`seaweedfs:8333`.

Grafana: `admin` / `OBS_GRAFANA_PASSWORD` (по умолчанию `admin` — смените).
S3-ключи для локального стека: `mai-code` / `mai-code-secret`
(`infra/observability/seaweedfs-s3.json`).

## Куда что пишется

```
приложение/агент
   │ OTLP 4317/4318
   ▼
OTel Collector ── traces ──► Tempo ──► SeaweedFS (bucket tempo, 72h)
               ├─ logs   ──► Loki  ──► SeaweedFS (bucket loki, 72h)
               └─ metrics ─► Prometheus :8889 ──► локальный TSDB (72h)
Grafana читает Prometheus + Loki + Tempo.
Phoenix принимает OTLP отдельно (порт 6006) и хранит метаданные в Postgres.
```

## Срок хранения

| Данные | Где задаётся | Значение |
|---|---|---|
| Логи | `loki-config.yaml` → `limits_config.retention_period`, `compactor` | `72h` |
| Трейсы | `tempo.yaml` → `compactor.compaction.block_retention` | `72h` |
| Метрики | `docker-compose.yml` → `--storage.tsdb.retention.time` | `72h` |
| Phoenix | `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS` | `3` |

Loki удаляет старые чанки компактором (интервал 10 минут). Tempo удаляет
блоки при компакции. Prometheus удаляет блоки TSDB по retention.

## Arize Phoenix: важное ограничение

Phoenix — это UI/evals для трейсов, а не объектное хранилище. Его метаданные
(проекты, спаны, оценки) живут в Postgres, потому что upstream Phoenix не
умеет хранить их в S3. Трейсы, которые нужны для долгого хранения и поиска,
идут в Tempo → SeaweedFS. Если нужен именно S3-бэкенд для Phoenix, это
потребует внешнего экспортёра/ETL — в текущем стеке не реализовано.

## Отправка данных из MAI Code

Любой процесс может отправлять OTLP на `http://127.0.0.1:4318`:

```powershell
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
$env:OTEL_SERVICE_NAME = "mai-code"
```

Проверка: `npm run obs:smoke` отправляет trace и лог, затем ждёт, пока Tempo
вернёт trace по ID. Если Tempo не отвечает, смотрите логи:

```powershell
docker compose -f infra/observability/docker-compose.yml logs tempo otel-collector loki
```

## Остановка и очистка

```powershell
npm run obs:down
docker compose -f infra/observability/docker-compose.yml down -v   # вместе с данными
```

## Ресурсы

Стек рассчитан на локальную машину: SeaweedFS + Loki + Tempo + Prometheus +
Grafana + Phoenix + Postgres. Комфортно с 8 ГБ свободной RAM; на 4 ГБ
поднимайте сервисы по частям.
