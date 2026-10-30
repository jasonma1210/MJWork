// ESLint 配置（P1-6）
// 目标：给 10434 行主进程 + 10618 行渲染层补上「机器可执行的卫生门禁」。
// 此前全仓零 ESLint，代码卫生（空 catch 1 处 / TODO 7 处 / 重复代码 0.8%）
// 全靠人工自律——这个数字说明作者很用心，但**没有机器保障**就意味着
// 任何一次疏忽都不会被拦住。
//
// 规则刻意保守：只加「明确的坏味道」类规则（no-unused-vars / no-undef / no-empty /
// no-console 在 src 侧），**不引入风格争议规则**（缩进/引号交给 Prettier），
// 避免一次性涌入海量告警导致规则被整体弃用。
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node 侧
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly',
        // 以下为 Node 17+/Electron 33 可用但 js.configs.recommended 未声明的全局
        structuredClone: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        queueMicrotask: 'readonly', globalThis: 'readonly', performance: 'readonly',
        // T3-1：protocol.handle 回应用 Response 对象（Node 18+/Electron 33 全局）
        Response: 'readonly', Request: 'readonly', Headers: 'readonly', FormData: 'readonly',
      },
    },
    rules: {
      // ── 真错误（必须修）──
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }],

      // ── 坏味道（本项目既有门禁的机器化）──
      'no-empty': ['warn', { allowEmptyCatch: false }], // 对齐「空 catch 要有注释」基线
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-alert': 'error',

      // ── 潜在缺陷 ──
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'warn',
      'no-return-await': 'off', // 项目刻意使用 return await 保证栈可读
      'no-console': 'off', // 主进程日志是产品能力，不禁

      // T2-3：God File 硬门禁——>1500 行直接红（lint 0 error 的「红」）。
      // 800 行软档（warn 级）由 test/max-lines.test.js 基线清单实现「只减不增」，
      // 原因：ESLint 同一规则无法对同一文件配两档 severity，error 档必须无豁免地
      // 拦住所有新文件（存量 >1500 的两个文件见下方 overrides 豁免清单）。
      'max-lines': ['error', { max: 1500, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // agent-core 是 ESM 模块（package.json type: module），需独立 sourceType。
    // 它同时被主进程（动态 import）与渲染层（Vite）加载，故 globals 需同时覆盖
    // Node 与浏览器两侧。
    files: ['agent-core/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly', URL: 'readonly',
        structuredClone: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        globalThis: 'readonly', performance: 'readonly',
        // 渲染层宿主兼容（engine 在两种宿主下运行）
        window: 'readonly', document: 'readonly', localStorage: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-eval': 'error',
    },
  },
  {
    files: ['renderer/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly',
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        fetch: 'readonly', URL: 'readonly', AbortController: 'readonly',
        Blob: 'readonly', FileReader: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
        HTMLElement: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
        // 以下为补齐的浏览器全局（useVoice 语音转写、collab base64 编解码等实际用到）
        btoa: 'readonly', atob: 'readonly',
        AudioContext: 'readonly', webkitAudioContext: 'readonly',
        MediaRecorder: 'readonly', Audio: 'readonly', HTMLAudioElement: 'readonly',
        File: 'readonly', FormData: 'readonly', XMLHttpRequest: 'readonly',
        WebSocket: 'readonly', location: 'readonly', history: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        structuredClone: 'readonly', crypto: 'readonly',
        performance: 'readonly', requestIdleCallback: 'readonly', cancelIdleCallback: 'readonly',
        documentFragment: 'readonly', Image: 'readonly', CanvasRenderingContext2D: 'readonly',
        IntersectionObserver: 'readonly', matchMedia: 'readonly', Notification: 'readonly',
        KeyboardEvent: 'readonly', MouseEvent: 'readonly', DragEvent: 'readonly',
        HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly', HTMLDivElement: 'readonly',
        SVGElement: 'readonly', getComputedStyle: 'readonly', scrollTo: 'readonly',
      },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '18.3' } },
    rules: {
      ...react.configs.recommended.rules,
      // P1-6：启用 exhaustive-deps（warn 而非 error）。
      // 选 warn 的理由：存量代码里 useEffect 依赖数组不严谨是普遍现象，一次性设 error
      // 会涌入大量告警导致规则被整体弃用；设 warn 既让新代码被 CI 看见，又不阻断构建。
      // 后续存量清零后可收紧为 error。
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react/prop-types': 'off', // 无 TS，prop-types 成本高且与既有 jest 无关
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/jsx-key': 'error',
      'react/no-children-prop': 'error',
      'react/no-danger-with-children': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-console': 'off', // 渲染层 console 已在既有门禁中按零 emoji 等约束管理
    },
  },
  {
    // 测试与构建脚本：放宽（需要 root hooks / 动态特性）
    files: ['test/**/*.{js,mjs}', '*.config.js', 'eval/**/*.mjs', 'main/preload.js'],
    rules: {
      'no-unused-vars': 'off',
      'no-empty': 'off',
      // 测试夹具刻意包含 javascript: 字符串（安全用例的被拒输入）与
      // 匹配源码文本的正则（含连续空格），这两条规则在 test/ 属误报
      'no-script-url': 'off',
      'no-regex-spaces': 'off',
    },
  },
  {
    // .mjs 按 Node 规范恒为 ESM：test/eval 下的 .mjs 使用 import/export，
    // 必须覆盖第一块的 sourceType: 'commonjs'，否则解析即报 error。
    files: ['test/**/*.mjs', 'eval/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', URL: 'readonly',
        fetch: 'readonly', Buffer: 'readonly', AbortController: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', global: 'readonly',
      },
    },
  },
  {
    // T2-3：max-lines 存量豁免清单（>1500 行，只减不增）。
    // 与 test/max-lines.test.js 是**双向绑定**，任一侧漏改都会红：
    //   · 本清单的文件名集合必须与该套件算出的 over1500 集合完全相等；
    //   · agent-core/index.js 同时登记在 BASELINE_800 的 code 行数快照里（上限 2967）。
    // 所以「豁免」不是无上限挡箭牌：它只能缩，涨 1 行就红。拆到 1500(code) 以下后
    // 必须从这两个地方一起删掉；禁止新增条目（新文件超线要先拆再合入）。
    files: [
      'agent-core/index.js',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // T4-2：Chrome 接管扩展（MV3 service worker）——chrome.* 扩展 API 与浏览器全局。
    // 只补 globals：其余规则沿用第一块（no-undef/max-lines 等照常生效）。
    files: ['chrome-extension/**/*.js'],
    languageOptions: {
      globals: {
        chrome: 'readonly', WebSocket: 'readonly', navigator: 'readonly',
        window: 'readonly', document: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', 'renderer/dist/', 'release/', '**/*.bak', 'coverage/', 'desktop/eval/results/'],
  },
];
