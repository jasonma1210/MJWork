/* MJWork 原型 · 数据 · 设置默认值
   口径对齐 MJCode 现有设置页（SettingsModal / settings.json）：
   通用（语言 / 描述粒度 / 沙箱 / 审批 / 通知 / 已授权规则 / 大任务拆分 / 分档模型 / 版本更新）
   外观（主题 / 强调色 / 动效）、模型配置、生态与工具、网络与链接、Git 与 Hooks、记忆、团队空间。 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};

  MJ.settingsDefaults = {
    locale: 'zh-CN',
    responseStyle: 'default',
    approvalMode: 'on-request',
    sandboxPolicy: 'workspace-write',
    approvalNotice: false,
    autoDecompose: true,
    accent: 'moss',
    reduceMotion: false,
    mainModel: 'cloud-sonnet',
    providers: [
      { id: 'local-qwen', name: '本地 · Qwen3-32B', url: 'http://127.0.0.1:8080/v1', key: '无需 Key', models: 1, state: '正常' },
      { id: 'cloud-sonnet', name: '云端 · Sonnet 4.5', url: 'https://api.anthropic.com/v1', key: '已保存', models: 2, state: '正常' },
      { id: 'cloud-gpt', name: '云端 · GPT-5.1', url: 'https://api.openai.com/v1', key: '未填', models: 1, state: '需 Key' }
    ],
    tiers: { compact: '', decompose: '', worker: '' },
    tools: { read: true, write: true, shell: false, web: true, sandbox: true, cua: false },
    rules: [
      { id: 'r1', level: 'L2', label: '文件写入', scope: '项目 · 北极星 CRM 重构' },
      { id: 'r2', level: 'L3', label: 'MCP 工具 github', scope: '项目 · 北极星 CRM 重构' }
    ],
    search: {
      firstByte: 20,
      idle: 60,
      total: 600,
      providers: [
        { id: 'searxng', name: 'SearXNG', url: 'https://searx.example.org', enabled: true },
        { id: 'brave', name: 'Brave Search', url: 'https://api.search.brave.com', enabled: false },
        { id: 'tavily', name: 'Tavily', url: 'https://api.tavily.com', enabled: false }
      ]
    },
    linkOpen: 'smart',
    git: { name: '老板', email: 'boss@polestar.dev', path: '/usr/bin/git', scope: '全局', signing: false, gh: '已登录' },
    hooks: [
      { id: 'h1', name: '写入前校验', event: 'preToolUse', match: 'write_file|apply_patch', timeout: 3000, command: 'node ~/.mjwork/hooks/guard.js', enabled: true },
      { id: 'h2', name: '命令审计', event: 'postToolUse', match: 'run_command', timeout: 2000, command: 'node ~/.mjwork/hooks/audit.js', enabled: true }
    ],
    memory: { autoCapture: true, teamAuto: true, teamSharing: false, cap: 300 },
    team: { concurrency: 2, maxMembers: 20, typeLimit: 2 },
    update: { version: '0.1.0-beta', channel: 'stable', state: 'idle', latest: '', lastCheck: '今天 09:00' }
  };

  /* 档位中文标签：设置页、接单台、对话页共用同一份映射，避免各处手写出现口径漂移 */
  MJ.settingLabels = {
    approval: {
      'on-request': '按需审批',
      'auto-safe': '安全动作自动放行',
      always: '每次都问',
      never: '全自动执行'
    },
    sandbox: {
      'read-only': '只读',
      'workspace-write': '工作区可写',
      'full-access': '不隔离',
      'not-ready': '未就绪'
    },
    style: { concise: '精简', default: '默认', detailed: '详细' }
  };

  /* 强调色：只提供无蓝配色（苔绿 / 墨黑 / 赭石 / 酒红），与「绝不出现蓝色」的视觉约束一致 */
  MJ.accentChoices = [
    { id: 'moss', name: '苔绿', vars: {}, darkVars: {} },
    {
      id: 'ink', name: '墨黑',
      vars: { '--moss': '#2B2B26', '--moss-hover': '#1F1F1B', '--moss-soft': 'rgba(43,43,38,.09)', '--moss-line': 'rgba(43,43,38,.24)', '--focus': 'rgba(43,43,38,.45)' },
      darkVars: { '--moss': '#C9C9C0', '--moss-hover': '#DCDCD4', '--moss-soft': 'rgba(201,201,192,.14)', '--moss-line': 'rgba(201,201,192,.32)', '--focus': 'rgba(201,201,192,.5)', '--on-moss': '#141412' }
    },
    {
      id: 'clay', name: '赭石',
      vars: { '--moss': '#8A5A2B', '--moss-hover': '#744A22', '--moss-soft': 'rgba(138,90,43,.10)', '--moss-line': 'rgba(138,90,43,.26)', '--focus': 'rgba(138,90,43,.45)' },
      darkVars: { '--moss': '#C39A6B', '--moss-hover': '#D2AC80', '--moss-soft': 'rgba(195,154,107,.16)', '--moss-line': 'rgba(195,154,107,.34)', '--focus': 'rgba(195,154,107,.5)', '--on-moss': '#17171A' }
    },
    {
      id: 'wine', name: '酒红',
      vars: { '--moss': '#7A2E2E', '--moss-hover': '#642525', '--moss-soft': 'rgba(122,46,46,.10)', '--moss-line': 'rgba(122,46,46,.26)', '--focus': 'rgba(122,46,46,.45)' },
      darkVars: { '--moss': '#D08A86', '--moss-hover': '#DDA09C', '--moss-soft': 'rgba(208,138,134,.16)', '--moss-line': 'rgba(208,138,134,.34)', '--focus': 'rgba(208,138,134,.5)', '--on-moss': '#17171A' }
    }
  ];

  /* 设置页导航：分组与 MJCode 一致（设置 / 功能） */
  MJ.settingsNav = [
    {
      group: '设置',
      items: [
        { id: 'general', name: '通用', kw: '语言 描述粒度 沙箱 审批 通知 规则 拆分 分档 更新' },
        { id: 'appearance', name: '外观', kw: '主题 强调色 动效 侧栏' },
        { id: 'models', name: '模型配置', kw: '服务商 模型 key 连接 主模型' }
      ]
    },
    {
      group: '功能',
      items: [
        { id: 'eco', name: '生态与工具', kw: '技能 mcp 连接器 原生工具 权限 computer use' },
        { id: 'network', name: '网络与链接', kw: '搜索 超时 浏览器 链接 打开方式' },
        { id: 'git', name: 'Git 与 Hooks', kw: 'git github hooks 提交 署名' },
        { id: 'memory', name: '记忆', kw: '沉淀 分层 晋升 清空' },
        { id: 'team', name: '团队空间', kw: '并发 编制 预算 共享' }
      ]
    }
  ];

  /* 分档模型槽位（对齐 MJCode：压缩 / 拆解 / 后台 worker） */
  MJ.tierSlots = [
    { id: 'compact', name: '上下文压缩' },
    { id: 'decompose', name: '任务拆解' },
    { id: 'worker', name: '后台 Worker' }
  ];
})();
