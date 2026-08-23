---
name: collector
description: Use when 在本仓库需要调度字幕采集链路或消费字幕数据——查视频/字幕/统计、批量采集(B 站 UP 主/合集/关键词/YouTube)、导出 srt/csv/分析原料包 bundle、AI 打标、server 与扩展客户端运维。触发词:采集、字幕库、查库、导出、bundle、stats、collect、tags 打标、客户端、扩展在线、server 起停、YouTube 字幕。
---

# collector-cli 与 scripts 调度参考

B 站**字幕(subtitle,非弹幕)**采集项目的 agent 友好 CLI 调度入口。多步任务编排见 [references/playbooks.md](references/playbooks.md)。

## 调用形态(唯一正确姿势)

`collector-cli` ≡ `pnpm -C apps/collector-server exec tsx src/cli/main.ts`(下文样例用简写):

```collector-cli
collector-cli stats overview
```

- **禁 `pnpm cli`**:pnpm run 回显 banner 混入 stdout,`| jq` 直接解析失败。
- **禁 `pnpm -s cli`**:silent 模式吞退出码(失败全变 1,丢失语义)。
- exec tsx 直调:stdout 为数据 + 结果报告(**格式随全局 `--format`**,json 时纯数据 JSON;list 类 `{total,page,size,items}`);失败 `{"ok":false,"error":"...","code":"..."}`;stderr 人类日志(`-q` 抑制)。正确退出码:**0** 成功 / **1** 运行时 / **2** 参数错 / **3** server 不可达 / **4** DB 不可读 / **5** 未找到。
- 全局选项在子命令前:`--db <path>` / `--server <url>` / `--token <token>` / `--format <json|ndjson|csv|table>` / `-q`。
- **cwd 陷阱**:`pnpm -C` 把子进程 cwd 切到 `apps/collector-server`,`--db`/`-o`/`--out` 等路径参数按该 cwd 解析——相对路径 `--db data/...` 会找成 `apps/collector-server/data/...`(exit 4)。**路径参数一律用绝对路径**,下文 `<repo>` 指仓库根绝对路径。
- **兜底纪律:不确定的参数,先跑 `collector-cli <命令> --help` 再动手**——commander 每级自描述,以实时 help 为准(本文速查只列常用项)。
- shell 脚本循环里传子命令勿用未加引号的 `$var`(zsh 不分词,"videos list" 会整串传参变成未知命令)。

## 双库(高频事故源)

| 库 | 路径 | 用途 |
|---|---|---|
| dev | `apps/collector-server/bilibili-collector.db`(CLI 默认) | 本地开发,数据偏旧 |
| 生产 | repo 根 `data/bilibili-collector.db`(docker 挂载) | collector.local.taevas.host 真源,数据最新 |

用户说「字幕库」默认指**生产**(`--db` 用绝对路径,见上方 cwd 陷阱):

```collector-cli
collector-cli --db <repo>/data/bilibili-collector.db stats overview
```

## 命令组速查(细节靠 --help)

