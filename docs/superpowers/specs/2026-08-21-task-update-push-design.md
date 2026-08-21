# WS task-update 底层推送 → popup 实时任务进度

日期:2026-08-21
状态:已批准(设计三问:只做 popup / 独立进度列表 / 有在途才显示)

## 问题

popup 批量提交(`POST /api/collect-tasks/batch`)后只有一次性 toast;任务状态(pending→dispatched→succeeded/failed)只存在 server SQLite,HTTP 侧仅有拉模式接口(手机采集页 2s 轮询),popup 无法实时看到进度。

## 方案总览

复用扩展↔server 的既有 WS 长连:server 在任务状态落库后广播 `task-update` 推送 → background 原样转发 `chrome.runtime.sendMessage` → popup 合并渲染。快照(GET /api/collect-tasks)+ 低频兜底轮询补推送盲区(popup 关闭期间、旧 server)。

推送策略:广播所有已握手连接,不按 creator_client_id 定向——每任务全生命周期最多 4 条小消息,广播省掉路由复杂度,顺带覆盖任务降级派给其他机器执行的场景。

## 协议(server→扩展,无 id 推送,与 hello-ack/ingest-ack 同类)

- `{type:'task-update', task:<CollectTask 完整行,含 LEFT JOIN title>}`
  触发:任务创建(pending)、派发(dispatched)、终态(succeeded/failed)、迟到改判(amend)。
- `{type:'task-delete', id: number}` — 任务删除后。

兼容性双向安全:旧扩展 background 的 `if (!msg.id) return;` 守卫静默忽略新消息;新扩展 + 旧 server 收不到推送,靠快照+兜底轮询降级,列表仍可用(不实时)。

## server 改动

- `ws/server.ts`:新增 `broadcastEvent(msg)` 导出(遍历 connections,readyState OPEN 即发)。
- `tasks/tasks.ts`:内部 `pushTask(db, id)`——`getTask` 取整行(含 title)后 `broadcastEvent`;task 不存在则不推。各触发点一行调用:
  - `createTask`(单条/批量共用)→ pending
  - `dispatchTask`:UPDATE dispatched 后、UPDATE succeeded/failed 后
  - `deleteTask` 成功后 → `{type:'task-delete', id}`
  - `resetDispatched`(启动恢复)无连接,不推
- `tasks/amend.ts`:`amendLateResult` 返回值 boolean → `number | null`(改判的 task id);保持不 import ws/server(amend 被其调用,反向 import 成环)。`ws/server.ts` 迟到 result 处理在改判命中后调 `pushTask`。

## 扩展改动

- `background.js` `ws.onmessage`:在 `ingest-ack` 分支旁加 `task-update`/`task-delete` 两分支,`chrome.runtime.sendMessage({type:'TASK_UPDATE', task})` / `{type:'TASK_DELETE', id}` 转发。转发必须吞无监听者错误(popup 关闭是常态,sendMessage 会 reject)——现有 `INGEST_RESULT` 裸调同样隐患,一并修。

## popup 改动

- `hooks.ts` 新增 `useCollectTasks(httpBase, enabled)`:
  - 挂载拉快照 `GET /api/collect-tasks?limit=50` → `Map<id, task>`(state 为数组,合并在回调里按 id upsert)
  - 订阅 `chrome.runtime.onMessage` 的 `TASK_UPDATE`(upsert)/`TASK_DELETE`(remove)
  - 10s 低频兜底轮询重拉(旧 server 无推送时仍是慢实时)
- `Popup.tsx` 新增 `CollectTasksCard`(位置:BrandHeader 后第一个卡,非视频页也可见):
  - 显隐:存在 pending/dispatched 任务 → 显示;全部终态后保留 30s 再收起(记录"最后存在在途的时刻")
  - 每行:平台标 + 标题(无则 source_vid)+ 状态徽标:排队(灰)/采集中(蓝)/成功(绿,带 captured 轨数)/失败(红 + error 文案)
  - 在途置顶(按 id 升序),终态按 finished_at desc 跟随;最多显示 10 行,超出折叠成计数行
  - standalone 模式 enabled=false 不显示(守卫与批量按钮一致)
- 批量提交流程不变:toast 保留;新任务的 pending 推送/快照令卡片自动浮现。

## 边界

- popup 关闭期间错过的推送:重开时快照即真值,不做补发/seq 机制(YAGNI)。
- WS 断线重连期间:兜底轮询补。
- 旧扩展收到新推送:静默忽略(487 行守卫);扩展版本不强制 bump(新增消息向后兼容)。

## 测试

- server(`http/tasks.test.ts` 增补,复用真 WS 集成测试模式):模拟扩展连接后建任务/派发/终态/删除,断言收到 task-update 消息序列(pending→dispatched→succeeded,task 行含 title/status);删除收到 task-delete;amend 改判路径推一条(在 ws 层迟到 result 测试中补,若该路径已有测试文件则在其内)。
- 扩展:`test/*.test.mjs` 按现有模式补 hook 合并逻辑可测部分(popup 无浏览器测试环境,推送合并逻辑若难独立测则依赖 server 集成测试 + 手动验收)。

## 非目标

- 手机 web 采集页 SSE(范围已排除,后续需要再做)
- 推送补发/序列号机制
- popup 端任务删除/重试操作(只读进度)
