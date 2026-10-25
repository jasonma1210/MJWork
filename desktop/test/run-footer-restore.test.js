// 运行结束信息条（RunFooter）恢复测试
//
// 事故背景（2026-10-15 真机）：一次 30 轮 / 1027s / 675,525 tokens 的运行正常收尾，
// 但消息区底部完全没有「运行结束 耗时… 共消耗…」那条，只有单条消息的 meta 小字。
//
// 根因：ChatArea 的会话切换 effect 里有一句早退
//     if (isCreatingThread) return;
// 它把**全部**恢复逻辑一并跳过——包括 setRunSummary。而 isCreatingThread 的语义是
// 「thread.id 从空变成非空」，除了真的新建会话，还匹配「activeThread 曾被置空、又切回
// 同一个会话」；而 activeThread 变 null 是常规操作：
//   ① ⌘N 新建会话 → setActiveThread(null)
//   ② 新建任务未选目录 → onAutoProject → App.selectProject → setActiveThread(null)
// 于是「切走 → 运行在后台跑完 → 切回」时：完成消息经补挂逻辑正常显示（所以有 meta 行），
// 但 setRunSummary 被吞掉（所以没有结束条）——正好是「第二行有、第三行没有」的症状。
//
// 本测试锁住修复后的结构：运行快照无条件恢复；只有会话级状态清理保留守卫。
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A10 守卫辅助：去除 JS 行/块注释，仅保留「生效」源码，用于判断 token 是否真正参与执行。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'components', 'ChatArea.jsx'), 'utf8');

// ── T3-2 i18n 适配 helper ──
// RunFooter 文案已抽取到 zh-CN 语言包（MessageStream.tsx 内译函数别名为 tr），
// 断言改为两段式：① 文案值在 zh-CN/<mod>.json 对应 key 上；② 组件源码引用该 key
function zhValue(mod, keyPath) {
  let o = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'i18n', 'locales', 'zh-CN', mod + '.json'), 'utf8'));
  for (const seg of keyPath.split('.')) o = o == null ? undefined : o[seg];
  return typeof o === 'string' ? o : '';
}

// 定位「运行保活」恢复块：从 registry 读取到 effect 依赖数组为止
const blockStart = src.indexOf('const rs = thread?.id != null ? runRegistry.get(String(thread.id)) : null;');
check('找到运行快照恢复块', blockStart > 0);
const restoreBlock = blockStart > 0 ? src.slice(blockStart, src.indexOf('}, [thread?.id]);', blockStart)) : '';

// ── 核心回归：不得再有无条件早退 ──
check('不存在无条件的 isCreatingThread 早退（本次事故的直接原因）',
  !/\n\s*if \(isCreatingThread\) return;/.test(src),
  '一旦回归，切回会话时结束条会再次消失');

// ── setRunSummary 必须在恢复块内、且不被任何守卫包裹 ──
check('恢复块内含 setRunSummary', /setRunSummary\(rs\?\.done \? rs\.runSummary : null\)/.test(restoreBlock));
const summaryIdx = restoreBlock.indexOf('setRunSummary(');
const guardIdx = restoreBlock.indexOf('if (!isCreatingThread) {');
check('setRunSummary 位于 isCreatingThread 守卫之前（即无条件执行）',
  summaryIdx > 0 && (guardIdx === -1 || summaryIdx < guardIdx),
  `setRunSummary@${summaryIdx}, guard@${guardIdx}`);
check('isCreatingThread 只包裹会话级状态清理（plan / planReport / planMode）', (() => {
  if (guardIdx === -1) return false;
  const guarded = restoreBlock.slice(guardIdx, restoreBlock.indexOf('}', guardIdx) + 1);
  const hasPlan = /setPlan\(null\)/.test(guarded)
    && /setPlanReport\(null\)/.test(guarded)
    && /setPlanMode\(false\)/.test(guarded);
  // 守卫块内不得再出现 setRunSummary（否则又会被吞掉）
  return hasPlan && !/setRunSummary/.test(guarded);
})());

