# 站内条目跳转原站（视频页 / UP 空间页）— 设计

日期：2026-08-19
状态：已确认（方案 A：纯函数 + OutLink 组件 + server 补字段，全站接入）

## 背景

collector-web 各页面展示视频标题与 UP 主名，但均为纯文本，无法跳回 B 站 / YouTube 原站对照。需求：视频条目跳转原站视频页、作者条目跳转原站空间页，全站（视频详情页、视频列表页、UP 详情页、UP 列表页）生效。

## 架构决策

- **URL 拼法收口为纯函数**：新建 `apps/collector-web/src/lib/sourceLinks.ts`，`videoUrl(source, sourceVid)` / `creatorUrl(source, uid)` 返回 `string | null`。返回 null（未知 source / 缺 uid）时接入点退化为纯文本，不渲染链接。
- **统一外链组件 `OutLink`**：`apps/collector-web/src/components/OutLink.tsx`，封装 `<a target="_blank" rel="noopener noreferrer">` + hover 下划线 + 可选 lucide `ExternalLink` 小图标。6+ 处接入点共用，避免样式漂移。
- **server 只补一列**：getVideo 详情 SQL join creators 时补 `c.source_uid AS creator_source_uid`（列表 API 已有该字段，详情缺）。无 schema 迁移、无新端点。

## 跳转规则

| 条目 | bilibili | youtube |
|---|---|---|
| 视频 | `https://www.bilibili.com/video/{source_vid}` | `https://www.youtube.com/watch?v={source_vid}` |
| 作者 | `https://space.bilibili.com/{source_uid}` | `https://www.youtube.com/channel/{source_uid}` |

数据依据（本地库已验证）：bilibili `source_uid` = 数字 mid；youtube `source_uid` = `UC…` channel ID。

## 改动清单

### server
- [queries.ts](../../../apps/collector-server/src/db/queries.ts) `getVideo`：SELECT 加 `c.source_uid AS creator_source_uid`。

### web
- `types.ts`：`VideoInfo` 加 `creator_source_uid?: string | null`。
- 新建 `lib/sourceLinks.ts` + `lib/sourceLinks.test.ts`（node:test 纯函数，两平台 × 视频/作者 × null 退化共 ~8 用例）。
- 新建 `components/OutLink.tsx`。
- 接入点（均保留原样式，hover 下划线提示可点；缺 uid / 未知 source 显示纯文本）：
  - **VideoDetail**：h1 标题整体包 OutLink 跳视频页；「作者」Field 值包 OutLink 跳空间页。
  - **VideoList**：标题本身保留点击进站内详情，标题旁加 ExternalLink 图标按钮跳原站（避免嵌套交互元素）；作者名 OutLink 跳空间页（列表 API 已有 `creator_source_uid`）。
  - **CreatorDetailPage**：头部 UP 名 OutLink 跳空间页；视频卡标题旁加外链图标（卡片本身保留 onOpenVideo 进站内详情）。
  - **CreatorsPage**：表格 UP 名 TableCell 包 OutLink 跳空间页。

## 错误处理

- `creator_source_uid` 为 null（早期数据 / creator 未落库）或 source 未知：显示纯文本，不渲染 `<a>`。
- 全部外链 `target="_blank" rel="noopener noreferrer"`（站内为 hash 路由，必须新开标签）。

## 不做（YAGNI）

- 不做 youtube `@handle` 短链（channel ID 已可用）。
- 不加「复制链接」按钮、不加用户自定义域名（LAN IP 打开场景与外站跳转无关）。
- 扩展 popup 不动（本需求仅 collector-web）。

## 测试轮次记录表

| 轮次 | 命令 | 结果 |
|---|---|---|
| 1 | collector-web `npx tsc --noEmit`（改动文件）/ `node --test src/lib/sourceLinks.test.ts` | 待实施填写 |
| 2 | `pnpm turbo run build`（web vite 冒烟） | 待实施填写 |
| 3 | `pnpm turbo run test` 全量（server 单测含 getVideo 新字段断言） | 待实施填写 |

版本：不涉及 subtitle-collector 扩展改动，manifest 不 bump；web/server 走 docker rebuild 自带最新。
