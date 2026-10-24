/* MJWork 原型 · 视图 · ecosystem */
(function () {
  'use strict';
  var U = window.MJUI;
  var MJ = window.MJ;
  var S = MJ.store;
  var C = window.MJCommon;
  var V = window.MJViews;
  var esc = U.esc;
  var icon = U.icon;
  var tabsUnder = C.tabsUnder;

  function ecosystem () {
    var tab = S.ecoTab;
    return '' +
      '<header class="eco-head">' +
        '<div><p class="eyebrow">生态中心</p><h2 class="display">66 名数字员工，77 个精选连接器，100 个技能。</h2>' +
        '<p class="lede">全部随包可用，离线也能跑。招募与授权只改本机配置，不会上传任何凭据。</p></div>' +
        '<div class="eco-stats"><span><b>66</b>数字员工</span><span><b>77</b>精选连接器</span><span><b>100</b>技能</span></div>' +
      '</header>' +
      '<nav class="tabs eco-tabs" aria-label="生态分类">' +
        tabsUnder({ employees: 0, connectors: 1, skills: 2 }[tab], 3) +
        '<a class="tab' + (tab === 'employees' ? ' is-active' : '') + '" href="#/ecosystem?tab=employees">数字员工<span class="tab-count">66</span></a>' +
        '<a class="tab' + (tab === 'connectors' ? ' is-active' : '') + '" href="#/ecosystem?tab=connectors">连接器<span class="tab-count">77</span></a>' +
        '<a class="tab' + (tab === 'skills' ? ' is-active' : '') + '" href="#/ecosystem?tab=skills">技能<span class="tab-count">100</span></a>' +
      '</nav>' +
      '<div class="eco-body">' +
        (tab === 'connectors' ? V.connectorsTab() : tab === 'skills' ? V.skillsTab() : V.employeesTab()) +
      '</div>';
  }

  V.ecosystem = ecosystem;
})();
