/* MJWork 原型 · 视图 · onboarding */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;

  function onboarding (state) {
    var steps = ['接算力', '招人', '立项目', '派第一单'];
    var progress = steps.map(function (s, i) {
      return '<span class="onb-seg' + (i < state.step ? ' is-done' : i === state.step ? ' is-now' : '') + '"><i></i><em>0' + (i + 1) + ' ' + s + '</em></span>';
    }).join('');

    var powerCards = [
      { id: 'openai', name: 'OpenAI 兼容接口', meta: '推荐 · 用自己的密钥', desc: '把 MJWork 指向任意兼容端点，云端模型负责复杂交付。' },
      { id: 'ollama', name: '本地 Ollama', meta: '零出网 · 适合敏感项目', desc: '全部推理在本机完成，速度慢一些，但代码不出门。' },
      { id: 'later', name: '稍后配置', meta: '先看界面', desc: '可以先用离线模板体验，正式派单前再接入。' }
    ];
    var teamCards = [
      { id: 'founders', name: '创业专家团', meta: '5 人', people: ['林砚', '许清', '周行', '陈屿', '方岚'], desc: '战略、产品、工程、市场、财务，适合从 0 到 1。' },
      { id: 'delivery', name: '软件交付班组', meta: '4 人', people: ['林砚', '许清', '沈墨', '周行'], desc: '产品、设计、工程、测试，适合已有项目的迭代。' },
      { id: 'blank', name: '空白', meta: '0 人', people: [], desc: '不预置成员，等第一单来了再决定拉起谁。' }
    ];

    var stepsHtml = '' +
      '<section class="onb-step">' +
        '<p class="onb-eyebrow">01 · 接算力</p>' +
        '<h2>先把算力接上。</h2>' +
        '<p class="onb-lede">MJWork 不绑定模型。你可以用自己的密钥，也可以让所有活跑在本机。密钥只写进本机钥匙串，原型里不会真的发请求。</p>' +
        '<div class="choice-list">' + powerCards.map(function (c) {
          return '<button class="choice-card' + (state.power === c.id ? ' is-active' : '') + '" data-action="onb-power" data-value="' + c.id + '">' +
            '<span class="choice-radio"></span><span class="choice-copy"><span class="choice-title"><b>' + esc(c.name) + '</b><em>' + esc(c.meta) + '</em></span>' +
            '<small>' + esc(c.desc) + '</small></span></button>';
        }).join('') + '</div>' +
      '</section>' +

      '<section class="onb-step">' +
        '<p class="onb-eyebrow">02 · 招人</p>' +
        '<h2>先招一个小团队。</h2>' +
        '<p class="onb-lede">数字员工各有模型档位与工具权限。统筹只有一个，其他人可以随时增减。</p>' +
        '<div class="choice-list teams">' + teamCards.map(function (c) {
          return '<button class="choice-card' + (state.team === c.id ? ' is-active' : '') + '" data-action="onb-team" data-value="' + c.id + '">' +
            '<span class="choice-radio"></span><span class="choice-copy"><span class="choice-title"><b>' + esc(c.name) + '</b><em>' + esc(c.meta) + '</em></span>' +
            '<small>' + esc(c.desc) + '</small>' +
            '<span class="onb-stack">' + (c.people.length ? c.people.map(function (n) { return U.avatar(n, { size: 'xs', lead: n === '林砚' }); }).join('') : '<span class="stack-empty">暂不编入</span>') + '</span>' +
            '</span></button>';
        }).join('') + '</div>' +
      '</section>' +

      '<section class="onb-step">' +
        '<p class="onb-eyebrow">03 · 立项目</p>' +
        '<h2>给第一件事一个落脚点。</h2>' +
        '<p class="onb-lede">项目空间会记住目标、里程碑、工件与决策。目录只授予这个项目的读写权限。</p>' +
        '<div class="onb-form">' +
          '<label class="field"><span>项目名称</span><input id="onbName" type="text" value="' + esc(state.name) + '" placeholder="例如：北极星 CRM 重构"></label>' +
          '<label class="field"><span>工作目录</span><input id="onbDir" type="text" value="' + esc(state.dir) + '" placeholder="~/MJWork/项目名"></label>' +
          '<label class="field"><span>项目模板</span><select id="onbTemplate">' +
            '<option value="delivery"' + (state.template === 'delivery' ? ' selected' : '') + '>软件交付 · 含验收清单</option>' +
            '<option value="founders"' + (state.template === 'founders' ? ' selected' : '') + '>创业探索 · 含市场与财务</option>' +
            '<option value="blank"' + (state.template === 'blank' ? ' selected' : '') + '>空白项目</option>' +
          '</select></label>' +
          '<p class="field-hint">' + icon('lock', 'ico-xs') + '所有写入都限制在这个目录内；越界操作会先问你。</p>' +
          '<div id="onbStep3Error"></div>' +
        '</div>' +
      '</section>' +

      '<section class="onb-step">' +
        '<p class="onb-eyebrow">04 · 派第一单</p>' +
        '<h2>把第一句话说清楚。</h2>' +
        '<p class="onb-lede">目标越具体，统筹拆得越准。第一单会走完整个流程：拆解、派活、审批、验收、记账。</p>' +
        '<div class="onb-form">' +
          '<label class="field"><span>第一单目标</span><textarea id="onbGoal" rows="5">' + esc(state.goal) + '</textarea></label>' +
          '<div class="onb-summary">' +
            '<div><span>算力</span><b>' + (state.power === 'openai' ? 'OpenAI 兼容' : state.power === 'ollama' ? '本地 Ollama' : '稍后配置') + '</b></div>' +
            '<div><span>团队</span><b>' + (state.team === 'founders' ? '创业专家团 · 5 人' : state.team === 'delivery' ? '软件交付班组 · 4 人' : '空白') + '</b></div>' +
            '<div><span>项目</span><b>' + esc(state.name) + '</b></div>' +
          '</div>' +
          '<p class="field-hint">' + icon('lock', 'ico-xs') + '删除、迁移与密钥操作默认需要你审批。</p>' +
        '</div>' +
      '</section>';

    return '' +
      '<div class="onb">' +
        '<header class="onb-top">' +
          '<div class="onb-brand"><span class="brand-mark"><svg viewBox="0 0 24 24"><path d="M3 8h18M3 8v10h18V8M8 8V5h8v3"/><path d="M12 12v6"/></svg></span><b>MJWork</b><span>开张向导</span></div>' +
          '<div class="onb-segs" id="onbProgress">' + progress + '</div>' +
          '<button class="onb-skip" data-action="onb-skip">跳过，先看看</button>' +
        '</header>' +
        '<div class="onb-viewport">' +
          '<div class="onb-track" id="onbTrack" style="transform:translateX(-' + (state.step * 100) + '%)">' + stepsHtml + '</div>' +
        '</div>' +
        '<footer class="onb-foot">' +
          '<span class="onb-count" id="onbCount">0' + (state.step + 1) + ' / 04</span>' +
          '<div class="onb-actions">' +
            '<button class="btn btn-quiet" data-action="onb-back"' + (state.step === 0 ? ' disabled' : '') + '>上一步</button>' +
            '<button class="btn btn-primary" data-action="onb-next" id="onbNext">' + (state.step === 3 ? '开工，进入对话' : '下一步') + icon('arrow-right') + '</button>' +
          '</div>' +
        '</footer>' +
      '</div>';
  }

  V.onboarding = onboarding;
})();
