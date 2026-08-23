# 多步任务编排(playbooks)

六个高频任务的多步编排。单命令选项细节以 `--help` 为准(SKILL.md 兜底纪律)。

## 1. 链路体检(采集前的必经检查)

采集类命令全部经 server→扩展执行,先确认链路通:

```collector-cli
collector-cli server ping
collector-cli clients list
collector-cli collect search 测试关键词 --page 1
```

- `server ping` 退 3 或输出 `online:false` → server 没起:`node scripts/run-collector-server.mjs`(本地)或查 docker(生产)。
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

```collector-cli
collector-cli --db <repo>/data/bilibili-collector.db export bundle --creator <UP名> --has-subtitle --out <dir>
collector-cli --db <repo>/data/bilibili-collector.db export bundle --tag <标签名> --out <dir>
```

- bundle 产物:manifest.json + videos/*.txt + ANALYZE.md;`--track <lan>` 选语言,`--limit <n>` 控量。`--db`/`--out` 一律绝对路径(SKILL.md cwd 陷阱)。
- 分析在 Claude Code 会话中完成(内置 AI pipeline 是远期项);产物落盘 `analysis/<主题>/`,三类模板见 README「分析产物规范」:观点汇总(多 UP 分歧共识)/ 面试题库(题目+考点+参考答案)/ 理念整理(系列视频方法论)。

## 5. tags 打标(含 AI 打标工作流)

三档 `manual|batch|ai`(bili 档只读视频自带)。AI 打标官方工作流([tags.ts](../../../apps/collector-server/src/cli/commands/tags.ts) 头注释约定):

```collector-cli
collector-cli sub search <主题关键词> --ctx 8 --max-videos 20
collector-cli tags apply <bvid1> <bvid2> --names <标签1>,<标签2> --source ai
collector-cli tags list --source ai
```

- 先 `sub search` 读字幕正文判断视频归属 → `tags apply` 打标(打标即建标,视频需已入库)→ `tags list` 核对。
- `tags remove <bvid...> --names <csv>`;`--source` 省略时删该名字全部三档。

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
