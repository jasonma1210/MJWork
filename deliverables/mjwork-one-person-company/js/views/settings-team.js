/* MJWork 原型 · 设置 · 团队空间（并发 / 编制 / 协同规则） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;

  function roster () {
    return '<div class="roster-preview">' + S.team.map(function (m) {
      return '<div class="roster-chip">' + U.avatar(m.name, { lead: m.lead, size: 'sm' }) +
        '<span><b>' + esc(m.name) + '</b><small>' + esc(m.role) + ' · ' + esc(m.status) + '</small></span></div>';
    }).join('') + '</div>';
  }

  function team () {
    var st = S.settings.team;
    return SS.section('并发与编制', '同一团队最多 20 人，统筹全局唯一；超出并发时按批次串行唤醒。',
      SS.row('同时执行人数', '并发越高越吃预算；探活失败会自动降档。',
        SS.select('teamConcurrency', st.concurrency, [
          { value: '1', name: '1 人（最省）' },
          { value: '2', name: '2 人（推荐）' },
          { value: '3', name: '3 人' },
          { value: '4', name: '4 人（激进）' }
        ], { label: '同时执行人数' })) +
      SS.row('单团队人数上限', '上限 20 人；新增成员超过上限时会拒绝并提示。',
        '<label class="set-num"><input id="teamMaxMembers" type="number" min="1" max="20" value="' + st.maxMembers + '"><span>人</span></label>' +
        '<button class="btn btn-quiet btn-sm" data-action="save-team">保存</button>', { stack: true }) +
      SS.row('同类型上限', '同一类型数字员工最多 2 人，避免角色重复占预算。',
        SS.select('teamTypeLimit', st.typeLimit, [
          { value: '1', name: '1 人' },
          { value: '2', name: '2 人' }
        ], { label: '同类型上限' }))) +
    SS.section('当前编制', S.team.length + ' 名成员 · ' + S.team.filter(function (m) { return m.lead; }).length + ' 名统筹',
      roster() +
      '<div class="set-actions"><span class="set-count">编制变更只影响后续任务，运行中的任务使用启动快照</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="open-roster">' + icon('arrow-right', 'ico-sm') + '查看编制</button></div>') +
    SS.section('协同规则', '这些规则不提供开关，属于产品底线。',
      '<ul class="set-rules">' +
        '<li><b>批次串行</b><span>每批任务完成后再唤醒下一批，跨成员依赖走 DAG，轮询只作为兜底。</span></li>' +
        '<li><b>探活撤员</b><span>每 5 秒探活一次，连续 3 次失败立即撤下成员并降低并发。</span></li>' +
        '<li><b>预算口径</b><span>成员可动用整组剩余额度；token 只做软告警，墙钟时间才是硬闸。</span></li>' +
        '<li><b>中断权限</b><span>你可中断任意对象；统筹可中断本团队成员但需留痕，成员只能中断自己的任务。</span></li>' +
      '</ul>');
  }

  SS.pages.team = team;
})();
