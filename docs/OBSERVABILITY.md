# Observability: OpenTelemetry, Loki, Prometheus, Tempo, Grafana, Phoenix

Стек поднимается из `infra/observability/`. Логи и трейсы хранятся **не более
72 часов** (3 дня). Логи и трейсы лежат в **SeaweedFS (S3)**, метрики — в
локальном TSDB Prometheus: нативного S3-бэкенда у Prometheus нет.

## Быстрый старт

```powershell
Copy-Item infra/observability/.env.example infra/observability/.env
npm.cmd run obs:up
npm.cmd run obs:smoke
```

| Сервис | Адрес | Назначение |
|---|---|---|
| Grafana | http://localhost:3001 | Дашборды, Explore |
| Prometheus | http://localhost:9090 | Метрики, 72h |
| Loki | http://localhost:3100 | Логи, 72h |
| Tempo | http://localhost:3200 | Трейсы, 72h |
| Arize Phoenix | http://localhost:6006 | Трейсы и eval UI |
| OTel Collector | `localhost:4317` (gRPC), `localhost:4318` (HTTP) | Приём OTLP |
| SeaweedFS S3 | http://localhost:18333 | Бакеты `loki`, `tempo`, `phoenix` |

Порты SeaweedFS у стека наблюдаемости сдвинуты на `18333/18888/19333`, чтобы не
конфликтовать с основным SeaweedFS приложения (`8333/8888/9333` из
`infra/docker-compose.yml`). Внутри compose-сети сервисы обращаются к
`seaweedfs:8333`.

Grafana: `admin` / `OBS_GRAFANA_PASSWORD` (по умолчанию `admin` — смените).
S3-ключи локального стенда: `mai-code` / `mai-code-secret`
(`infra/observability/seaweedfs-s3.json`).

## Схема

```
приложение / агент / рантайм
   │ OTLP 4317/4318
   ▼
OTel Collector ── traces ──► Tempo ──► SeaweedFS (bucket tempo, 72h)
               ├─ logs   ──► Loki  ──► SeaweedFS (bucket loki, 72h)
               └─ metrics ─► Prometheus :8889 ──► локальный TSDB (72h)
Grafana читает Prometheus + Loki + Tempo.
Phoenix принимает OTLP отдельно и хранит метаданные в Postgres.
```

## Сроки хранения

| Данные | Где задаётся | Значение |
|---|---|---|
| Логи | `loki-config.yaml` → `limits_config.retention_period`, `compactor` | `72h` |
| Трейсы | `tempo.yaml` → `compactor.compaction.block_retention` | `72h` |
| Метрики | `docker-compose.yml` → `--storage.tsdb.retention.time` | `72h` |
| Phoenix | `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS` | `3` |

Loki удаляет старые чанки компактором (интервал 10 минут). Tempo удаляет
блоки при компакции. Prometheus удаляет блоки TSDB по retention.

## Отправка из MAI Code

В приложении: **Настройки → OpenTelemetry** → включить и указать endpoint.

Или через окружение:

```powershell
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
$env:OTEL_SERVICE_NAME = "mai-code"
```

`electron/lib/telemetry.js` — минимальный OTLP/HTTP-экспортёр без внешних
зависимостей. Он отправляет:

- лог запуска приложения;
- ошибки (`logError`) с маскированием секретов;
- спаны `runtime.run` для каждого запуска внешнего рантайма (одиночного и
  параллельного).

Отправка не блокирует UI: ошибки сети игнорируются.

## Проверка

```powershell
npm.cmd run obs:smoke
```

Скрипт отправляет тестовый trace и лог в OTLP, затем ждёт, пока Tempo вернёт
trace по ID. Если Tempo не отвечает:

```powershell
docker compose -f infra/observability/docker-compose.yml logs tempo otel-collector loki
```

### Уроки запуска

- `minio/mc` больше недоступен в Docker Hub, а `quay.io/minio/mc` отдаёт 401.
  Бакеты создаёт `seaweedfs-init` через `weed shell` из образа SeaweedFS.
- Порты SeaweedFS сдвинуты на `18333/18888/19333`, иначе конфликт с основным
  SeaweedFS приложения.
- Стек тяжёлый: при 5,9 ГБ RAM его нельзя поднимать одновременно с локальным
  Kubernetes-кластером и десятками других контейнеров.

## Arize Phoenix: ограничение

Phoenix — UI и evals для трейсов, а не объектное хранилище. Его метаданные
(проекты, спаны, оценки) живут в Postgres, потому что upstream Phoenix не умеет
хранить их в S3. Трейсы для долгого хранения и поиска идут в Tempo → SeaweedFS.
Для S3-бэкенда именно Phoenix нужен внешний экспортёр/ETL; в текущем стеке его
нет.

## Остановка и очистка

```powershell
npm.cmd run obs:down
docker compose -f infra/observability/docker-compose.yml down -v   # вместе с данными
```

## Ресурсы

Стек рассчитан на локальную машину. Комфортно с 8 ГБ свободной RAM; на 4 ГБ
поднимайте сервисы по частям. Phoenix + Postgres и SeaweedFS + Loki + Tempo +
Prometheus + Grafana вместе занимают заметную часть памяти.
