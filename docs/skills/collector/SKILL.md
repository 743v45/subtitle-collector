---
name: collector
description: Use when 在本仓库需要调度字幕采集链路或消费字幕数据——查视频/字幕/统计、批量采集(B 站 UP 主/合集/关键词/YouTube/抖音)、导出 srt/csv/分析原料包 bundle、AI 打标、server 与扩展客户端运维。触发词:采集、字幕库、查库、导出、bundle、stats、collect、tags 打标、客户端、扩展在线、server 起停、YouTube 字幕、抖音采集。
---

# collector-cli 与 scripts 调度参考

B 站**字幕(subtitle)/评论(comment)/弹幕(danmaku)**采集项目的 agent 友好 CLI 调度入口(三类数据措辞分离,见 CLAUDE.md §4)。多步任务编排见 [references/playbooks.md](references/playbooks.md)。

## 调用形态(唯一正确姿势)

`collector-cli` ≡ `pnpm -C apps/collector-server exec tsx src/cli/main.ts`(下文样例用简写):

```collector-cli
collector-cli stats overview
collector-cli comments collect --bvid <BV> --dry-run
collector-cli danmaku collect --bvid <BV> --dry-run
```

- **禁 `pnpm cli`**:pnpm run 回显 banner 混入 stdout,`| jq` 直接解析失败。
- **禁 `pnpm -s cli`**:silent 模式吞退出码(失败全变 1,丢失语义)。
- exec tsx 直调:stdout 为数据 + 结果报告(**格式随全局 `--format`**,json 时纯数据 JSON;list 类 `{total,page,size,items}`);失败 `{"ok":false,"error":"...","code":"..."}`;stderr 人类日志(`-q` 抑制)。正确退出码:**0** 成功 / **1** 运行时 / **2** 参数错 / **3** server 不可达 / **4** DB 不可读 / **5** 未找到 / **6** 扩展版本过旧(不认识新 action,提示更新扩展而非重试)。
- 全局选项在子命令前:`--db <path>` / `--server <url>` / `--token <token>` / `--format <json|ndjson|csv|table>` / `-q`。
- **cwd 陷阱**:`pnpm -C` 把子进程 cwd 切到 `apps/collector-server`,`--db`/`-o`/`--out` 等路径参数按该 cwd 解析——相对路径 `--db data/...` 会找成 `apps/collector-server/data/...`(exit 4)。**路径参数一律用绝对路径**,下文 `<repo>` 指仓库根绝对路径。
- **兜底纪律:不确定的参数,先跑 `collector-cli <命令> --help` 再动手**——commander 每级自描述,以实时 help 为准(本文速查只列常用项)。
- shell 脚本循环里传子命令勿用未加引号的 `$var`(zsh 不分词,"videos list" 会整串传参变成未知命令)。

## 双库(高频事故源)

| 库 | 路径 | 用途 |
|---|---|---|
| dev | `apps/collector-server/bilibili-collector.db`(CLI 默认) | 本地开发,数据偏旧 |
| 生产 | docker volume `subtitle-collector_collector-data` 内 `/data/bilibili-collector.db`(2026-08-25 迁移) | collector.local.taevas.host 真源,数据最新 |

用户说「字幕库」默认指**生产**。生产库在 named volume 内,**宿主机没有该文件**(`--db` 直读生产不可用)——查生产一律走 server HTTP 或容器内 exec:

```collector-cli
collector-cli --server https://collector.local.taevas.host --token <t> stats overview
```

```bash
docker exec collector-server node -e 'const db=require("better-sqlite3")("/data/bilibili-collector.db",{readonly:true});console.log(db.prepare("...").all())'
```

历史教训(2026-08-24 两次 SQLITE_CORRUPT):旧 bind mount 走 virtiofs,宿主机进程直触挂载库(哪怕只读)会引发 mmap 一致性损坏;named volume 已根除此路径,但「宿主直读」习惯须保持禁用。

