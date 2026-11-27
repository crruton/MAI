# Образ MAI Ship (E3.A5, ADR 0126): роли ревьюер, approver, steward и отчёт без Electron.
#
#   docker build -f ci/ship.Dockerfile -t mai-ship .
#   docker run --rm -e GITLAB_TOKEN -e SHIP_REVIEWER_BASE_URL -e SHIP_REVIEWER_API_KEY \
#     mai-ship mai ship review --mr https://gitlab.example/group/app/-/merge_requests/7 --dry-run
#
# В GitLab CI — переменная MAI_SHIP_IMAGE (ci/mai-ship.gitlab-ci.yml): джоба не клонирует MAI.
# ENTRYPOINT не задан: GitLab запускает в образе свою оболочку.
# Базовый образ — аргументом: без доступа к Docker Hub — зеркало или прокси-кэш Harbor, например
#   --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-slim
ARG NODE_IMAGE=node:24-slim
FROM ${NODE_IMAGE}

# git нужен steward'у (коммит и push в ветку MR); ca-certificates — для HTTPS к GitLab и шлюзам.
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mai
COPY package.json package-lock.json ./
# Electron — devDependency: в образ не ставится. Скрипты пакетов не запускаются.
# mermaid (~170 МБ с зависимостями) рисует схемы в окне — ролям Ship не нужен.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm uninstall --ignore-scripts --no-audit --no-fund mermaid \
  && npm cache clean --force

COPY electron ./electron
COPY bin ./bin
COPY scripts/mai-ship.mjs ./scripts/mai-ship.mjs
# Обёртка, а не ссылка на bin/mai.mjs: shebang из рабочей копии Windows (CRLF) в Linux не работает.
RUN printf '#!/bin/sh\nexec node /opt/mai/bin/mai.mjs "$@"\n' > /usr/local/bin/mai && chmod +x /usr/local/bin/mai

# Данные цикла агента (без Electron, ADR 0122) — во временной папке контейнера.
ENV MAI_DATA_DIR=/tmp/mai-data NODE_ENV=production
LABEL org.opencontainers.image.title="mai-ship" \
      org.opencontainers.image.description="MAI Ship: ревьюер, approver и steward MR для GitLab CI" \
      org.opencontainers.image.source="https://github.com/crruton/MAI" \
      org.opencontainers.image.licenses="MIT"

CMD ["mai", "ship", "--help"]
