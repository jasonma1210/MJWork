/* MJWork 原型 · 弹层与抽屉（派单 / 招募 / 档案 / 工件 / 看板 / 定时任务） */
(function () {
  'use strict';
  var U = window.MJUI, MJ = window.MJ, S = MJ.store, R = window.MJRouter, C = window.MJCommon;
  var esc = U.esc, icon = U.icon, badge = C.badge;

  /* 通用小工具 */
  function $ (id) { return document.getElementById(id); }
  function all (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function byId (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function T (msg, tone) { window.MJApp.toast(msg, tone); }
  function RF () { window.MJApp.refresh(); }
  function close () { window.MJApp.closeModal(); }
  function modal (opts) { return window.MJApp.modal(opts); }
  function field (label, control) { return '<label class="field"><span>' + label + '</span>' + control + '</label>'; }
  function hint (text) { return '<p class="field-hint">' + icon('lock', 'ico-xs') + text + '</p>'; }
  function kv (k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
  function colById (id) { for (var i = 0; i < MJ.boardCols.length; i++) if (MJ.boardCols[i].id === id) return MJ.boardCols[i]; return null; }
  function teamName (name, lead) { return '<span class="chip' + (lead ? ' is-active' : '') + '">' + esc(name) + (lead ? ' · 统筹' : '') + '</span>'; }
  function inTeam (emp) {
    return S.team.some(function (m) { return m.id === emp.id || m.name === emp.title; });
  }

  /* 招募一名数字员工：统筹只允许一位，重复不写入 */
  function addEmployee (emp) {
    if (inTeam(emp)) return false;
    S.team.push({
      id: emp.id, name: emp.title, role: emp.cat, lead: false,
      model: emp.tier === 'advanced' ? '云端 · Sonnet 4.5' : '本地 · Qwen3-32B',
      tier: emp.tier === 'advanced' ? '高级' : '标准',
      tools: emp.tools.slice(0, 4), status: '待命', focus: emp.mission, joined: '10-23', load: 0
    });
    return true;
  }

  /* ---------------- 派单 ---------------- */
  function dispatch () {
    var teams = MJ.templates.filter(function (t) { return t.id !== 'blank'; });
    var selected = teams[0].id;
    var teamCards = teams.map(function (t, i) {
      return '<button class="choice-card' + (i === 0 ? ' is-active' : '') + '" data-team="' + esc(t.id) + '">' +
        '<span class="choice-radio"></span><span class="choice-copy"><span class="choice-title"><b>' + esc(t.name) + '</b><em>' + t.people + ' 人</em></span>' +
        '<small>' + esc(t.cast) + '</small></span></button>';
    }).join('');
    var modeOpts = MJ.modes.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === S.chat.modeId ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('');
    var body = field('这一单要做什么', '<textarea id="dispatchGoal" rows="4" placeholder="说清目标、约束与交付时间">' + esc(S.chat.goal || '') + '</textarea>') +
      '<div class="field"><span>团队</span><div class="choice-list teams" id="dispatchTeams">' + teamCards + '</div></div>' +
      field('怎么干', '<select id="dispatchMode">' + modeOpts + '</select>') + field('预算 ¥', '<input id="dispatchBudget" type="number" min="10" step="10" value="' + (S.deskBudget || 80) + '">') +
      hint('派单后统筹先拆解；涉及删除、迁移与密钥的操作会先问你。');
    modal({
      eyebrow: '派单', title: '给团队一个新目标', body: body, size: 'md',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button><button class="btn btn-primary" id="dispatchSubmit">派单' + icon('arrow-right') + '</button>',
      onMount: function (sheet) {
        all('[data-team]', sheet).forEach(function (btn) {
          btn.addEventListener('click', function () {
            all('[data-team]', sheet).forEach(function (b) { b.classList.remove('is-active'); }); btn.classList.add('is-active'); selected = btn.getAttribute('data-team');
          });
        });
        sheet.querySelector('#dispatchSubmit').addEventListener('click', function () {
          var goal = String(sheet.querySelector('#dispatchGoal').value || '').trim();
          if (!goal) { T('先写清楚这一单要做什么', 'danger'); sheet.querySelector('#dispatchGoal').focus(); return; }
          var mode = byId(MJ.modes, sheet.querySelector('#dispatchMode').value) || MJ.modes[0];
          S.chat.goal = goal; S.chat.modeId = mode.id; S.chat.mode = mode.name; S.deskModeId = mode.id; S.deskMode = mode.name;
          S.deskBudget = Number(sheet.querySelector('#dispatchBudget').value) || 0; S.chat.teamId = selected;
          close(); T('已派单，统筹开始拆解'); R.go('chat');
        });
      }
    });
  }

  /* ---------------- 招募（连续添加） ---------------- */
  function recruit (employeeId) {
    var body = '<div style="display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);gap:18px"><div><label class="search-field">' + icon('search') +
      '<input id="recruitSearch" type="search" placeholder="搜职位、分类或行业"></label><div class="choice-list" id="recruitList"></div></div>' +
      '<aside><p class="eyebrow">当前编制</p><div class="chips" id="recruitTeam"></div>' +
      '<p class="field-hint">' + icon('lock', 'ico-xs') + '统筹只能有一位；招募后计入本月账本，可随时移除。</p></aside></div>';
    modal({
      eyebrow: '数字员工', title: '从 66 名模板里招人', body: body, size: 'lg',
      footer: '<button class="btn btn-primary" data-sheet-close>完成</button>',
      onMount: function (sheet) {
        var search = sheet.querySelector('#recruitSearch'), list = sheet.querySelector('#recruitList'), tags = sheet.querySelector('#recruitTeam');
        var query = '';
        function paintTags () { tags.innerHTML = S.team.map(function (m) { return teamName(m.name, m.lead); }).join('') || '<span class="chip">还没有编入成员</span>'; }
        function pool () {
          var q = query.trim().toLowerCase();
          var out = MJ.employees.filter(function (e) {
            if (!q) return true;
            return (e.title + e.cat + e.industry.join(' ') + e.mission).toLowerCase().indexOf(q) >= 0;
          });
          out.sort(function (a, b) { if (a.id === employeeId) return -1; if (b.id === employeeId) return 1; return 0; });
          return out.slice(0, 12);
        }
        function paintList () {
          var items = pool();
          if (!items.length) { list.innerHTML = '<p class="result-line">没有匹配的数字员工</p>'; return; }
          list.innerHTML = items.map(function (e) {
            var added = inTeam(e);
            return '<button class="choice-card' + (e.id === employeeId ? ' is-active' : '') + '" data-recruit="' + esc(e.id) + '">' +
              '<span class="choice-radio"></span><span class="choice-copy"><span class="choice-title"><b>' + esc(e.title) + '</b><em>' + esc(e.cat) + '</em></span>' +
              '<small>' + esc(e.mission) + '</small><span class="onb-stack"><span class="chip">' + (e.tier === 'advanced' ? '高级档' : '标准档') + '</span>' +
              (added ? '<span class="chip is-active">已在编制</span>' : '') + '</span></span></button>';
          }).join('');
          all('[data-recruit]', list).forEach(function (btn) {
            btn.addEventListener('click', function () {
              var emp = byId(MJ.employees, btn.getAttribute('data-recruit')); if (!emp) return;
              if (!addEmployee(emp)) { T('已在编制内：' + emp.title); return; }
              T('已加入编制：' + emp.title); RF(); paintList(); paintTags();
            });
          });
        }
        search.addEventListener('input', function () { query = search.value; paintList(); });
        paintList(); paintTags();
        if (employeeId) search.focus();
      }
    });
  }

  /* ---------------- 数字员工档案 ---------------- */
  function employee (id) {
    var emp = byId(MJ.employees, id);
    if (!emp) { T('没有找到这名数字员工', 'danger'); return; }
    var approval = { 'on-request': '按需审批', 'always': '总是审批' }[emp.approval] || emp.approval;
    var sandbox = emp.sandbox === 'read-only' ? '只读沙箱' : '工作区读写';
    var body = '<div class="member-top">' + U.avatar(emp.title, { size: 'lg' }) +
      '<div class="member-id"><div class="name-line"><h4>' + esc(emp.title) + '</h4><span class="lead-badge">' + esc(emp.cat) + '</span></div>' +
      '<p>' + (emp.tier === 'advanced' ? '高级档' : '标准档') + ' · ' + esc(emp.industry.slice(0, 3).join(' / ')) + '</p></div></div>' +
      '<p class="lede">' + esc(emp.mission) + '</p>' +
      '<dl class="member-kv">' + kv('技能', esc(emp.skills.join(' · '))) + kv('工具', esc(emp.tools.join(' · '))) +
      kv('审批', esc(approval)) + kv('沙箱', esc(sandbox)) + '</dl>' +
      hint('数字员工是角色模板，由本机模型驱动；权限按档位与审批策略收紧。');
    modal({
      eyebrow: '数字员工', title: emp.title, body: body, size: 'md',
      footer: '<button class="btn btn-quiet" data-sheet-close>关闭</button><button class="btn btn-primary" id="empAdd">招募' + icon('plus', 'ico-sm') + '</button>',
      onMount: function (sheet) {
        var btn = sheet.querySelector('#empAdd');
        if (inTeam(emp)) { btn.textContent = '已在编制'; btn.disabled = true; return; }
        btn.addEventListener('click', function () {
          if (!addEmployee(emp)) { T('已在编制内：' + emp.title); return; }
          close(); RF(); T('已加入编制：' + emp.title);
        });
      }
    });
  }

  /* ---------------- 在编成员 ---------------- */
  function member (id) {
    var m = null;
    for (var i = 0; i < S.team.length; i++) if (S.team[i].id === id) m = S.team[i];
    if (!m) { T('这名成员不在编制内', 'danger'); return; }
    var body = '<div class="member-top">' + U.avatar(m.name, { lead: m.lead, size: 'lg' }) +
      '<div class="member-id"><div class="name-line"><h4>' + esc(m.name) + '</h4>' + (m.lead ? '<span class="lead-badge">统筹</span>' : '') + '</div>' +
      '<p>' + esc(m.role) + ' · ' + esc(m.focus) + '</p></div></div>' +
      '<dl class="member-kv">' + kv('模型', esc(m.model)) + kv('档位', esc(m.tier)) +
      kv('工具', '<span class="mono">' + esc(m.tools.join(' · ')) + '</span>') + kv('加入', esc(m.joined)) + '</dl>' +
      '<div class="load-row"><span>本周负载</span><div class="mini-progress"><i style="width:' + m.load + '%"></i></div><b>' + m.load + '%</b></div>' +
      hint('移除后不再计入编制，正在运行的任务会交给统筹重新分派。');
    modal({
      eyebrow: '编制档案', title: m.name, body: body, size: 'md',
      footer: '<button class="btn btn-quiet" data-sheet-close>关闭</button><button class="btn btn-quiet" id="memRemove">从编制移除</button>',
      onMount: function (sheet) {
        sheet.querySelector('#memRemove').addEventListener('click', function () {
          S.team = S.team.filter(function (x) { return x.id !== m.id; });
          close(); RF(); T('已从编制移除：' + m.name);
        });
      }
    });
  }

  /* ---------------- 工件 ---------------- */
  function artifact (id) {
    var a = byId(S.artifacts, id);
    if (!a) { T('这件工件还没归档', 'danger'); return; }
    var add = 0, del = 0;
    var tree = a.changes.map(function (c) { add += c.add; del += c.del; return c.file + '   +' + c.add + ' −' + c.del; }).join('\n');
    var body = '<div class="art-card-top"><span class="art-type">' + esc(a.type) + '</span>' + badge(a.state) + '</div>' +
      '<h4>' + esc(a.name) + ' <code>' + esc(a.version) + '</code></h4>' +
      '<dl class="member-kv">' + kv('负责人', esc(a.owner)) + kv('更新', esc(a.updated)) + kv('规模', esc(a.size) + ' · ' + a.pages + ' 页') + kv('项目', esc(a.project)) + '</dl>' +
      '<p class="lede">' + esc(a.summary) + '</p>' +
      '<pre class="mono" style="white-space:pre-wrap;line-height:1.7;margin:10px 0 12px">' + esc(tree) + '</pre>' +
      '<p class="ai-text">要点一：本版围绕「' + esc(a.summary) + '」展开，目录中的文件就是本次交付的全部边界。</p>' +
      '<p class="ai-text">要点二：共 ' + a.changes.length + ' 个文件，新增 ' + add + ' 行、删除 ' + del + ' 行；验收按项目清单逐项确认。</p>' +
      hint('原型只展示归档结构，不读取真实文件；版本只增不改。');
    modal({
      eyebrow: '工件 · ' + a.version, title: a.name, body: body, size: 'lg',
      footer: '<button class="btn btn-quiet" data-sheet-close>关闭</button><button class="btn btn-primary" id="artAccept">标记已验收</button>',
      onMount: function (sheet) {
        sheet.querySelector('#artAccept').addEventListener('click', function () {
          a.state = '已验收'; close(); RF(); T('已标记验收：' + a.name);
        });
      }
    });
  }

  /* ---------------- 看板任务 ---------------- */
  function task (id) {
    var b = byId(S.board, id);
    if (!b) { T('没有找到这个任务', 'danger'); return; }
    var col = colById(b.col);
    var body = '<div class="art-card-top"><span class="art-type">' + esc(col ? col.name : b.col) + '</span><span class="token">' + esc(b.token) + ' tok</span></div>' +
      '<h4>' + esc(b.title) + '</h4>' +
      '<dl class="member-kv">' + kv('认领人', esc(b.who)) + kv('依赖', esc(b.dep)) + kv('状态', esc(col ? col.name : b.col)) + '</dl>' +
      hint('移动只改本机看板状态，不会重新触发运行；拖拽卡片也能换列。');
    var moves = MJ.boardCols.filter(function (c) { return c.id !== b.col; }).map(function (c) {
      return '<button class="btn btn-quiet btn-sm" data-move="' + c.id + '">移到 ' + esc(c.name) + '</button>';
    }).join('');
    modal({
      eyebrow: '任务', title: '看板任务', body: body, size: 'md',
      footer: '<button class="btn btn-quiet" data-sheet-close>关闭</button>' + moves,
      onMount: function (sheet) {
        all('[data-move]', sheet).forEach(function (btn) {
          btn.addEventListener('click', function () {
            b.col = btn.getAttribute('data-move');
            var target = colById(b.col);
            close(); RF(); T('已移到「' + (target ? target.name : b.col) + '」');
          });
        });
      }
    });
  }

  /* ---------------- 运行记录 ---------------- */
  function runs () {
    var rows = MJ.runs.map(function (r) {
      return '<div class="run-tr"><span class="run-mode">' + esc(r.mode) + '</span><span>' + esc(r.who) + '</span>' +
        '<span>' + esc(r.time) + '</span><span>' + esc(r.dur) + '</span><span class="num">' + esc(r.cost) + '</span>' + badge(r.state) + '</div>';
    }).join('');
    var body = '<div class="run-table">' + rows + '</div>' +
      '<section class="card" style="margin-top:14px"><div class="card-head"><div class="ch-title"><p class="eyebrow">当前批次</p><h3>' + esc(MJ.runtime.batch) + '</h3></div>' +
      '<span class="live-tag"><i class="breath"></i>运行中</span></div>' +
      '<div class="progress"><i style="width:' + MJ.runtime.progress + '%"></i></div>' +
      '<div class="run-meta"><span><b>' + MJ.runtime.progress + '%</b> 已完成</span><span>并发 ' + MJ.runtime.concurrency + '</span><span>已用 ¥' + MJ.runtime.cost.toFixed(2) + '</span></div></section>' +
      hint('原型保留最近 3 次运行；批次进度只做展示，不会真的推进。');
    window.MJApp.drawer({ eyebrow: '运行记录', title: '这家公司跑过的活', body: body });
  }

  /* ---------------- 连接器 ---------------- */
  function connector (id) {
    var c = byId(MJ.connectors, id);
    if (!c) { T('没有找到这个连接器', 'danger'); return; }
    var risk = c.health !== '健康';
    var body = '<div class="conn-name"><div class="conn-mark">' + esc(c.name.slice(0, 1)) + '</div><div><h4>' + esc(c.name) + '</h4><small>' + esc(c.vendor) + '</small></div></div>' +
      '<dl class="member-kv">' + kv('分类', esc(c.cat)) + kv('传输', esc(c.transport)) + kv('鉴权', esc(c.auth)) +
      kv('分层', esc(c.layer)) + kv('健康', badge(c.health)) + kv('本月调用', esc(c.calls)) + '</dl>' +
      '<p class="lede">' + esc(c.desc) + '</p>' +
      hint(c.layer === '手动' ? '高危连接器默认关闭；授权后每次调用仍会记录作用域与审批。' : '白名单内可直接启动；撤销授权会立即生效。');
    var footer = risk
      ? '<button class="btn btn-quiet" data-sheet-close>关闭</button><button class="btn btn-primary" id="connAuth">授权并启用</button>'
      : '<button class="btn btn-quiet" data-sheet-close>关闭</button>';
    modal({
      eyebrow: '连接器', title: c.name, body: body, size: 'md', footer: footer,
      onMount: function (sheet) {
        var btn = sheet.querySelector('#connAuth');
        if (!btn) return;
        btn.addEventListener('click', function () {
          c.health = '健康'; close(); RF(); T('已授权 ' + c.name + '，密钥写入本机钥匙串（原型模拟）');
        });
      }
    });
  }

  /* ---------------- 定时任务 ---------------- */
  function schedule (id) {
    var sch = id ? byId(S.schedules, id) : null;
    var teams = MJ.templates.map(function (t) { return t.name; }).concat(['直接回答']);
    var options = teams.map(function (name) {
      return '<option' + (sch && sch.team === name ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');
    var body = field('名称', '<input id="schName" type="text" value="' + esc(sch ? sch.name : '') + '" placeholder="例如：每日站会">') +
      field('计划', '<input id="schPlan" type="text" value="' + esc(sch ? sch.plan : '每个工作日 09:00') + '">') +
      field('目标', '<textarea id="schTarget" rows="3" placeholder="这条任务要产出什么">' + esc(sch ? sch.target : '') + '</textarea>') +
      field('团队', '<select id="schTeam">' + options + '</select>') +
      field('预算 ¥', '<input id="schBudget" type="number" min="10" step="10" value="' + (sch ? sch.budget : 30) + '">') +
      '<div class="load-row"><span>启用</span><span class="switch' + (!sch || sch.enabled ? ' is-on' : '') + '" id="schEnabled" role="switch" tabindex="0" aria-checked="' + (!sch || sch.enabled ? 'true' : 'false') + '"><i></i></span></div>' +
      hint('同一任务不会并发；电脑休眠时只补最近一次。');
    modal({
      eyebrow: '定时任务', title: sch ? '编辑：' + sch.name : '新建一条定时任务', body: body, size: 'md',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button><button class="btn btn-primary" id="schSave">保存</button>',
      onMount: function (sheet) {
        var sw = sheet.querySelector('#schEnabled');
        var enabled = !sch || sch.enabled;
        function flip () { enabled = !enabled; sw.classList.toggle('is-on', enabled); sw.setAttribute('aria-checked', enabled ? 'true' : 'false'); }
        sw.addEventListener('click', flip);
        sw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        sheet.querySelector('#schSave').addEventListener('click', function () {
          var name = String(sheet.querySelector('#schName').value || '').trim();
          var target = String(sheet.querySelector('#schTarget').value || '').trim();
          if (!name) { T('给任务起个名字', 'danger'); sheet.querySelector('#schName').focus(); return; }
          if (!target) { T('写清楚这条任务要产出什么', 'danger'); sheet.querySelector('#schTarget').focus(); return; }
          var plan = String(sheet.querySelector('#schPlan').value || '').trim() || '每个工作日 09:00';
          var data = { name: name, plan: plan, planShort: plan, target: target,
            team: sheet.querySelector('#schTeam').value, budget: Number(sheet.querySelector('#schBudget').value) || 0, enabled: enabled };
          if (sch) { for (var k in data) sch[k] = data[k]; }
          else S.schedules.push({ id: 's' + Date.now(), name: data.name, plan: data.plan, planShort: data.plan, target: data.target,
            team: data.team, budget: data.budget, owner: '林砚', next: '待定', last: '尚未运行', lastState: '待确认', enabled: data.enabled });
          close(); RF(); T('定时任务已保存：' + name);
        });
      }
    });
  }

  /* ---------------- 运行日志 ---------------- */
  function scheduleLog () {
    var logs = [
      { name: '每日站会', time: '今天 09:00', dur: '12 秒', cost: '¥0.42', state: '成功' },
      { name: '周报', time: '10-17 18:02', dur: '48 秒', cost: '¥1.86', state: '成功' },
      { name: '账本结算', time: '10-01 09:31', dur: '22 秒', cost: '¥0.24', state: '成功' }
    ];
    var body = '<div class="run-table">' + logs.map(function (l) {
      return '<div class="run-tr"><span class="run-mode">' + esc(l.name) + '</span><span>' + esc(l.time) + '</span>' +
        '<span>' + esc(l.dur) + '</span><span class="num">' + esc(l.cost) + '</span>' + badge(l.state) + '</div>';
    }).join('') + '</div>' + hint('日志来自本机运行记录，原型只展示最近 3 条；每次运行都会写进账本。');
    modal({
      eyebrow: '运行日志', title: '最近 3 次自动运行', body: body, size: 'sm',
      footer: '<button class="btn btn-quiet" data-sheet-close>关闭</button>'
    });
  }

  /* ---------------- 看板加任务 ---------------- */
  function addTask (colId) {
    var col = colById(colId);
    var body = field('任务标题', '<input id="taskTitle" type="text" placeholder="例如：补充导出失败态">') +
      '<p class="field-hint">' + icon('users', 'ico-xs') + '会加到「' + esc(col ? col.name : '待开始') + '」，认领人从当前编制里随机指定。</p>';
    modal({
      eyebrow: '看板', title: '添加任务', body: body, size: 'sm',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button><button class="btn btn-primary" id="taskAdd">添加</button>',
      onMount: function (sheet) {
        var input = sheet.querySelector('#taskTitle');
        function add () {
          var title = String(input.value || '').trim();
          if (!title) { T('任务标题不能为空', 'danger'); input.focus(); return; }
          var who = S.team.length ? S.team[Math.floor(Math.random() * S.team.length)].name : '待认领';
          S.board.push({ id: 'b' + Date.now(), col: colId || 'todo', title: title, who: who, dep: '—', token: '0.0k' });
          close(); RF(); T('已添加任务：' + title);
        }
        sheet.querySelector('#taskAdd').addEventListener('click', add);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
        input.focus();
      }
    });
  }

  window.MJModals = {
    dispatch: dispatch, recruit: recruit, employee: employee, member: member,
    artifact: artifact, task: task, runs: runs, connector: connector,
    schedule: schedule, scheduleLog: scheduleLog, addTask: addTask
  };
})();
