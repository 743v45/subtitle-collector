/**
 * popup「已采」标注刷新触发器(纯逻辑,无 chrome 依赖,可测)。
 *
 * 背景:popup 的「UP 全部视频 / 合集 / YouTube 频道」列表用 useCreatorCollected 拉
 * server /api/videos?creator_uid 构建「已采 vid 集合」(行内绿点 + 头部「已采 N」计数),
 * 原实现只在 popup 打开时拉一次——popup 开着时单视频上报入库(INGEST_RESULT)或批量
 * 采集任务终态(TASK_UPDATE 推送)后,列表采集状态不刷新,需关掉重开 popup(2026-08-24 修复)。
 *
 * 设计:喂入 popup 收到的广播消息,命中触发条件后去抖(默认 1.5s)回调一次重拉:
 *   - INGEST_RESULT 且 ok(!==false)——单视频上报入库(含 no-subtitle 打标,视频元信息同样入库);
 *   - TASK_UPDATE 且 task.status ∈ {succeeded, limited}——批量任务终态入库
 *     (succeeded=轨入库;limited=0 轨但元信息已入库;failed 通常未入库、pending/dispatched
 *     无库变更,均不触发)。批量任务串行完成会连发终态推送,去抖窗口内合并为一次重拉。
 *
 * 用法(hooks.ts useCreatorCollected):
 *   const ctrl = createCollectedRefresh({ onRefresh: () => bumpRefreshKey() });
 *   chrome.runtime.onMessage.addListener((m) => ctrl.notify(m));
 *   // unmount:ctrl.dispose()
 */
export function createCollectedRefresh({ delay = 1500, onRefresh } = {}) {
  if (typeof onRefresh !== 'function') throw new Error('createCollectedRefresh: onRefresh 必填');
  let timer = null;
  const fire = () => {
    timer = null;
    onRefresh();
  };
  const schedule = () => {
    // 窗口内已有待触发计时 → 合并(去抖核心);触发后下一条消息再开新窗口
    if (timer == null) timer = setTimeout(fire, delay);
  };
  return {
    /** popup chrome.runtime.onMessage 收到的消息原样喂入;命中条件则安排去抖重拉 */
    notify(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'INGEST_RESULT') {
        if (msg.ok !== false) schedule();
        return;
      }
      if (msg.type === 'TASK_UPDATE') {
        const status = msg.task?.status;
        if (status === 'succeeded' || status === 'limited') schedule();
      }
    },
    /** popup 组件卸载时清计时器(hook cleanup 调用),防 dispose 后误触发 */
    dispose() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
