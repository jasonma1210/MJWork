/* MJWork 原型 · 交互运行时（document 事件委托 / 设置动作合并 / 顶栏弹层）
   看板拖拽已拆到 js/board-drag.js，设置动作为 MJSettingsActions 注册表。 */
(function () {
  'use strict';
  var U = window.MJUI, MJ = window.MJ, S = MJ.store, R = window.MJRouter;
  var bound = false, ecoTimer = null, navTimer = null, popHost = null, popBtn = null;
  /* 通用小工具 */
  function $ (id) { return document.getElementById(id); }
  function all (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function T (msg, tone) { if (window.MJApp) window.MJApp.toast(msg, tone); }
  function RF () { if (window.MJApp) window.MJApp.refresh(); }
  function K (name, arg) { var m = window.MJModals; if (m && typeof m[name] === 'function') m[name](arg); else T('这个弹层稍后接入', 'danger'); }
  function byId (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function top () { var w = $('viewwrap'); return w ? w.scrollTop : 0; }
  function setTop (v) { var w = $('viewwrap'); if (w) w.scrollTop = v; }
  /* 设置：动作表在 settings-runtime*.js 注册，这里只做合并调度 */
  function settingsAct (name) {
    var api = window.MJSettingsActions;
    return api && api.ACTIONS ? api.ACTIONS[name] : null;
  }
  /* 设置左侧导航按关键词过滤：直接改 DOM，避免输入时整页重渲染打断输入 */
  function applyNavFilter () {
    var nav = document.querySelector('.settings-nav-body'); if (!nav) return;
    var empty = $('settingsNavEmpty');
    var q = String(S.settingsQuery || '').trim().toLowerCase();
    var visible = 0;
    all('.settings-nav-group', nav).forEach(function (group) {
      var shown = 0;
      all('.settings-nav-item', group).forEach(function (item) {
        var kw = item.getAttribute('data-kw') || '';
        var hit = !q || (item.textContent + ' ' + kw).toLowerCase().indexOf(q) >= 0;
        item.hidden = !hit;
        if (hit) shown += 1;
      });
      group.hidden = shown === 0;
      visible += shown;
    });
    if (empty) empty.hidden = visible > 0;
  }
  /* 接单台：聚焦 / 模式 / 派单 */
  function focusGoal () {
    var g = $('deskGoal'); if (!g) { R.go('desk'); return; }
    g.focus(); try { g.setSelectionRange(g.value.length, g.value.length); } catch (e) { /* 忽略 */ } if (g.scrollIntoView) g.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function closeMode () { var p = $('deskModePop'), b = $('deskModeBtn'); if (p) p.setAttribute('hidden', ''); if (b) b.setAttribute('aria-expanded', 'false'); }
  function toggleMode () {
    var p = $('deskModePop'), b = $('deskModeBtn'); if (!p || !b) return;
    var open = p.hasAttribute('hidden'); if (open) p.removeAttribute('hidden'); else p.setAttribute('hidden', '');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function pickMode (el) {
    var m = byId(MJ.modes, el.getAttribute('data-mode')); if (!m) return;
    S.deskModeId = m.id; S.deskMode = m.name; closeMode(); RF(); T('这一单按「' + m.name + '」来干');
  }
  function openDir () { var p = byId(MJ.projects, MJ.currentProjectId) || MJ.projects[0]; T('项目目录：' + (p ? p.dir : '~/MJWork') + '（原型不打开 Finder）'); }
  function sendDesk () {
    var input = $('deskGoal'); if (!input) { R.go('desk'); return; }
    var text = String(input.value || '').trim();
    if (!text) { T('先写清楚这一单要做什么', 'danger'); input.focus(); return; }
    S.chat.goal = text; S.chat.mode = S.deskMode; S.chat.modeId = S.deskModeId;
    T('已派单，统筹开始拆解'); R.go('chat');
  }
  /* 对话：发送即追加气泡 */
  function sendChat () {
    var input = $('chatInput'), stream = $('chatStream'); if (!input || !stream) return;
    var text = String(input.value || '').trim(); if (!text) { input.focus(); return; }
    var row = document.createElement('div'); row.className = 'msg-user';
    row.innerHTML = U.avatar('老板', { size: 'sm' }) + '<div class="msg-bubble"><p>' + U.esc(text) + '</p>' +
      '<div class="msg-foot"><span>老板</span><time>刚刚</time></div></div>';
    stream.appendChild(row); input.value = '';
    var sc = $('chatScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
    input.focus(); T('消息已进入项目空间');
  }
  /* 审批：详情弹层 + 行内批准 / 拒绝 */
  function setApproval (id, status) { var a = byId(S.approvals, id); if (a) a.status = status; }
  function openApproval (el) {
    var a = byId(S.approvals, el.getAttribute('data-approval')); if (!a) return;
    var pending = a.status === 'pending';
    var body = '<div class="ai-head">' + U.icon(a.risk === '低' ? 'lock' : 'alert') + '<b>' + U.esc(a.level) + ' · ' + U.esc(a.risk) + '风险</b>' +
      '<span>' + U.esc(a.who) + ' · ' + U.esc(a.age) + '</span></div><p class="ai-title">' + U.esc(a.title) + '</p><p class="ai-text">' + U.esc(a.reason) + '</p>' +
      '<div class="ai-diff"><code>' + U.esc(a.files.join(' · ')) + '</code><span>' + U.esc(a.diff) + '</span></div>' +
      '<dl class="member-kv"><div><dt>项目</dt><dd>' + U.esc(a.project) + '</dd></div><div><dt>影响</dt><dd>' + U.esc(a.scope) + '</dd></div>' +
      '<div><dt>动作</dt><dd>' + U.esc(a.action) + '</dd></div><div><dt>状态</dt><dd>' + (pending ? '待你决定' : a.status === 'approved' ? '已批准' : '已拒绝') + '</dd></div></dl>' +
      '<p class="field-hint">' + U.icon('lock', 'ico-xs') + '批准只对本次生效；同样的操作下次仍会再问一次。</p>';
    var footer = pending ? '<button class="btn btn-quiet" data-action="inline-reject" data-approval="' + a.id + '">拒绝</button><button class="btn btn-primary" data-action="inline-approve" data-approval="' + a.id + '">批准本次</button>'
      : '<button class="btn btn-quiet" data-sheet-close>关闭</button>';
    window.MJApp.modal({ eyebrow: '审批 · ' + a.id, title: a.level + ' 风险变更', body: body, footer: footer, size: 'md' });
  }
  function inlineApprove (el) {
    setApproval(el.getAttribute('data-approval') || 'A-1042', 'approved'); S.chat.approvalStatus = 'approved';
    T('已批准，成员继续执行'); window.MJApp.closeModal(); RF();
  }
  function inlineReject (el) {
    setApproval(el.getAttribute('data-approval') || 'A-1042', 'rejected'); S.chat.approvalStatus = 'rejected';
    T('已拒绝，任务退回统筹'); window.MJApp.closeModal(); RF();
  }
  /* 项目空间：里程碑 / 记忆 / 成员轨迹 */
  function addMilestone () {
    var body = '<label class="field"><span>里程碑名称</span><input id="msName" type="text" placeholder="例如：导入向导联调完成"></label><p class="field-hint">' + U.icon('lock', 'ico-xs') + '新增节点默认未开始，完成后由统筹标记。</p>';
    window.MJApp.modal({
      eyebrow: '里程碑', title: '给项目加一个可验收的节点', body: body, size: 'sm',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button><button class="btn btn-primary" id="msAdd">添加里程碑</button>',
      onMount: function (sheet) {
        var input = sheet.querySelector('#msName'), submit = sheet.querySelector('#msAdd');
        function add () {
          var name = String(input.value || '').trim(); if (!name) { T('里程碑名称不能为空', 'danger'); input.focus(); return; }
          MJ.milestones.push({ name: name, state: 'todo', date: '11-01' }); window.MJApp.closeModal(); RF(); T('已新增里程碑：' + name);
        }
        submit.addEventListener('click', add); input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
        input.focus();
      }
    });
  }
  function toggleMemory (el) {
    var card = el.closest('.memory-card') || document.querySelector('.memory-card'); if (!card) return;
    var open = card.classList.toggle('is-open');
    el.innerHTML = (open ? '收起' : '展开全部') + U.icon('chevron-down', 'ico-sm');
  }
  function toggleTracks () { S.chat.tracksOpen = !S.chat.tracksOpen; RF(); }
  /* 生态中心：技能来源筛选 / 连接器策略 */
  function applySkillSource () {
    var rows = all('.skill-card .skill-row'); if (!rows.length) return;
    var source = S.skillSource || '全部';
    rows.forEach(function (row) {
      var src = row.querySelector('.skill-src');
      row.style.display = source === '全部' || (src && src.textContent.replace(/\s/g, '') === source) ? '' : 'none';
    });
    all('.eco-toolbar .chip').forEach(function (chip) {
      chip.classList.toggle('is-active', (chip.getAttribute('data-source') || '全部') === source);
    });
  }
  function skillToggle (el) {
    var skill = byId(MJ.skills, el.getAttribute('data-skill')); if (!skill) return;
    skill.enabled = !skill.enabled;
    var y = top(); RF(); setTop(y); window.requestAnimationFrame(function () { setTop(y); });
    T('已' + (skill.enabled ? '启用' : '停用') + '技能：' + skill.name);
  }
  function connectorPolicy () {
    var body = '<p class="lede">分层决定谁能不打招呼就启动。凭据只进本机钥匙串，原型不会真的发起调用。</p>' +
      '<div class="rules"><div class="rule"><b class="rule-pct">自动启动</b><span>白名单内、只读或低风险工具，统筹可直接调用，事后记账。</span></div>' +
      '<div class="rule"><b class="rule-pct">白名单</b><span>需要你在首次授权时勾选作用域；之后按项目复用。</span></div>' +
      '<div class="rule"><b class="rule-pct">手动</b><span>数据库、生产文件系统与发信类连接器；每次调用都要审批。</span></div></div>' +
      '<p class="field-hint">' + U.icon('lock', 'ico-xs') + '撤销授权会立即生效，正在运行的任务会在下一步停下。</p>';
    window.MJApp.modal({ eyebrow: '连接器策略', title: '三层权限，一条底线', body: body, size: 'sm', footer: '<button class="btn btn-quiet" data-sheet-close>知道了</button>' });
  }
  /* 定时任务 */
  function toggleSchedule (el) {
    var sch = byId(S.schedules, el.getAttribute('data-schedule')); if (!sch) return;
    sch.enabled = !sch.enabled; RF(); T('已' + (sch.enabled ? '启用' : '暂停') + '：' + sch.name);
  }
  function runSchedule (el) {
    var sch = byId(S.schedules, el.getAttribute('data-schedule')); if (!sch) return;
    sch.lastState = '成功'; sch.last = '刚刚 · 成功'; RF(); T('已开始运行：' + sch.name);
  }
  /* 首启向导：表单同步 / 步进 / 校验 */
  function onbState () { return window.MJApp && window.MJApp.onboarding ? window.MJApp.onboarding.state : null; }
  function syncOnboard () {
    var st = onbState(); if (!st) return;
    var name = $('onbName'), dir = $('onbDir'), goal = $('onbGoal'), tpl = $('onbTemplate');
    if (name) st.name = name.value; if (dir) st.dir = dir.value; if (goal) st.goal = goal.value; if (tpl) st.template = tpl.value;
  }
  function paintOnboard () { if (window.MJApp.onboarding) window.MJApp.onboarding.paint(); }
  function showOnbError (msg) { var box = $('onbStep3Error'); if (box) box.innerHTML = U.fieldError(msg); }
  function onbNext () {
    var st = onbState(); if (!st) return;
    syncOnboard();
    if (st.step === 2) {
      if (!String(st.name || '').trim()) { showOnbError('请输入项目名称'); return; }
      if (!String(st.dir || '').trim()) { showOnbError('请输入工作目录'); return; }
    }
    if (st.step >= 3) { window.MJApp.onboarding.finish(); return; }
    st.step += 1; paintOnboard();
  }
  function onbBack () { var st = onbState(); if (!st || st.step <= 0) return; syncOnboard(); st.step -= 1; paintOnboard(); }
  /* 顶栏弹层：公司切换 / 通知 */
  function closePopovers () {
    if (popHost && popHost.parentNode) popHost.parentNode.removeChild(popHost);
    if (popBtn) popBtn.setAttribute('aria-expanded', 'false');
    popHost = null; popBtn = null;
  }
  function openPopover (btn, kind, html) {
    closePopovers();
    var pop = document.createElement('div');
    pop.className = 'popover pop-' + kind; pop.setAttribute('data-pop', kind); pop.innerHTML = html;
    document.body.appendChild(pop);
    var rect = btn.getBoundingClientRect(), width = pop.offsetWidth || 260;
    pop.style.position = 'fixed'; pop.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    pop.style.top = (rect.bottom + 8) + 'px';
    pop.style.maxHeight = Math.max(160, window.innerHeight - rect.bottom - 24) + 'px'; pop.style.overflowY = 'auto';
    btn.setAttribute('aria-expanded', 'true'); popHost = pop; popBtn = btn;
    return pop;
  }
  function companyMenu (btn) {
    if (popHost && popHost.getAttribute('data-pop') === 'company') { closePopovers(); return; }
    var html = '<div class="popover-head"><b>切换公司</b><span>' + MJ.companies.length + ' 家</span></div>' +
      MJ.companies.map(function (c) {
        return '<button class="mode-option' + (c.id === S.companyId ? ' is-active' : '') + '" data-company="' + U.esc(c.id) + '">' +
          '<span class="mode-radio"></span><span class="mode-copy"><b>' + U.esc(c.name) + '</b><small>' + U.esc(c.meta) + '</small></span></button>';
      }).join('') +
      '<button class="mode-option" data-company-new="1"><span class="mode-radio"></span><span class="mode-copy"><b>新建公司</b><small>原型阶段只演示一家</small></span></button>';
    var pop = openPopover(btn, 'company', html);
    pop.addEventListener('click', function (e) {
      var item = e.target.closest('[data-company]');
      if (item) {
        var c = byId(MJ.companies, item.getAttribute('data-company'));
        if (c) {
          S.companyId = c.id; S.companyName = c.name;
          var name = $('companyName'), sub = $('companySub');
          if (name) name.textContent = c.name; if (sub) sub.textContent = c.meta;
          T('已切换到 ' + c.name + '（原型只切换标签）');
        }
        closePopovers(); return;
      }
      if (e.target.closest('[data-company-new]')) T('原型阶段不提供新建公司');
    });
  }
  function syncNotifyDot () {
    var dot = $('notifyDot'); if (!dot) return;
    dot.style.display = S.notifications.some(function (n) { return n.unread; }) ? '' : 'none';
  }
  function notifyMenu (btn) {
    if (popHost && popHost.getAttribute('data-pop') === 'notify') { closePopovers(); return; }
    var unread = S.notifications.filter(function (n) { return n.unread; }).length;
    var html = '<div class="popover-head"><b>通知</b><span>' + unread + ' 条未读</span></div>' +
      S.notifications.map(function (n) {
        return '<button class="decision-row' + (n.unread ? ' is-unread' : '') + '" data-notify="' + U.esc(n.id) + '">' +
          '<span class="decision-main"><b>' + U.esc(n.title) + '</b><small>' + U.esc(n.meta) + '</small></span>' + U.icon('chevron-right', 'ico-sm') + '</button>';
      }).join('');
    var pop = openPopover(btn, 'notify', html);
    pop.addEventListener('click', function (e) {
      var item = e.target.closest('[data-notify]'); if (!item) return;
      var n = byId(S.notifications, item.getAttribute('data-notify')); if (!n) return;
      n.unread = false; syncNotifyDot();
      var route = R.parse(n.route); closePopovers(); R.go(route.name, route.params); T('已打开通知');
    });
  }
  /* 动作表：data-action → 处理函数，未命中静默忽略 */
  var ACTIONS = {
    'focus-goal': focusGoal,
    'attach': function () { T('原型不接收附件；把目标写在输入框里就够了'); },
    'toggle-mode-pop': toggleMode,
    'pick-mode': pickMode,
    'go-chat': function () { R.go('chat'); }, 'go-ledger': function () { R.go('ledger'); },
    'go-artifacts': function () { R.go('studio', { tab: 'artifacts' }); },
    'go-roster': function () { R.go('studio', { tab: 'roster' }); },
    'open-dir': openDir,
    'go-settings': function (el) {
      var tab = el.getAttribute('data-tab');
      if (tab) S.settingsTab = tab;
      R.go('settings');
    },
    'open-dispatch': function () { K('dispatch'); },
    'open-recruit': function (el) { K('recruit', el.getAttribute('data-employee') || el.getAttribute('data-member') || ''); },
    'employee-recruit': function (el) { K('recruit', el.getAttribute('data-employee') || ''); },
    'employee-detail': function (el) { K('employee', el.getAttribute('data-employee')); },
    'member-detail': function (el) { K('member', el.getAttribute('data-member')); },
    'open-approval': openApproval,
    'inline-approve': inlineApprove, 'inline-reject': inlineReject,
    'add-milestone': addMilestone,
    'toggle-memory': toggleMemory,
    'toggle-tracks': toggleTracks,
    'pause-run': function () { T('已暂停，原型不真正中断运行'); }, 'board-refresh': function () { T('看板已刷新（原型数据不变）'); },
    'open-runs': function () { K('runs'); },
    'board-add': function (el) { K('addTask', el.getAttribute('data-col')); },
    'task-detail': function (el) { K('task', el.getAttribute('data-task')); },
    'art-view': function (el) { S.artifactsView = el.getAttribute('data-view'); RF(); },
    'open-artifact': function (el) { var id = el.getAttribute('data-artifact'); if (!id) { T('这件交付还没归档成工件'); return; } K('artifact', id); },
    'set-period': function (el) { S.ledgerPeriod = el.getAttribute('data-period'); RF(); },
    'export-settlement': function () { T('结算单已导出（原型模拟）'); },
    'eco-cat': function (el) { S.ecoCat = el.getAttribute('data-cat'); RF(); }, 'eco-clear': function () { S.ecoCat = '全部'; S.ecoQuery = ''; RF(); },
    'connector-layer': function (el) { S.connectorLayer = el.getAttribute('data-layer'); RF(); },
    'skill-filter': function (el) { S.skillSource = el.getAttribute('data-source') || '全部'; RF(); },
    'connector-detail': function (el) { K('connector', el.getAttribute('data-connector')); },
    'connector-policy': connectorPolicy,
    'skill-toggle': skillToggle,
    'toggle-schedule': toggleSchedule,
    'run-schedule': runSchedule,
    'edit-schedule': function (el) { K('schedule', el.getAttribute('data-schedule')); },
    'open-schedule': function () { K('schedule'); }, 'schedule-log': function () { K('scheduleLog'); },
    'onb-next': onbNext,
    'onb-back': onbBack, 'onb-skip': function () { window.MJApp.onboarding.finish(); },
    'onb-power': function (el) { var st = onbState(); syncOnboard(); st.power = el.getAttribute('data-value'); paintOnboard(); },
    'onb-team': function (el) { var st = onbState(); syncOnboard(); st.team = el.getAttribute('data-value'); paintOnboard(); }
  };
  /* 事件委托：click / input / change / keydown */
  function onClick (e) {
    var t = e.target; if (!t || !t.closest) return;
    if (t.closest('#deskSend')) { sendDesk(); return; }
    if (t.closest('#chatSend')) { sendChat(); return; }
    if (t.closest('.eco-toolbar .chip:not([data-action])')) { S.skillSource = '全部'; RF(); return; }
    var actionEl = t.closest('[data-action]');
    if (actionEl) {
      var name = actionEl.getAttribute('data-action');
      var fn = ACTIONS[name] || settingsAct(name);
      if (fn) { if (actionEl.tagName === 'A') e.preventDefault(); fn(actionEl, e); return; }
    }
    var card = t.closest('.bcard');
    var blocked = window.MJBoardDrag ? window.MJBoardDrag.isBlocked() : false;
    if (card && !blocked) { K('task', card.getAttribute('data-board-card')); return; }
    if (!t.closest('.mode-wrap')) closeMode();
    if (!t.closest('[data-pop]') && !t.closest('#companyBtn') && !t.closest('#notifyBtn')) closePopovers();
  }
  function onInput (e) {
    var t = e.target; if (!t || !t.id) return;
    if (t.id === 'ecoSearch') {
      S.ecoQuery = t.value; window.clearTimeout(ecoTimer);
      ecoTimer = window.setTimeout(function () {
        var y = top(); RF(); setTop(y);
        var input = $('ecoSearch');
        if (input) { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch (err) { /* 忽略 */ } }
      }, 220);
      return;
    }
    if (t.id === 'settingsSearch') {
      S.settingsQuery = t.value; window.clearTimeout(navTimer);
      navTimer = window.setTimeout(applyNavFilter, 160);
      return;
    }
    if (t.id === 'onbName' || t.id === 'onbDir' || t.id === 'onbGoal') syncOnboard();
  }
  function onChange (e) {
    var t = e.target; if (!t || !t.id) return;
    if (window.MJSettingsActions && window.MJSettingsActions.change(t)) return;
    if (t.id === 'deskModel') { S.deskModel = t.value; return; } if (t.id === 'deskBudget') { S.deskBudget = Number(t.value) || 0; return; }
    if (t.id === 'onbTemplate') syncOnboard();
  }
  function onKeydown (e) {
    var t = e.target, cmd = e.metaKey || e.ctrlKey;
    if (t && t.getAttribute && t.getAttribute('role') === 'switch' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); t.click(); return;
    }
    if (cmd && e.key === 'Enter' && $('deskGoal')) { e.preventDefault(); sendDesk(); return; }
    if (t && t.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); return; }
    if (e.key === 'Escape') { closeMode(); closePopovers(); }
  }
  /* 每次渲染后的钩子 */
  function afterRender () {
    closeMode(); closePopovers(); syncNotifyDot();
    if ($('board') && window.MJBoardDrag) window.MJBoardDrag.init();
    applySkillSource(); applyNavFilter();
  }
  function init () {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onClick); document.addEventListener('input', onInput);
    document.addEventListener('change', onChange); document.addEventListener('keydown', onKeydown);
  }
  window.MJInteractions = { init: init, afterRender: afterRender, companyMenu: companyMenu, notifyMenu: notifyMenu };
})();
