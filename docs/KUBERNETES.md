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

Манифесты проверены синтаксически, **не на живом кластере**. Это шаблон, а не
готовый production-профиль.

## Локальный кластер

### k3d

```powershell
k3d cluster create mai-code --agents 1 -p "8080:80@loadbalancer" -p "8443:443@loadbalancer"
kubectl apply -k infra/k8s
kubectl -n mai-code get pods -w
```

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
- Локальный кластер не проверялся в этой среде.

## Проверка манифестов без кластера

```powershell
kubectl apply --dry-run=client -k infra/k8s
kubectl kustomize infra/k8s | Out-Null
```
