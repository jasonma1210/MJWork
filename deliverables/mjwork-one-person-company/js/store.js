/* MJWork 原型 · 会话状态（localStorage 持久化 + 内存副本） */
(function () {
  'use strict';

  var MJ = window.MJ = window.MJ || {};

  function read (key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function write (key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* file:// 下允许失败 */ }
  }

  MJ.storage = { read: read, write: write };

  /* 设置是嵌套对象：默认值打底 + 本地快照覆盖，避免版本升级后新增项缺失 */
  function readJSON (key, fallback) {
    var raw = read(key, null);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function isPlain (v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function mergeDeep (base, patch) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (!isPlain(patch)) return out;
    Object.keys(patch).forEach(function (k) {
      if (!(k in base)) return; /* 只接受已登记的键，脏数据不落进状态 */
      out[k] = isPlain(base[k]) && isPlain(patch[k]) ? mergeDeep(base[k], patch[k]) : patch[k];
    });
    return out;
  }

  /* 员工数据分段加载完成后才会执行到这里（脚本顺序保证） */
  MJ.store = {
    theme: read('mjwork.theme', 'light'),
    collapsed: read('mjwork.collapsed', '0') === '1',
    onboarded: read('mjwork.onboarded', '0') === '1',
    companyId: 'polestar',
    companyName: '北极星工作室',
    ledgerPeriod: 'month',
    rosterTab: 'space',
    artifactsView: 'list',
    ecoTab: 'employees',
    ecoCat: '全部',
    ecoQuery: '',
    connectorLayer: 'all',
    team: MJ.team.slice(),
    approvals: MJ.approvals.map(function (a) {
      return Object.assign({}, a, { status: 'pending' });
    }),
    board: MJ.board.map(function (c) { return Object.assign({}, c); }),
    schedules: MJ.schedules.map(function (s) { return Object.assign({}, s); }),
    artifacts: MJ.artifacts.map(function (a) { return Object.assign({}, a); }),
    notifications: MJ.notifications.map(function (n) { return Object.assign({}, n); }),
    chat: {
      goal: MJ.runtime.goal,
      mode: '团队协作',
      modeId: 'team',
      projectId: 'crm',
      messages: [],
      tracksOpen: false,
      approvalStatus: 'pending'
    },
    deskMode: '自动',
    deskModeId: 'auto',
    deskModel: '本地 · Qwen3-32B',
    deskBudget: 80,
    hasRun: true,
    settingsTab: 'general',
    settingsQuery: '',
    settings: mergeDeep(MJ.settingsDefaults, readJSON('mjwork.settings', null)),
    memorySessionCount: 3,
    memoryList: MJ.memories.map(function (m, i) {
      return { id: 'm' + (i + 1), text: m.text, tag: m.tag, hits: m.hits, from: m.from, longTerm: i < 2 };
    })
  };

  MJ.persistOnboarded = function (value) {
    MJ.store.onboarded = value;
    write('mjwork.onboarded', value ? '1' : '0');
  };

  MJ.savePref = function (key, value) {
    write('mjwork.' + key, value);
  };

  /* 设置项变更后统一落库：所有入口（通用 / 外观 / 模型 / 生态 / 记忆 / 团队）共用 */
  MJ.saveSettings = function () {
    write('mjwork.settings', JSON.stringify(MJ.store.settings));
  };
})();
