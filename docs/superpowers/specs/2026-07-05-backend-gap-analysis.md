# 后台功能 Gap Analysis（2026-07-05，4 线盘点综合）

## 现状：已就绪，不用动
- **数据采集完整**：view / tid / tname / 全互动(like/coin/favorite/share/danmaku/reply) / tags / desc / pic 全部入库，存在 `videos.extra` JSON（采集链路 agent 逐项确认「③已入库」，无需补抓）。
- **后端 filter**：q / tid / tname / tag / lang / track_type / has_subtitle / since / until / min_duration / max_duration（[filter.ts:23](../../../apps/collector-server/src/http/filter.ts#L23)）。
- **后端 sort**：first_seen / published_at / title / duration / **view**（[advanced.ts:142](../../../apps/collector-server/src/db/advanced.ts#L142)）。
- **aggregate groupBy**：creator / tname / lang / track-type，topN=20 硬编码。
- **列表富化**：[enrichItems](../../../apps/collector-server/src/http/queries.ts#L16) 已从 extra 抽 tid/tname/tags，但**没抽 view/pic**。

## 缺失功能清单

### 第一梯队（用户点名 + 高投入产出）
- **A. 列表行显示播放量 + 时长 + 封面** —— 用户点名「播放量多少」。后端 enrichItems 加抽 view/pic + 前端展示。
- **B. 分区筛选下拉** —— 用户点名「分区搜索」。后端 tid/tname filter 已支持，缺 facet 列表端点 + 前端下拉（当前只有 tname 文本框）。

### 第二梯队（影子功能接线，纯前端）
- **C. 时间区间 + 时长区间筛选 UI** —— since/until/min_duration/max_duration 后端+api.ts 都铺好，前端无日期/时长控件。
- **D. UP 详情页挂该 UP 的视频列表** —— 主链路断裂（[CreatorDetailPage](../../../apps/collector-web/src/pages/CreatorDetailPage.tsx) 有资料无视频）。

### 第三梯队（需小后端改）
- **E. 播放量范围 filter（min_view/max_view）+ 按 published_at 时间过滤**（since/until 现只比 first_seen_at）。
- **F. UP 列表按 fans / video_count 排序**（现硬编码 first_seen_at DESC）。

### 第四梯队（大功能，视情况单列）
- 时间趋势图（按天/月分桶，需新端点 + 图表库）
- 字幕全文搜索（FTS5）
- Web 端导出（CLI 已有 export，web 无）
- change_log 最近变更流水（db 层有 getChanges，无 HTTP 端点）
- 独立列 + 索引（性能优化，数据量大再做）

## 执行顺序
**A → B → C → D → E → F** → 第四梯队视情况
