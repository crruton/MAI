# Harbor под MAI Code

Harbor — это **registry** для Docker/OCI-образов, а не среда запуска
сервисов. Он не заменяет Docker-песочницу и не «запускает» DeepSeek Harness
или Hermes. Его задачи: хранить образы MAI Code и рантаймов, сканировать их
Trivy, раздавать по ролям и подписывать.

## Можно ли развернуть локально

Да, при условиях:

- Docker Desktop с WSL2 (Harbor installer — bash-скрипт, нативный PowerShell
  не поддерживается);
- ≥ 4 ГБ RAM свободно (лучше 8 ГБ), ≥ 40 ГБ диска;
- свободный порт (в примере `8088`, чтобы не конфликтовать с Keycloak/Multica);
- Git Bash или WSL2 для `install.sh`.

Проверка машины:

```powershell
npm run harbor:check
```

## Установка (WSL2 / Git Bash)

```bash
# 1. Скачать online installer (подставьте актуальную версию)
curl -fsSL -o harbor.tgz \
  https://github.com/goharbor/harbor/releases/download/v2.13.0/harbor-online-installer-v2.13.0.tgz

# 2. Распаковать
tar -xzf harbor.tgz
cd harbor

# 3. Конфигурация
cp /mnt/c/Users/User/Desktop/dev/mai-code/infra/harbor/harbor.yml.example harbor.yml
# отредактируйте hostname, пароли и data_volume

# 4. Установка (нужен sudo)
sudo ./install.sh
```

Проверка:

```bash
curl -u admin:Harbor12345 http://localhost:8088/api/v2.0/systeminfo
```

Web UI: http://localhost:8088 (`admin` / пароль из `harbor.yml`).

## Работа с образами MAI Code

```bash
docker login localhost:8088 -u admin
docker tag mai-code:0.1.0 localhost:8088/mai-code/mai-code:0.1.0
docker push localhost:8088/mai-code/mai-code:0.1.0
```

Для локального HTTP-registry Docker Desktop должен разрешать insecure
registry: Settings → Docker Engine → `"insecure-registries": ["localhost:8088"]`.

## Очистка старых образов

Harbor умеет retention policies и tag immutability:

- Project → `mai-code` → Policy → Tag Retention: оставлять 2 последних тега;
- Policy → Tag Immutability: запретить перезапись релизных тегов.

Локальный Docker тоже чистится скриптом:

```powershell
npm run docker:gc:dry
npm run docker:gc
```

## Ограничения

- Harbor не запускает контейнеры. Для запуска рантаймов используйте режим
  `docker` в панели «Рантаймы» или Docker-песочницу.
- Trivy-сканеру нужны обновления БД и заметный объём диска.
- На Windows без WSL2 официальный installer не работает; альтернатива —
  Harbor в Kubernetes (Helm-чарт `harbor/harbor`), но это уже отдельный
  кластер и ingress.
