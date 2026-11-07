# 0014. Harbor как registry, а не среда запуска

- **Статус:** accepted
- **Дата:** 2026-11-06

## Контекст

Пользователь спросил, можно ли развернуть Harbor «под запуск сервиса».
Harbor — это registry для Docker/OCI-образов: он хранит и сканирует образы,
но не запускает контейнеры. Смешивать его с песочницей или рантаймами нельзя.

## Решение

Добавить Harbor как отдельный инфраструктурный слой:

- шаблон `infra/harbor/harbor.yml.example` (порт 8088, чтобы не конфликтовать
  с Keycloak и Multica);
- инструкция `infra/harbor/README.md` для WSL2/Git Bash;
- проверка условий `npm run harbor:check`: Docker, Compose, RAM, диск, порт,
  bash/WSL2.

Harbor не включается в `infra/k8s` и не запускается автоматически. На
проверочной машине свободно 19,2 ГБ вместо рекомендуемых 40 ГБ, поэтому живой
прогон не выполнен.

## Альтернативы

| Вариант | Плюсы | Минусы | Почему не выбран |
|---|---|---|---|
| Docker Hub / GHCR | Не нужно ставить | Нет локального контроля | Harbor нужен для self-host |
| Harbor в Kubernetes | Масштабируемо | Нужен кластер и ingress | Отдельный слой |
| Harbor на Docker Compose | Проще локально | Нужен WSL2 и диск | Выбран как инструкция |

## Последствия

- Пользователь получает локальный registry и retention policies.
- Harbor требует ≥ 40 ГБ диска и ≥ 4 ГБ RAM.
- На Windows без WSL2 официальный installer не работает.
- Harbor не заменяет Docker-песочницу и не запускает DeepSeek Harness/Hermes.

## Ссылки

- `infra/harbor/README.md`
- `infra/harbor/harbor.yml.example`
- `scripts/harbor-check.mjs`
