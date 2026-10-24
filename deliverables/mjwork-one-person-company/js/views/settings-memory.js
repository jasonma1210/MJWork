/* MJWork 原型 · 设置 · 记忆（沉淀策略 / 分层计数 / 列表 / 晋升 / 清空） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function stats () {
    var global = S.memoryList.filter(function (m) { return m.longTerm; }).length;
    var project = S.memoryList.length - global;
    return { session: S.memorySessionCount, project: project, global: global };
  }

  function layers () {
    var s = stats();
    return '<div class="layer-stats">' +
      '<div><b>' + s.session + '</b><span>本次会话</span><small>会话结束自动清理</small></div>' +
      '<div><b>' + s.project + '</b><span>项目层</span><small>会话删除时晋升命中项</small></div>' +
      '<div><b>' + s.global + '</b><span>个人层</span><small>跨项目长期复用</small></div>' +
      '</div>';
  }

  function memoryRows () {
    if (!S.memoryList.length) return SS.empty('项目层还没有记忆。对话里确认过的事实、约束与决策会自动沉淀。');
    return '<div class="set-list">' + S.memoryList.map(function (m) {
      return '<div class="memory-row">' +
        '<div class="memory-main"><p>' + esc(m.text) + '</p>' +
          '<small><span class="badge badge-plain">' + esc(m.tag) + '</span> 命中 ' + m.hits + ' 次 · ' + esc(m.from) +
          (m.longTerm ? ' · 已晋升个人层' : '') + '</small></div>' +
        '<div class="memory-actions">' +
          (m.longTerm ? '' : '<button class="btn btn-quiet btn-sm" data-action="promote-memory" data-memory="' + esc(m.id) + '">晋升</button>') +
          '<button class="btn btn-quiet btn-sm" data-action="forget-memory" data-memory="' + esc(m.id) + '">遗忘</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  function pending () {
    var list = S.memoryList.filter(function (m) { return !m.longTerm && m.hits >= 3; });
    if (!list.length) return SS.empty('暂无待晋升条目。命中 ≥3 次的条目会出现在这里，由你确认后再写入个人层。');
    return '<div class="set-list">' + list.map(function (m) {
      return '<div class="set-list-row"><span class="set-list-main"><b>' + esc(m.text) + '</b>' +
        '<small>' + esc(m.tag) + ' · 命中 ' + m.hits + ' 次</small></span>' +
        '<button class="btn btn-ghost btn-sm" data-action="promote-memory" data-memory="' + esc(m.id) + '">晋升</button></div>';
    }).join('') + '</div>';
  }

  function memory () {
    var st = S.settings.memory;
    return SS.section('沉淀策略', '记忆只存事实与约束，不存对话原文；写入前会去掉密钥与个人信息。',
      layers() +
      SS.row('自动沉淀', '任务结束把确认过的约束、决策与风险写入项目层。',
        SS.toggle('memory.autoCapture', st.autoCapture, { label: '自动沉淀' })) +
      SS.row('团队对话自动沉淀', '团队协作中的共享结论写入团队记忆，供后续任务复用。',
        SS.toggle('memory.teamAuto', st.teamAuto, { label: '团队对话自动沉淀' })) +
      SS.row('团队共享', '开启后同一个团队的成员都能召回团队记忆；关闭则只有统筹可见。',
        SS.toggle('memory.teamSharing', st.teamSharing, { label: '团队共享' })) +
      SS.row('个人层容量上限', '超过上限时按命中次数与时间淘汰，不会静默丢最新条目。',
        '<label class="set-num"><input id="memoryCap" type="number" min="50" max="1000" step="10" value="' + st.cap + '"><span>条</span></label>' +
        '<button class="btn btn-quiet btn-sm" data-action="save-memory">保存</button>', { stack: true })) +
    SS.section('项目记忆', '与团队工作室「这个项目记得」共用同一份数据。',
      memoryRows()) +
    SS.section('待晋升', '提名制：团队记忆默认不自动晋升，避免专有约定污染其他项目。',
      pending()) +
    SS.section('危险区', '清空后无法恢复，但不会删除已产生的账本与工件。',
      '<div class="set-actions set-actions-danger"><span class="set-count">共 ' + S.memoryList.length + ' 条项目记忆</span>' +
      '<button class="btn btn-danger btn-sm" data-action="clear-memory">' + icon('alert', 'ico-sm') + '清空全部记忆</button></div>', 'is-danger');
  }

  SS.pages.memory = memory;
})();
