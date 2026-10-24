/* MJWork 原型 · 视图 · chat */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var L = MJ.settingLabels;

  function chat () {
    var c = S.chat;
    var tracks = MJ.chatTracks.map(function (t) {
      return '<div class="track-row">' +
        U.avatar(t.who, { size: 'sm', lead: t.role === '统筹' }) +
        '<div class="track-main"><div class="track-name"><b>' + esc(t.who) + '</b><span>' + esc(t.role) + '</span>' +
        (t.state === 'running' ? '<span class="track-state running"><i class="breath"></i>执行中</span>' :
          t.state === 'waiting' ? '<span class="track-state waiting">等待审批</span>' :
            '<span class="track-state done">已汇报</span>') + '</div>' +
        '<div class="track-chain">' + t.steps.map(function (s, i) {
          return '<span class="' + (i === t.steps.length - 1 ? 'last' : '') + '">' + esc(s) + '</span>';
        }).join(icon('chevron-right', 'ico-xs')) + '</div></div></div>';
    }).join('');

    var arts = S.artifacts.slice(0, 3).map(function (a) {
      return '<button class="chat-art" data-action="open-artifact" data-artifact="' + a.id + '">' +
        '<span class="art-type">' + esc(a.type) + '</span>' +
        '<span class="art-main"><b>' + esc(a.name) + '</b><small>' + esc(a.owner) + ' · ' + esc(a.updated) + '</small></span>' +
        '<code>' + esc(a.version) + '</code>' + icon('eye', 'ico-sm') +
      '</button>';
    }).join('');

    var approvalBlock = S.settings.approvalMode === 'never'
      ? '<div class="approval-inline is-auto"><div class="ai-head">' + icon('shield') + '<b>全自动执行 · 不再逐次询问</b><span>' + esc(L.approval.never) + '</span></div>' +
        '<p class="ai-text">本单的中高风险操作（删除、迁移、密钥）也会直接执行。要恢复逐次确认，去设置改回按需审批。</p>' +
        '<div class="ai-actions"><button class="link-btn" data-action="go-settings" data-tab="general">到设置改审批档位</button></div></div>'
      : c.approvalStatus === 'approved'
      ? '<div class="approval-inline is-approved"><div class="stamp">已批准</div><div class="ai-head">' + icon('check') + '<b>审批已通过</b><span>' + esc('A-1042') + '</span></div><p class="ai-text">周行继续执行，变更已写入工作区。</p></div>'
      : c.approvalStatus === 'rejected'
        ? '<div class="approval-inline is-rejected"><div class="stamp stamp-rejected">已拒绝</div><div class="ai-head">' + icon('close') + '<b>审批已拒绝</b><span>' + esc('A-1042') + '</span></div><p class="ai-text">周行已停下这一步，工作区未发生改动；你可以补充说明后重新派单。</p></div>'
        : '<div class="approval-inline" id="inlineApproval">' +
          '<div class="ai-head">' + icon('lock') + '<b>需要你决定 · L1 低风险</b><span>周行 · 6 分钟前</span></div>' +
          '<p class="ai-title">修改 .env.example，新增 STRIPE_WEBHOOK_SECRET 占位</p>' +
          '<p class="ai-text">只写入占位符，不触碰真实密钥；影响 3 个部署配置。' +
            (S.settings.approvalMode === 'auto-safe' ? '当前档位为「安全动作放行」，本次属于需询问的高风险写入。' : '') + '</p>' +
          '<div class="ai-diff"><code>.env.example</code>' + U.diff(2, 0) + '<code>docs/deploy.md</code>' + U.diff(0, 0) + '</div>' +
          '<div class="ai-actions"><button class="btn btn-primary btn-sm" data-action="inline-approve">批准本次</button>' +
          '<button class="btn btn-quiet btn-sm" data-action="inline-reject">拒绝</button>' +
          '<button class="link-btn" data-action="open-approval" data-approval="A-1042">看完整风险</button></div>' +
        '</div>';

    return '' +
      '<div class="chat-view">' +
        '<header class="chat-head">' +
          '<div class="chat-title"><p class="eyebrow">' + esc(MJ.runtime.project) + ' · 09:32 开始</p>' +
            '<h2>线索导入流程重做</h2></div>' +
          '<div class="chat-meta">' +
            '<button class="meta-chip is-action" data-action="go-settings" data-tab="general" title="审批档位 · 点击修改">' +
              icon('shield') + esc(L.approval[S.settings.approvalMode]) + '</button>' +
            '<button class="meta-chip is-action" data-action="go-settings" data-tab="general" title="沙箱策略 · 点击修改">' +
              icon('lock') + esc(L.sandbox[S.settings.sandboxPolicy]) + '</button>' +
            '<button class="meta-chip is-action" data-action="go-settings" data-tab="general" title="输出粒度 · 点击修改">' +
              icon('file') + esc(L.style[S.settings.responseStyle]) + '</button>' +
            '<span class="meta-chip">' + icon('users') + '团队协作 · ' + MJ.runtime.people + ' 人</span>' +
            '<span class="meta-chip">本次 <b>¥' + MJ.runtime.cost.toFixed(2) + '</b></span>' +
            '<button class="btn btn-ghost btn-sm" data-action="open-runs">运行记录' + icon('list', 'ico-sm') + '</button>' +
          '</div>' +
        '</header>' +

        '<div class="chat-scroll" id="chatScroll">' +
          '<div class="chat-stream" id="chatStream">' +
            '<div class="msg-user">' + U.avatar('老板', { size: 'sm' }) +
              '<div class="msg-bubble"><p>' + esc(c.goal) + '</p>' +
              '<div class="msg-foot"><span>老板</span><time>09:32</time></div></div>' +
            '</div>' +

            '<div class="sysbar"><span class="sys-ico">' + icon('check') + '</span><b>已拆解</b><span>6 个任务 · 2 个批次</span><em>规则：多角色交付 v3</em><time>09:32</time></div>' +

            '<article class="coord-card">' +
              '<div class="coord-head">' + U.avatar('林砚', { lead: true, size: 'sm' }) +
                '<div><b>林砚</b><span>统筹 · 已汇总 5 人进度</span></div>' +
                '<span class="coord-state"><i class="breath"></i>批次 2 执行中</span>' +
              '</div>' +
              '<p class="coord-summary">第一批 3 个任务已完成：需求范围、字段盘点、竞品拆解。第二批由许清补验收标准、沈墨出导入向导、周行写接口契约；迁移脚本卡在 L2 审批。整体预算 ¥80，已用 ¥4.86。</p>' +
              '<div class="coord-stats"><span><b>3</b> 件已验收</span><span><b>2</b> 个任务进行中</span><span><b>1</b> 个等待审批</span><span><b>62%</b> 预算进度</span></div>' +
              '<button class="coord-toggle" data-action="toggle-tracks" aria-expanded="' + (c.tracksOpen ? 'true' : 'false') + '">' +
                '<span>' + (c.tracksOpen ? '收起成员轨迹' : '展开成员轨迹') + '</span>' + icon('chevron-down', 'ico-sm coord-caret' + (c.tracksOpen ? ' is-open' : '')) + '</button>' +
              '<div class="track-list' + (c.tracksOpen ? ' is-open' : '') + '">' + tracks + '</div>' +
            '</article>' +

            '<div class="art-block">' +
              '<div class="art-block-head"><span>' + icon('file') + '本批次产出 3 件</span><button class="link-btn" data-action="go-artifacts">全部工件' + icon('arrow-right', 'ico-sm') + '</button></div>' +
              arts +
            '</div>' +

            approvalBlock +

            '<div class="sysbar new"><span class="sys-ico">' + icon('refresh') + '</span><b>批次 2 已唤醒</b><span>沈墨、周行 开始执行</span><span class="live-mini"><i class="breath"></i>运行中</span><time>10:52</time></div>' +
          '</div>' +
        '</div>' +

        '<div class="composer' + (c.tracksOpen ? ' composer-raised' : '') + '">' +
          '<div class="composer-box">' +
            '<textarea id="chatInput" rows="1" placeholder="继续交代，或补充约束…"></textarea>' +
            '<div class="composer-tools">' +
              '<button class="tool-btn" data-action="attach">' + icon('paperclip') + '附件</button>' +
              '<span class="composer-mode">' + icon('users') + esc(c.mode) + '</span>' +
              '<span class="composer-hint">⌘↵ 派单</span>' +
              '<button class="btn btn-primary btn-sm" id="chatSend">发送' + icon('send', 'ico-sm') + '</button>' +
            '</div>' +
          '</div>' +
          '<p class="composer-note">' + (S.settings.approvalMode === 'never'
            ? '当前全自动执行：本单不会停下询问，删除、迁移与密钥操作也会直接执行。'
            : '消息会进入当前项目空间；涉及删除、迁移与密钥的操作会先问你。') + '</p>' +
        '</div>' +
      '</div>';
  }

  V.chat = chat;
})();
