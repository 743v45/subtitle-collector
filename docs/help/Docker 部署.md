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
pnpm verify:deployed -- --token <t> [--server <url>] [--db <库路径>]
```

跑 `/ping` + 核心只读 API + SQLite `integrity_check`。**坏页损坏 HTTP 探活测不出**,要测库完整性必须带 `--db`(2026-08-24 生产库 SQLITE_CORRUPT 事故的产物)。

> [!danger] 数据卷红线:禁 bind mount,只用 named volume
> 数据库走 named volume `collector-data` → `/data`,不进镜像不经 bind mount。原因:bind mount 走 virtiofs,SQLite WAL 的 mmap(-shm) 跨虚拟机共享一致性有缺陷,宿主机进程直触挂载库(哪怕只读)两次引发 **SQLITE_CORRUPT**(曾丢当日数据)。
> 查生产库一律走 server HTTP / CLI,或 `docker exec collector-server node -e '...'`——宿主机上不存在该文件,误操作路径物理封死。

## 备份

| 层 | 机制 |
|---|---|
| 自动 | server 内置每小时容器内 `VACUUM INTO /data/backups/`,滚动 24 份 |
| 导出宿主 | `node scripts/backup-export.mjs`(docker cp 拷出 volume) |
| 告警 | 备份连续失败 ≥2 次推飞书自定义 bot(`COLLECTOR_BACKUP_WEBHOOK_URL`,缺省只打日志) |

## 扩展侧配合

server 上云/换机后,在扩展 popup 服务器配置里把 URL 改成新地址(token 模式带 `?token=xxx`),详见 [[客户端与任务派发]]。

## 容器内直接执行 CLI

```bash
docker exec collector-server node dist/cli/main.js videos list --size 5
```
