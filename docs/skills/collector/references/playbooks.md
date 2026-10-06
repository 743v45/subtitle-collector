# 多步任务编排(playbooks)

六个高频任务的多步编排。单命令选项细节以 `--help` 为准(SKILL.md 兜底纪律)。

## 1. 链路体检(采集前的必经检查)

采集类命令全部经 server→扩展执行,先确认链路通:

```collector-cli
collector-cli server ping
collector-cli clients list
collector-cli collect search 测试关键词 --page 1
```

- `server ping` 退 3 或输出 `online:false` → server 没起:`collector-cli server start`(本地;默认后台 detached,日志 `.collector-server.log`,停走 `server stop`)或查 docker(生产)。
- `clients list` 空 → 扩展不在线:`scripts/load-collector-extension.sh` 装扩展 + `scripts/launch-chrome.mjs` 起 Chrome,确认扩展已连 server。
- `collect search` 是无副作用试探(不入库),通了才继续批量。

## 2. 给 UP 主建库

```collector-cli
collector-cli collect upper-info <mid>
collector-cli collect upper-videos <mid> --all
collector-cli collect new-videos <mid>
```

- 多 UP 主批量走 `pnpm collect-uppers <mid1> <mid2> ... [--size 30] [--sleep 1000] [--dry-run] [--category <名>]`(`scripts/collect-uppers.mts`;退出码 0 完成 / 2 用法 / 3 前置不满足 / 4 风控中断)。
- 少量补采:`node scripts/collect-batch.mjs`(stdin 读 bvid 列表,串行 + sleep 防风控);单视频 `collector-cli collect subtitle <bvid>`。
- 合集一次采全:`collector-cli collect season <BV号或合集id> --dry-run` 先看展开量,去掉 `--dry-run` 正式建任务(server 自动串行执行)。
- 采完核对:`collector-cli --db <repo>/data/bilibili-collector.db stats overview`(路径一律绝对,见 SKILL.md cwd 陷阱),或 `collect dedupe <bvid...>` 批量判重。

## 3. YouTube 链路

CLI 路(推荐,入库统一):

```collector-cli
collector-cli collect yt-videos <@handle或UCxxx> --since-days 90
collector-cli collect yt-videos <@handle> --since-days 90 --collect
collector-cli collect yt-search <关键词> --order newest --since-days 30
collector-cli collect yt-search <关键词> --collect
```

`yt-search` 关键词搜候选(类 B 站 `find`,`--order relevance|newest|views` 默认相关性);`--collect` 对未入库串行采集。回执带 `diag` 解析命中计数(lockup/renderer),0 命中或报错先看它再排查。

脚本路(独立产出文件,适合给下游消费):

```bash
node scripts/youtube-collect-videos.mjs   # stdout 产 videoId 清单,[fetch]/[parse]/[filter] 分步日志
node scripts/youtube-collect-subs.mjs     # stdin 读 videoId,采英文+中文翻译字幕
```

## 4. 消费端:bundle 导出 → 会话分析 → 落盘

当前项目最大缺口是消费端闭环(README Feature 冻结政策的依据),原料包导出是采集侧唯一出口:

```bash
node scripts/export-bundle.mjs --theme <主题> --creator <UP名> --has-subtitle
node scripts/export-bundle.mjs --theme <主题> --tag <标签名>
node scripts/export-bundle.mjs --theme <主题> --tags <标签1>,<标签2>
```

