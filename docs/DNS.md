# DNS, доменные имена и hosts

Документ описывает три сценария: локальная машина, локальный Kubernetes и
публичный домен.

## 1. Локальная машина (hosts)

Файл hosts позволяет открывать сервисы по имени без DNS-сервера.

Windows: `C:\Windows\System32\drivers\etc\hosts`
Linux/macOS: `/etc/hosts`

```text
127.0.0.1  mai-code.local
127.0.0.1  keycloak.mai-code.local
127.0.0.1  multica.mai-code.local
127.0.0.1  api.multica.mai-code.local
```

Проверка:

```powershell
ping mai-code.local
curl http://keycloak.mai-code.local:8080/realms/mai-code
```

Ограничения:

- hosts действует только на этой машине;
- для HTTPS нужен локальный сертификат (mkcert) или самоподписанный;
- браузер может ругаться на самоподписанный сертификат.

## 2. Локальный Kubernetes

Ingress-контроллер получает трафик на IP узла. Добавьте в hosts IP узла:

```text
192.168.1.50  keycloak.mai-code.local multica.mai-code.local api.multica.mai-code.local
```

Для k3d узнайте IP:

```powershell
kubectl get nodes -o wide
```

Если Ingress недоступен напрямую, используйте port-forward и `127.0.0.1`.

## 3. Публичный домен

### A-запись

Для IPv4:

```text
mai-code.example.com.        A     203.0.113.10
keycloak.example.com.        A     203.0.113.10
multica.example.com.         A     203.0.113.10
api.example.com.             A     203.0.113.10
```

### CNAME

Для поддомена, который указывает на другой домен:

```text
www.example.com.             CNAME  mai-code.example.com.
docs.example.com.            CNAME  crruton.github.io.
```

CNAME нельзя ставить на apex-домен (`example.com`). Для apex используйте A/AAAA
или ALIAS/ANAME, если провайдер поддерживает.

### AAAA

```text
mai-code.example.com.        AAAA   2001:db8::10
```

## Бесплатные варианты

| Вариант | Пример | Ограничение |
|---|---|---|
| Поддомен GitHub Pages | `crruton.github.io/mai-code` | нет своего apex-домена |
| Cloudflare Pages | `mai-code.pages.dev` | поддомен, не бренд |
| `*.is-a.dev` | `mai-code.is-a.dev` | заявка через PR, без SLA |
| `*.eu.org` | `mai-code.eu.org` | ручное подтверждение, долго |
| DuckDNS | `mai-code.duckdns.org` | динамический DNS |

Бесплатный TLD — это не брендовый `.com`. Для production лучше купить домен.

## TLS

### Let's Encrypt + cert-manager (Kubernetes)

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: traefik
```

В Ingress добавьте аннотацию:

```yaml
cert-manager.io/cluster-issuer: letsencrypt-prod
```

### Локально (mkcert)

```powershell
mkcert -install
mkcert mai-code.local "*.mai-code.local"
```

Укажите полученные файлы в Ingress как TLS-секрет.

## Проверка DNS

```powershell
Resolve-DnsName mai-code.example.com
nslookup keycloak.example.com
curl -I https://mai-code.example.com
```

## Частые ошибки

| Симптом | Причина | Решение |
|---|---|---|
| Домен не открывается | нет A-записи | добавить A на IP |
| `NXDOMAIN` | домен не делегирован | проверить NS у регистратора |
| Сертификат не выпускается | закрыт 80/443 | открыть порты или DNS-01 |
| Работает у вас, не у других | запись в hosts | настроить DNS |
| CNAME на apex | запрещено | A/AAAA или ALIAS |

## Переезд на другой домен

1. Поменяйте A/CNAME.
2. Обновите issuer в Keycloak (`KC_HOSTNAME`).
3. Обновите `appUrl`/`serverUrl` в Multica.
4. Обновите ссылки в `site/` и документации.
5. Выпустите новый сертификат.
6. Проверьте редиректы и cookie-домены.
