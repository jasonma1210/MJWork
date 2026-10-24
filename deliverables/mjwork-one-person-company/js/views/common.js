/* MJWork 原型 · 视图 · currentProject / statusTone / badge / sectionHead / emptyState / tabsUnder */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;

  function currentProject () {
    for (var i = 0; i < MJ.projects.length; i++) {
      if (MJ.projects[i].id === MJ.currentProjectId) return MJ.projects[i];
    }
    return MJ.projects[0];
  }

  function statusTone (state) {
    var map = {
      '交付中': 'accent', '等待验收': 'amber', '已完成': 'plain', '进行中': 'accent',
      '已验收': 'accent', '待验收': 'amber', '待确认': 'amber', '已结算': 'accent',
      '待结算': 'amber', '已开票': 'plain', '成功': 'accent', '失败': 'red',
      '正常': 'accent', '将满': 'amber', '健康': 'accent', '需手动授权': 'red',
      '需授权': 'amber'
    };
    return map[state] || 'plain';
  }

  function badge (state) {
    return U.badge(state, statusTone(state));
  }

  function sectionHead (title, meta, action) {
    return '<div class="card-head"><div class="ch-title"><h3>' + esc(title) + '</h3>' +
      (meta ? '<p>' + meta + '</p>' : '') + '</div>' + (action || '') + '</div>';
  }

  function emptyState (title, desc, actionLabel, action) {
    return '<div class="empty-state">' +
      '<span class="empty-mark">' + icon('file') + '</span>' +
      '<h4>' + esc(title) + '</h4><p>' + esc(desc) + '</p>' +
      (actionLabel ? '<button class="btn btn-ghost btn-sm" data-action="' + action + '">' + esc(actionLabel) + '</button>' : '') +
      '</div>';
  }

  function tabsUnder (activeIndex, count) {
    var w = 100 / count;
    return '<span class="tab-under" data-tab-under style="width:' + w + '%;transform:translateX(' + (activeIndex * 100) + '%)"></span>';
  }

  C.currentProject = currentProject;
  C.statusTone = statusTone;
  C.badge = badge;
  C.sectionHead = sectionHead;
  C.emptyState = emptyState;
  C.tabsUnder = tabsUnder;
})();
