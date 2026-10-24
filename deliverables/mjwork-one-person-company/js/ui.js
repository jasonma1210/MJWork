/* MJWork 原型 · 通用 UI 片段（图标 / 头像 / 数字 / 文本） */
(function () {
  'use strict';

  var U = {};

  U.esc = function (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  U.icon = function (name, cls, extra) {
    return '<svg class="ico ' + (cls || '') + '" aria-hidden="true"' + (extra || '') +
      '><use href="#i-' + name + '"></use></svg>';
  };

  U.avatar = function (name, opts) {
    var o = opts || {};
    var lead = o.lead ? ' is-lead' : '';
    var size = o.size ? ' av-' + o.size : '';
    var initial = String(name || '').slice(0, 1);
    var title = o.title || name;
    return '<span class="avatar' + lead + size + '" title="' + U.esc(title) + '">' +
      '<span>' + U.esc(initial) + '</span></span>';
  };

  U.teamAvatars = function (team, max) {
    var limit = max || 5;
    var out = team.slice(0, limit).map(function (m) { return U.avatar(m.name, { lead: m.lead, size: 'sm' }); }).join('');
    if (team.length > limit) {
      out += '<span class="avatar av-sm av-more">+' + (team.length - limit) + '</span>';
    }
    return out;
  };

  U.money = function (n, sign) {
    var value = Math.round(Number(n) || 0);
    return (sign === false ? '' : '¥') + value.toLocaleString('zh-CN');
  };

  U.num = function (n) {
    return (Number(n) || 0).toLocaleString('zh-CN');
  };

  U.badge = function (text, tone) {
    return '<span class="badge badge-' + (tone || 'plain') + '">' + U.esc(text) + '</span>';
  };

  U.ring = function (pct, size, tone) {
    var s = size || 44;
    var r = (s - 4) / 2;
    var c = 2 * Math.PI * r;
    var dash = (c * Math.min(100, Math.max(0, pct)) / 100).toFixed(1);
    return '<span class="ring" style="width:' + s + 'px;height:' + s + 'px">' +
      '<svg viewBox="0 0 ' + s + ' ' + s + '" aria-hidden="true">' +
      '<circle class="ring-bg" cx="' + (s / 2) + '" cy="' + (s / 2) + '" r="' + r + '"></circle>' +
      '<circle class="ring-fg' + (tone === 'danger' ? ' ring-danger' : '') + '" cx="' + (s / 2) + '" cy="' + (s / 2) + '" r="' + r + '" stroke-dasharray="' + dash + ' ' + c.toFixed(1) + '"></circle>' +
      '</svg>' +
      '<b>' + Math.round(pct) + '<i>%</i></b></span>';
  };

  U.count = function (value, attrs) {
    return '<span class="num count" data-count="' + value + '"' + (attrs || '') + '>0</span>';
  };

  U.stateBadge = function (state) {
    var map = {
      '交付中': 'accent', '等待验收': 'amber', '已完成': 'plain', '进行中': 'accent',
      '已验收': 'accent', '待验收': 'amber', '待确认': 'amber', '已结算': 'accent',
      '待结算': 'amber', '已开票': 'plain', '成功': 'accent', '失败': 'red',
      '正常': 'accent', '将满': 'amber', '需授权': 'amber', '健康': 'accent',
      '需手动授权': 'red', '值班中': 'accent', '已批准': 'accent', '已拒绝': 'red'
    };
    return U.badge(state, map[state] || 'plain');
  };

  U.fieldError = function (msg) {
    return '<p class="field-error" role="alert">' + U.icon('alert') + '<span>' + U.esc(msg) + '</span></p>';
  };

  U.diff = function (add, del) {
    return '<span class="diff"><span class="diff-add">+' + add + '</span> <span class="diff-del">−' + del + '</span></span>';
  };

  window.MJUI = U;
})();
