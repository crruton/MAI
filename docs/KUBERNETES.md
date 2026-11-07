# Kubernetes

Серверные сервисы MAI Code можно развернуть в Kubernetes: Keycloak, Postgres,
Multica и будущий web-клиент. Само десктопное приложение остаётся локальным.

## Что лежит в репозитории

```
infra/k8s/
  namespace.yaml
  secrets.example.yaml
  postgres.yaml
  keycloak.yaml
  multica.yaml
  ingress.yaml
  kustomization.yaml
```

Манифесты проверены на живом кластере k3d (k3s v1.35.5): namespace, секрет,
PVC, Keycloak с realm `mai-code`, Multica backend/web и оба Ingress поднялись.

## Проверено на живом кластере

Окружение: Windows 10, Docker Desktop 29.9.2, k3d v5.9.0, k3s v1.35.5.

```powershell
k3d cluster create mai-code --servers 1 --agents 0 --no-lb --no-rollback --wait
kubectl create namespace mai-code
kubectl -n mai-code create secret generic mai-code-secrets `
  --from-literal=POSTGRES_PASSWORD=change-me `
  --from-literal=KEYCLOAK_ADMIN_PASSWORD=change-me `
  --from-literal=KEYCLOAK_DB_PASSWORD=change-me `
  --from-literal=MULTICA_DB_PASSWORD=change-me `
  --from-literal=JWT_SECRET=change-me `
  --from-literal=RESEND_API_KEY= `
  --from-literal=MULTICA_DEV_VERIFICATION_CODE=
kubectl apply -k infra/k8s
kubectl -n mai-code get pods,pvc,ingress
```

Результат: 5 pod'ов `Running`, 3 PVC `Bound`, оба Ingress получили адрес.
Проверка через `kubectl port-forward -n kube-system svc/traefik 18080:80`:

| Запрос | Код |
|---|---|
| `Host: keycloak.mai-code.local` → `/realms/master` | 200 |
| `Host: keycloak.mai-code.local` → `/realms/mai-code` | 200 |
| `Host: api.multica.mai-code.local` → `/healthz` | 200 |
| `Host: multica.mai-code.local` → `/` | 200 |

Уроки живого прогона:

- `$(MULTICA_DB_PASSWORD)` в `DATABASE_URL` раскрывается только если переменная
  объявлена **раньше** в списке `env`. Иначе backend падает с ошибкой пароля.
- Keycloak на 1 vCPU стартует несколько минут (Quarkus augmentation + импорт
  realm). Readiness-проба должна иметь `timeoutSeconds` и запас
  `failureThreshold`, иначе pod мигает `0/1`.
- На Docker Desktop адрес узла `172.22.0.3` с хоста недоступен: Ingress
  проверяется через port-forward на `svc/traefik`, а не напрямую.

## Локальный кластер

### k3d

```powershell
k3d cluster create mai-code --servers 1 --agents 0 --no-lb --wait
kubectl apply -k infra/k8s
kubectl -n mai-code get pods -w
```

`--no-lb` экономит память на слабой машине. Ingress всё равно работает через
Traefik внутри кластера; снаружи — `kubectl port-forward -n kube-system
svc/traefik 18080:80`.

### kind

```powershell
kind create cluster --name mai-code
kubectl apply -k infra/k8s
```

Для доступа к Ingress добавьте port-forward:

```powershell
kubectl -n mai-code port-forward svc/keycloak 8080:8080
kubectl -n mai-code port-forward svc/multica-web 3000:3000
```

## Секреты

```powershell
kubectl create namespace mai-code
kubectl -n mai-code create secret generic mai-code-secrets `
  --from-literal=POSTGRES_PASSWORD="<случайный пароль>" `
  --from-literal=KEYCLOAK_ADMIN_PASSWORD="<случайный пароль>" `
  --from-literal=JWT_SECRET="<случайный пароль>"
```

`secrets.example.yaml` содержит только заглушки. Не коммитьте реальные значения.

## Бесплатное облако

| Провайдер | Что бесплатно | Ограничения |
|---|---|---|
| Oracle Cloud Always Free | 4 OCPU / 24 ГБ ARM, 200 ГБ | нужна карта, регион, ручная настройка |
| Google GKE | пробный кредит, один zonal cluster | кредит кончается, узлы платные |
| Civo | пробный период | после пробного — платно |
| k3s на своём сервере | ПО бесплатно | сервер и электричество платные |

Рекомендуемый путь: **Oracle Cloud Always Free + k3s**. Это даёт бесплатный
кластер на ARM, но требует ручной установки k3s и Ingress.

```bash
# на VM Oracle (Ubuntu ARM)
curl -sfL https://get.k3s.io | sh -
sudo kubectl get nodes
```

Затем примените манифесты и настройте DNS (см. `docs/DNS.md`).

## Ingress и TLS

В `ingress.yaml` используются хосты:

- `keycloak.mai-code.local`
- `multica.mai-code.local`
- `api.multica.mai-code.local`

Для локального кластера добавьте их в `hosts`. Для облака замените на реальные
домены и выпустите сертификат через cert-manager + Let's Encrypt.

Let's Encrypt не выдаёт сертификаты для `.local`. В локальном кластере либо
уберите TLS-блок из `ingress.yaml`, либо выпустите самоподписанный сертификат
через mkcert и создайте секрет вручную.

## Переезд в облако

1. Создайте кластер (k3s, GKE, Civo).
2. Установите Ingress-контроллер.
3. Создайте namespace и секреты.
4. Примените `kubectl apply -k infra/k8s`.
5. Настройте DNS A-записи на IP Ingress.
6. Выпустите TLS.
7. Проверьте `kubectl get pods`, `/healthz`, вход в Keycloak и Multica.

## Ограничения

- Postgres в манифестах — один pod без репликации. Для production нужен
  managed Postgres или operator.
- Нет backup/restore.
- Нет HPA, PodDisruptionBudget и network policies.
- Образы Keycloak/Multica используют теги `latest` или конкретные версии; перед
  production зафиксируйте digest.
- Ресурсы (requests/limits) — примерные.
- Кластер проверялся на Docker Desktop с 1 server и без load balancer; это
  smoke-проверка, а не production-профиль.

## Проверка манифестов без кластера

```powershell
kubectl apply --dry-run=client -k infra/k8s
kubectl kustomize infra/k8s | Out-Null
```
