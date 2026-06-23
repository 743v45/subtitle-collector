# info/

测试样本归档：用于 bilibili 字幕扩展开发的真实样例数据。

## 样本

### 视频地址

```
https://www.bilibili.com/video/BV1mhjg6SEJy/?spm_id_from=333.1007.tianma.1-1-1.click&vd_source=f527d7278d3dc02d7590116bd722bf44
```

- BV 号：`BV1mhjg6SEJy`

### AI 字幕链接

```
https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1167578303746023915330506892e636c5641951d0938079b7fd38c022?auth_key=1781675687-995897d41e06442d8a04cf766e910278-0-46acd28fa88ec94aa735144b4644173d
```

- 主机：`aisubtitle.hdslb.com`
- 路径：`/bfs/ai_subtitle/prod/1167578303746023915330506892e636c5641951d0938079b7fd38c022`
- `auth_key` 带时效，过期后需重新获取。

### 响应体 `body.json`

该 URL 的响应已保存为 `body.json`（已格式化，UTF-8，indent=2）。

顶层字段：

| 字段 | 值 | 说明 |
|------|-----|------|
| `font_size` | `0.4` | |
| `font_color` | `#FFFFFF` | |
| `background_alpha` | `0.5` | |
| `background_color` | `#9C27B0` | |
| `Stroke` | `"none"` | |
| `type` | `"AIsubtitle"` | AI 生成字幕 |
| `lang` | `"zh"` | |
| `version` | `"v1.7.0.4"` | |
| `body` | 数组，428 条 | 字幕条目 |

`body[]` 每项结构：

| 字段 | 类型 | 含义 |
|------|------|------|
| `from` | number | 起始时间（秒） |
| `to` | number | 结束时间（秒） |
| `sid` | number | 字幕序号（1 起） |
| `location` | number | 位置标识（此样本全为 `2`） |
| `content` | string | 字幕文本 |
| `music` | number | 音乐标记（此样本全为 `0.0`） |

- 时间范围：`0.36` → `1083.46` 秒（约 18 分 3 秒）
- 示例：
  - 首条：`{from:0.36, to:2.56, sid:1, content:"前几期我一直在讲AI编程工程化"}`
  - 末条：`{from:1079.449, to:1083.46, sid:428, content:"开发者最重要最重要的价值体现"}`
