# 批量采集 UP 主视频

围绕一个 UP 主把视频收进库:全量拉、增量发现、多 UP 巡检三个粒度。

相关:[[采集模型]]、[[客户端与任务派发]]

## 三个命令,一个心智

```bash
# 1. 拉 UP 主视频列表(只看不入库;--all 全量翻页拉完)
pnpm cli collect upper-videos <mid>
pnpm cli collect upper-videos <mid> --all

# 2. 发现新视频:拉列表 + 对比库,返回 new / collected
pnpm cli collect new-videos <mid>

# 3. 多 UP 主巡检:每个 UP 拉列表对比库,汇总 per_mid + all_new
pnpm cli collect discover <mid1> <mid2> <mid3>
```

`mid` 是 UP 主数字 ID(B 站空间 URL 里的 `space.bilibili.com/<mid>`)。

列表确认后,对要采的 BV 号逐个 `collect subtitle`,或走下面的界面批量。

## 界面批量(推荐日常用)

- **popup「UP 全部视频」卡**:在 UP 主空间页弹出卡,勾选批量采集上报
- **web 采集页「按 UP / 频道批量」**:贴 mid 或 UP 链接展开勾选批量提交(B 站与 YouTube 双平台)

## 顺手采 UP 主资料

```bash
pnpm cli collect upper-info <mid>    # 扩展 fetch acc/info + relation/stat 入库
```

UP 资料入库后,web 的 UP 主分类管理、创作者筛选才有数据。

## 采完去哪看

- [[检索视频库]] — 视频库按 UP 筛
- web 采集任务历史页:按 UP(名字模糊 / mid 精确)、时间范围、批次聚焦查任务,URL query 承载可分享
