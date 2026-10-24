/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.connectors = [
  {
    "id": "github",
    "name": "GitHub",
    "vendor": "GitHub",
    "cat": "版本控制",
    "transport": "HTTP",
    "auth": "OAuth 设备码",
    "layer": "白名单",
    "health": "健康",
    "calls": "1,284",
    "desc": "读仓库、开 PR、查 Actions 日志。"
  },
  {
    "id": "notion",
    "name": "Notion",
    "vendor": "Notion",
    "cat": "知识库",
    "transport": "HTTP",
    "auth": "内部集成 Token",
    "layer": "白名单",
    "health": "健康",
    "calls": "642",
    "desc": "读写项目空间与会议纪要。"
  },
  {
    "id": "figma",
    "name": "Figma",
    "vendor": "Figma",
    "cat": "设计",
    "transport": "HTTP",
    "auth": "个人访问令牌",
    "layer": "手动",
    "health": "需授权",
    "calls": "318",
    "desc": "拉取画板与设计变量。"
  },
  {
    "id": "slack",
    "name": "Slack",
    "vendor": "Salesforce",
    "cat": "沟通",
    "transport": "HTTP",
    "auth": "Bot Token",
    "layer": "自动启动",
    "health": "健康",
    "calls": "906",
    "desc": "推送交付通知与审批提醒。"
  },
  {
    "id": "postgres",
    "name": "Postgres",
    "vendor": "社区",
    "cat": "数据库",
    "transport": "stdio",
    "auth": "连接串（只读）",
    "layer": "手动",
    "health": "需手动授权",
    "calls": "2,140",
    "desc": "只读查询测试库，高危操作走审批。"
  },
  {
    "id": "playwright",
    "name": "Playwright",
    "vendor": "Microsoft",
    "cat": "浏览器",
    "transport": "stdio",
    "auth": "无需鉴权",
    "layer": "白名单",
    "health": "健康",
    "calls": "1,720",
    "desc": "本地无头浏览器，跑端到端测试。"
  },
  {
    "id": "brave",
    "name": "Brave Search",
    "vendor": "Brave",
    "cat": "检索",
    "transport": "HTTP",
    "auth": "API Key",
    "layer": "自动启动",
    "health": "健康",
    "calls": "3,468",
    "desc": "公开网页检索，不登录个人账号。"
  },
  {
    "id": "filesystem",
    "name": "Filesystem",
    "vendor": "官方",
    "cat": "文件",
    "transport": "stdio",
    "auth": "工作区沙箱",
    "layer": "自动启动",
    "health": "健康",
    "calls": "5,932",
    "desc": "限定在项目目录内读写文件。"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.connectorLayers = [
  {
    "id": "all",
    "name": "全部"
  },
  {
    "id": "自动启动",
    "name": "自动启动"
  },
  {
    "id": "白名单",
    "name": "白名单"
  },
  {
    "id": "手动",
    "name": "手动"
  }
];
})();
