/* MJWork 原型 · 视图 · space */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var badge = C.badge, sectionHead = C.sectionHead, emptyState = C.emptyState;

  function space (p) {
    var isCrm = p.id === 'crm';
    var arts = S.artifacts.filter(function (a) { return a.project === p.id; });
    var milestones = isCrm ? MJ.milestones : [];
    var doneCount = milestones.filter(function (m) { return m.state === 'done'; }).length;
    var mems = isCrm ? S.memoryList : [];

    return '' +
      '<div class="space-grid">' +
        '<div class="space-main">' +
          '<section class="card goal-card">' +
            sectionHead('这个项目要做成什么', '<span>最后编辑 09:32 · 林砚</span>') +
            '<p class="goal-text">' + esc(p.goal) + '</p>' +
            '<div class="goal-meta"><span>负责人 ' + esc(p.owner) + '</span><span>交付 ' + esc(p.due) + '</span><span>' + esc(p.mode) + '</span></div>' +
          '</section>' +

          '<section class="card">' +
            sectionHead('里程碑', '<span>' + doneCount + ' / 5 已完成</span>', '<button class="link-btn" data-action="add-milestone">新增里程碑' + icon('plus', 'ico-sm') + '</button>') +
            (milestones.length ? '<ol class="milestones">' + milestones.map(function (m, i) {
              return '<li class="ms ms-' + m.state + '"><span class="ms-dot">' + (m.state === 'done' ? icon('check') : '') + '</span>' +
                '<span class="ms-name">' + esc(m.name) + '</span><span class="ms-date">' + esc(m.date) + '</span>' +
                '<span class="ms-state">' + (m.state === 'done' ? '已完成' : m.state === 'doing' ? '进行中' : '未开始') + '</span></li>';
            }).join('') + '</ol>' : emptyState('还没有里程碑', '这个项目刚建立，派一单后会自动生成可验收的节点。', '派一单', 'open-dispatch')) +
          '</section>' +

          '<section class="card">' +
            sectionHead('本次交付', '<span>' + arts.length + ' 件工件 · 2 件待确认</span>', '<button class="link-btn" data-action="go-artifacts">打开工件' + icon('arrow-right', 'ico-sm') + '</button>') +
            (arts.length ? '<div class="delivery-list compact">' + arts.map(function (a) {
              return '<button class="delivery-row" data-action="open-artifact" data-artifact="' + a.id + '">' +
                '<span class="file-ico">' + icon('file') + '</span>' +
                '<span class="delivery-main"><b>' + esc(a.name) + '</b><small>' + esc(a.owner) + ' · ' + esc(a.size) + '</small></span>' +
                '<span class="delivery-meta"><code>' + esc(a.version) + '</code>' + badge(a.state) + '</span></button>';
            }).join('') + '</div>' : emptyState('这次还没有产出工件', '工件会在成员交付后自动归档到项目空间。', '查看全部工件', 'go-artifacts')) +
          '</section>' +

          '<section class="card memory-card">' +
            sectionHead('这个项目记得', '<span>' + mems.length + ' 条有效记忆 · 本次命中 4 条</span>', '<button class="link-btn" data-action="toggle-memory">展开全部' + icon('chevron-down', 'ico-sm') + '</button>') +
            (mems.length ? '<div class="memory-list">' + mems.map(function (m, i) {
              return '<div class="memory' + (i > 1 ? ' is-extra' : '') + '">' +
                '<span class="mem-tag">' + esc(m.tag) + '</span><p>' + esc(m.text) + '</p>' +
                '<span class="mem-meta">命中 ' + m.hits + ' 次 · ' + esc(m.from) + '</span></div>';
            }).join('') + '</div>' : emptyState('还没有可复用的记忆', '在对话里勾选“记住这条”，下次派单会自动带入。', '去对话', 'go-chat')) +
          '</section>' +

          '<section class="card">' +
            sectionHead('最近运行', '<span>按开始时间排序</span>') +
            '<div class="run-table">' + MJ.runs.map(function (r) {
              return '<div class="run-tr"><span class="run-mode">' + esc(r.mode) + '</span><span>' + esc(r.time) + '</span>' +
                '<span>' + esc(r.dur) + '</span><span class="num">' + esc(r.cost) + '</span>' + badge(r.state) + '</div>';
            }).join('') + '</div>' +
          '</section>' +

          '<section class="card quota-card">' +
            sectionHead('项目配额', '<span>已用 ' + Math.round(p.spent / p.budget * 100) + '% · ¥' + U.num(p.spent) + ' / ¥' + U.num(p.budget) + '</span>') +
            '<div class="quota-bar"><i style="width:' + Math.round(p.spent / p.budget * 100) + '%"></i></div>' +
            '<p class="quota-note">本月剩余 ¥' + U.num(p.budget - p.spent) + '。到 90% 时新派单需要二次确认。</p>' +
          '</section>' +
        '</div>' +

        '<aside class="space-rail">' +
          '<section class="card team-mini">' +
            sectionHead('团队', '<span>' + S.team.length + ' 人在编</span>', '<button class="link-btn" data-action="go-roster">管理' + icon('chevron-right', 'ico-sm') + '</button>') +
            S.team.map(function (m) {
              return '<div class="mini-person">' + U.avatar(m.name, { lead: m.lead, size: 'sm' }) +
                '<span><b>' + esc(m.name) + '</b><small>' + esc(m.role) + '</small></span>' +
                '<span class="mini-state">' + esc(m.status) + '</span></div>';
            }).join('') +
          '</section>' +

          '<section class="card risk-card">' +
            sectionHead('风险', '<span>' + (p.id === 'crm' ? MJ.risks.length : 0) + ' 条未关闭</span>') +
            (p.id === 'crm' ? MJ.risks.map(function (r) {
              return '<div class="risk-row"><span class="risk-level">' + esc(r.level) + '</span>' +
                '<p>' + esc(r.text) + '</p><small>负责人 ' + esc(r.owner) + '</small></div>';
            }).join('') : emptyState('暂无登记风险', '派单后可在这里登记依赖与阻塞。', '派一单', 'open-dispatch')) +
          '</section>' +

          '<section class="card rail-tip">' +
            '<p class="eyebrow">项目目录</p><code class="dir-path">' + esc(p.dir) + '</code>' +
            '<button class="btn btn-ghost btn-sm" data-action="open-dir">' + icon('folder', 'ico-sm') + '在 Finder 中打开</button>' +
          '</section>' +
        '</aside>' +
      '</div>';
  }

  V.space = space;
})();
