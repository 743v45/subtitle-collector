# Web 导出与原料包

web 上三处导出入口,对应 CLI `export videos` / `export subtitle` / `export bundle`(CLI 用法见 [[导出字幕与视频]]、[[导出分析原料包]])。

## 视频库:列表导出(CSV / NDJSON / JSON)

视频页工具栏「导出」下拉,选格式即下载;**当前筛选条件原样透传**——先筛后导(关键词/标签/平台/时间等全部生效),条件也随 URL 还原。

对应 CLI:`export videos --format csv|ndjson`(web 多 json、少 table 人读形态)。

## 视频库:原料包(zip)

工具栏「原料包」开对话框,按当前筛选把一批视频的元信息 + 字幕打包成分析原料 zip(manifest.json + videos/*.txt + ANALYZE.md 三件套):

| 选项 | 说明 |
|---|---|
| 打包上限 | 1–1000,默认 500(超限服务端拒绝) |
| 文件名组成 | 包内文件命名成分:ID+标题(默认)/ 仅 ID / ID+标题+发布时间 / ID+标题+作者 |
| 字幕轨语言 | 留空 = 各视频默认轨;填 lan(如 `zh-Hans`)统一指定轨 |

下载完成对话框内联显示三个数:**匹配 / 导出 / 错误**;错误 > 0 出黄条提示部分视频缺字幕未导出(明细在包内 manifest.json)。

导出后喂给 [[分析工作流]]。对应 CLI:`export bundle`(web 直出 zip 下载;生产库走 `scripts/export-bundle.mjs` 快照两步,见 [[导出分析原料包]])。

## 视频详情:按轨导出

详情页字幕正文区的「按轨导出」条:选轨(下拉列出该视频全部轨,默认轨带标记)+ 格式(SRT / VTT / TXT / JSON)→「导出」即下载(取该轨默认版本)。

对应 CLI:`export subtitle <source> <vid> --track <lan> --sub-format <fmt>`。

> [!tip] 三处入口的筛选口径
> 列表导出与原料包都吃当前列表筛选;按轨导出只看当前视频的轨。批量打包给分析用永远走「原料包」,单视频拿字幕文件走「按轨导出」。
