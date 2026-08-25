# 采集 YouTube 频道

YouTube 侧两个入口:频道批量、关键词搜索。与 B 站侧对齐(含 [[无字幕视频处理]] 的 no-subtitle 标记)。

相关:[[采集模型]]、[[批量采集 UP 主视频]]

## 频道批量(CLI)

```bash
# 拉频道视频列表(@handle / UC 开头频道 ID / 频道页 URL 三种都认)
pnpm cli collect yt-videos @handle
pnpm cli collect yt-videos @handle --since-days 30     # 只要近 30 天
pnpm cli collect yt-videos @handle --collect           # 列表后直接逐个采集未入库的
```

实现:`@handle/**` 任意子页识别,ytInitialData + InnerTube 全量分页;一次全量回执,顺带落频道 creator 最小行(channelId + 名称)供历史页按 UP 筛。

## 频道批量(界面)

- **popup 频道卡**:在 YouTube 频道页弹出,勾选批量 navigate 采集
- **web 采集页「按 UP / 频道批量」**:`@handle` / `UC…` / 频道链接展开勾选批量(`/api/upper-videos/expand` 双平台)

## 关键词搜索

```bash
pnpm cli collect yt-search "rust tokio"                       # 只列候选(不入库)
pnpm cli collect yt-search "rust tokio" --order views         # relevance|newest|views
pnpm cli collect yt-search "rust tokio" --since-days 90 --collect
```

`--collect` 对未入库的串行采集。

## 与 B 站侧的差异

- 视频标识是 11 位 YouTube ID(不是 BV 号),命令里 `--source youtube`
- 频道完整统计(订阅数等 about 指标)入库是远期项(📋),当前只落 creator 最小行
