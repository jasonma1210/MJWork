/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.schedules = [
  {
    "id": "s1",
    "name": "每日站会",
    "plan": "每个工作日 09:00",
    "planShort": "工作日 09:00",
    "target": "汇总看板进度、阻塞与今日计划，发到项目空间。",
    "team": "软件交付班组",
    "budget": 30,
    "owner": "林砚",
    "next": "明天 09:00",
    "last": "今天 09:00 · 成功",
    "lastState": "成功",
    "enabled": true
  },
  {
    "id": "s2",
    "name": "周报",
    "plan": "每周五 18:00",
    "planShort": "周五 18:00",
    "target": "按项目汇总本周交付、花费与风险，生成周报工件。",
    "team": "创业专家团",
    "budget": 80,
    "owner": "许清",
    "next": "10-24 18:00",
    "last": "10-17 18:02 · 成功",
    "lastState": "成功",
    "enabled": true
  },
  {
    "id": "s3",
    "name": "账本结算",
    "plan": "每月 1 日 09:30",
    "planShort": "每月 1 日 09:30",
    "target": "生成上月结算单，按项目与成员分摊，导出 Markdown。",
    "team": "直接回答",
    "budget": 20,
    "owner": "林砚",
    "next": "11-01 09:30",
    "last": "10-01 09:31 · 成功",
    "lastState": "成功",
    "enabled": true
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.notifications = [
  {
    "id": "n1",
    "title": "周行 请求 L1 审批",
    "meta": "修改 .env.example · 6 分钟前",
    "unread": true,
    "route": "#/desk"
  },
  {
    "id": "n2",
    "title": "出海官网 v2 等待验收",
    "meta": "3 个工件 · 1 小时前",
    "unread": true,
    "route": "#/studio?tab=artifacts"
  },
  {
    "id": "n3",
    "title": "本月预算已用 62%",
    "meta": "建议图片生成切到标准档 · 今天 08:50",
    "unread": false,
    "route": "#/ledger"
  }
];
})();
