/* MJWork 原型 · 设置运行时（扩展）
   版本更新 / 服务商增删测 / Git 与 Hooks / 记忆 / 团队上限 / 恢复默认。
   依赖 settings-runtime.js 暴露的 helpers；本文件在 interactions.js 之前加载。 */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var RT = window.MJSettingsRuntime;
  var esc = U.esc;
  var T = RT.T, RF = RT.RF, save = RT.save, byId = RT.byId, confirmDanger = RT.confirmDanger, commit = RT.commit;

  function addProviderModal () {
    window.MJApp.modal({
      eyebrow: '模型服务商', title: '添加一个 OpenAI 兼容服务',
      body: '<div class="set-form">' +
        '<label class="field"><span>名称</span><input id="provName" type="text" placeholder="例如：本地 · Qwen3-32B"></label>' +
        '<label class="field"><span>Base URL</span><input id="provUrl" type="text" placeholder="https://api.example.com/v1"></label>' +
        '<label class="field"><span>API Key</span><input id="provKey" type="text" placeholder="本地服务留空"></label>' +
        '<div id="provError"></div>' +
        '<p class="set-hint">' + U.icon('lock', 'ico-xs') + '<span>Key 只写入本机钥匙串，界面只显示「已保存 / 未填」。</span></p></div>',
      size: 'sm',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button>' +
        '<button class="btn btn-primary" id="provAdd">添加服务商</button>',
      onMount: function (sheet) {
        var name = sheet.querySelector('#provName');
        var url = sheet.querySelector('#provUrl');
        var key = sheet.querySelector('#provKey');
        var err = sheet.querySelector('#provError');
        sheet.querySelector('#provAdd').addEventListener('click', function () {
          var n = String(name.value || '').trim();
          var u = String(url.value || '').trim();
          if (!n) { err.innerHTML = U.fieldError('服务商名称不能为空'); name.focus(); return; }
          if (!/^https?:\/\//.test(u)) { err.innerHTML = U.fieldError('Base URL 需以 http:// 或 https:// 开头'); url.focus(); return; }
          var filled = String(key.value || '').trim();
          S.settings.providers.push({
            id: 'prov-' + Date.now(), name: n, url: u,
            key: filled ? '已保存' : '未填', models: 1, state: filled ? '正常' : '需 Key'
          });
          window.MJApp.closeModal();
          commit('已添加服务商：' + n);
        });
        name.focus();
      }
    });
  }

  function addHookModal () {
    window.MJApp.modal({
      eyebrow: 'Hooks', title: '新增一条钩子',
      body: '<div class="set-form">' +
        '<label class="field"><span>名称</span><input id="hookName" type="text" placeholder="例如：写入前校验"></label>' +
        '<label class="field"><span>触发时机</span><select id="hookEvent">' +
          '<option value="preToolUse">preToolUse · 工具调用前</option>' +
          '<option value="postToolUse">postToolUse · 工具调用后</option></select></label>' +
        '<label class="field"><span>匹配工具</span><input id="hookMatch" type="text" placeholder="write_file|apply_patch"></label>' +
        '<label class="field"><span>执行命令</span><input id="hookCommand" type="text" placeholder="node ~/.mjwork/hooks/guard.js"></label>' +
        '<label class="field"><span>超时（毫秒）</span><input id="hookTimeout" type="number" min="200" max="60000" value="3000"></label>' +
        '<div id="hookError"></div></div>',
      size: 'sm',
      footer: '<button class="btn btn-quiet" data-sheet-close>取消</button>' +
        '<button class="btn btn-primary" id="hookAdd">添加钩子</button>',
      onMount: function (sheet) {
        var name = sheet.querySelector('#hookName');
        var cmd = sheet.querySelector('#hookCommand');
        var err = sheet.querySelector('#hookError');
        sheet.querySelector('#hookAdd').addEventListener('click', function () {
          var n = String(name.value || '').trim();
          var c = String(cmd.value || '').trim();
          if (!n) { err.innerHTML = U.fieldError('钩子名称不能为空'); name.focus(); return; }
          if (!c) { err.innerHTML = U.fieldError('执行命令不能为空'); cmd.focus(); return; }
          var timeout = Number(sheet.querySelector('#hookTimeout').value) || 3000;
          S.settings.hooks.push({
            id: 'h' + Date.now(), name: n,
            event: sheet.querySelector('#hookEvent').value,
            match: String(sheet.querySelector('#hookMatch').value || '').trim() || '*',
            timeout: Math.min(60000, Math.max(200, timeout)),
            command: c, enabled: true
          });
          window.MJApp.closeModal();
          commit('已添加钩子：' + n);
        });
        name.focus();
      }
    });
  }

  var EXTRA = {
    /* 版本更新 */
    'update-check': function () {
      var u = S.settings.update;
      if (u.state === 'checking' || u.state === 'installing') return;
      u.state = 'checking'; save(); RF();
      window.setTimeout(function () {
        var next = u.version === '0.1.0-beta' ? '0.1.1' : '';
        u.state = next ? 'ready' : 'latest';
        u.latest = next; u.lastCheck = '刚刚';
        save(); RF();
        T(next ? '发现新版本 v' + next : '已是最新版本');
      }, 1100);
    },
    'update-install': function () {
      var u = S.settings.update;
      if (u.state !== 'ready') return;
      u.state = 'installing'; save(); RF();
      window.setTimeout(function () {
        u.version = u.latest || '0.1.1';
        u.latest = ''; u.state = 'latest'; u.lastCheck = '刚刚';
        save(); RF();
        T('已更新到 v' + u.version + '（原型模拟，无需重启）');
      }, 1300);
    },

    /* 模型服务商 */
    'test-provider': function (el) {
      var p = byId(S.settings.providers, el.getAttribute('data-provider'));
      if (!p || p.state === '检测中') return;
      p.state = '检测中'; save(); RF();
      window.setTimeout(function () {
        p.state = p.key === '未填' ? '需 Key' : '正常';
        save(); RF();
        T(p.state === '正常' ? p.name + ' 连接正常' : p.name + ' 缺少 Key', p.state === '正常' ? '' : 'danger');
      }, 900);
    },
    'remove-provider': function (el) {
      var id = el.getAttribute('data-provider');
      var p = byId(S.settings.providers, id);
      if (!p) return;
      if (S.settings.providers.length <= 1) { T('至少保留一个服务商', 'danger'); return; }
      confirmDanger({
        title: '移除 ' + p.name + '？',
        desc: '移除后本机将不再加载它的模型；已产生的账本记录不会删除。',
        ok: '移除'
      }, function () {
        S.settings.providers = S.settings.providers.filter(function (x) { return x.id !== id; });
        if (S.settings.mainModel === id) S.settings.mainModel = S.settings.providers[0].id;
        MJ.tierSlots.forEach(function (slot) {
          if (S.settings.tiers[slot.id] === id) S.settings.tiers[slot.id] = '';
        });
        commit('已移除 ' + p.name);
      });
    },
    'add-provider': addProviderModal,

    /* Git 与 Hooks */
    'save-git': function () {
      var name = document.getElementById('gitName');
      var email = document.getElementById('gitEmail');
      if (!name || !email) return;
      var n = String(name.value || '').trim();
      var e = String(email.value || '').trim();
      if (!n) { T('Git 用户名不能为空', 'danger'); name.focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { T('邮箱格式不正确', 'danger'); email.focus(); return; }
      S.settings.git.name = n;
      S.settings.git.email = e;
      commit('Git 身份已保存');
    },
    'git-recheck': function () {
      S.settings.git.path = '/usr/bin/git';
      commit('Git 2.44.0 · 可用');
    },
    'gh-toggle': function () {
      S.settings.git.gh = S.settings.git.gh === '已登录' ? '未连接' : '已登录';
      commit(S.settings.git.gh === '已登录' ? 'GitHub 已连接' : '已退出 GitHub');
    },
    'hook-add': addHookModal,
    'toggle-hook': function (el) {
      var h = byId(S.settings.hooks, el.getAttribute('data-hook'));
      if (!h) return;
      h.enabled = !h.enabled;
      commit('钩子已' + (h.enabled ? '启用' : '暂停'));
    },
    'delete-hook': function (el) {
      var h = byId(S.settings.hooks, el.getAttribute('data-hook'));
      if (!h) return;
      confirmDanger({
        title: '删除钩子「' + h.name + '」？',
        desc: '删除后对应的校验或审计不再执行，直到你重新添加。',
        ok: '删除'
      }, function () {
        S.settings.hooks = S.settings.hooks.filter(function (x) { return x.id !== h.id; });
        commit('已删除钩子：' + h.name);
      });
    },

    /* 记忆 */
    'save-memory': function () {
      var input = document.getElementById('memoryCap');
      if (!input) return;
      var cap = Number(input.value);
      if (!(cap >= 50 && cap <= 1000)) { T('个人层上限需在 50–1000 之间', 'danger'); input.focus(); return; }
      S.settings.memory.cap = cap;
      commit('容量上限已保存');
    },
    'clear-memory': function () {
      confirmDanger({
        title: '清空全部项目记忆？',
        desc: '清空后成员将不再记得此前的约束与决策，需要重新在对话里确认。',
        ok: '清空'
      }, function () {
        S.memoryList = [];
        S.memorySessionCount = 0;
        RF();
        T('记忆已清空');
      });
    },
    'promote-memory': function (el) {
      var m = byId(S.memoryList, el.getAttribute('data-memory'));
      if (!m || m.longTerm) return;
      m.longTerm = true;
      RF();
      T('已晋升到个人层，其他项目也能召回');
    },
    'forget-memory': function (el) {
      var id = el.getAttribute('data-memory');
      S.memoryList = S.memoryList.filter(function (m) { return m.id !== id; });
      RF();
      T('已遗忘这条记忆');
    },

    /* 团队 */
    'save-team': function () {
      var input = document.getElementById('teamMaxMembers');
      if (!input) return;
      var n = Number(input.value);
      if (!(n >= 1 && n <= 20)) { T('单团队上限需在 1–20 之间', 'danger'); input.focus(); return; }
      S.settings.team.maxMembers = Math.round(n);
      commit('团队编制上限已保存');
    },

    /* 恢复默认 */
    'reset-settings': function () {
      confirmDanger({
        title: '恢复全部设置为默认？',
        desc: '语言、审批、沙箱、模型分档、搜索、Git、Hooks、记忆策略与团队上限都会重置；记忆条目与账本不受影响。',
        ok: '恢复默认'
      }, function () {
        S.settings = RT.clone(MJ.settingsDefaults);
        save();
        window.MJApp.applyAccent(S.settings.accent);
        window.MJApp.applyMotion(S.settings.reduceMotion);
        RF();
        T('设置已恢复默认');
      });
    }
  };

  Object.keys(EXTRA).forEach(function (key) {
    window.MJSettingsActions.ACTIONS[key] = EXTRA[key];
  });
})();