**生产备份**(2026-08-25 grilling 定案的四层体系):① server 内置定时容器内 `VACUUM INTO /data/backups/`(启动即备一次,分层滚动;备份间隔/保留份数/保留天数等参数**单源见 [apps/collector-server/src/db/backup.ts](../../../apps/collector-server/src/db/backup.ts)**,此处不复述数字以防漂移);② 每日 10:23 cron 导最新 1 份到群晖同步盘(异地,`crontab -l` 可查);③ 恢复走 `node scripts/backup-restore.mjs --list / --drill / --apply <文件名>`(--drill 恢复演练不碰生产,按定案节奏定期跑);④ 连续失败 ≥2 次推飞书 webhook(.env 配 `COLLECTOR_BACKUP_WEBHOOK_URL`,缺省只打日志)。导出到任意宿主目录:`node scripts/backup-export.mjs [目录] [--all|--keep N]`。

## 命令组速查(细节靠 --help)

| 组 | 通道 | 用途 |
|---|---|---|
| `videos list/get/get-by-id` | DB 只读 | 过滤查视频:`--q --creator --creator-id --creator-uid --since --until --date-field --tag --tags --tag-source --has-subtitle --sort --desc --page --size`(sort 键 `first_seen\|published_at\|title\|duration\|view\|updated_at`;`--desc` 可选值,缺省降序,升序 `--desc=false`;`--tag` 模糊单值,`--tags` 精确逗号分隔多标签 AND——空串按未传,二者可叠加;`--creator-id`/`--creator-uid` UP 精确(库内 id/平台 uid 如 B 站 mid);`--tag-source` 档位 CSV(manual\|batch\|ai\|system\|bili\|season,配 --tag/--tags 收窄匹配档位,单独传=该档位有任一标签);`--date-field` first_seen\|published_at 切 --since/--until 比对列,缺省 first_seen;export videos/bundle 与 stats count 过滤大体同款——四新参 2026-10-05 起仅 videos list) |
| `versions get <id>` | DB 只读 | 取字幕版本 payload(B 站 JSON 含 body) |
| `changes list` | DB 只读 | change_log 变更历史:`--entity --since --until --source <平台> --sort --desc`(sort 仅 `changed_at`;items 带派生 source 平台列) |
| `export subtitle <source> <bvid>` | DB 只读 | 字幕导出:`--sub-format srt\|vtt\|txt\|json --track <lan> --version <id> -o <file>`;不指定轨取默认轨默认版本,纯文本直写 stdout |
| `export videos` | DB 只读 | 视频列表 json/csv/ndjson(格式随全局 `--format`;过滤同 videos list) |
| `export bundle` | DB 只读 | 分析原料包:`--out <dir> --track <lan> --limit <n> --name-order <parts>` + videos list 全套过滤 → manifest.json + videos/*.txt + ANALYZE.md;`--name-order` 定 videos/ 文件名组件与顺序(逗号分隔 `id\|name\|time\|author`,默认 `id,name` 即 `<id>-<标题>`,time=发布日期,author=UP 名,`--name-order id` 回纯 ID 形态) |
| `stats overview` / `stats count --by <kind> --top <n>` | DB 只读 | 总览(全库 total + 分平台 by_source) / 分组计数(`--by` 六值 `creator\|tname\|lang\|track-type\|tag\|source`,`tag`=标签共现分布(六档并聚按视频去重),可与 `--tags` 精确 AND 组合看子集;`--source` 过滤收窄;`--sort count\|key --desc` 排序,2026-08-25) |
| `sub search <关键词>` | DB 只读 | 字幕正文检索:`--ctx --regex --max-videos --full`;AI 打标的数据源 |
| `translate pending/source/fill` | pending/source 读 DB;fill 走 server | 补翻工作流(无中文轨视频):`pending --source <平台> --sort first_seen\|published_at --desc` 查缺口(带各源语言行数;缺省降序最新在前,升序 `--desc=false`——2026-10-05 P1-10 命名统一,原 asc 旗标退 2)→ `source <vid> --from <lan> --source <平台>` 取逐行待翻文本 → 会话内翻译 → `fill <vid> --from <lan> --file <译文> --source <平台>` 写回 zh-manual 轨 |
| `asr backfill` | server HTTP + B 站/抖音直链 + 本机 fireredasr | 无字幕视频兜底转写(no-subtitle 圈定,`--source bilibili\|douyin` 定平台,2026-08-29 抖音接入):`--size <n>`(默认 5,先小样本实测速度,RTF≈0.2)/ `--page` / `--max-duration <秒>` / `--dry-run`(只圈定,先行预检口径)/ `--cookie-file`(仅 bilibili 必配——nav 取 wbi keys 即需登录态,匿名 -101,或 $COLLECTOR_BILI_COOKIE_FILE)/ `--asr-url`(默认 127.0.0.1:5079)。bilibili:圈定→wbi playurl 拉音轨;douyin:详情取 extra.play_uri 直构 snssdk 直链下载 mp4(零 cookie,mp4 整段上传由 fireredasr 抽音轨;500MB 上限,超限跳过 video_too_large 不重试)→FireRedASR 转写→写回 `asr-zh-<引擎>` 轨(如 `asr-zh-fireredasr-aed-l`;`--engine` 兼定轨名,不同引擎各自成轨,web 详情页轨选择器可切换比对),成功自动摘标(重跑跳过已完成);失败分类计数不中断批次(douyin 新分类 missing_play_uri/video_too_large/detail_fetch_error) |
| `comments collect` | server HTTP + B 站直连 | 评论分析树采集(宿主 CLI 直连 B 站 wbi 游标遍历+楼中楼翻全,写库经 server ingest 端点;2026-10 评论采集):`--bvid/--aid/--bvid-file --mode auto\|full\|incremental --sort hot\|time --max-pages --max-floor-pages --refresh-roots --max-requests --page-interval-ms --batch-size --dry-run --cookie-file`(cookie 必配——wbi 签名前置 nav 需登录态,匿名 -101;取 cookie 见 `scripts/bili-cookie-from-chrome.mjs`) |
| `comments tree/verify` | DB 只读 | 评论树查看与完整性校验(R0-R9):`tree --bvid --limit`(点赞前 N 根)/ `verify --bvid --stat-reply <n>`(外部总量哨兵,给了才启 R9 规模对账);建议全局 `--format json`;显式 `--server` 出「只读本地 --db」警告(videos/sub/export/stats/changes/comments 同组) |
| `danmaku collect` | server HTTP + B 站直连 | 弹幕池时间轴采集(seg.so 分段,cookie 可选;宿主 CLI 直连 B 站 360s 分段拉取,写库经 server ingest 端点;2026-10 弹幕采集):`--bvid/--aid --page all\|n --max-segments --max-requests --segment-interval-ms --batch-size --dry-run --cookie-file`(cookie **可选**——匿名实测可用,缺省 `$COLLECTOR_BILI_COOKIE_FILE`,都没有匿名跑;与评论必配不同) |
| `danmaku verify` | DB 只读 | 弹幕校验统计(R1-R5):`verify --bvid`(必填)——段外时间轴值域/重复 id/分布分位/60s 直方图峰值/ctime 范围;建议全局 `--format json`;显式 `--server` 出「只读本地 --db」警告(videos/sub/export/stats/changes/comments/danmaku 同组) |
| `tags list/apply/remove/rename/delete` | list 读 DB;apply/remove/rename/delete 走 server | `tags list --sort count\|name\|created_at --desc --top <n>`(count 语义跟随 `--scope` 档;`--top` 条数上限默认 500——2026-10-05 P1-10 命名统一,原 topN 拼写退 2)/ `tags apply <vid...> --names <csv> --scope manual\|batch\|ai\|system --source <平台>`(打标即建标;scope=档位,source=平台默认 bilibili——YouTube 11 位 ID 用 `--source youtube`,抖音 19 位 aweme_id 用 `--source douyin`;system=系统状态档如 no-subtitle,采集链路自动打/摘)/ `tags rename <标签id> --name <新名>`(标签库纠错:改名,已有打标关系自动跟随新名;撞已有名 409→RUNTIME 退 1)/ `tags delete <标签id>`(删标签含全部档位关系;不存在 404→NOT_FOUND 退 5)——标签 id 取 `tags list` 输出的 id 列(2026-10-05) |
| `clients list/reporting/task-dispatch/command` | server HTTP | 扩展客户端管控;`list --sort last_seen\|first_seen\|name --desc` 含离线客户端(DB 注册表合并在线态,带 popup 改的名字、在线/离线时长、扩展版本与双平台登录态 `bili_login`/`yt_login`——B 站未登录会让充电视频 AI 字幕接口返回空、YouTube 未登录时年龄限制视频播不了且 pot 受限加重,批量采集整批 no_subtitle/pot_limited 的判因依据);`reporting <id> <on\|off>` 切上报 / `task-dispatch <id> <on\|off>` 切任务派发(off=仅上报状态,调度器不派任务);`command <id> <action> --timeout <ms>` |
| `tasks list/get/retry` | server HTTP | 采集任务查询与重试(2026-10-02):`list` 筛选/排序/分页(`--status failed,limited` 逗号多值 / `--source <平台>` / `--batch-id <id>` / `--batch <名>` / `--creator` / `--creator-uid` / `--q` / `--since --until` / `--limit <n>`(最近 N)或 `--page --page-size`(翻页,输出带 page/page_size;**展示单元口径** 2026-10-05:单条任务/整批各算 1 单元,整批必落同一页——items 可超 page_size,total=单元数,写翻页脚本按单元算) / `--sort created_at\|finished_at\|status`);`get <id>` 单任务详情(失败原因 `error` 与回执摘要 `result` 在 task 内);`retry <id...>` 多 id 批量重试(非可重试行 server 侧静默跳过,看回执 `retried` 计数) |
| `creators list/get` | server HTTP | UP 主(创作者)查询(2026-10-05):`list` 筛选/七键排序/分页(`--q` UP 名/平台 uid 模糊 / `--category <名>` 分类精确 + `--scope agent\|human` 选槽位(单独传=该槽位已打标) / `--source <平台>` / `--page <n> --size <n>`(端点钳 size≤100,默认 20) / `--sort first_seen\|fans\|video_count\|following\|level\|updated_at\|name`);`get <id>` 单创作者详情(P2 字段 sign/level/sex/official/fans/following + 分类 join,库内 id 非 uid);存量 no-subtitle 回填查缺资料 UP 清单用(账本 P1-5 配套) |
| `categories list/add/update/delete` | server HTTP | UP 主分类 CRUD(2026-10-05,值域 agent/human 两槽位合一):`list`(输出 {total,items},items 含 creator_count 两槽位任一引用计数)/ `add <名>`(重名 409→RUNTIME 退 1)/ `update <id> --name <新名> --sort-order <整数>`(至少传一键;不存在 404→NOT_FOUND 退 5,撞名 409)/ `delete <id>`(引用该分类的创作者两槽位自动置 NULL;分类 id 取 `categories list` 输出的 id 列)——`creators list --category` 筛选的值域治理(给 UP 打分类在 web 创作者页) |
| `settings get/set` | server HTTP | web 设置页键值 CLI 读写(2026-10-05):`get tag-priority`(六档展示优先级,高→低)/ `get collect-timeout`(三平台采集超时毫秒);`set tag-priority --order manual,batch,bili,season,ai,system`(六档 CSV 精确排列,缺档/未知档/重复档 ARGS 退 2 不发请求)/ `set collect-timeout --bilibili <ms> --youtube <ms> --douyin <ms>`(整数毫秒,区间 [15000, 600000],越界/非数字 ARGS 退 2)——超时三键语义见 collect 速记「超时三平台分档」段 |

| `server ping/status/start/stop` | 本地 | 探活 / 起停(pid 文件;`start --no-detached --port`) |
| `collect …`(11 子命令) | server→扩展 | 见下方 |

采集任务(tasks 组)生产库样例——查失败/受限任务并批量重试:

```collector-cli
collector-cli --server https://collector.local.taevas.host --token <t> tasks list --status failed,limited --sort created_at
collector-cli --server https://collector.local.taevas.host --token <t> tasks get 123
collector-cli --server https://collector.local.taevas.host --token <t> tasks retry 123 124
```

UP 主(creators 组)生产库样例——存量回填查缺资料 UP 清单(按粉丝量降序看大 UP,或按分类筛):

```collector-cli
collector-cli --server https://collector.local.taevas.host --token <t> creators list --source bilibili --sort fans --size 20
collector-cli --server https://collector.local.taevas.host --token <t> creators list --category AI --scope agent
collector-cli --server https://collector.local.taevas.host --token <t> creators get 42
```

标签库纠错(tags rename/delete 组,2026-10-05)——AI 打标打错时的改名/删标重建(标签 id 取 `tags list` 输出的 id 列,非视频 id):

```collector-cli
collector-cli --server https://collector.local.taevas.host --token <t> tags rename 42 --name 新标签名
collector-cli --server https://collector.local.taevas.host --token <t> tags delete 43
```

分类治理与设置键(categories/settings 组,2026-10-05)——分类值域维护与 web 设置页键值读写(超时语义见 collect 速记「超时三平台分档」段):

```collector-cli
collector-cli --server https://collector.local.taevas.host --token <t> categories list
collector-cli --server https://collector.local.taevas.host --token <t> categories add AI 基础
collector-cli --server https://collector.local.taevas.host --token <t> categories update 3 --name AI --sort-order 2
collector-cli --server https://collector.local.taevas.host --token <t> categories delete 7
collector-cli --server https://collector.local.taevas.host --token <t> settings get collect-timeout
collector-cli --server https://collector.local.taevas.host --token <t> settings set collect-timeout --bilibili 120000 --youtube 60000 --douyin 60000
collector-cli --server https://collector.local.taevas.host --token <t> settings set tag-priority --order ai,manual,batch,bili,season,system
```

collect 子命令速记:`search <关键词>` 搜候选(不入库)/ `subtitle <vid> [--source bilibili|youtube|douyin]` 采单个入库(vid=平台 ID:B 站 BV 号 / YouTube 11 位 / 抖音 19 位 aweme_id;douyin 经扩展 navigate 后台 tab 开 douyin.com/video/<id> 页面上下文取数——server 无法直连抖音 API;三平台回执 reason=no_subtitle 都自动打 no-subtitle 系统标,采到轨自动摘;douyin 图集回 reason=not_video→failed)/ `dedupe <vid...> [--source <平台>]` 批量判重 / `season` 整合集 / `upper-info <mid>` UP 资料入库 / `upper-videos <mid> --all` 拉列表 / `new-videos <mid>` / `discover <mid...>` 多 UP 发现 / `find <关键词> --min-fans --since-days` 条件检索 / `yt-videos <handle> --since-days --collect [--force]` YouTube 频道(--collect 逐条采,已有字幕轨的默认跳过,--force 强制重采) / `yt-search <关键词> --order --since-days --collect` YouTube 搜索。**抖音博主批量**(2026-08-29):web 采集页「按 UP / 频道 / 博主批量」或 `POST /api/upper-videos/expand {source:'douyin', sec_uid}`(裸 sec_uid 或 …/user/<sec_uid> 主页链接均可;扩展内 max_cursor 游标翻页聚合成一次回传,server 不感知游标;无 CLI 命令)。**超时三平台分档**(settings `collect_timeout_ms` 三键 bilibili/youtube/douyin,web 设置页可调):bilibili 预算式默认 90s(server 等回执预算);youtube/douyin 窗口式默认 45s(扩展侧无进展窗口,server 回执预算=窗口+135s);CLI `--timeout` 缺省 180s 覆盖全链路。**批量建任务端点同语义**:`POST /api/collect-tasks/batch {vids,source,force?}` 默认跳过已有字幕轨的入库视频(skipped_collected 返回),force=true 强制重采(2026-08-25)。

**排序语义**:全部列表端点支持 `--sort` + `--desc`(缺省降序,升序 `--desc=false`;非法键 ARGS 退 2 / HTTP 400,不再静默回落)——2026-08-25 全端点统一。`--sort first_seen`(入库时间)vs `published_at`(发布时间)——用户说「最近」先确认指哪个;无法确认时默认 `first_seen`(查询主语是「库」,最近入库)。可空键(finished_at/name/published_at 等)NULLS LAST 恒排尾。

## scripts 工具速查

| 脚本 | 用途 |
|---|---|
| `scripts/collect-batch.mjs` | 视频ID列表串行采集(sleep 1s 防风控;`--tag` 批量打标;`--source bilibili\|youtube` 平台,默认 B 站;`--client <id>` 多客户端时显式指定采集机——缺省第一个在线可能是仅上报态,会整批「任务派发已关闭」空跑) |
| `scripts/backfill-no-subtitle-tags.mjs` | 历史存量回填 no-subtitle 系统标(collect_tasks 有据部分,两平台都回填;`--db` 绝对路径 `--dry-run` 试跑) |
| `scripts/collect-uppers.mts` | 多 UP 主批量:`pnpm collect-uppers <mid...> [--size 30] [--dry-run] [--since <unix秒>] [--category <名>]` |
| `scripts/youtube-collect-videos.mjs` | 列频道视频(stdout 给 videoId 列表;第 2 参月数默认 6,给 240 即全量;InnerTube 续页拉满,`[fetch]/[browse]/[parse]/[filter]` 分步 stderr 日志;2026-08-24 续页 token 适配三层嵌套新结构——扩展侧 tab 注入路径另有 browse 故障,全量列表以此脚本为准) |
| `scripts/verify-yt-channel.mjs` | YouTube 频道采集验收(`<@handle\|UCxxx\|URL>`;频道全量=youtube-collect-videos.mjs 续页拉满,库内=HTTP /api/videos?creator_uid=,对比输出覆盖率与缺失清单 JSON;全采 exit 0,有缺 exit 1) |
| `scripts/youtube-collect-subs.mjs` | 采 YouTube 字幕(英文+中文翻译,stdin 读 videoId) |
| `scripts/launch-chrome.mjs` | 起 Chrome + cdpc 端口(扩展联调) |
| `scripts/load-collector-extension.sh` | 装扩展到 Chrome |
| `scripts/proxy-collector-server.mjs` | 127.0.0.1:21528 → 内网 21527 转发 |
| `scripts/verify-deployed.mjs` | 部署后服务状态自检(`pnpm verify:deployed -- --token <t> [--server <url>] [--via-docker [容器名]\|--db <路径>]`;HTTP 核心接口 + DB 层 SQLite integrity_check,坏页损坏探活测不出——2026-08-24 事故教训;生产库在 named volume 宿主无文件,DB 层走 `--via-docker`(docker exec 容器内校验,缺省容器名 collector-server),`--db` 只用于导出的备份文件) |
| `scripts/backup-export.mjs` | 生产备份导出(docker cp volume → 宿主;`node scripts/backup-export.mjs [目录] [--all\|--keep N]`,默认最新 1 份到 `data/exports/`) |
| `scripts/backup-healthcheck.mjs` | 备份体系巡检(只读,防链路静默死——2026-10-04 异地导出 cron 裸 node 死 40 天教训):卷内最新备份 <30min / 异地最新 .db <48h / 异地副本 `sqlite3 -readonly` quick_check+videos 行数 / 宿主 data/exports 快照盘点(仅日志);`node scripts/backup-healthcheck.mjs [--dry-run]`,任一失败 exit 1+推飞书(`COLLECTOR_BACKUP_WEBHOOK_URL`);与 backup-export 分工:export 搬副本出卷,healthcheck 只验链路活着,建议 cron 每周跑(node 绝对路径);恢复演练见 backup-restore --drill |
| `scripts/verify-full-chain.mjs` | 生产全链路真值冒烟(2026-10-04 C2):前置在线检查→建已采视频重采任务→轮询 succeeded→快照出包断言→收场删任务;`node scripts/verify-full-chain.mjs --server <url> --token <t> [--bvid BV] [--timeout 秒]`;扩展离线即刻 exit 2 不空转;部署/扩展 bump 后跑——「派发→采集→入库→导出」闭环此前零覆盖,本工具补位 |
| `scripts/env-inventory.mjs` | 外置配置只读盘点(A5,验收日与健康检查同轮):crontab backup-export 行(node 须绝对路径+行内脚本存在)/主检出 .env(token 非空非占位符+webhook,值绝不打印)/B 站 cookie mtime/异地最新 .db <48h/report 产物仓 git 干净;`node scripts/env-inventory.mjs`,任一 fail exit 1(纯巡检不告警,告警职责在 backup-healthcheck) |
| `scripts/export-bundle.mjs` | 生产库→分析原料包一条命令(`node scripts/export-bundle.mjs --theme <主题> [过滤器...] [--out <dir>] [--max-age-hours <n>] [--force]`;容器内 VACUUM INTO 新快照 → docker cp → collector-cli `--db` 出包,`--max-age-hours` 内复用 mtime 最新快照;分析闭环第一步) |
| `scripts/backup-restore.mjs` | 生产备份恢复(`--list` 列卷内备份 / `--drill` 演练(临时卷+容器 21599,不碰生产,季度跑) / `--apply <文件名>` 真恢复(停服换库,旧库改名留证);事故现场不再靠记忆) |
| `scripts/sqlite-rescue.mjs` | 损坏库抢救重建(`node scripts/sqlite-rescue.mjs <主库> <完好备份> <新库输出>`;分段绕坏页 + 备份兜底 + JSON 列降级 + 孤儿引用登记,2026-08-24 SQLITE_CORRUPT 事故产物) |
| `scripts/web-screenshots.mjs` | collector-web 全功能截图走查(UI 评审/grill 用;`node scripts/web-screenshots.mjs [--base http://localhost:21527] [--out <dir>]`;10 个 tab + 视频/创作者详情各一张 `shot-<view>.png`,详情 ID 走 API 探测缺了只少两张;浏览器同源导航过 server 免鉴权通道,不碰日常 Chrome profile;行尾打印 console 报错与 ≥400 API 响应,有失败视图 exit 1) |
| `scripts/verify-*.mjs` | 链路验收冒烟族(`pnpm test:ext` / `test:youtube`,按需不进 qa) |

> scripts 输出契约(退出码 0/非 0、失败 stderr `[tag]` 分步日志、stdout 只出数据可 pipe):[docs/quality/SCRIPTS-CONTRACT.md](../../quality/SCRIPTS-CONTRACT.md)——新增/改动 scripts 工具前先过其 §3 检查单。

## 纪律

- **批量采集/验证/诊断前,先确认工具失败路径日志足以定位根因**(HTTP 特征/解析命中/每步计数),详见 CLAUDE.md §9;日志不够先修日志再跑。
- 措辞红线:字幕(subtitle)/评论(comment)/弹幕(danmaku)三类数据措辞分离,严禁混用(评论/弹幕 2026-10-03/2026-10-07 先后解冻入库;字幕≠弹幕原红线语义维持,CLAUDE.md §4)。
- **维护契约**:改 CLI 命令/选项或 scripts 工具后必须同步本文件与 playbooks——`node scripts/verify-skill-sync.mjs`(进 `pnpm qa`)会拦截漂移。
