/* MJWork 原型 · 视图 · employeesTab / connectorsTab / skillsTab */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var badge = C.badge, emptyState = C.emptyState;

  function employeesTab () {
    var cats = ['全部'];
    MJ.employees.forEach(function (e) {
      if (cats.indexOf(e.cat) < 0) cats.push(e.cat);
    });
    var q = S.ecoQuery.trim().toLowerCase();
    var list = MJ.employees.filter(function (e) {
      var catOk = S.ecoCat === '全部' || e.cat === S.ecoCat;
      var qOk = !q || (e.title + e.mission + e.cat + e.industry.join(' ')).toLowerCase().indexOf(q) >= 0;
      return catOk && qOk;
    });

    return '' +
      '<div class="eco-toolbar">' +
        '<div class="chips" id="ecoCats">' + cats.map(function (c) {
          return '<button class="chip' + (S.ecoCat === c ? ' is-active' : '') + '" data-action="eco-cat" data-cat="' + esc(c) + '">' + esc(c) +
            (c === '全部' ? '<span>66</span>' : '') + '</button>';
        }).join('') + '</div>' +
        '<label class="search-field">' + icon('search') + '<input id="ecoSearch" type="search" placeholder="搜职位、使命或行业" value="' + esc(S.ecoQuery) + '"></label>' +
      '</div>' +
      '<p class="result-line">显示 <b>' + list.length + '</b> 名数字员工 · 招募后计入编制，原始模板不变' + (S.ecoCat !== '全部' ? ' · 分类：' + esc(S.ecoCat) : '') + '</p>' +
      (list.length ? '<div class="emp-grid">' + list.map(function (e) {
        return '<article class="emp-card">' +
          '<div class="emp-top"><span class="letter-badge">' + esc(e.title.slice(0, 1)) + '</span>' +
            '<div class="emp-id"><h4>' + esc(e.title) + '</h4><p>' + esc(e.cat) + ' · ' + esc(e.tier === 'advanced' ? '高级档' : '标准档') + '</p></div></div>' +
          '<p class="emp-mission">' + esc(e.mission) + '</p>' +
          '<div class="emp-tags">' + e.industry.slice(0, 3).map(function (tag) { return '<span>' + esc(tag) + '</span>'; }).join('') + '</div>' +
          '<div class="emp-skills">' + e.skills.slice(0, 3).map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>' +
          '<div class="emp-actions"><button class="btn btn-quiet btn-sm" data-action="employee-detail" data-employee="' + e.id + '">详情</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="employee-recruit" data-employee="' + e.id + '">招募' + icon('plus', 'ico-sm') + '</button></div>' +
        '</article>';
      }).join('') + '</div>' : emptyState('没有匹配的数字员工', '换个关键词，或点“全部”看 66 名员工。', '清空筛选', 'eco-clear')) +
      '<p class="eco-note">数字员工是角色模板，不提供下载；招募后由本机模型驱动，工具权限按档位与审批策略收紧。</p>';
  }

  function connectorsTab () {
    var list = MJ.connectors.filter(function (c) {
      return S.connectorLayer === 'all' || c.layer === S.connectorLayer;
    });
    return '' +
      '<div class="eco-toolbar">' +
        '<div class="chips">' + MJ.connectorLayers.map(function (l) {
          return '<button class="chip' + (S.connectorLayer === l.id ? ' is-active' : '') + '" data-action="connector-layer" data-layer="' + esc(l.id) + '">' + esc(l.name) + '</button>';
        }).join('') + '</div>' +
        '<p class="toolbar-note">精选 77 · 导入 214 · 分层决定谁能不打招呼就启动</p>' +
      '</div>' +
      '<div class="card conn-card"><div class="table-wrap"><table class="table conn-table">' +
        '<thead><tr><th>连接器</th><th>分类</th><th>传输 / 鉴权</th><th>分层</th><th>健康</th><th>本月调用</th><th></th></tr></thead><tbody>' +
        list.map(function (c) {
          return '<tr><td class="conn-name"><div class="conn-mark">' + esc(c.name.slice(0, 1)) + '</div><div><b>' + esc(c.name) + '</b><small>' + esc(c.vendor) + '</small></div></td>' +
            '<td>' + esc(c.cat) + '</td><td><b class="mono">' + esc(c.transport) + '</b><small class="cell-note">' + esc(c.auth) + '</small></td>' +
            '<td>' + U.badge(c.layer, c.layer === '自动启动' ? 'accent' : c.layer === '白名单' ? 'plain' : 'amber') + '</td>' +
            '<td>' + U.stateBadge(c.health) + '</td><td class="mono">' + esc(c.calls) + '</td>' +
            '<td class="row-action"><button class="mini-link" data-action="connector-detail" data-connector="' + c.id + '">' +
              (c.health === '健康' ? '管理' : '授权') + '</button></td></tr>';
        }).join('') + '</tbody></table></div></div>' +
      '<section class="card connector-note">' +
        '<div class="note-icon">' + icon('lock') + '</div>' +
        '<div><h4>高危连接器需要你手动授权</h4><p>数据库、生产文件系统与发信类连接器默认关闭；每次调用都带作用域与审批记录，密钥只进本机钥匙串。</p></div>' +
        '<button class="btn btn-ghost btn-sm" data-action="connector-policy">查看策略</button>' +
      '</section>';
  }

  function skillsTab () {
    var bundled = MJ.skills.filter(function (s) { return s.source === '随包'; }).length;
    return '' +
      '<div class="eco-toolbar"><div class="chips"><button class="chip is-active">全部 ' + MJ.skills.length + '</button><button class="chip" data-action="skill-filter" data-source="随包">随包 ' + bundled + '</button><button class="chip" data-action="skill-filter" data-source="市场">市场 ' + (MJ.skills.length - bundled) + '</button></div>' +
        '<p class="toolbar-note">技能是方法与验收流程，不执行外部代码</p></div>' +
      '<div class="card skill-card"><div class="skill-list">' + MJ.skills.map(function (s) {
        return '<div class="skill-row"><span class="skill-name">' + esc(s.name) + '</span><code>' + esc(s.slug) + '</code>' +
          '<span class="skill-src' + (s.source === '随包' ? ' is-bundled' : '') + '">' + esc(s.source) + '</span>' +
          '<span class="skill-uses">' + s.uses + ' 次</span>' +
          '<button class="switch mini' + (s.enabled ? ' is-on' : '') + '" data-action="skill-toggle" data-skill="' + esc(s.id) + '" role="switch" aria-checked="' + (s.enabled ? 'true' : 'false') + '" aria-label="启用 ' + esc(s.name) + '"><i></i></button></div>';
      }).join('') + '</div></div>' +
      '<p class="eco-note">共 100 个技能：随包 ' + bundled + ' 个，市场 ' + (MJ.skills.length - bundled) + ' 个。市场技能安装前会展示权限清单。</p>';
  }

  V.employeesTab = employeesTab;
  V.connectorsTab = connectorsTab;
  V.skillsTab = skillsTab;
})();