// ── A10 守卫：setRunSummary 必须作为「去注释生效代码」落在恢复块内、且在 isCreatingThread 守卫之前 ──
// 旧检查只在恢复块文本内比对 token 存在+顺序，对「setRunSummary 被注释/挪出恢复块但仍残留在文本」
// 的回归是盲的（假绿）。这里剥离注释后断言 setRunSummary 真正作为生效代码落在恢复块内、且仍在守卫之前（无条件执行）。
{
  const restoreActive = stripJsComments(restoreBlock);
  const sumActive = restoreActive.indexOf('setRunSummary(');
  const guardActive = restoreActive.indexOf('if (!isCreatingThread) {');
  check('A10 守卫：setRunSummary 在去注释恢复块内、且位于 isCreatingThread 守卫之前（无条件）',
    sumActive > 0 && (guardActive === -1 || sumActive < guardActive));
}

// ── 其余快照同样无条件恢复（loading/流式/工具调用）──
for (const [name, re] of [
  ['loading', /setLoading\(!!rs\?\.inFlight\)/],
  ['流式文本', /setStreamingText\(rs\?\.inFlight \? \(rs\.streaming \|\| ''\) : ''\)/],
  ['推理文本', /setReasoningText\(rs\?\.inFlight \? \(rs\.reasoning \|\| ''\) : ''\)/],
  ['工具调用', /setToolCalls\(rs\?\.inFlight \? \[\.\.\.rs\.toolCalls\] : \[\]\)/],
]) {
  check(`${name} 在恢复块内无条件恢复`, re.test(restoreBlock));
}

// ── 事故链条的两端必须都还在（否则本测试的根因描述失效）──
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'App.jsx'), 'utf8');
check('App.selectProject 仍会置空 activeThread（事故链条入口）',
  /setActiveThread\(null\)/.test(appSrc));
// T2-2：send 流程（含自动建目录 onAutoProject）已拆出 hooks/useAgentRun.ts
const runHookSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'hooks', 'useAgentRun.ts'), 'utf8');
check('ChatArea 未选目录时仍走 onAutoProject（新建任务必触发）',
  /onAutoProject\?\.\(effectiveProject\)/.test(runHookSrc));

// ── 结束条本身：RunFooter 契约未变（T1-5 升级为 live/summary 双态「本轮概览」卡；
//    T2-2 实现与渲染随消息流域拆出 MessageStream.tsx，ChatArea 负责传入运行数据 props）──
const msSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'components', 'MessageStream.tsx'), 'utf8');
check('RunFooter 仍在消息区底部渲染（live 态接运行数据）',
  /<RunFooter[\s\S]{0,300}summary=\{runSummary\}/.test(msSrc) && /live=\{loading \? \{/.test(msSrc)
  && /runUsage=\{runUsage\}/.test(src) && /runStartedAt=\{runStartRef\.current\}/.test(src));
check('RunFooter 对 done 状态显示「运行结束」',
  zhValue('message', 'statusDone').includes('运行结束') && /label: tr\(['"]message\.statusDone['"]\)/.test(msSrc));
check('RunFooter 展示耗时（durationMs > 0）',
  zhValue('message', 'duration').includes('耗时') && /summary\.durationMs > 0 && <span>\{tr\(['"]message\.duration['"]/.test(msSrc));
check('RunFooter 展示共消耗 tokens',
  zhValue('message', 'totalTokens').includes('共消耗') && /tr\(['"]message\.totalTokens['"], \{ n: total\.toLocaleString\(\) \}\)/.test(msSrc));
check('RunFooter 无 summary 且非 live 时返回 null（空态不占位）', /if \(!summary && !live\) return null;/.test(msSrc));

// ── 完成消息补挂路径仍在（解释了「有 meta 行却没有结束条」）──
check('完成后切回会话仍补挂最终消息（meta 行的来源）',
  /rsDone\?\.done && rsDone\.finalMsg && !rsDone\.applied/.test(src));

// ── 仪表盘收尾上报存在（避免把 running 永久停在 true）──
const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'agent-core', 'index.js'), 'utf8');
check('引擎收尾时上报 running:false（仪表盘能显示「已结束」）',
  /running: false, budgetKind/.test(coreSrc));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
