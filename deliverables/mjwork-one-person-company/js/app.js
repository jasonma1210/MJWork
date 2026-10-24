/* MJWork 原型 · 应用壳层（渲染 / 转场 / 弹层 / Toast / 主题 / 快捷键） */
(function () {
  'use strict';

  var MJ = window.MJ;
  var S = MJ.store;
  var V = window.MJViews;
  var R = window.MJRouter;
  var U = window.MJUI;

  var el = {
    app: document.getElementById('app'),
    view: document.getElementById('view'),
    wrap: document.getElementById('viewwrap'),
    title: document.getElementById('viewTitle'),
    crumb: document.getElementById('crumb'),
    primary: document.getElementById('primaryAction'),
    nav: document.getElementById('navList'),
    navSub: document.getElementById('navListSub'),
    ind: document.getElementById('navInd'),
    indSub: document.getElementById('navIndSub'),
    layers: document.getElementById('layers'),
    toast: document.getElementById('toastRoot'),
    sidebar: document.getElementById('sidebar')
  };

  var current = { name: 'desk', params: {} };
  var onb = { step: 0, power: 'openai', team: 'founders', name: '北极星 CRM 重构', dir: '~/MJWork/polestar-crm', template: 'delivery', goal: '把线索导入流程重做：支持 CSV 导入、字段映射与重复合并，下周给销售团队试用。' };

  /* ---------------- 顶栏主操作 ---------------- */
  var PRIMARY = {
    desk: '<button class="btn btn-primary btn-sm" data-action="focus-goal">派一单' + U.icon('arrow-right', 'ico-sm') + '</button>',
    chat: '<button class="btn btn-ghost btn-sm" data-action="open-runs">运行记录</button>',
    studio: '<button class="btn btn-primary btn-sm" data-action="open-dispatch">派单</button>',
    ledger: '<button class="btn btn-ghost btn-sm" data-action="export-settlement">导出结算单</button>',
    ecosystem: '<button class="btn btn-ghost btn-sm" data-action="open-recruit">招募成员</button>',
    schedule: '<button class="btn btn-primary btn-sm" data-action="open-schedule">新建定时任务</button>'
  };

  /* ---------------- 渲染 ---------------- */
  function bodyFor (route) {
    switch (route.name) {
      case 'chat': return V.chat();
      case 'studio': return V.studio(route.params.tab || 'space');
      case 'ledger': return V.ledger();
      case 'ecosystem': return V.ecosystem(route.params.tab);
      case 'schedule': return V.schedule();
      case 'settings': return V.settings();
      default: return V.desk();
    }
  }

  function render () {
    current = R.parse();
    if (current.name === 'ecosystem' && current.params.tab) S.ecoTab = current.params.tab;

    el.title.textContent = R.TITLES[current.name];
    el.crumb.textContent = MJ.company.name + ' · 2026 年 10 月 23 日';
    el.primary.innerHTML = PRIMARY[current.name] || '';

    el.view.classList.remove('is-enter');
    el.view.innerHTML = bodyFor(current);
    /* 强制回流后再加转场类，保证每次切换都有位移入场 */
    void el.view.offsetWidth;
    el.view.classList.add('is-enter');

    paintNav();
    animateCounts();
    scrollMemory();
    if (window.MJInteractions && window.MJInteractions.afterRender) window.MJInteractions.afterRender(current);
  }

  function refresh () { render(); }

  function paintNav () { paintNavList(el.nav, el.ind); paintNavList(el.navSub, el.indSub); }

  /* 两个导航列表共用一个高亮规则：命中则移动苔绿指示块，否则淡出 */
  function paintNavList (list, ind) {
    if (!list || !ind) return;
    var links = list.querySelectorAll('.nav-item');
    var target = null;
    Array.prototype.forEach.call(links, function (a) {
      var on = a.getAttribute('data-nav') === current.name;
      a.classList.toggle('is-active', on);
      a.setAttribute('aria-current', on ? 'page' : 'false');
      if (on) target = a;
    });
    if (!target) { ind.style.opacity = '0'; return; }
    var box = target.getBoundingClientRect();
    var listBox = list.getBoundingClientRect();
    ind.style.height = box.height + 'px';
    ind.style.transform = 'translateY(' + (box.top - listBox.top) + 'px)';
    ind.style.opacity = '1';
  }

  /* ---------------- 数字滚动 ---------------- */
  function animateCounts () {
    var nodes = el.view.querySelectorAll('[data-count]');
    Array.prototype.forEach.call(nodes, function (n) {
      var to = Number(n.getAttribute('data-count')) || 0;
      var start = null;
      function step (ts) {
        if (!start) start = ts;
        var t = Math.min(1, (ts - start) / 620);
        var eased = 1 - Math.pow(1 - t, 3);
        n.textContent = Math.round(to * eased).toLocaleString('zh-CN');
        if (t < 1) window.requestAnimationFrame(step);
      }
      window.requestAnimationFrame(step);
    });
  }

  function scrollMemory () {
    var sc = document.getElementById('chatScroll');
    if (sc && current.name === 'chat') sc.scrollTop = sc.scrollHeight;
  }

  /* ---------------- Toast ---------------- */
  function toast (message, tone) {
    var t = document.createElement('div');
    t.className = 'toast' + (tone ? ' toast-' + tone : '');
    t.innerHTML = '<span class="toast-ico">' + U.icon(tone === 'danger' ? 'alert' : 'check') + '</span><span>' + U.esc(message) + '</span>';
    el.toast.appendChild(t);
    window.setTimeout(function () { t.classList.add('is-out'); }, 2200);
    window.setTimeout(function () { t.remove(); }, 2600);
  }

  /* ---------------- 弹层（物理感：弹簧入场 + 下拉惯性关闭） ---------------- */
  function modal (opts) {
    closeModal();
    var size = opts.size || 'md';
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="sheet sheet-' + size + '" role="dialog" aria-modal="true">' +
      '<header class="sheet-head"><div class="sheet-drag" aria-hidden="true"></div>' +
      '<div class="sheet-title"><p class="eyebrow">' + U.esc(opts.eyebrow || '') + '</p><h3>' + U.esc(opts.title || '') + '</h3></div>' +
      '<button class="icon-btn sheet-close" data-sheet-close aria-label="关闭">' + U.icon('close') + '</button></header>' +
      '<div class="sheet-body">' + (opts.body || '') + '</div>' +
      (opts.footer ? '<footer class="sheet-foot">' + opts.footer + '</footer>' : '') +
      '</div>';
    el.layers.appendChild(ov);
    document.body.classList.add('has-layer');

    var sheet = ov.querySelector('.sheet');
    ov.addEventListener('click', function (e) {
      if (e.target === ov) closeModal();
      if (e.target.closest('[data-sheet-close]')) closeModal();
    });

    /* 拖拽关闭：只从头部抓起，松手按位移与速度决定收或弹回 */
    var startY = 0;
    var dragY = 0;
    var dragging = false;
    sheet.querySelector('.sheet-head').addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      startY = e.clientY;
      sheet.setPointerCapture(e.pointerId);
      sheet.classList.add('is-dragging');
    });
    sheet.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dragY = Math.max(0, e.clientY - startY);
      sheet.style.transform = 'translateY(' + dragY + 'px)';
    });
    sheet.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('is-dragging');
      sheet.style.transform = '';
      if (dragY > 120) closeModal();
      dragY = 0;
    });

    if (opts.onMount) window.setTimeout(function () { opts.onMount(sheet); }, 0);
    return sheet;
  }

  function closeModal () {
    var ov = el.layers.querySelector('.overlay');
    if (!ov) return;
    ov.classList.add('is-out');
    window.setTimeout(function () { ov.remove(); }, 260);
    if (!el.layers.querySelector('.overlay')) document.body.classList.remove('has-layer');
  }

  /* 右侧抽屉：运行记录 / 任务详情 */
  function drawer (opts) {
    closeDrawer();
    var d = document.createElement('div');
    d.className = 'drawer';
    d.innerHTML = '<header class="drawer-head"><div><p class="eyebrow">' + U.esc(opts.eyebrow || '') + '</p><h3>' + U.esc(opts.title || '') + '</h3></div>' +
      '<button class="icon-btn" data-drawer-close aria-label="关闭">' + U.icon('close') + '</button></header>' +
      '<div class="drawer-body">' + (opts.body || '') + '</div>';
    el.layers.appendChild(d);
    document.body.classList.add('has-layer');
    d.addEventListener('click', function (e) {
      if (e.target.closest('[data-drawer-close]')) closeDrawer();
    });
    return d;
  }

  function closeDrawer () {
    var d = el.layers.querySelector('.drawer');
    if (!d) return;
    d.classList.add('is-out');
    window.setTimeout(function () { d.remove(); }, 240);
  }

  /* ---------------- 首启 ---------------- */
  function onboarding () {
    el.app.classList.add('is-hidden');
    var host = document.createElement('div');
    host.className = 'onb-host';
    host.id = 'onbHost';
    host.innerHTML = V.onboarding(onb);
    el.layers.appendChild(host);
  }

  function paintOnboarding () {
    var host = document.getElementById('onbHost');
    if (!host) return;
    host.innerHTML = V.onboarding(onb);
  }

  function finishOnboarding () {
    MJ.persistOnboarded(true);
    var host = document.getElementById('onbHost');
    if (host) host.remove();
    el.app.classList.remove('is-hidden');
    render();
    toast('公司已开张，第一单已派给创业专家团');
  }

  /* ---------------- 主题 / 侧栏 ---------------- */
  function applyTheme (theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var label = document.getElementById('themeLabel');
    if (label) label.textContent = theme === 'dark' ? '浅色模式' : '深色模式';
    MJ.savePref('theme', theme);
  }

  function applyCollapsed (collapsed) {
    el.sidebar.classList.toggle('is-collapsed', collapsed);
    S.collapsed = collapsed;
    MJ.savePref('collapsed', collapsed ? '1' : '0');
    paintNav();
  }

  /* 强调色通过动态样式表覆盖 --moss 系列变量：先匹配浅色，再匹配深色 */
  function applyAccent (id) {
    var choice = null;
    for (var i = 0; i < MJ.accentChoices.length; i++) {
      if (MJ.accentChoices[i].id === id) choice = MJ.accentChoices[i];
    }
    if (!choice) choice = MJ.accentChoices[0];
    var style = document.getElementById('accentVars');
    if (!style) {
      style = document.createElement('style');
      style.id = 'accentVars';
      document.head.appendChild(style);
    }
    function decl (vars) {
      return Object.keys(vars).map(function (k) { return k + ':' + vars[k] + ';'; }).join('');
    }
    var css = '';
    if (choice.vars && Object.keys(choice.vars).length) css += ':root{' + decl(choice.vars) + '}';
    if (choice.darkVars && Object.keys(choice.darkVars).length) css += '[data-theme="dark"]{' + decl(choice.darkVars) + '}';
    style.textContent = css;
    S.settings.accent = choice.id;
    MJ.saveSettings();
  }

  function applyMotion (on) {
    document.documentElement.setAttribute('data-motion', on ? 'reduced' : 'normal');
    S.settings.reduceMotion = !!on;
    MJ.saveSettings();
  }

  /* ---------------- 启动 ---------------- */
  function boot () {
    applyTheme(S.theme);
    applyCollapsed(S.collapsed);
    applyAccent(S.settings.accent);
    applyMotion(S.settings.reduceMotion);

    document.getElementById('themeToggle').addEventListener('click', function () {
      S.theme = S.theme === 'dark' ? 'light' : 'dark';
      applyTheme(S.theme);
    });
    document.getElementById('collapseBtn').addEventListener('click', function () {
      applyCollapsed(!S.collapsed);
    });
    document.getElementById('replayOnboarding').addEventListener('click', function () {
      onboarding();
    });
    document.getElementById('searchBtn').addEventListener('click', function () {
      if (window.MJPalette) window.MJPalette.open();
    });
    document.getElementById('companyBtn').addEventListener('click', function () {
      if (window.MJInteractions) window.MJInteractions.companyMenu(this);
    });
    document.getElementById('notifyBtn').addEventListener('click', function () {
      if (window.MJInteractions) window.MJInteractions.notifyMenu(this);
    });
    document.getElementById('ownerBtn').addEventListener('click', function () {
      toast('原型阶段不提供账户体系');
    });

    window.addEventListener('hashchange', render);
    window.addEventListener('resize', paintNav);

    document.addEventListener('keydown', function (e) {
      var cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key === 'k') { e.preventDefault(); if (window.MJPalette) window.MJPalette.open(); return; }
      if (cmd && e.key === '1') { e.preventDefault(); R.go('chat'); return; }
      if (cmd && e.key === '2') { e.preventDefault(); R.go('studio', { tab: S.rosterTab }); return; }
      if (cmd && e.key === '3') { e.preventDefault(); R.go('ledger'); return; }
      if (cmd && e.key === ',') { e.preventDefault(); R.go('settings'); return; }
      if (e.key === 'Escape') { closeModal(); closeDrawer(); }
    });

    if (!S.onboarded) onboarding();
    else render();

    if (window.MJInteractions) window.MJInteractions.init();
  }

  window.MJApp = {
    get current () { return current; },
    render: render,
    refresh: refresh,
    toast: toast,
    modal: modal,
    closeModal: closeModal,
    drawer: drawer,
    closeDrawer: closeDrawer,
    onboarding: { paint: paintOnboarding, state: onb, finish: finishOnboarding },
    paintNav: paintNav,
    applyTheme: applyTheme,
    applyAccent: applyAccent,
    applyMotion: applyMotion,
    setCollapsed: applyCollapsed,
    html: { el: el }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
