/* MJWork 原型 · 看板拖拽（从 interactions.js 拆出，保持单文件不过长）
   只负责看板列的拖拽换列与列计数；动作表与其它委托仍在 interactions.js。 */
(function () {
  'use strict';
  var MJ = window.MJ, S = MJ.store;
  var dragId = null, blockClick = false;

  function all (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function T (msg) { if (window.MJApp) window.MJApp.toast(msg); }
  function byId (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function colName (id) { for (var i = 0; i < MJ.boardCols.length; i++) if (MJ.boardCols[i].id === id) return MJ.boardCols[i].name; return id; }

  function updateCounts () {
    var board = document.getElementById('board'); if (!board) return;
    all('[data-list]', board).forEach(function (list) {
      var id = list.getAttribute('data-list');
      var badge = board.querySelector('[data-col-count="' + id + '"]');
      if (badge) badge.textContent = String(S.board.filter(function (c) { return c.col === id; }).length);
    });
  }
  function clearDrop () { all('.drop-target').forEach(function (n) { n.classList.remove('drop-target'); }); }
  function moveCard (id, to) {
    var card = byId(S.board, id); if (!card || !to || card.col === to) return;
    card.col = to;
    var node = document.querySelector('.bcard[data-board-card="' + id + '"]');
    var list = document.querySelector('.board-list[data-list="' + to + '"]');
    if (node && list) list.appendChild(node);
    updateCounts();
    var col = list ? list.closest('.board-col') : null;
    if (col) { col.classList.add('drop-target'); window.setTimeout(function () { col.classList.remove('drop-target'); }, 520); }
    T('已移到「' + colName(to) + '」');
  }
  function init () {
    var board = document.getElementById('board'); if (!board) return;
    all('.bcard', board).forEach(function (card) {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', function (e) {
        dragId = card.getAttribute('data-board-card'); card.classList.add('is-dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* 旧浏览器 */ } }
      });
      card.addEventListener('dragend', function () {
        card.classList.remove('is-dragging'); clearDrop(); dragId = null;
        blockClick = true; window.setTimeout(function () { blockClick = false; }, 80);
      });
    });
    all('.board-list', board).forEach(function (list) {
      list.addEventListener('dragover', function (e) {
        e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var col = list.closest('.board-col'); if (col) col.classList.add('drop-target');
      });
      list.addEventListener('dragleave', function (e) {
        var col = list.closest('.board-col');
        if (col && !list.contains(e.relatedTarget)) col.classList.remove('drop-target');
      });
      list.addEventListener('drop', function (e) {
        e.preventDefault();
        var id = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        clearDrop(); if (id) moveCard(id, list.getAttribute('data-list'));
      });
    });
  }

  window.MJBoardDrag = {
    init: init,
    isBlocked: function () { return blockClick; }
  };
})();
