/* MJWork 原型 · 设置 · 模型配置（主模型 / 服务商 / 连接测试） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function tone (state) {
    return state === '正常' ? 'accent' : state === '需 Key' ? 'amber' : state === '失败' ? 'red' : 'plain';
  }

  function providerRows (st) {
    return st.providers.map(function (p) {
      var isMain = st.mainModel === p.id;
      return '<div class="provider-row">' +
        '<span class="provider-mark">' + (icon('spark')) + '</span>' +
        '<span class="provider-main"><b>' + esc(p.name) + (isMain ? '<span class="provider-tag">主模型</span>' : '') + '</b>' +
          '<small>' + esc(p.url) + ' · 凭据：' + esc(p.key) + ' · ' + p.models + ' 个模型</small></span>' +
        U.badge(p.state, tone(p.state)) +
        '<button class="btn btn-quiet btn-sm" data-action="test-provider" data-provider="' + esc(p.id) + '"' +
          (p.state === '检测中' ? ' disabled' : '') + '>测试连接</button>' +
        '<button class="icon-btn" data-action="remove-provider" data-provider="' + esc(p.id) + '" aria-label="移除 ' + esc(p.name) + '">' +
          icon('close') + '</button>' +
        '</div>';
    }).join('');
  }

  function models () {
    var st = S.settings;
    return SS.section('主模型', '统筹汇总与日常对话默认使用它；其他环节可以在通用页分档指定。',
      SS.row('当前主模型', '切换只影响后续任务，正在运行的任务保持原模型。',
        SS.select('setMainModel', st.mainModel, st.providers.map(function (p) {
          return { value: p.id, name: p.name };
        }), { wide: true, label: '当前主模型' }), { stack: true })) +
    SS.section('服务商', '支持 OpenAI 兼容接口；本地服务留空 Key 即可。',
      '<div class="provider-list">' + providerRows(st) + '</div>' +
      SS.row('添加服务商', '填入名称、Base URL 与 Key，保存后立即出现在主模型与分档下拉里。',
        '<button class="btn btn-ghost btn-sm" data-action="add-provider">' + icon('plus', 'ico-sm') + '添加服务商</button>')) +
    SS.section('凭据与隐私', '',
      '<p class="set-copy">Key 只写入本机钥匙串，界面只显示「已保存 / 未填」。原型不发起真实请求，测试连接为本地校验。</p>' +
      SS.hint('移除服务商不会删除已产生的账本记录；主模型被移除时会自动回落到第一个可用服务商。'));
  }

  SS.pages.models = models;
})();
