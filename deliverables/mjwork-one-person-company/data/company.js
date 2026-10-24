/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.company = {
  "id": "polestar",
  "name": "北极星工作室",
  "tagline": "一个人的软件公司",
  "owner": "老板",
  "budget": 20000,
  "used": 12480,
  "balance": 7520,
  "forecast": 18200,
  "tokens": 8.42,
  "month": "2026 年 10 月"
};
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.companies = [
  {
    "id": "polestar",
    "name": "北极星工作室",
    "meta": "当前公司 · 5 名数字员工"
  },
  {
    "id": "nanshan",
    "name": "南山实验室",
    "meta": "试验公司 · 3 名数字员工"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.team = [
  {
    "id": "lin-yan",
    "name": "林砚",
    "role": "统筹",
    "lead": true,
    "model": "云端 · Sonnet 4.5",
    "tier": "高级",
    "tools": [
      "project",
      "dispatch",
      "review"
    ],
    "status": "值班中",
    "focus": "拆目标、定批次、验收交付",
    "joined": "09-02",
    "load": 82
  },
  {
    "id": "xu-qing",
    "name": "许清",
    "role": "产品",
    "lead": false,
    "model": "云端 · GPT-5.1",
    "tier": "高级",
    "tools": [
      "read",
      "write",
      "web"
    ],
    "status": "写需求规格",
    "focus": "需求澄清、验收标准、记忆维护",
    "joined": "09-02",
    "load": 64
  },
  {
    "id": "shen-mo",
    "name": "沈墨",
    "role": "设计",
    "lead": false,
    "model": "本地 · Qwen3-VL 32B",
    "tier": "标准",
    "tools": [
      "design",
      "write",
      "screenshot"
    ],
    "status": "做高保真",
    "focus": "信息架构、界面与交互稿",
    "joined": "09-05",
    "load": 57
  },
  {
    "id": "zhou-xing",
    "name": "周行",
    "role": "工程",
    "lead": false,
    "model": "云端 · Sonnet 4.5",
    "tier": "高级",
    "tools": [
      "read",
      "write",
      "edit",
      "bash",
      "git"
    ],
    "status": "改接口契约",
    "focus": "实现、迁移脚本、联调",
    "joined": "09-02",
    "load": 91
  },
  {
    "id": "chen-yu",
    "name": "陈屿",
    "role": "市场",
    "lead": false,
    "model": "本地 · Qwen3 32B",
    "tier": "标准",
    "tools": [
      "web",
      "write",
      "analytics"
    ],
    "status": "整理竞品",
    "focus": "竞品拆解、试点名单、发布文案",
    "joined": "09-12",
    "load": 38
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.modes = [
  {
    "id": "auto",
    "name": "自动",
    "desc": "按目标复杂度自动选择人数与批次",
    "cast": "统筹先判断，最多拉起 5 人"
  },
  {
    "id": "answer",
    "name": "直接回答",
    "desc": "不建项目，单模型直接回答",
    "cast": "只调用 1 名模型，不写文件"
  },
  {
    "id": "template",
    "name": "按模板",
    "desc": "套用固定班组与验收清单",
    "cast": "软件交付班组 4 人"
  },
  {
    "id": "team",
    "name": "团队协作",
    "desc": "多角色并行，统筹汇总与验收",
    "cast": "林砚 + 许清 + 沈墨 + 周行 + 陈屿"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.templates = [
  {
    "id": "founders",
    "name": "创业专家团",
    "people": 5,
    "desc": "战略、产品、技术、增长、财务各一人，适合从 0 到 1。",
    "cast": "林砚 · 许清 · 周行 · 陈屿 · 方岚"
  },
  {
    "id": "delivery",
    "name": "软件交付班组",
    "people": 4,
    "desc": "产品、设计、工程、测试，适合已有项目的迭代交付。",
    "cast": "林砚 · 许清 · 沈墨 · 周行"
  },
  {
    "id": "blank",
    "name": "空白",
    "people": 0,
    "desc": "不预置成员，派单时再决定拉起谁。",
    "cast": "暂不编入成员"
  }
];
})();
