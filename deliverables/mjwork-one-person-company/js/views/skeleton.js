/* MJWork 原型 · 视图 · skeleton */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;

  function skeleton () {
    return '<div class="skel-page" aria-hidden="true">' +
      '<div class="skel skel-eyebrow"></div><div class="skel skel-title"></div><div class="skel skel-line"></div>' +
      '<div class="skel skel-input"></div>' +
      '<div class="skel-grid"><div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div></div>' +
      '<div class="skel-grid two"><div class="skel skel-card tall"></div><div class="skel skel-card tall"></div></div>' +
      '</div>';
  }

  V.skeleton = skeleton;
})();
