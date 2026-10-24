/* MJWork 原型 · 命令面板（⌘K / Ctrl+K） */
(function () {
  'use strict';
  var U = window.MJUI, MJ = window.MJ, R = window.MJRouter;
  var host = null, input = null, list = null, flat = [], index = 0;
  function esc (s) { return U.esc(s == null ? '' : String(s)); }

  /* 三组固定候选：页面 6 / 数字员工前 8 / 工件前 6 */
  function pool () {
    var items = [];
    R.ROUTES.forEach(function (r) {
      items.push({ group: '去往', title: R.TITLES[r], meta: '页面', icon: 'arrow-right', kind: 'route', id: r });
    });
    MJ.employees.slice(0, 8).forEach(function (e) {
      items.push({ group: '数字员工', title: e.title, meta: e.cat, icon: 'users', kind: 'employee', id: e.id });
    });
    MJ.artifacts.slice(0, 6).forEach(function (a) {
      items.push({ group: '工件', title: a.name, meta: a.type + ' · ' + a.version, icon: 'file', kind: 'artifact', id: a.id });
    });
    return items;
  }

  function filtered () {
    var q = String(input.value || '').trim().toLowerCase();
    var base = pool();
    if (!q) return base;
    return base.filter(function (it) {
      return (it.title + ' ' + it.meta + ' ' + it.group).toLowerCase().indexOf(q) >= 0;
    });
  }

  function close () {
    if (!host) return;
    host.hidden = true;
    host.classList.remove('is-open');
  }

  function run (item) {
    close();
    if (!item) return;
    if (item.kind === 'route') { R.go(item.id); return; }
    if (item.kind === 'employee') { if (window.MJModals) window.MJModals.employee(item.id); return; }
    R.go('studio', { tab: 'artifacts' });
    if (window.MJModals) window.MJModals.artifact(item.id);
  }

  /* 渲染分组列表，首项默认高亮 */
  function paint () {
    flat = filtered();
    index = 0;
    if (!flat.length) { list.innerHTML = '<p class="palette-empty">没有匹配的命令，换个词试试</p>'; return; }
    var html = '', last = '';
    flat.forEach(function (it, i) {
      if (it.group !== last) {
        if (last) html += '</div>';
        html += '<div class="palette-group"><p class="palette-label">' + esc(it.group) + '</p>';
        last = it.group;
      }
      html += '<button class="palette-item' + (i === 0 ? ' is-active' : '') + '" data-palette="' + i + '" role="option" aria-selected="' + (i === 0 ? 'true' : 'false') + '">' +
        '<span class="palette-ico">' + U.icon(it.icon) + '</span>' +
        '<span class="palette-copy"><b>' + esc(it.title) + '</b><small>' + esc(it.meta) + '</small></span>' +
        '<span class="palette-kbd">↵</span></button>';
    });
    list.innerHTML = html + '</div>';
  }

  function activate (next) {
    var nodes = list.querySelectorAll('.palette-item');
    if (!nodes.length) return;
    index = (next + nodes.length) % nodes.length;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('is-active', i === index);
      nodes[i].setAttribute('aria-selected', i === index ? 'true' : 'false');
    }
    if (nodes[index].scrollIntoView) nodes[index].scrollIntoView({ block: 'nearest' });
  }

  function bind () {
    input.addEventListener('input', paint);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); activate(index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activate(index - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); run(flat[index]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    list.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-palette]') : null;
      if (!btn) return;
      run(flat[Number(btn.getAttribute('data-palette'))]);
    });
    host.addEventListener('mousedown', function (e) { if (e.target === host) close(); });
  }

  function ensure () {
    if (host) return;
    host = document.createElement('div');
    host.className = 'palette';
    host.id = 'palette';
    host.hidden = true;
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', '命令面板');
    host.innerHTML = '<div class="palette-panel" role="document">' +
      '<div class="palette-head">' + U.icon('search') +
      '<input class="palette-input" id="paletteInput" type="search" placeholder="搜索页面、数字员工或工件" autocomplete="off" aria-label="搜索命令"></div>' +
      '<div class="palette-list" id="paletteList" role="listbox" aria-label="命令列表"></div>' +
      '<div class="palette-hint"><span class="palette-kbd">↑</span><span class="palette-kbd">↓</span> 选择 · ' +
      '<span class="palette-kbd">↵</span> 执行 · <span class="palette-kbd">esc</span> 关闭</div></div>';
    document.body.appendChild(host);
    input = host.querySelector('.palette-input');
    list = host.querySelector('.palette-list');
    bind();
  }

  function open () {
    ensure();
    host.hidden = false;
    host.classList.add('is-open');
    input.value = '';
    paint();
    input.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && host && !host.hidden) { e.preventDefault(); close(); }
  });
  window.addEventListener('hashchange', close);

  window.MJPalette = { open: open, close: close };
})();