| 组 | 通道 | 用途 |
|---|---|---|
| `videos list/get/get-by-id` | DB 只读 | 过滤查视频:`--q --creator --since --until --tag --has-subtitle --sort --desc --page --size` |
| `versions get <id>` | DB 只读 | 取字幕版本 payload(B 站 JSON 含 body) |
| `changes list` | DB 只读 | change_log 变更历史:`--entity --since --until` |
| `export subtitle <source> <bvid>` | DB 只读 | 字幕导出:`--sub-format srt\|vtt\|txt\|json --track <lan> --version <id> -o <file>`;不指定轨取默认轨默认版本,纯文本直写 stdout |
| `export videos` | DB 只读 | 视频列表 json/csv/ndjson(格式随全局 `--format`;过滤同 videos list) |
| `export bundle` | DB 只读 | 分析原料包:`--out <dir> --track <lan> --limit <n>` + videos list 全套过滤 → manifest.json + videos/*.txt + ANALYZE.md |
| `stats overview` / `stats count --by <kind> --top <n>` | DB 只读 | 总览 / 分组计数 |
| `sub search <关键词>` | DB 只读 | 字幕正文检索:`--ctx --regex --max-videos --full`;AI 打标的数据源 |
| `translate pending/source/fill` | pending/source 读 DB;fill 走 server | 补翻工作流(无中文轨视频):`pending` 查缺口(带各源语言行数)→ `source <bvid> --from <lan>` 取逐行待翻文本 → 会话内翻译 → `fill <bvid> --from <lan> --file <译文>` 写回 zh-manual 轨 |
| `tags list/apply/remove` | list 读 DB;apply/remove 走 server | `tags apply <bvid...> --names <csv> --source manual\|batch\|ai\|system`(打标即建标;system=系统状态档如 no-subtitle,采集链路自动打/摘) |
| `clients list/reporting/task-dispatch/command` | server HTTP | 扩展客户端管控;`reporting <id> <on\|off>` 切上报 / `task-dispatch <id> <on\|off>` 切任务派发(off=仅上报状态,调度器不派任务);`command <id> <action> --timeout <ms>` |
| `server ping/status/start/stop` | 本地 | 探活 / 起停(pid 文件;`start --no-detached --port`) |
| `collect …`(11 子命令) | server→扩展 | 见下方 |

collect 子命令速记:`search <关键词>` 搜候选(不入库)/ `subtitle <bvid>` 采单个入库(确认无字幕自动打 no-subtitle 系统标;采到轨自动摘) / `dedupe <bvid...>` 批量判重 / `season` 整合集 / `upper-info <mid>` UP 资料入库 / `upper-videos <mid> --all` 拉列表 / `new-videos <mid>` / `discover <mid...>` 多 UP 发现 / `find <关键词> --min-fans --since-days` 条件检索 / `yt-videos <handle> --since-days --collect` YouTube。采集默认超时 180s(覆盖扩展全链路)。

**排序语义**:`--sort first_seen`(入库时间)vs `published_at`(发布时间)——用户说「最近」先确认指哪个;无法确认时默认 `first_seen`(查询主语是「库」,最近入库)。

## scripts 工具速查

| 脚本 | 用途 |
|---|---|
| `scripts/collect-batch.mjs` | bvid 列表串行采集(sleep 1s 防风控) |
| `scripts/backfill-no-subtitle-tags.mjs` | 历史存量回填 no-subtitle 系统标(collect_tasks 有据部分;`--db` 绝对路径 `--dry-run` 试跑) |
| `scripts/collect-uppers.mts` | 多 UP 主批量:`pnpm collect-uppers <mid...> [--size 30] [--dry-run] [--since <unix秒>] [--category <名>]` |
| `scripts/youtube-collect-videos.mjs` | 列频道近 N 月视频(stdout 给 videoId 列表;`[fetch]/[parse]/[filter]` 分步 stderr 日志) |
| `scripts/youtube-collect-subs.mjs` | 采 YouTube 字幕(英文+中文翻译,stdin 读 videoId) |
| `scripts/run-collector-server.mjs` | 启动 server(node24 ABI 已重编译) |
| `scripts/launch-chrome.mjs` | 起 Chrome + cdpc 端口(扩展联调) |
| `scripts/load-collector-extension.sh` | 装扩展到 Chrome |
| `scripts/proxy-collector-server.mjs` | 127.0.0.1:21528 → 内网 21527 转发 |
| `scripts/verify-*.mjs` | 链路验收冒烟族(`pnpm test:ext` / `test:youtube`,按需不进 qa) |

## 纪律

- **批量采集/验证/诊断前,先确认工具失败路径日志足以定位根因**(HTTP 特征/解析命中/每步计数),详见 CLAUDE.md §9;日志不够先修日志再跑。
- 措辞红线:字幕(subtitle),非弹幕(danmaku),严禁混用。
- **维护契约**:改 CLI 命令/选项或 scripts 工具后必须同步本文件与 playbooks——`node scripts/verify-skill-sync.mjs`(进 `pnpm qa`)会拦截漂移。
