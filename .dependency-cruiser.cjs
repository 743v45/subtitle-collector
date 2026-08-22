// 依赖结构规则（dependency-cruiser）—— 分层单向 + 跨 app 隔离 + 禁循环。
// 细则见 docs/quality/RULES.md。跑法：pnpm depcruise（进 pnpm qa 质量门）。
module.exports = {
  forbidden: [
    // —— 跨 app 隔离：apps 之间只走 HTTP/WS API，不走 import ——
    {
      name: 'no-cross-app-server',
      comment: 'collector-server 不得 import 其他 app（跨 app 只走 API）',
      severity: 'error',
      from: { path: '^apps/collector-server/' },
      to: { path: '^apps/(collector-web|subtitle-collector)/' },
    },
    {
      name: 'no-cross-app-web',
      comment: 'collector-web 不得 import 其他 app（跨 app 只走 API）',
      severity: 'error',
      from: { path: '^apps/collector-web/' },
      to: { path: '^apps/(collector-server|subtitle-collector)/' },
    },
    {
      name: 'no-cross-app-ext',
      comment: 'subtitle-collector 不得 import 其他 app（跨 app 只走 API）',
      severity: 'error',
      from: { path: '^apps/subtitle-collector/' },
      to: { path: '^apps/(collector-server|collector-web)/' },
    },

    // —— web 分层：ui 是最底层原子组件，lib 是纯工具层 ——
    {
      name: 'web-ui-isolated',
      comment: 'components/ui 原子组件不得 import pages / 非 ui 组件 / lib / api（保持最底层）',
      severity: 'error',
      from: { path: '^apps/collector-web/src/components/ui/' },
      to: {
        path: '^apps/collector-web/src/(pages|lib|api|components/(?!ui))',
      },
    },
    {
      name: 'web-lib-isolated',
      comment: 'lib 纯工具层不得 import pages / components（保持无 UI 依赖）',
      severity: 'error',
      from: { path: '^apps/collector-web/src/lib/' },
      to: { path: '^apps/collector-web/src/(pages|components)/' },
    },

    // —— server 分层：db 最底层；tasks 不上跳 http/cli ——
    {
      name: 'server-db-bottom',
      comment: 'db 层不得 import http/cli/tasks/ws/main（db 是最底层）',
      severity: 'error',
      from: { path: '^apps/collector-server/src/db/' },
      to: { path: '^apps/collector-server/src/(http|cli|tasks|ws|main)\\.ts$|^apps/collector-server/src/(http|cli|tasks|ws)/' },
    },
    {
      name: 'server-tasks-no-upward',
      comment: 'tasks 层不得 import http/cli/ws/main（调度层只依赖 db）',
      severity: 'error',
      from: { path: '^apps/collector-server/src/tasks/' },
      to: { path: '^apps/collector-server/src/(http|cli|ws)/|^apps/collector-server/src/main\\.ts$' },
    },

    // —— 扩展：React 侧（popup/options）不得 import 运行时脚本 ——
    // 共享纯模块（顶层 .mjs，如 subtitleFormat.mjs/servers.mjs）是既定共享模式，放行；
    // 运行时脚本（background/content/inject）各有浏览器运行环境与全局态，只能走 chrome.runtime 消息。
    {
      name: 'ext-no-runtime-script-import',
      comment: 'src/（popup/options React 侧）不得 import background/content/inject 运行时脚本',
      severity: 'error',
      from: { path: '^apps/subtitle-collector/src/' },
      to: { path: '^apps/subtitle-collector/(background|content|content-yt|inject|inject-yt)\\.js$' },
    },

    // —— 循环依赖全仓禁止 ——
    {
      name: 'no-circular',
      comment: '循环依赖：模块职责边界不清的信号',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // 项目全为相对路径导入（无 path alias），不需要 tsconfig 解析；tsconfig 在各 app 下而工具在根跑。
    doNotFollow: { path: 'node_modules' },
    // 测试文件豁免：架构规则只管运行时代码（测试常为覆盖便利反向 import，如 db 测试引 http/filter
    // 造数据），与 ESLint 静态门豁免测试的口径一致。
    exclude: ['^(dist|\\.husky)', '\\.(test|spec)\\.[cm]?[jt]s$'],
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'node', 'require'] },
  },
};
