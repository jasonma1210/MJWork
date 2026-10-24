/* MJWork 原型 · 设置运行时（核心）
   统一处理设置页动作、select 变更与危险项二次确认；
   高危动作拆分在 settings-runtime-extra.js，避免单文件过长。 */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var R = window.MJRouter;
  var esc = U.esc;

  function T (msg, tone) { if (window.MJApp) window.MJApp.toast(msg, tone); }
  function RF () { if (window.MJApp) window.MJApp.refresh(); }
  function save () { MJ.saveSettings(); }
  function get (path) {
    return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, S.settings);
  }
  function set (path, value) {
    var parts = String(path).split('.');
    var node = S.settings;
    for (var i = 0; i < parts.length - 1; i++) node = node[parts[i]];
    node[parts[parts.length - 1]] = value;
  }
  function clone (value) { return JSON.parse(JSON.stringify(value)); }
  function byId (list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 危险操作确认：标题 + 说明 + 红色确认按钮，确认后才执行回调 */
  function confirmDanger (opts, onOk) {
    if (!window.MJApp) return;
    window.MJApp.modal({
      eyebrow: '危险操作', title: opts.title,
      body: '<p class="lede">' + opts.desc + '</p>' +
        '<p class="set-hint is-danger">' + U.icon('alert', 'ico-xs') + '<span>' +
        esc(opts.warn || '该操作会立即生效，正在运行的任务会在下一步停下。') + '</span></p>',
      size: 'sm',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button>' +
        '<button class="btn btn-danger" id="dangerOk">' + esc(opts.ok || '确认') + '</button>',
      onMount: function (sheet) {
        sheet.querySelector('#dangerOk').addEventListener('click', function () {
          window.MJApp.closeModal();
          onOk();
        });
      }
    });
  }

  function commit (msg) {
    save();
    RF();
    if (msg) T(msg);
  }

  var ACTIONS = {
    'settings-tab': function (el) {
      S.settingsTab = el.getAttribute('data-tab') || 'general';
      S.settingsQuery = '';
      RF();
      var wrap = document.getElementById('viewwrap');
      if (wrap) wrap.scrollTop = 0;
    },
    'set-option': function (el) {
      var key = el.getAttribute('data-key');
      var value = el.getAttribute('data-value');
      if (key === 'theme') {
        S.theme = value;
        window.MJApp.applyTheme(value);
        RF();
        return;
      }
      var apply = function () {
        set(key, value);
        commit(key === 'approvalMode' ? '审批档位已改为「' + (MJ.settingLabels.approval[value] || value) + '」'
          : key === 'sandboxPolicy' ? '沙箱策略已改为「' + (MJ.settingLabels.sandbox[value] || value) + '」'
            : '设置已更新');
      };
      if (!el.hasAttribute('data-danger')) { apply(); return; }
      confirmDanger({
        title: '确定放开这一层保护？',
        desc: key === 'approvalMode' ? '全自动执行后，成员不会再逐次询问。删除、迁移与密钥类操作也会直接执行。'
          : '不隔离会让成员读写工作区之外的路径，仅建议在一次性沙箱机器上使用。',
        ok: '仍然开启'
      }, apply);
    },
    'set-toggle': function (el) {
      var key = el.getAttribute('data-key');
      var next = !get(key);
      var apply = function () {
        set(key, next);
        commit((next ? '已开启：' : '已关闭：') + (el.getAttribute('aria-label') || key));
      };
      if (el.hasAttribute('data-danger') && next) {
        confirmDanger({
          title: '开启高权限能力？',
          desc: key === 'tools.shell' ? '执行命令属于 Terminal 类高权限能力，开启后仍受审批约束。'
            : 'computer use 会接管鼠标键盘，仅 macOS 可用，调用会逐次审批。',
          ok: '仍然开启'
        }, apply);
        return;
      }
      apply();
    },
    'set-accent': function (el) {
      var id = el.getAttribute('data-accent');
      S.settings.accent = id;
      window.MJApp.applyAccent(id);
      commit('强调色已切换');
    },
    'toggle-collapsed': function () {
      window.MJApp.setCollapsed(!S.collapsed);
      RF();
    },
    'revoke-rule': function (el) {
      var id = el.getAttribute('data-rule');
      S.settings.rules = S.settings.rules.filter(function (r) { return r.id !== id; });
      commit('已撤销授权，同类操作会重新逐次询问');
    },
    'open-eco-connectors': function () { S.ecoTab = 'connectors'; R.go('ecosystem', { tab: 'connectors' }); },
    'open-eco-skills': function () { S.ecoTab = 'skills'; R.go('ecosystem', { tab: 'skills' }); },
    'open-roster': function () { R.go('studio', { tab: 'roster' }); },
    'settings-skill': function (el) {
      var sk = byId(MJ.skills, el.getAttribute('data-skill'));
      if (!sk) return;
      sk.enabled = !sk.enabled;
      RF();
      T('已' + (sk.enabled ? '启用' : '停用') + '技能：' + sk.name);
    },
    'toggle-search': function (el) {
      var p = byId(S.settings.search.providers, el.getAttribute('data-provider'));
      if (!p) return;
      p.enabled = !p.enabled;
      commit('已' + (p.enabled ? '启用' : '停用') + '搜索：' + p.name);
    },
    'save-limits': function () {
      var fb = document.getElementById('searchFirstByte');
      var idle = document.getElementById('searchIdle');
      var total = document.getElementById('searchTotal');
      if (!fb || !idle || !total) return;
      var a = Number(fb.value), b = Number(idle.value), c = Number(total.value);
      if (!(a >= 1 && a <= 120)) { T('首字节需在 1–120 秒之间', 'danger'); fb.focus(); return; }
      if (!(b >= 5 && b <= 600)) { T('空闲需在 5–600 秒之间', 'danger'); idle.focus(); return; }
      if (!(c >= b && c <= 3600)) { T('总时长需不小于空闲且不超过 3600 秒', 'danger'); total.focus(); return; }
      S.settings.search.firstByte = a;
      S.settings.search.idle = b;
      S.settings.search.total = c;
      commit('超时设置已保存');
    }
  };

  /* select 变更：命中返回 true，未命中交回默认处理 */
  function change (t) {
    var id = t.id || '';
    if (id === 'setLang') {
      S.settings.locale = t.value;
      document.documentElement.lang = t.value;
      commit(t.value === 'zh-CN' ? '语言已切换为简体中文' : '已记录英文偏好，英文语言包随安装包提供');
      return true;
    }
    if (id === 'setMainModel') {
      S.settings.mainModel = t.value;
      var p = byId(S.settings.providers, t.value);
      commit('主模型已切换为 ' + (p ? p.name : t.value));
      return true;
    }
    if (id === 'tierCompact' || id === 'tierDecompose' || id === 'tierWorker') {
      set('tiers.' + id.replace('tier', '').toLowerCase(), t.value);
      commit('分档模型已更新');
      return true;
    }
    if (id === 'teamConcurrency' || id === 'teamTypeLimit') {
      set(id === 'teamConcurrency' ? 'team.concurrency' : 'team.typeLimit', Number(t.value));
      commit('团队规则已更新');
      return true;
    }
    if (id === 'memoryCap') {
      var cap = Number(t.value);
      if (!(cap >= 50 && cap <= 1000)) { T('个人层上限需在 50–1000 之间', 'danger'); t.value = S.settings.memory.cap; return true; }
      S.settings.memory.cap = cap;
      commit('容量上限已保存');
      return true;
    }
    if (id === 'searchFirstByte' || id === 'searchIdle' || id === 'searchTotal') {
      var hint = document.getElementById('limitsHint');
      if (hint) {
        hint.textContent = '当前 ' + document.getElementById('searchFirstByte').value + ' / ' +
          document.getElementById('searchIdle').value + ' / ' + document.getElementById('searchTotal').value + ' 秒';
      }
      return true;
    }
    return false;
  }

  window.MJSettingsRuntime = {
    T: T, RF: RF, save: save, get: get, set: set, clone: clone,
    byId: byId, confirmDanger: confirmDanger, commit: commit
  };
  window.MJSettingsActions = { ACTIONS: ACTIONS, change: change, confirmDanger: confirmDanger };
})();
