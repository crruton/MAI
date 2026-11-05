# Keycloak: локальный запуск

## Запуск

```powershell
docker compose -f infra/keycloak/docker-compose.yml up -d
```

Проверка:

```powershell
curl http://localhost:8080/realms/mai-code/.well-known/openid-configuration
```

Остановка:

```powershell
docker compose -f infra/keycloak/docker-compose.yml down
```

Данные Postgres сохраняются в томе `keycloak-db`. Удалить их:

```powershell
docker compose -f infra/keycloak/docker-compose.yml down -v
```

## Пользователи

Realm `mai-code` импортируется при первом старте. Пользователи:

| Логин | Email | Роль | Пароль |
|---|---|---|---|
| `admin` | `admin@mai-code.local` | admin | `admin` |
| `guest` | `guest@mai-code.local` | guest | `guest` |
| `letun82` | `letun82@mail.ru` | admin | `ChangeMe-letun82!` (временный) |

Пароль `letun82` временный: Keycloak потребует сменить его при первом входе.
Пароли `admin`/`guest` — только для локальной проверки. Смените их перед
публикацией.

## Добавить пользователя

Через Admin Console: http://localhost:8080/admin → realm `mai-code` →
Users → Add user. Затем вкладка Credentials → Set password и Role mapping →
realm role `admin` или `guest`.

Через CLI:

```powershell
docker exec -it mai-code-keycloak /opt/keycloak/bin/kcadm.sh config credentials `
  --server http://localhost:8080 --realm master --user admin --password change-me

docker exec -it mai-code-keycloak /opt/keycloak/bin/kcadm.sh create users `
  -r mai-code -s username=ivan -s email=ivan@example.com -s enabled=true

docker exec -it mai-code-keycloak /opt/keycloak/bin/kcadm.sh set-password `
  -r mai-code --username ivan --new-password 'ChangeMe-123!'
```

## Postgres

| Параметр | Значение |
|---|---|
| Host | `postgres:5432` (внутри compose) |
| Database | `keycloak` |
| User | `keycloak` |
| Password | `keycloak-dev-password` (по умолчанию) |

Проверка:

```powershell
docker exec -it mai-code-keycloak-db psql -U keycloak -d keycloak -c "\dt"
```

## Клиент приложения

- Client ID: `mai-code-desktop`
- Тип: public
- Flow: Device Authorization Grant
- PKCE: S256
- Issuer: `http://localhost:8080/realms/mai-code`

## Ограничения

- `start-dev` не для production: нет TLS, кэширования, кластера.
- Пароли в compose — значения по умолчанию для локальной машины.
- Realm-файл — начальная конфигурация. После первого старта изменения живут
  в Postgres, а не в JSON.
- Нет бэкапа и ротации ключей.
