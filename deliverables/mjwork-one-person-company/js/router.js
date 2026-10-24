/* MJWork 原型 · hash 路由 */
(function () {
  'use strict';

  var ROUTES = ['desk', 'chat', 'studio', 'ledger', 'ecosystem', 'schedule', 'settings'];

  var TITLES = {
    desk: '接单台',
    chat: '对话',
    studio: '团队工作室',
    ledger: '账本',
    ecosystem: '生态中心',
    schedule: '定时任务',
    settings: '设置'
  };

  function parse (hash) {
    var raw = String(hash == null ? window.location.hash : hash).replace(/^#\/?/, '');
    var qi = raw.indexOf('?');
    var name = (qi < 0 ? raw : raw.slice(0, qi)) || 'desk';
    var params = {};
    if (qi >= 0) {
      raw.slice(qi + 1).split('&').forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split('=');
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    }
    if (ROUTES.indexOf(name) < 0) name = 'desk';
    return { name: name, params: params };
  }

  function href (name, params) {
    var q = Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return '#/' + name + (q ? '?' + q : '');
  }

  function go (name, params) {
    var next = href(name, params);
    if (window.location.hash === next) return;
    window.location.hash = next;
  }

  window.MJRouter = {
    ROUTES: ROUTES,
    TITLES: TITLES,
    parse: parse,
    href: href,
    go: go
  };
})();
