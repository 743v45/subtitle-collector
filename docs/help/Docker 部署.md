# Docker 部署

长期挂机采集用 docker compose,一条命令起生产。

相关:[[环境变量]]、[[测试与质量门]](部署后自检)

## 启动

```bash
docker compose up -d --build
```

**先改 token**(compose 默认值是占位符,不改动等于裸奔):

```bash
# 仓库根放 .env:
COLLECTOR_TOKEN=<node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 的输出>
# 从局域网 IP/主机名访问再加:
COLLECTOR_ALLOWED_HOSTS=192.168.1.5
```

## 部署后自检

```bash
pnpm verify:deployed -- --token <t> [--server <url>] [--via-docker [容器名] | --db <库路径>]
```

跑 `/ping` + 核心只读 API + SQLite `integrity_check`。**坏页损坏 HTTP 探活测不出**,要测库完整性必须带 DB 层检查(2026-08-24 生产库 SQLITE_CORRUPT 事故的产物):生产库在 named volume 里宿主机无文件,容器在跑用 `--via-docker`(经 docker exec 容器内校验,缺省容器名 collector-server);`--db` 只适用于导出的备份文件,两项同传报参数错。

> [!danger] 数据卷红线:禁 bind mount,只用 named volume
> 数据库走 named volume `collector-data` → `/data`,不进镜像不经 bind mount。原因:bind mount 走 virtiofs,SQLite WAL 的 mmap(-shm) 跨虚拟机共享一致性有缺陷,宿主机进程直触挂载库(哪怕只读)两次引发 **SQLITE_CORRUPT**(曾丢当日数据)。
> 查生产库一律走 server HTTP / CLI,或 `docker exec collector-server node -e '...'`——宿主机上不存在该文件,误操作路径物理封死。

## 备份

| 层 | 机制 |
|---|---|
| 自动 | server 内置定时容器内 `VACUUM INTO /data/backups/`,分层滚动清理(备份间隔/保留份数/保留天数的**参数单源见 [backup.ts](../../apps/collector-server/src/db/backup.ts)**,此处不复述数字;`COLLECTOR_BACKUP_INTERVAL_MS` 可调) |
| 导出宿主 | `node scripts/backup-export.mjs`(docker cp 拷出 volume) |
| 告警 | 备份连续失败 ≥2 次推飞书自定义 bot(`COLLECTOR_BACKUP_WEBHOOK_URL`,缺省只打日志) |

## 扩展侧配合

server 上云/换机后,在扩展 popup 服务器配置里把 URL 改成新地址(token 模式带 `?token=xxx`),详见 [[客户端与任务派发]]。

## 容器内直接执行 CLI

```bash
docker exec collector-server node dist/cli/main.js videos list --size 5
```

## 控制面安全边界(2026-10-04 拍板:接受现状)

鉴权门(暴露部署下 `HTTP_AUTH_REQUIRED`,Bearer)的设计目标是**防浏览器侧风险**(DNS rebinding、跨站误配),不是防局域网主动攻击者:

- **实证**:同源放行路只比对 Origin 与 Host 的 hostname,而这两个头皆可伪造——无 token 请求会 401,但补上伪造头即整体绕过:

  ```bash
  curl -H 'Host: localhost:21527' -H 'Origin: http://localhost' http://<LAN-IP>:21527/api/clients   # → 200
  ```

  LAN 内主动攻击者可免 token 访问全部 `/api/*`(含 `/command` 驱动扩展)。
- **已评估三个封堵方案**(绑 127.0.0.1 / 恒 Bearer + web 录 token / 接受现状):前两者破坏零配置,且 LAN 明文 HTTP 下主动攻击者本可嗅探 token,header 层不可修——**接受现状**。
- **WS `/ext` 侧不受影响**:hello token 闸是独立校验,无同源放行路。
- **异常观测**:401 结构化日志(不含 token,只记 hasBearer 布尔):

  ```bash
  docker logs collector-server 2>&1 | grep '\[http\] 401'
  # [http] 401 method=GET url=/api/clients host=... originHostname=... secFetchSite=... hasBearer=false
  ```
