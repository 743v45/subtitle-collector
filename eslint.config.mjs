// ESLint 静态质量门 —— 仅两条规则：圈复杂度(complexity ≤15)与模块大小(max-lines ≤400 总行数)。
// 细则与豁免流程见 docs/quality/RULES.md；台账对比由 scripts/quality-baseline.mjs 负责（ESLint 只报 warn）。
// 范围：三个 app 源码 + 扩展顶层裸脚本 + 根 scripts/；排除测试文件(豁免)、subtitle-extractor(测试冻结先例)、生成物。
// 仅用 typescript-eslint 的 parser（语法级规则无需 type-aware），不引入其规则集。
import { parser as tsParser } from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // .claude/worktrees/** 是会话级临时 worktree（自带独立分支，不属于本仓源码面），
      // 静态台账扫描（quality-baseline）经 ESLint 快照取数，须一并排除防误登记
      '.claude/**',
      'apps/subtitle-extractor/**',
      // 测试文件对两条静态规则豁免（质量由覆盖率指标管）
      '**/*.test.*',
      'apps/subtitle-collector/test/**',
      // 生成物
      'apps/subtitle-collector/icons/**',
    ],
  },
  {
    files: [
      'apps/collector-server/src/**/*.ts',
      'apps/collector-web/src/**/*.{ts,tsx}',
      'apps/subtitle-collector/src/**/*.{ts,tsx}',
      'apps/subtitle-collector/*.{mjs,js}',
      'apps/subtitle-collector/scripts/**/*.mjs',
      'scripts/**/*.{mjs,mts}',
    ],
    languageOptions: { parser: tsParser },
    rules: {
      complexity: ['warn', 15],
      'max-lines': ['warn', { max: 400, skipBlankLines: false, skipComments: false }],
    },
  },
];
