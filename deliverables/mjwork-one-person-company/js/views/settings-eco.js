/* MJWork 原型 · 设置 · 生态与工具（技能 / 原生工具权限 / MCP 分层） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function topSkills () {
    return MJ.skills.slice().sort(function (a, b) { return b.uses - a.uses; }).slice(0, 6);
  }

  function skillRow (sk) {
    return '<div class="set-list-row">' +
      '<span class="set-list-main"><b>' + esc(sk.name) + '</b><small>' + esc(sk.source) + ' · 调用 ' + sk.uses + ' 次</small></span>' +
      '<span class="switch' + (sk.enabled ? ' is-on' : '') + '" role="switch" tabindex="0"' +
      ' aria-checked="' + (sk.enabled ? 'true' : 'false') + '" aria-label="启用技能 ' + esc(sk.name) + '"' +
      ' data-action="settings-skill" data-skill="' + esc(sk.id) + '"><i></i></span>' +
      '</div>';
  }

  function toolRow (key, name, desc, danger) {
    return SS.row(name, desc, SS.toggle('tools.' + key, S.settings.tools[key], { label: name, danger: danger }), { danger: danger && S.settings.tools[key] });
  }

  function eco () {
    var enabled = MJ.skills.filter(function (s) { return s.enabled; }).length;
    return SS.section('常用技能', '按调用次数排序；全部 ' + MJ.skills.length + ' 个技能在生态中心统一管理。',
      '<div class="set-list">' + topSkills().map(skillRow).join('') + '</div>' +
      '<div class="set-actions"><span class="set-count">已启用 ' + enabled + ' / ' + MJ.skills.length + '</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="open-eco-skills">' + icon('arrow-right', 'ico-sm') + '全部技能</button></div>') +
    SS.section('原生工具权限', '原生工具默认只开只读能力；写入、命令与 computer use 需要显式开启。',
      toolRow('read', '读取文件', '默认开启；只读工作区与项目目录。', false) +
      toolRow('write', '写入文件', '改动工作区文件；高风险路径仍会逐次审批。', false) +
      toolRow('shell', '执行命令', 'Terminal 类高权限能力，绝不默认启动；开启后仍受审批约束。', true) +
      toolRow('web', '网页抓取', '只读 GET，固定域名校验；与浏览器自动化严格分离。', false) +
      toolRow('sandbox', '沙盒代码执行', 'Node VM + 独立子进程，带网络开关与超时；不复用宿主进程。', false) +
      toolRow('cua', 'computer use', '仅 macOS 可用；逐次审批 + 应用白名单 + 步数上限。', true) +
      SS.hint('所有工具调用都会进入审计；高危操作弹出确认，能力降级开关统一生效。')) +
    SS.section('MCP 分层', '默认全部关闭，按意图按需加载；同一次运行不会与原生实现同框。',
      '<div class="set-list">' +
        '<div class="set-list-row"><span class="rule-badge">自动</span><span class="set-list-main"><b>只读低风险</b><small>web-fetch、time、filesystem 只读类，随对话按需加载</small></span></div>' +
        '<div class="set-list-row"><span class="rule-badge">白名单</span><span class="set-list-main"><b>需授权作用域</b><small>git、付费搜索、http-client；首次授权后按项目复用</small></span></div>' +
        '<div class="set-list-row"><span class="rule-badge">手动</span><span class="set-list-main"><b>每次显式开启</b><small>Terminal、数据库、playwright；每次调用都要审批</small></span></div>' +
      '</div>' +
      '<div class="set-actions"><span class="set-count">原生优先：已有原生实现时不拉起同名 MCP</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="open-eco-connectors">' + icon('arrow-right', 'ico-sm') + '连接器</button></div>');
  }

  SS.pages.eco = eco;
})();
