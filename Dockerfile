ARG NODE_IMAGE=node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
ARG PYTHON_IMAGE=python:3.14.6-slim-bookworm@sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8
FROM ${NODE_IMAGE} AS node-runtime
RUN npm install --global npm@11.11.0 --registry=https://registry.npmjs.org
FROM node-runtime AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
FROM manifests AS production-deps
RUN npm ci --omit=dev --registry=https://registry.npmjs.org
FROM manifests AS build
RUN npm ci --registry=https://registry.npmjs.org
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN npm run build

FROM ${PYTHON_IMAGE} AS engines
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /app
COPY runtime/dsh/package.json runtime/dsh/package-lock.json runtime/dsh/
RUN npm ci --prefix runtime/dsh --registry=https://registry.npmjs.org
COPY runtime/hermes runtime/hermes
RUN python3 runtime/hermes/install.py && rm -f .runtime/hermes-*.tar.gz

FROM ${PYTHON_IMAGE} AS application
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 hyper && useradd --uid 10001 --gid 10001 --no-create-home hyper
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /app
COPY --from=production-deps /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/contracts packages/contracts
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=engines --chown=10001:10001 /app/.runtime .runtime
COPY --from=engines /app/runtime/dsh/node_modules runtime/dsh/node_modules
COPY runtime/dsh runtime/dsh
COPY runtime/hermes runtime/hermes
COPY db/migrations db/migrations
COPY ["docs/handoff-v1/AI-IM基线/product-baseline.v1.json", "docs/handoff-v1/AI-IM基线/product-baseline.v1.json"]
COPY scripts/deploy-bootstrap.mjs scripts/worker-health.mjs scripts/
COPY LICENSE ./LICENSE
RUN mkdir -p /var/lib/hyper/runs && chown 10001:10001 /var/lib/hyper/runs && chmod 700 /var/lib/hyper/runs && node --version && python3 --version && dpkg-query -W > /app/runtime/image-packages.txt
ARG VCS_REF=unrecorded
LABEL org.opencontainers.image.title="Hyper Workspace" org.opencontainers.image.source="https://github.com/MkaliezZ/hyper-workspace" org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp/hyper-home
USER 10001:10001
WORKDIR /app/apps/api
EXPOSE 3100
CMD ["node", "--import", "tsx", "dist/main.js"]
