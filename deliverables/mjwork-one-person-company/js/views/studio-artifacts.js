/* MJWork 原型 · 视图 · artifacts */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var badge = C.badge, emptyState = C.emptyState;

  function artifacts (p) {
    var list = S.artifacts.filter(function (a) { return a.project === p.id; });
    var grid = S.artifactsView === 'grid';
    var head = '<div class="art-top">' +
      '<div><h3 class="section-title">' + list.length + ' 件工件</h3><p class="section-sub">每次交付自动归档，版本只增不改；验收状态由你或统筹确认。</p></div>' +
      '<div class="seg" id="artViewSeg">' +
        '<button class="seg-btn' + (!grid ? ' is-active' : '') + '" data-action="art-view" data-view="list">' + icon('list', 'ico-sm') + '列表</button>' +
        '<button class="seg-btn' + (grid ? ' is-active' : '') + '" data-action="art-view" data-view="grid">' + icon('grid', 'ico-sm') + '网格</button>' +
      '</div></div>';

    if (!list.length) {
      return head + emptyState('还没有工件', '成员交付后会出现在这里；也可以在对话中要求立即产出。', '去对话', 'go-chat');
    }

    if (grid) {
      return head + '<div class="art-grid">' + list.map(function (a) {
        return '<button class="art-card" data-action="open-artifact" data-artifact="' + a.id + '">' +
          '<div class="art-card-top"><span class="art-type">' + esc(a.type) + '</span>' + badge(a.state) + '</div>' +
          '<h4>' + esc(a.name) + '</h4><p>' + esc(a.summary) + '</p>' +
          '<div class="art-card-foot"><code>' + esc(a.version) + '</code><span>' + esc(a.owner) + ' · ' + esc(a.updated) + '</span></div>' +
        '</button>';
      }).join('') + '</div>';
    }

    return head + '<div class="card art-table">' + list.map(function (a) {
      return '<button class="art-row" data-action="open-artifact" data-artifact="' + a.id + '">' +
        '<span class="file-ico">' + icon('file') + '</span>' +
        '<span class="art-name"><b>' + esc(a.name) + '</b><small>' + esc(a.summary) + '</small></span>' +
        '<span class="art-type">' + esc(a.type) + '</span>' +
        '<code>' + esc(a.version) + '</code>' +
        '<span class="art-updated">' + esc(a.updated) + '</span>' +
        badge(a.state) +
        '<span class="art-open">' + icon('chevron-right', 'ico-sm') + '</span>' +
      '</button>';
    }).join('') + '</div>';
  }

  V.artifacts = artifacts;
})();
