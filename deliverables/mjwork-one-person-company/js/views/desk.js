/* MJWork 原型 · 视图 · desk */
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
  var L = MJ.settingLabels;

  /* 接单台的三个口径 chip：直接读设置，点击回设置页对应分组 */
  function policyChips () {
    var st = S.settings;
    return '<div class="intake-policy">' +
      '<button class="policy-chip" data-action="go-settings" data-tab="general" title="到设置里改审批档位">' +
        icon('shield', 'ico-xs') + esc(L.approval[st.approvalMode] || st.approvalMode) + '</button>' +
      '<button class="policy-chip" data-action="go-settings" data-tab="general" title="到设置里改沙箱策略">' +
        icon('lock', 'ico-xs') + esc(L.sandbox[st.sandboxPolicy] || st.sandboxPolicy) + '</button>' +
      '<button class="policy-chip" data-action="go-settings" data-tab="general" title="到设置里改输出粒度">' +
        icon('file', 'ico-xs') + esc(L.style[st.responseStyle] || st.responseStyle) + '</button>' +
      '</div>';
  }

  function desk () {
    var company = MJ.company;
    var running = MJ.projects[0];
    var modes = MJ.modes.map(function (m) {
      return '<button class="mode-option' + (S.deskModeId === m.id ? ' is-active' : '') + '" data-action="pick-mode" data-mode="' + m.id + '">' +
        '<span class="mode-radio"></span>' +
        '<span class="mode-copy"><b>' + esc(m.name) + '</b><small>' + esc(m.desc) + '</small><em>' + esc(m.cast) + '</em></span>' +
        '</button>';
    }).join('');
    var modelOptions = S.settings.providers.map(function (p) {
      return '<option' + (p.name === S.deskModel ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');
    var runs = MJ.runs.slice(0, 3).map(function (r) {
      return '<button class="run-row" data-action="open-runs">' +
        '<span class="run-row-main"><b>' + esc(r.mode) + '</b><small>' + esc(r.who) + ' · ' + esc(r.dur) + '</small></span>' +
        '<span class="run-row-meta"><code>' + esc(r.cost) + '</code><time>' + esc(r.time) + '</time>' + badge(r.state) + '</span>' +
        '</button>';
    }).join('');
    var deliveries = MJ.deliveries.slice(0, 4).map(function (d) {
      return '<button class="delivery-row" data-action="open-artifact" data-artifact="' + esc(d.artifactId || '') + '" data-name="' + esc(d.name) + '">' +
        '<span class="file-ico">' + icon('file') + '</span>' +
        '<span class="delivery-main"><b>' + esc(d.name) + '</b><small>' + esc(d.project) + ' · ' + esc(d.who) + '</small></span>' +
        '<span class="delivery-meta"><code>' + esc(d.version) + '</code>' + badge(d.state) + '<time>' + esc(d.time) + '</time></span>' +
        '</button>';
    }).join('');

    return '' +
      '<header class="desk-hero">' +
        '<p class="eyebrow">2026 年 10 月 23 日 · 周五 · ' + esc(company.name) + '</p>' +
        '<div class="hero-line">' +
          '<h2 class="display">早上好，老板。</h2>' +
          '<p class="hero-decide">今天有 <b>3</b> 件事等你决定<span>2 条审批 · 1 份验收</span></p>' +
        '</div>' +
      '</header>' +

      '<section class="card intake" aria-label="接单输入">' +
        '<label class="field-label" for="deskGoal">接一单</label>' +
        '<textarea id="deskGoal" class="intake-input" rows="3" placeholder="说清楚目标、约束和交付时间，剩下的交给团队。">把北极星 CRM 的线索导入流程重做：支持 CSV 导入、字段映射与重复合并，下周给销售团队试用。</textarea>' +
        '<div class="intake-tools">' +
          '<button class="tool-btn" data-action="attach">' + icon('paperclip') + '附件</button>' +
          '<div class="mode-wrap">' +
            '<button class="mode-pill" id="deskModeBtn" data-action="toggle-mode-pop" aria-haspopup="true" aria-expanded="false">' +
              '<span class="mode-dot"></span><span id="deskModeLabel">' + esc(S.deskMode) + '</span>' + icon('chevron-down', 'ico-sm') +
            '</button>' +
            '<div class="popover mode-pop" id="deskModePop" hidden>' +
              '<div class="popover-head"><b>怎么干这一单</b><span>可随时改</span></div>' + modes +
            '</div>' +
          '</div>' +
          policyChips() +
          '<label class="select-field"><span>模型</span><select id="deskModel">' + modelOptions + '</select></label>' +
          '<label class="budget-field"><span>预算 ¥</span><input id="deskBudget" type="number" min="10" step="10" value="' + S.deskBudget + '"></label>' +
          '<span class="intake-kbd"><kbd>⌘</kbd><kbd>↵</kbd></span>' +
          '<button class="btn btn-primary" id="deskSend">派单' + icon('arrow-right') + '</button>' +
        '</div>' +
      '</section>' +

      '<div class="desk-grid">' +
        '<div class="desk-main">' +
          '<section class="card run-card">' +
            '<div class="card-head">' +
              '<div class="ch-title"><p class="eyebrow">进行中 · 09:32 开始</p><h3>' + esc(running.name) + '</h3></div>' +
              '<span class="live-tag"><i class="breath"></i>运行中</span>' +
            '</div>' +
            '<p class="run-goal">把线索导入流程重做：CSV 导入、字段映射、重复合并，下周给销售团队试用。</p>' +
            '<div class="progress"><i style="width:' + running.progress + '%"></i></div>' +
            '<div class="run-meta">' +
              '<span><b>' + running.progress + '%</b> 已完成</span><span>批次 2 / 3</span><span>已用 ¥4.86</span>' +
              '<span class="run-people">' + U.teamAvatars(S.team, 5) + '</span>' +
            '</div>' +
            '<div class="run-note">' + icon('spark') + '<span>林砚正在统筹：许清写需求，沈墨做向导，周行等 L2 审批。</span></div>' +
            '<div class="card-actions">' +
              '<button class="btn btn-ghost btn-sm" data-action="go-chat">查看对话' + icon('chevron-right', 'ico-sm') + '</button>' +
              '<button class="btn btn-quiet btn-sm" data-action="pause-run">' + icon('pause', 'ico-sm') + '暂停</button>' +
              '<button class="btn btn-quiet btn-sm" data-action="open-runs">' + icon('list', 'ico-sm') + '运行记录</button>' +
            '</div>' +
          '</section>' +

          '<section class="card recent">' +
            sectionHead('最近交付', '按更新时间排序 · 共 4 件', '<button class="link-btn" data-action="go-artifacts">全部工件' + icon('arrow-right', 'ico-sm') + '</button>') +
            '<div class="delivery-list">' + deliveries + '</div>' +
          '</section>' +
        '</div>' +

        '<aside class="desk-rail">' +
          '<section class="card recent-runs">' +
            sectionHead('最近运行', '<span>' + MJ.runs.length + ' 次 · 与项目空间共用记录</span>',
              '<button class="link-btn" data-action="open-runs">全部记录' + icon('arrow-right', 'ico-sm') + '</button>') +
            '<div class="run-list">' + runs + '</div>' +
          '</section>' +

          '<section class="card account">' +
            sectionHead('账上', '2026 年 10 月') +
            '<p class="account-big"><span>¥</span><b data-count="7520">0</b></p>' +
            '<p class="account-sub">本月已用 ¥12,480 / 预算 ¥20,000</p>' +
            '<div class="progress thin"><i style="width:62%"></i></div>' +
            '<div class="account-foot"><span>月底预测 ¥18,200</span><span class="ok">剩余 ¥1,800</span></div>' +
            '<button class="link-btn wide" data-action="go-ledger">打开账本' + icon('arrow-right', 'ico-sm') + '</button>' +
          '</section>' +

          '<section class="card decisions">' +
            sectionHead('待你决定', '2 条审批') +
            S.approvals.map(function (a) {
              return '<button class="decision-row" data-action="open-approval" data-approval="' + a.id + '">' +
                '<span class="risk-mark risk-' + (a.risk === '低' ? 'low' : 'mid') + '">' + esc(a.level) + '</span>' +
                '<span class="decision-main"><b>' + esc(a.title) + '</b><small>' + esc(a.who) + ' · ' + esc(a.age) + ' · ' + esc(a.diff) + '</small></span>' +
                icon('chevron-right', 'ico-sm') +
              '</button>';
            }).join('') +
          '</section>' +
        '</aside>' +
      '</div>';
  }

  V.desk = desk;
})();
