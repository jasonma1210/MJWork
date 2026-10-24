/* MJWork 原型 · 数据模块 · 自动生成，请改源数据而非手改本文件 */
(function () {
  'use strict';
  var MJ = window.MJ = window.MJ || {};
  MJ.ledger = {
  "periods": {
    "month": {
      "key": "month",
      "label": "本月",
      "range": "10-01 至 10-23",
      "spent": 12480,
      "budget": 20000,
      "forecast": 18200,
      "tokens": "8.42M",
      "runs": 46,
      "days": 23,
      "daily": [
        280,
        360,
        420,
        390,
        510,
        470,
        620,
        580,
        340,
        300,
        480,
        560,
        610,
        520,
        690,
        750,
        460,
        380,
        540,
        620,
        500,
        430,
        680
      ],
      "labels": "10/01 至 10/23",
      "projects": [
        {
          "name": "北极星 CRM 重构",
          "amount": 5960,
          "pct": 48,
          "state": "交付中"
        },
        {
          "name": "出海官网 v2",
          "amount": 3120,
          "pct": 25,
          "state": "等待验收"
        },
        {
          "name": "Q4 投资研报",
          "amount": 2400,
          "pct": 19,
          "state": "已完成"
        },
        {
          "name": "内部运营",
          "amount": 1000,
          "pct": 8,
          "state": "日常"
        }
      ],
      "members": [
        {
          "name": "林砚",
          "role": "统筹",
          "amount": 3480,
          "pct": 92
        },
        {
          "name": "周行",
          "role": "工程",
          "amount": 3120,
          "pct": 84
        },
        {
          "name": "许清",
          "role": "产品",
          "amount": 2240,
          "pct": 61
        },
        {
          "name": "沈墨",
          "role": "设计",
          "amount": 1960,
          "pct": 53
        },
        {
          "name": "陈屿",
          "role": "市场",
          "amount": 1680,
          "pct": 45
        }
      ],
      "buckets": [
        {
          "name": "北极星 CRM 重构",
          "used": 5960,
          "cap": 8000,
          "state": "正常"
        },
        {
          "name": "出海官网 v2",
          "used": 3120,
          "cap": 5000,
          "state": "正常"
        },
        {
          "name": "Q4 投资研报",
          "used": 2400,
          "cap": 3000,
          "state": "将满"
        },
        {
          "name": "团队共享池",
          "used": 12480,
          "cap": 20000,
          "state": "正常"
        }
      ],
      "settlements": [
        {
          "date": "10-23",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "612k",
          "amount": 2700,
          "state": "待结算"
        },
        {
          "date": "10-20",
          "project": "出海官网 v2",
          "team": "按模板 · 4 人",
          "tokens": "388k",
          "amount": 1260,
          "state": "已结算"
        },
        {
          "date": "10-16",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 4 人",
          "tokens": "402k",
          "amount": 980,
          "state": "已结算"
        },
        {
          "date": "10-12",
          "project": "Q4 投资研报",
          "team": "直接回答 · 1 人",
          "tokens": "221k",
          "amount": 740,
          "state": "已开票"
        },
        {
          "date": "10-09",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "564k",
          "amount": 1200,
          "state": "已结算"
        },
        {
          "date": "10-06",
          "project": "出海官网 v2",
          "team": "按模板 · 3 人",
          "tokens": "341k",
          "amount": 1640,
          "state": "已结算"
        },
        {
          "date": "10-02",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "702k",
          "amount": 3960,
          "state": "已结算"
        }
      ]
    },
    "last": {
      "key": "last",
      "label": "上月",
      "range": "09-01 至 09-30",
      "spent": 9860,
      "budget": 18000,
      "forecast": 9860,
      "tokens": "6.71M",
      "runs": 39,
      "days": 30,
      "daily": [
        210,
        260,
        340,
        380,
        300,
        420,
        460,
        390,
        350,
        480,
        520,
        410,
        330,
        290,
        360,
        440,
        500,
        470,
        390,
        310,
        420,
        480,
        510,
        460,
        380,
        340,
        300,
        410,
        470,
        520
      ],
      "labels": "09/01 至 09/30",
      "projects": [
        {
          "name": "北极星 CRM 重构",
          "amount": 4820,
          "pct": 49,
          "state": "交付中"
        },
        {
          "name": "出海官网 v2",
          "amount": 2140,
          "pct": 22,
          "state": "等待验收"
        },
        {
          "name": "Q4 投资研报",
          "amount": 1900,
          "pct": 19,
          "state": "已完成"
        },
        {
          "name": "内部运营",
          "amount": 1000,
          "pct": 10,
          "state": "日常"
        }
      ],
      "members": [
        {
          "name": "林砚",
          "role": "统筹",
          "amount": 2860,
          "pct": 78
        },
        {
          "name": "周行",
          "role": "工程",
          "amount": 2540,
          "pct": 69
        },
        {
          "name": "许清",
          "role": "产品",
          "amount": 1860,
          "pct": 51
        },
        {
          "name": "沈墨",
          "role": "设计",
          "amount": 1580,
          "pct": 43
        },
        {
          "name": "陈屿",
          "role": "市场",
          "amount": 1020,
          "pct": 28
        }
      ],
      "buckets": [
        {
          "name": "北极星 CRM 重构",
          "used": 4820,
          "cap": 7000,
          "state": "正常"
        },
        {
          "name": "出海官网 v2",
          "used": 2140,
          "cap": 5000,
          "state": "正常"
        },
        {
          "name": "Q4 投资研报",
          "used": 1900,
          "cap": 3000,
          "state": "正常"
        },
        {
          "name": "团队共享池",
          "used": 9860,
          "cap": 18000,
          "state": "正常"
        }
      ],
      "settlements": [
        {
          "date": "09-30",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "486k",
          "amount": 1980,
          "state": "已结算"
        },
        {
          "date": "09-26",
          "project": "Q4 投资研报",
          "team": "直接回答 · 1 人",
          "tokens": "198k",
          "amount": 620,
          "state": "已开票"
        },
        {
          "date": "09-21",
          "project": "出海官网 v2",
          "team": "按模板 · 3 人",
          "tokens": "302k",
          "amount": 1180,
          "state": "已结算"
        },
        {
          "date": "09-17",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 4 人",
          "tokens": "368k",
          "amount": 940,
          "state": "已结算"
        },
        {
          "date": "09-11",
          "project": "Q4 投资研报",
          "team": "直接回答 · 1 人",
          "tokens": "276k",
          "amount": 780,
          "state": "已结算"
        },
        {
          "date": "09-07",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "512k",
          "amount": 1460,
          "state": "已结算"
        },
        {
          "date": "09-02",
          "project": "出海官网 v2",
          "team": "按模板 · 3 人",
          "tokens": "442k",
          "amount": 2900,
          "state": "已结算"
        }
      ]
    },
    "quarter": {
      "key": "quarter",
      "label": "本季",
      "range": "07-01 至 09-30",
      "spent": 32140,
      "budget": 50000,
      "forecast": 46800,
      "tokens": "21.6M",
      "runs": 118,
      "days": 13,
      "daily": [
        2100,
        2460,
        2680,
        2320,
        2900,
        3180,
        2740,
        2560,
        3020,
        2860,
        2440,
        3100,
        3760
      ],
      "labels": "第 30 周 至 第 42 周",
      "projects": [
        {
          "name": "北极星 CRM 重构",
          "amount": 14960,
          "pct": 47,
          "state": "交付中"
        },
        {
          "name": "出海官网 v2",
          "amount": 8420,
          "pct": 26,
          "state": "等待验收"
        },
        {
          "name": "Q4 投资研报",
          "amount": 6160,
          "pct": 19,
          "state": "已完成"
        },
        {
          "name": "内部运营",
          "amount": 2600,
          "pct": 8,
          "state": "日常"
        }
      ],
      "members": [
        {
          "name": "林砚",
          "role": "统筹",
          "amount": 9260,
          "pct": 88
        },
        {
          "name": "周行",
          "role": "工程",
          "amount": 8140,
          "pct": 77
        },
        {
          "name": "许清",
          "role": "产品",
          "amount": 5980,
          "pct": 57
        },
        {
          "name": "沈墨",
          "role": "设计",
          "amount": 5260,
          "pct": 50
        },
        {
          "name": "陈屿",
          "role": "市场",
          "amount": 3500,
          "pct": 33
        }
      ],
      "buckets": [
        {
          "name": "北极星 CRM 重构",
          "used": 14960,
          "cap": 20000,
          "state": "正常"
        },
        {
          "name": "出海官网 v2",
          "used": 8420,
          "cap": 12000,
          "state": "正常"
        },
        {
          "name": "Q4 投资研报",
          "used": 6160,
          "cap": 8000,
          "state": "将满"
        },
        {
          "name": "团队共享池",
          "used": 32140,
          "cap": 50000,
          "state": "正常"
        }
      ],
      "settlements": [
        {
          "date": "09-30",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "486k",
          "amount": 1980,
          "state": "已结算"
        },
        {
          "date": "09-16",
          "project": "出海官网 v2",
          "team": "按模板 · 3 人",
          "tokens": "602k",
          "amount": 2380,
          "state": "已结算"
        },
        {
          "date": "08-31",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 5 人",
          "tokens": "712k",
          "amount": 2860,
          "state": "已结算"
        },
        {
          "date": "08-18",
          "project": "Q4 投资研报",
          "team": "直接回答 · 1 人",
          "tokens": "344k",
          "amount": 1120,
          "state": "已结算"
        },
        {
          "date": "08-04",
          "project": "出海官网 v2",
          "team": "按模板 · 4 人",
          "tokens": "528k",
          "amount": 2040,
          "state": "已开票"
        },
        {
          "date": "07-22",
          "project": "北极星 CRM 重构",
          "team": "团队协作 · 4 人",
          "tokens": "498k",
          "amount": 1620,
          "state": "已结算"
        },
        {
          "date": "07-08",
          "project": "内部运营",
          "team": "直接回答 · 1 人",
          "tokens": "96k",
          "amount": 480,
          "state": "已结算"
        }
      ]
    }
  },
  "rules": [
    {
      "pct": 70,
      "label": "预算到 70% 发警告：只提醒，不拦截。",
      "tone": "warn"
    },
    {
      "pct": 90,
      "label": "预算到 90% 标红：新派单需要二次确认。",
      "tone": "danger"
    },
    {
      "pct": 100,
      "label": "仅墙钟硬闸：单次运行超过 60 分钟自动暂停。",
      "tone": "plain"
    }
  ]
};
})();
