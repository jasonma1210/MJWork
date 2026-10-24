/* MJWork 原型 · 视图 · studio */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var currentProject = C.currentProject, badge = C.badge, tabsUnder = C.tabsUnder;

  function studio (tab) {
    var p = currentProject();
    var tabIndex = { space: 0, roster: 1, board: 2, artifacts: 3 }[tab] || 0;

    return '' +
      '<header class="studio-head">' +
        '<div class="studio-title">' +
          '<p class="eyebrow">团队工作室</p>' +
          '<div class="title-row"><h2>' + esc(p.name) + '</h2>' + badge(p.status) + '</div>' +
          '<p class="studio-sub"><code>' + esc(p.dir) + '</code><span>' + p.team + ' 人 · 预算 ¥' + U.num(p.budget) + '</span><span>更新于 ' + esc(p.updated) + '</span></p>' +
        '</div>' +
        '<div class="studio-side">' +
          '<div class="ring-wrap">' + U.ring(p.progress, 52) + '<span class="ring-label">完成度</span></div>' +
          '<div class="studio-team">' + U.teamAvatars(S.team, 5) + '</div>' +
          '<button class="btn btn-ghost btn-sm" data-action="open-dir">' + icon('folder', 'ico-sm') + '打开目录</button>' +
          '<button class="btn btn-primary btn-sm" data-action="open-dispatch">' + icon('plus', 'ico-sm') + '派单</button>' +
        '</div>' +
      '</header>' +

      '<nav class="tabs" id="studioTabs" aria-label="团队工作室分区">' +
        tabsUnder(tabIndex, 4) +
        '<a class="tab' + (tab === 'space' ? ' is-active' : '') + '" href="#/studio?tab=space">项目空间</a>' +
        '<a class="tab' + (tab === 'roster' ? ' is-active' : '') + '" href="#/studio?tab=roster">编制<span class="tab-count">' + S.team.length + '</span></a>' +
        '<a class="tab' + (tab === 'board' ? ' is-active' : '') + '" href="#/studio?tab=board">看板<span class="tab-count">' + S.board.length + '</span></a>' +
        '<a class="tab' + (tab === 'artifacts' ? ' is-active' : '') + '" href="#/studio?tab=artifacts">工件<span class="tab-count">' + S.artifacts.length + '</span></a>' +
      '</nav>' +

      '<div class="studio-body">' +
        (tab === 'roster' ? V.roster() : tab === 'board' ? V.board(p) : tab === 'artifacts' ? V.artifacts(p) : V.space(p)) +
      '</div>';
  }

  V.studio = studio;
})();
