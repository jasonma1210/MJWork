/* MJWork 原型 · 设置 · 外观（主题 / 强调色 / 动效 / 侧栏） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function accents () {
    return '<div class="accent-grid">' + MJ.accentChoices.map(function (c) {
      return '<button class="accent-tile' + (S.settings.accent === c.id ? ' is-active' : '') + '"' +
        ' data-action="set-accent" data-accent="' + esc(c.id) + '" aria-pressed="' + (S.settings.accent === c.id ? 'true' : 'false') + '">' +
        '<i class="accent-swatch accent-' + esc(c.id) + '"></i><span>' + esc(c.name) + '</span>' +
        (S.settings.accent === c.id ? icon('check', 'ico-xs') : '') + '</button>';
    }).join('') + '</div>';
  }

  function appearance () {
    var st = S.settings;
    return SS.section('主题', '纸面与深色两套主题，跟随系统只影响首次启动。',
      SS.row('主题', '纸白底更像纸张，深色适合夜里看长文档。',
        SS.seg('theme', S.theme, [
          { value: 'light', name: '纸白' },
          { value: 'dark', name: '深色' }
        ]), { stack: true })) +
    SS.section('强调色', '只提供四种低饱和配色，不出现蓝色。切换后按钮、进度与聚焦环同步生效。',
      accents() +
      '<div class="set-preview" aria-hidden="true">' +
        '<div class="preview-card"><b>交付预览</b><p>进度 62% · 预算 ¥4.86</p>' +
        '<span class="progress"><i style="width:62%"></i></span>' +
        '<div class="preview-actions"><span class="preview-btn primary">派单</span><span class="preview-btn ghost">查看</span></div>' +
        '</div></div>') +
    SS.section('动效与布局', '减少动效会关掉弹层弹簧与列表位移，仅保留必要的状态反馈。',
      SS.row('减少动效', '适合晕动敏感或远程桌面场景。',
        SS.toggle('reduceMotion', st.reduceMotion, { label: '减少动效' })) +
      SS.row('侧栏默认折叠', '折叠后只留图标，给内容区更多宽度。',
        '<button class="switch' + (S.collapsed ? ' is-on' : '') + '" role="switch" tabindex="0"' +
        ' aria-checked="' + (S.collapsed ? 'true' : 'false') + '" aria-label="侧栏默认折叠"' +
        ' data-action="toggle-collapsed"><i></i></button>'));
  }

  SS.pages.appearance = appearance;
})();
