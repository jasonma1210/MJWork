/* MJWork 原型 · 设置 · 通用（语言 / 粒度 / 沙箱 / 审批 / 规则 / 分档 / 更新） */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var SS = window.MJSettings;
  var esc = U.esc;
  var icon = U.icon;
  var L = MJ.settingLabels;

  function modelOptions () {
    return [{ value: '', name: '跟随主模型' }].concat(S.settings.providers.map(function (p) {
      return { value: p.id, name: p.name };
    }));
  }

  function rulesBlock (st) {
    if (!st.rules.length) return SS.empty('暂无始终允许的规则。审批弹窗里选择「始终允许」后会登记在这里。');
    return '<div class="set-list">' + st.rules.map(function (r) {
      return '<div class="set-list-row">' +
        '<span class="rule-badge">' + esc(r.level) + '</span>' +
        '<span class="set-list-main"><b>' + esc(r.label) + '</b><small>' + esc(r.scope) + '</small></span>' +
        '<button class="btn btn-quiet btn-sm" data-action="revoke-rule" data-rule="' + esc(r.id) + '">撤销</button>' +
        '</div>';
    }).join('') + '</div>' +
      '<p class="set-hint">' + icon('lock', 'ico-xs') + '<span>撤销后同类操作会重新逐次询问；正在运行的任务会在下一步停下。</span></p>';
  }

  function updateBlock (st) {
    var u = st.update;
    var stateText = u.state === 'checking' ? '正在检查…'
      : u.state === 'installing' ? '正在安装…'
        : u.state === 'ready' ? '发现新版本 v' + (u.latest || '0.1.1')
          : u.state === 'latest' ? '已是最新 · ' + u.lastCheck
            : '上次检查 ' + u.lastCheck;
    var btn = u.state === 'ready'
      ? '<button class="btn btn-primary btn-sm" data-action="update-install">' + icon('download', 'ico-sm') + '下载并安装</button>'
      : (u.state === 'checking' || u.state === 'installing')
        ? '<button class="btn btn-ghost btn-sm" disabled>' + esc(u.state === 'checking' ? '检查中…' : '安装中…') + '</button>'
        : '<button class="btn btn-ghost btn-sm" data-action="update-check">' + icon('refresh', 'ico-sm') + '检查更新</button>';
    return '<div class="update-line"><div class="update-main">' +
      '<b>MJWork ' + esc(u.version) + '</b><small>' + esc(stateText) + '</small></div>' +
      '<div class="update-actions">' + btn + '</div></div>';
  }

  function general () {
    var st = S.settings;
    var approvalHint = st.approvalMode === 'never'
      ? SS.hint('全自动执行：成员不会再逐次询问，删除、迁移与密钥类操作也会直接执行。仅在受控环境使用。', 'danger')
      : SS.hint('按需审批只拦下中高风险操作；低风险的读取与草稿会自动放行。');
    var sandboxHint = st.sandboxPolicy === 'full-access'
      ? SS.hint('不隔离：成员可以读写工作区之外的路径。建议只在一次性沙箱机器上使用。', 'danger')
      : SS.hint('工作区可写：默认只能改项目目录，越过目录的写入需要审批。');

    return SS.section('通用', '语言、输出粒度、沙箱与审批，是每次派单都会用到的口径。',
      SS.row('界面语言', '仅提供简体中文与英文两套语言包，切换后立即生效。',
        SS.select('setLang', st.locale, [
          { value: 'zh-CN', name: '简体中文' },
          { value: 'en-US', name: 'English（随安装包）' }
        ], { label: '界面语言' })) +
      SS.row('任务结束输出', '决定统筹汇报的详略；只改提示词，不做事后改写。',
        SS.seg('responseStyle', st.responseStyle, [
          { value: 'concise', name: '精简' },
          { value: 'default', name: '默认' },
          { value: 'detailed', name: '详细' }
        ])) +
      SS.row('沙箱隔离', '决定成员能碰到的文件范围。',
        SS.seg('sandboxPolicy', st.sandboxPolicy, [
          { value: 'read-only', name: '只读' },
          { value: 'workspace-write', name: '工作区可写' },
          { value: 'full-access', name: '不隔离', danger: true }
        ]), { stack: true, danger: st.sandboxPolicy === 'full-access', note: sandboxHint }) +
      SS.row('审批档位', '决定成员在什么情况下需要先问你。',
        SS.seg('approvalMode', st.approvalMode, [
          { value: 'on-request', name: '按需审批' },
          { value: 'auto-safe', name: '安全动作放行' },
          { value: 'always', name: '每次都问' },
          { value: 'never', name: '全自动执行', danger: true }
        ]), { stack: true, note: approvalHint }) +
      SS.row('审批通知', '需要你决定时，同时发一条桌面通知；通知里可直接批准或拒绝。',
        SS.toggle('approvalNotice', st.approvalNotice, { label: '审批通知' })) +
      SS.row('大任务自动拆分', '目标超过一个交付面时，统筹先拆成有验收标准的任务再执行。',
        SS.toggle('autoDecompose', st.autoDecompose, { label: '大任务自动拆分' }))
    ) +
    SS.section('已授权规则', '选择「始终允许」后，同类操作不再逐次询问。',
      rulesBlock(st)) +
    SS.section('任务分档模型', '把不同环节交给合适的模型，省下来的钱会计入账本。',
      MJ.tierSlots.map(function (slot) {
        return SS.row(slot.name, slot.id === 'compact' ? '上下文压缩：长会话收口时使用。'
          : slot.id === 'decompose' ? '任务拆解：统筹把目标拆成可验收任务时使用。'
            : '后台 Worker：成员执行具体任务时使用。',
          SS.select('tier' + slot.id.charAt(0).toUpperCase() + slot.id.slice(1), st.tiers[slot.id], modelOptions(), { label: slot.name }));
      }).join('')) +
    SS.section('版本更新', '当前 ' + esc(st.update.version) + ' · ' + esc(st.update.channel) + ' 通道。',
      SS.row('更新通道', '稳定版只收经过验收的构建；测试版可以提前拿到新能力。',
        SS.seg('update.channel', st.update.channel, [
          { value: 'stable', name: '稳定版' },
          { value: 'beta', name: '测试版' }
        ])) +
      SS.row('版本', '更新在后台下载，完成后提示你重启。', updateBlock(st), { stack: true }));
  }

  SS.pages.general = general;
})();
