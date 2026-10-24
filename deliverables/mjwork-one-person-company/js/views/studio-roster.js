/* MJWork 原型 · 视图 · roster */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;

  function roster () {
    return '' +
      '<div class="roster-top">' +
        '<div><h3 class="section-title">在编 ' + S.team.length + ' 人</h3><p class="section-sub">统筹全局唯一；成员由你招募，招进来就计入本月账本。</p></div>' +
        '<button class="btn btn-primary btn-sm" data-action="open-recruit">' + icon('plus', 'ico-sm') + '招募成员</button>' +
      '</div>' +
      '<div class="member-grid">' + S.team.map(function (m) {
        return '<article class="member-card">' +
          '<div class="member-top">' + U.avatar(m.name, { lead: m.lead, size: 'lg' }) +
            '<div class="member-id"><div class="name-line"><h4>' + esc(m.name) + '</h4>' +
              (m.lead ? '<span class="lead-badge">统筹</span>' : '') + '</div>' +
              '<p>' + esc(m.role) + ' · ' + esc(m.focus) + '</p></div>' +
            '<span class="member-status">' + (m.load > 80 ? '<i class="breath"></i>' : '') + esc(m.status) + '</span>' +
          '</div>' +
          '<dl class="member-kv">' +
            '<div><dt>模型</dt><dd>' + esc(m.model) + '</dd></div>' +
            '<div><dt>档位</dt><dd>' + esc(m.tier) + '</dd></div>' +
            '<div><dt>工具</dt><dd class="mono">' + esc(m.tools.join(' · ')) + '</dd></div>' +
          '</dl>' +
          '<div class="load-row"><span>本周负载</span><div class="mini-progress"><i style="width:' + m.load + '%"></i></div><b>' + m.load + '%</b></div>' +
          '<div class="member-actions">' +
            '<button class="btn btn-quiet btn-sm" data-action="member-detail" data-member="' + m.id + '">档案</button>' +
            '<button class="btn btn-quiet btn-sm" data-action="open-recruit" data-member="' + m.id + '">调整</button>' +
          '</div>' +
        '</article>';
      }).join('') +
      '<button class="member-add" data-action="open-recruit"><span class="add-mark">' + icon('plus') + '</span><b>招募新成员</b><small>从 66 名数字员工里选，或直接描述岗位</small></button>' +
      '</div>';
  }

  V.roster = roster;
})();
