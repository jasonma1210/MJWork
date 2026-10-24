/* MJWork 原型 · 视图 · ledger */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var badge = C.badge, sectionHead = C.sectionHead;

  function ledger () {
    var period = MJ.ledger.periods[S.ledgerPeriod] || MJ.ledger.periods.month;
    var max = Math.max.apply(null, period.daily);
    var today = S.ledgerPeriod === 'month' ? period.daily.length - 1 : -1;
    var bars = period.daily.map(function (v, i) {
      var h = Math.max(6, Math.round(v / max * 100));
      var dayLabel = i + 1;
      var monthPrefix = S.ledgerPeriod === 'last' ? '9 月 ' : '10 月 ';
      return '<div class="bar' + (i === today ? ' is-today' : '') + '" style="--h:' + h + '%">' +
        '<span class="bar-tip">' + (S.ledgerPeriod === 'quarter' ? '第 ' + (30 + i) + ' 周' : monthPrefix + dayLabel + ' 日') + ' · ¥' + U.num(v) + '</span>' +
        '</div>';
    }).join('');

    var kpis = [
      { label: '周期支出', value: period.spent, prefix: '¥', note: '预算 ¥' + U.num(period.budget), pct: Math.round(period.spent / period.budget * 100) },
      { label: '运行次数', value: period.runs, prefix: '', note: '平均 ¥' + Math.round(period.spent / period.runs) + ' / 次', pct: 74 },
      { label: 'Token 消耗', value: period.tokens, prefix: '', note: '约 ¥1.48 / 万 token', pct: 66, raw: true }
    ];

    var projectBars = period.projects.map(function (p) {
      return '<div class="alloc-row"><div class="alloc-top"><span>' + esc(p.name) + '</span><b>¥' + U.num(p.amount) + '</b></div>' +
        '<div class="alloc-bar"><i style="width:' + p.pct + '%"></i></div>' +
        '<div class="alloc-foot"><span>' + esc(p.state) + '</span><span>' + p.pct + '%</span></div></div>';
    }).join('');

    var memberRows = period.members.map(function (m) {
      return '<div class="member-alloc"><span class="ma-name">' + esc(m.name) + '<small>' + esc(m.role) + '</small></span>' +
        '<div class="ma-bar"><i style="width:' + m.pct + '%"></i></div>' +
        '<b>¥' + U.num(m.amount) + '</b><span class="ma-pct">' + m.pct + '%</span></div>';
    }).join('');

    var bucketRows = period.buckets.map(function (b) {
      var pct = Math.round(b.used / b.cap * 100);
      return '<tr><td>' + esc(b.name) + '</td><td class="mono">¥' + U.num(b.used) + '</td><td class="mono">¥' + U.num(b.cap) + '</td>' +
        '<td><div class="table-bar"><i style="width:' + pct + '%"></i><span>' + pct + '%</span></div></td><td>' + badge(b.state) + '</td></tr>';
    }).join('');

    var settleRows = period.settlements.map(function (s) {
      return '<tr><td class="mono">' + esc(s.date) + '</td><td>' + esc(s.project) + '</td><td>' + esc(s.team) + '</td>' +
        '<td class="mono">' + esc(s.tokens) + '</td><td class="mono amount">¥' + U.num(s.amount) + '</td><td>' + badge(s.state) + '</td></tr>';
    }).join('');

    return '' +
      '<header class="ledger-head">' +
        '<div><p class="eyebrow">经营账本 · ' + esc(MJ.company.month) + '</p>' +
          '<h2 class="display">这个月花了 <span class="num">¥' + U.num(period.spent) + '</span>。</h2>' +
          '<p class="lede">预算还剩 ¥' + U.num(period.budget - period.spent) + '。按当前节奏，月底会落在 ¥' + U.num(period.forecast) + '，不会超支。</p></div>' +
        '<div class="period-switch" id="periodSwitch">' +
          ['month', 'last', 'quarter'].map(function (k) {
            var p = MJ.ledger.periods[k];
            return '<button class="seg-btn' + (k === S.ledgerPeriod ? ' is-active' : '') + '" data-action="set-period" data-period="' + k + '">' + esc(p.label) + '</button>';
          }).join('') +
        '</div>' +
      '</header>' +

      '<div class="kpi-row">' + kpis.map(function (k) {
        return '<section class="card kpi"><p class="eyebrow">' + esc(k.label) + '</p>' +
          '<p class="kpi-value">' + (k.raw ? '<span class="num">' + esc(k.value) + '</span>' : '<span>' + esc(k.prefix) + '</span><b data-count="' + k.value + '">0</b>') + '</p>' +
          '<div class="kpi-foot"><span>' + esc(k.note) + '</span><span class="kpi-pct">' + k.pct + '%</span></div></section>';
      }).join('') + '</div>' +

      '<div class="ledger-grid">' +
        '<section class="card chart-card">' +
          sectionHead('每日花费', '<span>' + esc(period.labels) + ' · 单位 ¥</span>') +
          '<div class="chart"><div class="bars">' + bars + '</div>' +
            '<div class="chart-axis"><span>' + (S.ledgerPeriod === 'quarter' ? '第 30 周' : '10/01') + '</span><span>' + (S.ledgerPeriod === 'quarter' ? '第 36 周' : '10/11') + '</span><span>' + (S.ledgerPeriod === 'quarter' ? '第 42 周' : '10/23') + '</span></div>' +
          '</div>' +
        '</section>' +
        '<section class="card">' +
          sectionHead('项目分摊', '<span>按结算单归集</span>') +
          '<div class="alloc-list">' + projectBars + '</div>' +
        '</section>' +
      '</div>' +

      '<div class="ledger-grid two">' +
        '<section class="card">' +
          sectionHead('成员分摊', '<span>含模型与工具调用</span>') +
          '<div class="member-alloc-list">' + memberRows + '</div>' +
        '</section>' +
        '<section class="card">' +
          sectionHead('配额桶', '<span>硬上限只对墙钟生效</span>') +
          '<div class="table-wrap"><table class="table"><thead><tr><th>项目</th><th>已用</th><th>上限</th><th>进度</th><th>状态</th></tr></thead><tbody>' + bucketRows + '</tbody></table></div>' +
        '</section>' +
      '</div>' +

      '<section class="card settle-card">' +
        sectionHead('结算单', '<span>' + period.settlements.length + ' 笔 · 合计 ¥' + U.num(period.spent) + '</span>',
          '<button class="btn btn-ghost btn-sm" data-action="export-settlement">' + icon('download', 'ico-sm') + '导出结算单</button>') +
        '<div class="table-wrap"><table class="table settle-table"><thead><tr><th>日期</th><th>项目</th><th>团队</th><th>Token</th><th>金额</th><th>状态</th></tr></thead><tbody>' + settleRows + '</tbody></table></div>' +
      '</section>' +

      '<section class="card rules-card">' +
        sectionHead('结算规则', '<span>只提醒，不偷偷停活</span>') +
        '<div class="rules">' + MJ.ledger.rules.map(function (r) {
          return '<div class="rule"><b class="rule-pct tone-' + r.tone + '">' + r.pct + '%</b><span>' + esc(r.label) + '</span></div>';
        }).join('') + '</div>' +
      '</section>';
  }

  V.ledger = ledger;
})();
