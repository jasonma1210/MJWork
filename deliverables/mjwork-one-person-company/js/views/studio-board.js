/* MJWork 原型 · 视图 · board / boardCard */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var emptyState = C.emptyState;

  function board (p) {
    if (p.id !== 'crm') {
      return emptyState('这个项目没有进行中的批次', '看板显示正在执行的任务；给「' + p.name + '」派一单就会出现在这里。', '派一单', 'open-dispatch');
    }
    return '' +
      '<div class="board-top">' +
        '<p><span class="live-mini"><i class="breath"></i>批次 2 / 3</span><span>并发 2</span><span>本批 4 个任务</span></p>' +
        '<div class="board-legend"><span>拖动卡片换列</span><button class="link-btn" data-action="board-refresh">' + icon('refresh', 'ico-sm') + '刷新</button></div>' +
      '</div>' +
      '<div class="board" id="board">' + MJ.boardCols.map(function (col) {
        var cards = S.board.filter(function (c) { return c.col === col.id; });
        return '<section class="board-col" data-col="' + col.id + '">' +
          '<header class="col-head"><span class="col-dot col-' + col.id + '"></span><h3>' + esc(col.name) + '</h3>' +
            '<b class="col-count" data-col-count="' + col.id + '">' + cards.length + '</b>' +
            '<button class="col-add" data-action="board-add" data-col="' + col.id + '" aria-label="在此列添加任务">' + icon('plus', 'ico-sm') + '</button>' +
          '</header>' +
          '<div class="board-list" data-list="' + col.id + '">' + cards.map(boardCard).join('') + '</div>' +
        '</section>';
      }).join('') + '</div>';
  }

  function boardCard (c) {
    return '<article class="bcard" data-board-card="' + c.id + '" tabindex="0">' +
      '<div class="bcard-grip" aria-hidden="true">' + icon('grip', 'ico-xs') + '</div>' +
      '<h4>' + esc(c.title) + '</h4>' +
      '<div class="bcard-who">' + U.avatar(c.who, { size: 'xs', lead: c.who === '林砚' }) + '<span>' + esc(c.who) + '</span></div>' +
      '<p class="bcard-dep">依赖 · ' + esc(c.dep) + '</p>' +
      '<div class="bcard-foot"><span class="token">' + esc(c.token) + ' tok</span>' +
        '<button class="mini-link" data-action="task-detail" data-task="' + c.id + '">查看</button></div>' +
    '</article>';
  }

  V.board = board;
})();
