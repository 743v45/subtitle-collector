# subtitle-collector 帮助中心

> 按任务切页的操作手册:每页解决一个问题,命令可直接复制执行。本页是总目录。
> 需求状态锚点(✅/🚧/📋)在 [README](../../README.md),本中心只管"怎么用"。

## 上手

- [[AI-接手]] — 新 AI 会话默认入口:载体分工 + 按任务必读 + 记忆晋升规约
- [[开始使用]] — 三端装起来跑通第一条链路
- [[环境变量]] — 五个变量与 token / 暴露部署的组合
- [[Docker 部署]] — 生产部署、备份、数据卷红线
- [[灾难重建]] — 裸机从零重建:仓库/.env/容器/群晖副本恢复/crontab/验收一条龙

## 采集

- [[采集模型]] — 数据怎么流、被动/主动、五入口总览(先读这篇)
- [[采集单个视频]] — 浏览被动入库 + 手动补采 + 刷新
- [[手机采集]] — Android app：分享/粘贴提交、任务跟踪、视频库与字幕查看
- [[批量采集 UP 主视频]] — UP 全量 / 新视频发现 / 多 UP 巡检
- [[采集 YouTube 频道]] — 频道批量 + 关键词搜索
- [[采集合集与搜索]] — 合集展开、条件搜索、充电专属视频
- [[客户端与任务派发]] — 多机管理、仅上报开关、客户端命名、双平台登录态判因、采集任务查询与重试(tasks)
- [[无字幕视频处理]] — no-subtitle 标记圈定与 `asr backfill` 批量转写兜底
- [[采集评论]] — B 站评论区采集入库(`comments collect`)、校验(`verify`)与树形查看(`tree`)

## 查询与导出

- [[检索视频库]] — web 列表筛选 + `videos list` 全参数
- [[全文检索字幕]] — `sub search` 带时间戳定位
- [[标签体系]] — 六档标签的打、摘、查
- [[导出字幕与视频]] — srt/vtt/txt/json 与 csv/ndjson
- [[导出分析原料包]] — `export bundle` 三件套

## 分析

- [[补翻中文字幕]] — translate 三步工作流
- [[分析工作流]] — bundle → Claude 会话 → analysis/ 落盘

## 运维

- [[测试与质量门]] — 什么时候跑 `pnpm test` / `pnpm qa` / `pnpm test:ext`
- [[排错]] — popup 连不上、任务卡住、端口坑、库损坏

## 本仓库其他文档(各管一件事)

| 文档 | 管什么 |
|---|---|
| [README](../../README.md) | 需求锚点:Feature 列表 + 架构总览 |
| [CLAUDE](../../CLAUDE.md) | 开发纪律:样式 / 测试 / 措辞红线 / 路线 |
| [MANUAL-collector](../../MANUAL-collector.md) | 真机验收清单 |
| [docs/quality/RULES](../quality/RULES.md) | 测试质量细则 |
| [改造账本](../plans/improvement-backlog-2026-10.md) | 改善项唯一台账:登记/划销/优先级 |
| [CLI 完整度台账](../plans/cli-completeness.md) | CLI 缺口登记与划销(含反向登记) |
| [消费端演进](../plans/consumption-loop.md) | 消费端闭环规划与推迟项登记 |
| [DOUYIN-PROGRESS](../../DOUYIN-PROGRESS.md) | 抖音全量集成进度与决策记录 |
| [docs/architecture.html](../architecture.html) | 架构总览静态页(数据流/红线/双库) |
| [平台接入手册](../platform-onboarding.md) | 新平台接入的清单与决策记录模板 |
| [docs/superpowers/](../superpowers/) | 历史设计文档与实现计划归档 |
| [CHANGELOG](../../CHANGELOG.md) | 变更记录 |
