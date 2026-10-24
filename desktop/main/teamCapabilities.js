// 成员能力摘要（从 ipc/teams.js 抽出，2026-10-24）
//
// 为什么抽出来：`ipc/teams.js` 已在 800 行软档边缘（新增 teams:draftTeam 处理器会顶破），
// 而「成员有哪几种能力」是**纯函数**，被三处消费：
//   · ipc/teams.js 的既有 handlers（渲染层看「这人能干什么」）；
//   · ipc/teamsDraft.js 的覆盖度报告（需求要的能力有没有人扛）；
//   · 渲染层的草案卡片。
// 三处各写一份必然漂移（改了 read 的判定口径，草案卡片与实际成员展示会不一致）。
//
// 口径（与抽出前逐字等价，只**新增**了 plan）：
//   read    = 能读文件/列目录
//   write   = 能写文件/改文件
//   execute = 能执行命令
//   search  = 能搜内容/找文件
//   web     = 能联网检索/抓取
//   browser = 能操作内置浏览器
//   plan    = 能维护任务清单（纯状态工具，编排里体现为「会拆步骤、会跟踪」）
// 新增 plan 的理由：设计文档 §8.2 的 CoverageReport 能力键集合含 plan，
// 此前没有对应判定，缺口无法被看见。
'use strict';

/** 能力键的固定顺序（UI 展示与报告都按这个顺序，避免各处自行排序）。 */
const CAPABILITY_KEYS = ['read', 'write', 'execute', 'search', 'web', 'browser', 'plan'];

/**
 * 从引擎具体工具名算能力摘要（布尔位）。
 * @param {string[]|null} toolNames 引擎具体工具名（如 read_file / shell / web_search）
 * @returns {{read:boolean,write:boolean,execute:boolean,search:boolean,web:boolean,browser:boolean,plan:boolean,tools:string[]}}
 */
function capabilitiesOf(toolNames) {
  const s = new Set(Array.isArray(toolNames) ? toolNames : []);
  return {
    read: s.has('read_file') || s.has('list_dir'),
    write: s.has('write_file') || s.has('edit_file'),
    execute: s.has('shell'),
    search: s.has('grep') || s.has('glob'),
    web: s.has('web_search') || s.has('web_fetch'),
    browser: [...s].some((t) => String(t).startsWith('browser_')),
    plan: s.has('todo_write'),
    tools: [...s],
  };
}

module.exports = { capabilitiesOf, CAPABILITY_KEYS };
