# Образ MAI Ship (E3.A5, ADR 0126): роли ревьюер, approver, steward и отчёт без Electron.
#
#   docker build -f ci/ship.Dockerfile -t mai-ship .
#   docker run --rm -e GITLAB_TOKEN -e SHIP_REVIEWER_BASE_URL -e SHIP_REVIEWER_API_KEY \
#     mai-ship mai ship review --mr https://gitlab.example/group/app/-/merge_requests/7 --dry-run
#
# В GitLab CI — переменная MAI_SHIP_IMAGE (ci/mai-ship.gitlab-ci.yml): джоба не клонирует MAI.
# ENTRYPOINT не задан: GitLab запускает в образе свою оболочку.
# Базовый образ — аргументом: без доступа к Docker Hub — зеркало или прокси-кэш Harbor, например
#   --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-alpine --build-arg ALPINE_IMAGE=mirror.gcr.io/library/alpine:3.24
#
# Размер (ADR 0126, дополнение): alpine вместо debian-slim; итоговый слой — чистый alpine, в него
# копируется только бинарник node (npm, corepack и yarn не попадают); из node_modules убраны типы,
# sourcemap и markdown (лицензии остаются); mermaid удалён из зависимостей MAI (ADR 0127); из
# исходников — только electron/lib. Итог: 272 МБ (64 МБ сжато) вместо 837 МБ.
ARG NODE_IMAGE=node:24-alpine
# Та же версия alpine, что у NODE_IMAGE: бинарник node собран под её musl и libstdc++.
ARG ALPINE_IMAGE=alpine:3.24

FROM ${NODE_IMAGE} AS deps
WORKDIR /opt/mai
COPY package.json package-lock.json ./
# Electron — devDependency: не ставится. Скрипты пакетов не запускаются.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' -o -name '*.markdown' -o -name '*.ts.map' \) -delete \
  && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} + \
  && rm -rf node_modules/.package-lock.json

FROM ${ALPINE_IMAGE}
# git — steward'у (коммит и push в ветку MR); ca-certificates — HTTPS к GitLab и шлюзам моделей;
# libstdc++ и libgcc — зависимости бинарника node.
RUN apk add --no-cache git ca-certificates libstdc++ libgcc
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

WORKDIR /opt/mai
COPY --from=deps /opt/mai/node_modules ./node_modules
COPY package.json ./
COPY electron/lib ./electron/lib
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
