/* MJWork 原型 · 设置 · Git 与 Hooks（身份 / 环境 / GitHub / 钩子） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function hookRows (st) {
    if (!st.hooks.length) return SS.empty('还没有钩子。写入前校验与命令审计是最常用的两条。');
    return '<div class="set-list">' + st.hooks.map(function (h) {
      return '<div class="hook-row">' +
        '<div class="hook-main"><b>' + esc(h.name) + '</b>' +
          '<small><code>' + esc(h.event) + '</code> · ' + esc(h.match) + ' · 超时 ' + h.timeout + 'ms</small>' +
          '<code class="hook-cmd">' + esc(h.command) + '</code></div>' +
        '<div class="hook-actions">' +
          '<span class="switch' + (h.enabled ? ' is-on' : '') + '" role="switch" tabindex="0"' +
          ' aria-checked="' + (h.enabled ? 'true' : 'false') + '" aria-label="启用 ' + esc(h.name) + '"' +
          ' data-action="toggle-hook" data-hook="' + esc(h.id) + '"><i></i></span>' +
          '<button class="icon-btn" data-action="delete-hook" data-hook="' + esc(h.id) + '" aria-label="删除 ' + esc(h.name) + '">' +
          icon('close') + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  function git () {
    var st = S.settings.git;
    var hooks = S.settings.hooks;
    return SS.section('Git 身份', '用于提交署名；不会上传到任何服务器。',
      SS.row('用户名', '提交记录里的 author.name。',
        '<input class="set-input" id="gitName" type="text" value="' + esc(st.name) + '" aria-label="Git 用户名">', { stack: true }) +
      SS.row('邮箱', '提交记录里的 author.email。',
        '<input class="set-input" id="gitEmail" type="text" value="' + esc(st.email) + '" aria-label="Git 邮箱">', { stack: true }) +
      SS.row('提交署名', '开启后每次提交附带 MJWork 协作署名（Co-Authored-By）。',
        SS.toggle('git.signing', st.signing, { label: '提交署名' })) +
      '<div class="set-actions"><span class="set-count" id="gitHint">当前：' + esc(st.name) + ' &lt;' + esc(st.email) + '&gt;</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="save-git">保存身份</button></div>') +
    SS.section('Git 环境', '成员执行提交、分支与 diff 时使用的可执行文件。',
      SS.row('可执行文件', '检测失败时成员会拒绝所有写操作，而不是降级为无痕改动。',
        '<code class="set-code">' + esc(st.path) + '</code>' +
        '<button class="btn btn-quiet btn-sm" data-action="git-recheck">' + icon('refresh', 'ico-sm') + '重新检测</button>', { stack: true }) +
      SS.row('GitHub', st.gh === '已登录' ? '已登录为 boss@polestar.dev；推送与 PR 使用本机凭据。' : '未连接；推送、PR 与 Issue 能力不可用。',
        '<span class="badge ' + (st.gh === '已登录' ? 'badge-accent' : 'badge-amber') + '">' + esc(st.gh) + '</span>' +
        '<button class="btn btn-quiet btn-sm" data-action="gh-toggle">' + (st.gh === '已登录' ? '退出登录' : '登录 GitHub') + '</button>', { stack: true })) +
    SS.section('Hooks', '在工具调用前后执行本机脚本；失败不阻断任务，但会记进审计。',
      hookRows(S.settings) +
      '<div class="set-actions"><span class="set-count">' + hooks.filter(function (h) { return h.enabled; }).length + ' / ' + hooks.length + ' 条启用</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="hook-add">' + icon('plus', 'ico-sm') + '新增钩子</button></div>');
  }

  SS.pages.git = git;
})();
