# Caddy 内网域名网关(collector.taevas.host)— 设计

日期:2026-08-19
状态:已确认(方案 A:独立 caddy docker 栈作常驻网关,子域名分发)

## 背景

collector-server 跑在本机 docker(宿主端口 21527),其他设备/服务只能靠 `10.0.0.100:21527` 直连。需求:用 caddy 搭常驻网关,按 `*.taevas.host` 子域名分发到本机各服务,首个接入 collector-server(域名 `collector.taevas.host`,用户定名,非早期 [.env](../../../.env) 注释里的 `collector.work.taevas.host`),以后其他服务继续挂子域名。

## 网络前提(已与用户确认)

- `taevas.host` 为真实注册域名,但**不走公网 DNS**:各客户端用本地 hosts 把子域名指到 `10.0.0.100`。
- 纯内网访问、无公网入口 → caddy 的 ACME 自动 HTTPS 不可用,走 **HTTP**。
- `10.0.0.100` 须为这台 Mac 的固定局域网 IP(路由器静态 DHCP / DHCP 保留)。

## 架构决策(方案对比)

| 方案 | 结论 |
|---|---|
| **A. 独立 caddy docker 栈(选定)** | 项目外 `~/Code/caddy/` 放 compose + Caddyfile,监听 80/443。macOS 上 docker 绑特权端口免 root;网关职责独立于任何单项目仓库;反代宿主服务走 `host.docker.internal`,反代 docker 服务共用网络,扩展性最好 |
| B. brew 宿主机 caddy | 配置最少,但 macOS 绑 80 需 root/launchd 特权配置,与现有 docker 部署习惯割裂 |
| C. 不加 caddy,维持 IP:端口直连 | 零成本但不满足「常驻网关 + 子域名分发」,`.env` 预埋的 ALLOWED_HOSTS 规划也作废 |

## 设计

### 1. 网关栈(项目外,`~/Code/caddy/`)

```yaml
# docker-compose.yml
services:
  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"   # 先占位,内网暂不用(未来 internal CA/穿透时启用)
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
volumes:
  caddy_data:
```

```nginx
# Caddyfile
{
	auto_https off
}

collector.taevas.host {
	reverse_proxy host.docker.internal:21527
}
# 以后加服务:X.taevas.host { reverse_proxy ... }
```

要点:
- `auto_https off`:全局禁 ACME,以后加站点不用逐个写 `http://` 前缀。
- `reverse_proxy` 默认保留原 Host 头(`collector.taevas.host`)→ 与 collector-server 的 `COLLECTOR_ALLOWED_HOSTS` 放行逻辑天然对齐;WebSocket(`/ext`)原生透传,无需额外配置。
- `host.docker.internal`:Docker Desktop / OrbStack / colima 默认均支持,从 caddy 容器回连宿主映射端口。
- 更新 Caddyfile 后重载:`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`(不断流)。

### 2. 本仓库改动(仅一处,且不入库)

[.env](../../../.env) 的 `COLLECTOR_ALLOWED_HOSTS`:`collector.work.taevas.host,10.0.0.100` → `collector.taevas.host,10.0.0.100`(同步更新注释里的域名字样)。

- `.env` 已被 .gitignore 排除,该改动只存在于本机部署,不进 git。
- server 侧无需改代码:[main.ts:22-45](../../../apps/collector-server/src/main.ts#L22) 的 Host/Origin 双校验已就绪。
- 生效方式:`docker compose up -d`(collector-server 环境变量变更需重建容器)。

### 3. 客户端接入

每台要访问的设备在 hosts 加:

```
10.0.0.100 collector.taevas.host
```

- macOS/Linux:`/etc/hosts`;Windows:`C:\Windows\System32\drivers\etc\hosts`;iOS/Android 需能改 hosts 的工具或路由器侧 DNS,按设备另议。
- 之后统一用 `http://collector.taevas.host`(API `http://collector.taevas.host/api/*`,WS `ws://collector.taevas.host/ext`)。
- 浏览器扩展(其他机器上的 subtitle-collector)把 server 地址配为上述域名。

### 4. 前置条件 / 风险

- **固定 IP**:路由器为这台 Mac 做 DHCP 保留,否则 IP 漂移后所有客户端 hosts 失效。
- **macOS 防火墙**:若开启,需放行 80 端口入站(系统设置 → 网络 → 防火墙)。
- **80 端口冲突**:启动前确认宿主 80 未被占用(`lsof -i :80`)。
- **安全边界**:server 仅监听内网,且受 `COLLECTOR_TOKEN` 鉴权 + Host/Origin 白名单双护;caddy 不对外暴露管理端口。

## 不做(YAGNI)

- 不做 HTTPS:内网自签需往每台设备装根证书,扩展走 `http://`/`ws://` 完全够用;443 仅占位。
- 不做公网解析/DDNS/穿透(明确不走公网)。
- 不做泛域名自动配置:每加一个服务,手动加一段站点块 + 客户端 hosts 加一行。
- 不把 caddy 并进本仓库 docker-compose.yml(网关是机器级设施,不属于 subtitle-collector 项目)。

## 测试轮次记录表

| 轮次 | 命令 / 操作 | 结果 |
|---|---|---|
| 1 | 网关栈起来后本机验证:hosts 加 `127.0.0.1 collector.taevas.host`,`curl -i http://collector.taevas.host/api/creators?limit=1` 返回 collector-server JSON(非 caddy 404) | 待实施填写 |
| 2 | WS 透传验证:模拟扩展握手 `ws://collector.taevas.host/ext`(verify 脚本或浏览器扩展真连) | 待实施填写 |
| 3 | Host/Origin 校验:用未放行 Host 头 curl → 403;`COLLECTOR_ALLOWED_HOSTS` 生效确认 | 待实施填写 |
| 4 | 持久性:`docker compose restart` / 重启 Docker 后 caddy 自动拉起(restart: unless-stopped) | 待实施填写 |

版本:不涉及 subtitle-collector 扩展改动,manifest 不 bump。
