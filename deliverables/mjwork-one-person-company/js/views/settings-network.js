/* MJWork 原型 · 设置 · 网络与链接（搜索提供方 / 超时 / 链接打开方式） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function searchRows (st) {
    return st.search.providers.map(function (p) {
      return '<div class="set-list-row">' +
        '<span class="set-list-main"><b>' + esc(p.name) + '</b><small>' + esc(p.url) + '</small></span>' +
        '<span class="switch' + (p.enabled ? ' is-on' : '') + '" role="switch" tabindex="0"' +
        ' aria-checked="' + (p.enabled ? 'true' : 'false') + '" aria-label="启用 ' + esc(p.name) + '"' +
        ' data-action="toggle-search" data-provider="' + esc(p.id) + '"><i></i></span>' +
        '</div>';
    }).join('');
  }

  function numField (id, value, min, max, unit) {
    return '<label class="set-num"><input id="' + id + '" type="number" min="' + min + '" max="' + max + '" value="' + value + '">' +
      '<span>' + esc(unit) + '</span></label>';
  }

  function network () {
    var st = S.settings;
    return SS.section('搜索', '搜索结果用于竞品与资料检索；只把命中的摘要交给模型。',
      '<div class="set-list">' + searchRows(st) + '</div>' +
      SS.hint('至少保留一个提供方；付费搜索走独立 MCP，不会默认启动。')) +
    SS.section('超时限制', '超时按「首字节 / 空闲 / 总时长」三段控制，避免一次慢请求拖住整轮任务。',
      '<div class="set-timeouts">' +
        SS.row('首字节', '连接后等待第一段数据的最长时间。', numField('searchFirstByte', st.search.firstByte, 1, 120, '秒')) +
        SS.row('空闲', '两次数据之间允许的最长间隔。', numField('searchIdle', st.search.idle, 5, 600, '秒')) +
        SS.row('总时长', '单次请求的硬上限，超过即中止。', numField('searchTotal', st.search.total, 10, 3600, '秒')) +
      '</div>' +
      '<div class="set-actions"><span class="set-count" id="limitsHint">当前 ' + st.search.firstByte + ' / ' + st.search.idle + ' / ' + st.search.total + ' 秒</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="save-limits">保存超时</button></div>') +
    SS.section('链接打开方式', '决定对话里的引用链接被点击后去哪里。',
      SS.row('打开方式', '智能：登录与支付类交给系统浏览器，文档类在应用内只读预览。',
        SS.seg('linkOpen', st.linkOpen, [
          { value: 'smart', name: '智能' },
          { value: 'system', name: '系统浏览器' },
          { value: 'copy', name: '只复制链接' }
        ]), { stack: true })) +
    SS.section('应用内浏览', '应用内只读预览不支持登录、支付与文件下载。',
      '<p class="set-copy">需要登录或提交表单的站点会自动改用系统浏览器；预览页禁用脚本注入，避免页面反向控制应用。</p>' +
      '<div class="set-actions"><button class="btn btn-ghost btn-sm" data-action="open-eco-connectors">' +
      icon('arrow-right', 'ico-sm') + '管理浏览器连接器</button></div>');
  }

  SS.pages.network = network;
})();
