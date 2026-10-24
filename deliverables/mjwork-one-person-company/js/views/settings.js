/* MJWork 原型 · 视图 · settings（壳层 + 原语）
   分页实现分散在 settings-*.js，每个文件只承载一个分组，避免长文件。
   window.MJSettings 暴露原语供各分页复用；运行时在 js/settings-runtime.js。 */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;

  var SSet = { pages: {} };

  function get (path) {
    return String(path).split('.').reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, S.settings);
  }

  /* 分组容器：标题 + 说明 + 一组行 */
  SSet.section = function (title, desc, inner, cls) {
    return '<section class="card set-section' + (cls ? ' ' + cls : '') + '">' +
      '<header class="set-head"><h3>' + esc(title) + '</h3>' +
      (desc ? '<p>' + desc + '</p>' : '') + '</header>' +
      '<div class="set-rows">' + (inner || '') + '</div></section>';
  };

  /* 单行：左侧标签与说明，右侧控件；stack 让控件独占一行 */
  SSet.row = function (label, desc, control, opts) {
    var o = opts || {};
    return '<div class="set-row' + (o.stack ? ' is-stack' : '') + (o.danger ? ' is-danger' : '') + '">' +
      '<div class="set-row-main"><b>' + esc(label) + '</b>' +
      (desc ? '<small>' + desc + '</small>' : '') +
      (o.note ? '<div class="set-note">' + o.note + '</div>' : '') + '</div>' +
      '<div class="set-control">' + (control || '') + '</div></div>';
  };

  /* 开关：危险项通过 data-danger 交给运行时二次确认 */
  SSet.toggle = function (key, on, opts) {
    var o = opts || {};
    return '<button class="switch' + (on ? ' is-on' : '') + '" role="switch" tabindex="0"' +
      ' aria-checked="' + (on ? 'true' : 'false') + '"' +
      ' aria-label="' + esc(o.label || key) + '"' +
      ' data-action="set-toggle" data-key="' + esc(key) + '"' + (o.danger ? ' data-danger="1"' : '') + '><i></i></button>';
  };

  /* 分段控件：选项值直接写回 settings[key] */
  SSet.seg = function (key, current, options) {
    return '<div class="seg" role="group">' + options.map(function (opt) {
      return '<button class="seg-btn' + (opt.value === current ? ' is-active' : '') + '"' +
        ' data-action="set-option" data-key="' + esc(key) + '" data-value="' + esc(opt.value) + '"' +
        (opt.danger ? ' data-danger="1"' : '') + ' aria-pressed="' + (opt.value === current ? 'true' : 'false') + '">' +
        esc(opt.name) + '</button>';
    }).join('') + '</div>';
  };

  /* 下拉：id 交给运行时 change 分发（setLang / setMainModel / tier-* 等） */
  SSet.select = function (id, current, options, opts) {
    var o = opts || {};
    return '<label class="set-select' + (o.wide ? ' is-wide' : '') + '"><select id="' + esc(id) + '"' +
      (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + '>' + options.map(function (opt) {
      return '<option value="' + esc(opt.value) + '"' + (String(opt.value) === String(current) ? ' selected' : '') + '>' +
        esc(opt.name) + '</option>';
    }).join('') + '</select></label>';
  };

  SSet.hint = function (text, tone) {
    return '<p class="set-hint' + (tone ? ' is-' + tone : '') + '">' +
      icon(tone === 'danger' ? 'alert' : 'lock', 'ico-xs') + '<span>' + text + '</span></p>';
  };

  SSet.empty = function (text) {
    return '<p class="set-empty">' + esc(text) + '</p>';
  };

  SSet.get = get;

  function navItem (item) {
    return '<button class="settings-nav-item' + (S.settingsTab === item.id ? ' is-active' : '') + '"' +
      ' data-action="settings-tab" data-tab="' + esc(item.id) + '" data-kw="' + esc(item.kw) + '"' +
      ' title="' + esc(item.kw) + '"><span>' + esc(item.name) + '</span>' + icon('chevron-right', 'ico-xs') + '</button>';
  }

  function settings () {
    var nav = MJ.settingsNav.map(function (group) {
      return '<div class="settings-nav-group"><p class="settings-nav-label">' + esc(group.group) + '</p>' +
        '<div class="settings-nav-list">' + group.items.map(navItem).join('') + '</div></div>';
    }).join('');
    var page = SSet.pages[S.settingsTab] || SSet.pages.general;
    var q = S.settingsQuery || '';

    return '' +
      '<header class="settings-head">' +
        '<div><p class="eyebrow">设置</p><h2 class="display">把公司调成你顺手的样子。</h2>' +
        '<p class="lede">改动即时生效并保存在本机。危险开关会二次确认，撤销授权立刻生效。</p></div>' +
        '<div class="settings-head-side">' +
          '<span class="badge badge-plain">本地优先 · 不上传凭据</span>' +
          '<button class="btn btn-ghost btn-sm" data-action="reset-settings">' + icon('refresh', 'ico-sm') + '恢复默认</button>' +
        '</div>' +
      '</header>' +

      '<div class="settings-grid">' +
        '<aside class="settings-nav card" aria-label="设置分类">' +
          '<label class="search-field settings-search">' + icon('search') +
            '<input id="settingsSearch" type="search" placeholder="搜索设置项" value="' + esc(q) + '">' +
          '</label>' +
          '<nav class="settings-nav-body">' + nav + '</nav>' +
          '<p class="settings-nav-empty" id="settingsNavEmpty" hidden>没有匹配的设置项</p>' +
          '<p class="settings-nav-foot">' + icon('command', 'ico-xs') + '按 ⌘, 随时回到这里</p>' +
        '</aside>' +
        '<div class="settings-body" id="settingsBody">' + page() + '</div>' +
      '</div>';
  }

  V.settings = settings;
  window.MJSettings = SSet;
})();
