/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.projects = [
  {
    "id": "crm",
    "name": "北极星 CRM 重构",
    "short": "CRM 重构",
    "status": "交付中",
    "progress": 62,
    "budget": 8000,
    "spent": 5960,
    "tokens": 3.92,
    "due": "11-06",
    "owner": "林砚",
    "dir": "~/MJWork/polestar-crm",
    "team": 5,
    "mode": "团队协作",
    "updated": "4 分钟前",
    "goal": "把线索导入流程重做：CSV 导入、字段映射、重复合并，并把导入过程做成可回滚的批次任务。"
  },
  {
    "id": "site",
    "name": "出海官网 v2",
    "short": "出海官网",
    "status": "等待验收",
    "progress": 100,
    "budget": 5000,
    "spent": 3120,
    "tokens": 2.61,
    "due": "10-24",
    "owner": "沈墨",
    "dir": "~/MJWork/polestar-site",
    "team": 3,
    "mode": "按模板",
    "updated": "昨天 18:20",
    "goal": "面向东南亚市场重做官网：英文优先、首屏加载低于 1.8 秒、接入线索表单。"
  },
  {
    "id": "report",
    "name": "Q4 投资研报",
    "short": "投资研报",
    "status": "已完成",
    "progress": 100,
    "budget": 3000,
    "spent": 2400,
    "tokens": 1.89,
    "due": "10-18",
    "owner": "许清",
    "dir": "~/MJWork/q4-research",
    "team": 2,
    "mode": "直接回答",
    "updated": "10-18",
    "goal": "整理 12 家 SaaS 公司的续费率与客单价，输出 18 页投资研报。"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.currentProjectId = "crm";
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.approvals = [
  {
    "id": "A-1042",
    "level": "L1",
    "risk": "低",
    "title": "修改 .env.example，新增 STRIPE_WEBHOOK_SECRET 占位",
    "project": "北极星 CRM 重构",
    "who": "周行",
    "age": "6 分钟前",
    "scope": "3 个部署配置 · 不触碰真实密钥",
    "diff": "+2 −0",
    "files": [
      ".env.example",
      "docs/deploy.md"
    ],
    "reason": "接入支付回调需要声明新的环境变量；只写占位符，不写入真实值。",
    "action": "写入工作区内 2 个文件"
  },
  {
    "id": "A-1043",
    "level": "L2",
    "risk": "中",
    "title": "删除旧线索表字段 phone_legacy（迁移不可逆）",
    "project": "北极星 CRM 重构",
    "who": "周行",
    "age": "22 分钟前",
    "scope": "12% 历史线索依赖该字段 · 影响 1 张报表",
    "diff": "−14 +3",
    "files": [
      "migrations/014_drop_phone_legacy.sql",
      "src/lead/mapper.ts"
    ],
    "reason": "字段已迁移到 phones 表，但旧报表仍在读取，需要确认是否同步改报表。",
    "action": "执行数据库迁移 · 不可回滚"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.deliveries = [
  {
    "id": "d1",
    "artifactId": "prd",
    "name": "需求规格",
    "version": "v0.03",
    "type": "PRD",
    "project": "北极星 CRM 重构",
    "who": "许清",
    "time": "12 分钟前",
    "state": "已验收"
  },
  {
    "id": "d2",
    "artifactId": "api",
    "name": "接口契约",
    "version": "v0.04",
    "type": "契约",
    "project": "北极星 CRM 重构",
    "who": "周行",
    "time": "36 分钟前",
    "state": "待确认"
  },
  {
    "id": "d3",
    "artifactId": "hi",
    "name": "首页高保真",
    "version": "v0.05",
    "type": "设计稿",
    "project": "出海官网 v2",
    "who": "沈墨",
    "time": "1 小时前",
    "state": "待验收"
  },
  {
    "id": "d4",
    "artifactId": "",
    "name": "迁移方案",
    "version": "v0.02",
    "type": "方案",
    "project": "北极星 CRM 重构",
    "who": "周行",
    "time": "昨天 18:40",
    "state": "已验收"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.artifacts = [
  {
    "id": "prd",
    "name": "需求规格",
    "version": "v0.03",
    "type": "PRD",
    "project": "crm",
    "updated": "今天 09:41",
    "state": "已验收",
    "owner": "许清",
    "size": "18.4 KB",
    "pages": 12,
    "summary": "线索导入的范围、字段映射规则、重复合并策略与验收标准。",
    "changes": [
      {
        "file": "docs/prd/lead-import.md",
        "add": 42,
        "del": 6
      },
      {
        "file": "docs/prd/acceptance.md",
        "add": 18,
        "del": 2
      },
      {
        "file": "docs/prd/glossary.md",
        "add": 4,
        "del": 1
      },
      {
        "file": "docs/prd/open-questions.md",
        "add": 3,
        "del": 0
      }
    ]
  },
  {
    "id": "ia",
    "name": "信息架构",
    "version": "v0.02",
    "type": "图表",
    "project": "crm",
    "updated": "今天 10:18",
    "state": "已验收",
    "owner": "沈墨",
    "size": "6.1 KB",
    "pages": 3,
    "summary": "导入向导的三步结构、字段映射表与异常回退路径。",
    "changes": [
      {
        "file": "design/ia/import-flow.md",
        "add": 26,
        "del": 4
      },
      {
        "file": "design/ia/screen-map.md",
        "add": 12,
        "del": 3
      },
      {
        "file": "design/ia/empty-states.md",
        "add": 9,
        "del": 0
      }
    ]
  },
  {
    "id": "api",
    "name": "接口契约",
    "version": "v0.04",
    "type": "契约",
    "project": "crm",
    "updated": "今天 10:52",
    "state": "待确认",
    "owner": "周行",
    "size": "11.7 KB",
    "pages": 8,
    "summary": "导入批次、字段映射、重复合并三组接口与错误码。",
    "changes": [
      {
        "file": "api/openapi.yaml",
        "add": 74,
        "del": 12
      },
      {
        "file": "api/errors.md",
        "add": 16,
        "del": 2
      },
      {
        "file": "src/types/import.ts",
        "add": 31,
        "del": 8
      },
      {
        "file": "api/examples/import-batch.json",
        "add": 12,
        "del": 0
      }
    ]
  },
  {
    "id": "hi",
    "name": "首页高保真",
    "version": "v0.05",
    "type": "设计稿",
    "project": "site",
    "updated": "今天 09:06",
    "state": "待验收",
    "owner": "沈墨",
    "size": "24.9 KB",
    "pages": 6,
    "summary": "英文首页、定价页与线索表单的高保真稿，含 1366 宽适配。",
    "changes": [
      {
        "file": "design/site/home-v5.md",
        "add": 18,
        "del": 5
      },
      {
        "file": "design/site/pricing-v2.md",
        "add": 22,
        "del": 4
      },
      {
        "file": "design/site/form-v3.md",
        "add": 14,
        "del": 2
      },
      {
        "file": "design/site/tokens.md",
        "add": 6,
        "del": 1
      }
    ]
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.runtime = {
  "project": "北极星 CRM 重构",
  "mode": "团队协作",
  "people": 5,
  "cost": 4.86,
  "goal": "把北极星 CRM 的线索导入流程重做：支持 CSV 导入、字段映射与重复合并，下周给销售团队试用。",
  "batch": "批次 2 / 3",
  "concurrency": 2,
  "started": "09:32",
  "progress": 62,
  "steps": [
    {
      "name": "读取项目记忆",
      "time": "1.2s",
      "tool": "memory.read",
      "cost": "0.02",
      "who": "林砚",
      "note": "命中 4 条项目记忆，2 条与导入强相关"
    },
    {
      "name": "解析目标与约束",
      "time": "4.8s",
      "tool": "plan.split",
      "cost": "0.18",
      "who": "林砚",
      "note": "拆出 6 个任务，按依赖分成 3 批"
    },
    {
      "name": "读取仓库与既有 PRD",
      "time": "2.4s",
      "tool": "read · grep",
      "cost": "0.11",
      "who": "许清",
      "note": "读取 14 个文件，跳过 node_modules"
    },
    {
      "name": "写需求规格 v0.03",
      "time": "38.6s",
      "tool": "write",
      "cost": "1.42",
      "who": "许清",
      "note": "补充字段映射与重复合并的验收标准"
    },
    {
      "name": "自查验收标准",
      "time": "6.2s",
      "tool": "self-review",
      "cost": "0.36",
      "who": "林砚",
      "note": "发现 1 处缺失空态描述，已回退给许清"
    }
  ],
  "decision": "命中规则：多角色交付（multi-role-delivery v3）。目标同时涉及数据迁移与界面改动，单人无法覆盖。"
};
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.chatTracks = [
  {
    "who": "林砚",
    "role": "统筹",
    "state": "done",
    "steps": [
      "接单",
      "拆 6 个任务",
      "定 3 批",
      "验收批次 1"
    ]
  },
  {
    "who": "许清",
    "role": "产品",
    "state": "running",
    "steps": [
      "读取仓库",
      "写 PRD v0.03",
      "补充验收标准",
      "汇报"
    ]
  },
  {
    "who": "沈墨",
    "role": "设计",
    "state": "running",
    "steps": [
      "读 PRD",
      "画导入向导",
      "标注空态",
      "待评审"
    ]
  },
  {
    "who": "周行",
    "role": "工程",
    "state": "waiting",
    "steps": [
      "读接口约定",
      "写契约 v0.04",
      "等待 L2 审批",
      "实现"
    ]
  },
  {
    "who": "陈屿",
    "role": "市场",
    "state": "done",
    "steps": [
      "列试点名单",
      "写试用邀请",
      "汇报"
    ]
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.memories = [
  {
    "text": "销售团队只用企业微信，导出文件必须是 GBK 编码。",
    "tag": "约束",
    "hits": 12,
    "from": "09-18 评审"
  },
  {
    "text": "线索表的 phone_legacy 仍有 12% 历史数据依赖，不可直接删除。",
    "tag": "风险",
    "hits": 9,
    "from": "10-09 迁移复盘"
  },
  {
    "text": "客户要求所有页面在 1366×768 下不出现横向滚动。",
    "tag": "约束",
    "hits": 7,
    "from": "09-24 验收"
  },
  {
    "text": "侧边抽屉方案被否决：销售外勤时误触率高，改用整页向导。",
    "tag": "决策",
    "hits": 5,
    "from": "10-06 评审"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.milestones = [
  {
    "name": "范围澄清与字段盘点",
    "state": "done",
    "date": "10-14"
  },
  {
    "name": "信息架构与交互稿",
    "state": "done",
    "date": "10-18"
  },
  {
    "name": "接口契约冻结",
    "state": "done",
    "date": "10-21"
  },
  {
    "name": "导入向导高保真",
    "state": "doing",
    "date": "10-24"
  },
  {
    "name": "联调与销售试用",
    "state": "todo",
    "date": "11-06"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.risks = [
  {
    "level": "中",
    "text": "旧表字段清理需要人工复核 12% 历史数据，可能拖慢联调 1 天。",
    "owner": "周行"
  },
  {
    "level": "低",
    "text": "设计稿尚未覆盖导出失败态与无权限态。",
    "owner": "沈墨"
  }
];
})();

/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.runs = [
  {
    "mode": "团队协作",
    "who": "5 人",
    "time": "今天 09:32",
    "dur": "53 分钟",
    "cost": "¥4.86",
    "state": "进行中"
  },
  {
    "mode": "按模板",
    "who": "软件交付 4 人",
    "time": "昨天 16:10",
    "dur": "41 分钟",
    "cost": "¥3.20",
    "state": "已完成"
  },
  {
    "mode": "直接回答",
    "who": "许清",
    "time": "昨天 11:04",
    "dur": "2 分钟",
    "cost": "¥0.18",
    "state": "已完成"
  }
];
})();