- 生产数据源两步合一:容器内 `VACUUM INTO` 新快照 → docker cp 到 `data/exports/` → collector-cli `--db <快照绝对路径>` 出包(生产库在 volume,宿主机严禁直开;`--max-age-hours <n>` 内复用 mtime 最新快照不打新)。输出缺省 `analysis/<主题>/bundle/`,或 `--out <dir>` 显式指定(绝对路径,SKILL.md cwd 陷阱)。
- bundle 产物:manifest.json + videos/*.txt + ANALYZE.md;`--track <lan>` 选语言,`--limit <n>` 控量,`--force` 允许写入已存在非空目录。其余过滤器全量透传 export bundle。
- 多标签精确过滤用 `--tags`(逗号分隔,AND 语义,全部命中才导出;`--tag` 为模糊单值,二者可叠加,空串按未传)——videos list / export videos / stats count 同款。
- 分析在 Claude Code 会话中完成(内置 AI pipeline 是远期项);产物落盘 `analysis/<主题>/`,三类模板见 README「分析产物规范」:观点汇总(多 UP 分歧共识)/ 面试题库(题目+考点+参考答案)/ 理念整理(系列视频方法论)。

## 5. tags 打标(含 AI 打标工作流)

四档 `manual|batch|ai|system`(bili 档只读视频自带,不独立成列;system=系统状态档如 no-subtitle,采集链路自动打/摘)。AI 打标官方工作流([tags.ts](../../../apps/collector-server/src/cli/commands/tags.ts) 头注释约定;`--scope`=档位,`--source`=平台默认 bilibili):

```collector-cli
collector-cli sub search <主题关键词> --ctx 8 --max-videos 20
collector-cli tags apply <bvid1> <bvid2> --names <标签1>,<标签2> --scope ai --source bilibili
collector-cli tags list --scope ai
collector-cli tags rename <标签id> --name <新名>
collector-cli tags delete <标签id>
```

- 先 `sub search` 读字幕正文判断视频归属 → `tags apply` 打标(打标即建标,视频需已入库)→ `tags list` 核对。
- `tags remove <bvid...> --names <csv>`:`--scope` 省略删该名字全部四档(只传 `--scope` 则只删该档);`--source` 定平台,默认 bilibili。
- 打错标签的库内纠错(2026-10-05):`tags rename <标签id> --name <新名>`(已有打标关系自动跟随新名;撞已有名 409→RUNTIME 退 1)/ `tags delete <标签id>`(删标签含全部档位关系;不存在 404→NOT_FOUND 退 5)——标签 id 取 `tags list` 输出的 id 列。

## 6. 补翻工作流(无中文轨视频补中文翻译)

消费端能力(供会话内大模型调用,对齐 AI 打标「系统出工具、智能在会话」)。三步闭环:

```collector-cli
collector-cli --db <repo>/data/bilibili-collector.db translate pending --from ai-en --size 5
collector-cli --db <repo>/data/bilibili-collector.db translate source <bvid> --from ai-en
collector-cli --server <生产server> translate fill <bvid> --from ai-en --file zh.txt
```

- ① `translate pending` 查缺口:有轨但无任何中文轨(zh/zh-Hant/zh-Hans/ai-zh/zh-manual 全无)的视频,每项带各源语言轨行数——据此挑视频挑语言。
- ② `translate source` 取原料:stdout 逐行 `行号\t原文`(纯文本直写,可重定向);行数即翻译契约。
- ③ 会话内翻译产出 zh.txt(每行一条译文,可保留行号前缀;空行占位不可省),`translate fill` 写回:行数校验+时间轴从源轨拷贝,落 `zh-manual` 轨(origin=manual 不去重,重复 fill 堆版本快照)。
- fill 走 server HTTP(对齐 tags apply 先例)——`--db` 用于 pending/source 与行数预校验,`--server` 决定写哪个库,两者指向同一库。
- 补翻后该视频默认轨变中文(trackPriority zh-manual 档),`export subtitle`/`export bundle` 自动受益。

## 7. 评论树采集 → bundle 消费

B 站视频评论区(根评论+楼中楼完整分析树)采集入库;`export bundle` 自动携带评论原料,无新参数。

```bash
node scripts/bili-cookie-from-chrome.mjs --refresh   # cookie 准备(SESSDATA ~1 个月;-101 时重跑;必配)
```

```collector-cli
collector-cli comments collect --bvid <BV> --dry-run      # 试跑:取数解析计数,不写库
collector-cli comments collect --bvid <BV> --mode full    # 全量(auto 首采同效;写库走 server HTTP)
collector-cli comments verify --bvid <BV>                 # 校验(coverage / root_count_gap / dangling 族)
collector-cli comments tree --bvid <BV> --limit 20        # 树形速览(点赞 top 20 根)
```

- 通路:`comments collect` 宿主进程直连 B 站(wbi 签名+cookie),写库只走 server HTTP——server 必须可达(生产 `--server <url> --token <t>`);视频须先入库,否则 NOT_FOUND 退 5。
- 日常增量:`--mode incremental`(auto 分流默认)+ `--refresh-roots 50` 补老楼新回复;删除对账只在 full 轮发生。
- 批量:`--bvid-file <文件>`(每行一个 BV,串行 5s 间隔,失败不阻断,per-video 回执)。
- `tree`/`verify` 是 DB 只读:显式 `--server` 被忽略并警告,查生产先快照再 `--db <快照绝对路径>`。
- 消费:库内有评论的视频,`export bundle` 自动出 `comments/<BV>.md` 正文 + manifest `comments` 摘要(roots/total/coverage/like_top/last_collected_at);操作手册见 docs/help/采集评论.md。
