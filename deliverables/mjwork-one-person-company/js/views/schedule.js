/* MJWork 原型 · 视图 · schedule */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var badge = C.badge;

  function schedule () {
    return '' +
      '<header class="schedule-head">' +
        '<div><p class="eyebrow">定时任务</p><h2 class="display">让公司在你不看的时候也往前走。</h2>' +
        '<p class="lede">' + S.schedules.filter(function (s) { return s.enabled; }).length + ' 条启用 · 本月自动运行 18 次 · 花费 ¥286</p></div>' +
        '<button class="btn btn-primary" data-action="open-schedule">' + icon('plus') + '新建定时任务</button>' +
      '</header>' +
      '<div class="schedule-list">' + S.schedules.map(function (s) {
        return '<article class="card schedule-row' + (s.enabled ? '' : ' is-off') + '">' +
          '<div class="sch-time"><b>' + esc(s.planShort.split(' ').slice(-1)[0]) + '</b><span>' + esc(s.planShort.replace(s.planShort.split(' ').slice(-1)[0], '').trim()) + '</span></div>' +
          '<div class="sch-main"><div class="sch-title"><h3>' + esc(s.name) + '</h3>' +
            '<span class="switch' + (s.enabled ? ' is-on' : '') + '" data-action="toggle-schedule" data-schedule="' + s.id + '" role="switch" tabindex="0" aria-checked="' + (s.enabled ? 'true' : 'false') + '" aria-label="启用 ' + esc(s.name) + '"><i></i></span></div>' +
            '<p>' + esc(s.target) + '</p>' +
            '<div class="sch-meta"><span>' + icon('users', 'ico-xs') + s.team + '</span><span>' + icon('ledger', 'ico-xs') + '预算 ¥' + s.budget + '</span><span>' + icon('clock', 'ico-xs') + '下次 ' + esc(s.next) + '</span><span>' + icon('file', 'ico-xs') + '最近 ' + esc(s.last) + '</span></div>' +
          '</div>' +
          '<div class="sch-side"><span class="owner-chip">' + U.avatar(s.owner, { size: 'xs' }) + esc(s.owner) + '</span>' + badge(s.lastState) +
            '<button class="btn btn-quiet btn-sm" data-action="run-schedule" data-schedule="' + s.id + '">立即运行</button>' +
            '<button class="icon-btn sm" data-action="edit-schedule" data-schedule="' + s.id + '" aria-label="编辑">' + icon('more') + '</button>' +
          '</div>' +
        '</article>';
      }).join('') + '</div>' +
      '<section class="card schedule-note">' +
        '<div class="note-icon">' + icon('clock') + '</div>' +
        '<div><h4>错过就补跑，不叠加</h4><p>电脑休眠时任务会排队，唤醒后只补最近一次；同一任务不会并发运行。每次运行都是一条可追溯的账本记录。</p></div>' +
        '<button class="btn btn-ghost btn-sm" data-action="schedule-log">查看运行日志</button>' +
      '</section>';
  }

  V.schedule = schedule;
})();
