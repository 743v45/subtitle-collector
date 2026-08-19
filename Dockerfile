# collector-server 单容器镜像：
#   - 编译 TS → dist（node 运行，不带 tsx）
#   - build collector-web → 作为 server 静态托管的 public/
#   - better-sqlite3 原生模块在 builder 编译，runtime 仅需 node
# 数据库走 COLLECTOR_DB_PATH（默认 /data），由 compose 挂载到宿主，不进镜像。
#
# 关键：builder 用「空根 package.json」——真实根 package.json 的 devDependencies
# (puppeteer/turbo/ws)在镜像里毫无用处，puppeteer 还会下载 chrome。空根让 pnpm
# 只装 collector-server / collector-web 自己的依赖。

########## Stage 1: build collector-web 静态产物 ##########
FROM node:22-slim AS web
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
# hoisted：node_modules 扁平化，便于跨 stage COPY（避免 pnpm 符号链接断裂）
RUN printf 'node-linker=hoisted\nconfirm-modules-purge=false\n' > .npmrc
COPY pnpm-workspace.yaml ./
RUN printf '{"name":"bilibili-extensions","private":true}\n' > package.json
COPY apps/collector-web/package.json apps/collector-web/package.json
COPY apps/collector-server/package.json apps/collector-server/package.json
RUN pnpm install --filter @bilibili-ext/collector-web
COPY apps/collector-web/ apps/collector-web/
RUN pnpm --filter @bilibili-ext/collector-web build

########## Stage 2: build collector-server（编译 TS + 裁剪 prod 依赖） ##########
FROM node:22-slim AS server
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate && \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
RUN printf 'node-linker=hoisted\nconfirm-modules-purge=false\n' > .npmrc
COPY pnpm-workspace.yaml ./
RUN printf '{"name":"bilibili-extensions","private":true}\n' > package.json
COPY apps/collector-server/package.json apps/collector-server/package.json
# 装全量（含 server devDeps：typescript/tsx）用于 build
RUN pnpm install --filter @bilibili-ext/collector-server
COPY apps/collector-server/ apps/collector-server/
RUN pnpm --filter @bilibili-ext/collector-server build
# 覆盖为 prod-only（移除 typescript/tsx 等 devDeps），保留已编译的 better-sqlite3。
# 注意：pnpm 9 没有 `prune --prod`，用 `install --prod` 重新求解依赖图。
RUN pnpm install --filter @bilibili-ext/collector-server --prod

########## Stage 3: runtime ##########
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    COLLECTOR_HOST=0.0.0.0 \
    COLLECTOR_DB_PATH=/data/bilibili-collector.db
COPY --from=server /repo/apps/collector-server/dist ./dist
COPY --from=server /repo/node_modules ./node_modules
COPY --from=server /repo/apps/collector-server/package.json ./package.json
COPY --from=web /repo/apps/collector-server/public ./public
EXPOSE 21527
VOLUME ["/data"]
# /ping 不走 origin 校验，可作健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:21527/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
