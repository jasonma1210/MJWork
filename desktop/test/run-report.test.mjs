#!/usr/bin/env node
// M7（2026-10-30）：事后任务报告回归（设计文档 §6.4）。
//
// 背景：任务结束后只剩一段正文可看。「为什么停」「验收做到几成」「花了多少」「审查怎么判」
// 原本散在 trace / 数据库 / 日志里，想统计成功率、想找出「哪类任务老被预算闸砍」无从下手。
//
// 本套件守四件事：
//   A. 字段齐全——四块（outcome / acceptance / resources / judges）一个都不能少；
//      缺 stopReason 时整份报告退化成一段废话，所以按名断言，不按个数断言；
//   B. 不冒充——未判定 (total=0) 时 verdict=null，绝不写成「已满足」；
//   C. 写失败不影响主流程——只读目录注入后不抛，运行照常结束；
//   D. 接线闭合——写盘点、打包清单、IPC、前端入口与双语文案都要在。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRunReport, writeRunReport, listRunReports, readRunReport, initRunReports,
  MAX_REPORT_FILES, REPORT_VERSION,
} from '../main/runReport.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mjreport-'));

// ── A. 字段齐全（§6.4 四块）──
const FINAL = { stopReason: 'total-cap', rounds: 7, toolCalls: 11, checkpointSaved: true, judgeTokens: 900, judgeCalls: 2, acTotal: 4, acSatisfied: 3 };
const USAGE = { prompt_tokens: 1000, completion_tokens: 200, lastPromptTokens: 640 };
const full = buildRunReport({
  runId: 'run-abc', conversationId: 'c1', model: 'deepseek-chat', final: FINAL, usage: USAGE,
  aborted: false, routeMode: 'plan', finalText: '结论正文', startedAt: 1000, endedAt: 61000,
});
check('① 版本 + 身份字段齐备', full.version === REPORT_VERSION && full.runId === 'run-abc' && full.model === 'deepseek-chat');
// 逐字段按名断言（不用 Object.keys().length：数量对得上不代表字段对）
check('② outcome 四字段（§6.4「是否命中熔断」）',
  full.outcome.stopReason === 'total-cap' && full.outcome.aborted === false
  && full.outcome.interrupted === true && full.outcome.checkpointSaved === true && full.outcome.routeMode === 'plan',
  JSON.stringify(full.outcome));
check('③ acceptance 四字段（§6.4「AC 完成清单」）',
  full.acceptance.total === 4 && full.acceptance.satisfied === 3 && full.acceptance.missing === 1 && full.acceptance.judged === true,
  JSON.stringify(full.acceptance));
check('④ resources 五字段（§6.4「资源消耗统计」）',
  full.resources.promptTokens === 1000 && full.resources.completionTokens === 200
  && full.resources.lastPromptTokens === 640 && full.resources.rounds === 7 && full.resources.toolCalls === 11,
  JSON.stringify(full.resources));
check('⑤ judges 三字段（§6.4「失败根因来自 Judge」）',
  full.judges.tokens === 900 && full.judges.calls === 2 && full.judges.verdict === 'partial',
  JSON.stringify(full.judges));
check('⑥ 耗时由起止时间算出（不是让调用方另算一遍）', full.durationMs === 60000, String(full.durationMs));

// ── B. 不冒充：未判定 / 完成 / 中止 的三种语义必须分得开 ──
const noJudge = buildRunReport({ runId: 'r2', final: { stopReason: '', acTotal: 0, acSatisfied: 0 }, usage: null });
check('⑦ total=0（无基线/未判定）⇒ judged=false 且 verdict=null（不写成「已满足」）',
  noJudge.acceptance.judged === false && noJudge.acceptance.satisfied === 0 && noJudge.judges.verdict === null,
  JSON.stringify(noJudge.judges));
const done = buildRunReport({ runId: 'r3', final: { stopReason: '', acTotal: 2, acSatisfied: 2 }, aborted: false });
check('⑧ 正常完成 ⇒ interrupted=false、verdict=satisfied',
  done.outcome.interrupted === false && done.judges.verdict === 'satisfied');
const abortedRun = buildRunReport({ runId: 'r4', final: { stopReason: '' }, aborted: true });
check('⑨ 用户中止 ⇒ interrupted=true 且 stopReason 仍为空（中止不等于「为什么停」）',
  abortedRun.outcome.interrupted === true && abortedRun.outcome.stopReason === '');
check('⑩ 缺 usage / 缺 final 都不抛（兜底收尾路径拿不到这些数）',
  buildRunReport({ runId: 'r5' }).resources.promptTokens === 0 && buildRunReport({}).runId === 'unknown');
check('⑪ runId 被清洗为安全文件名（防路径穿越）',
  buildRunReport({ runId: '../../etc/passwd' }).runId === '.._.._etc_passwd');

// ── C. 落盘 / 读回 / LRU ──
initRunReports(path.join(tmpRoot, 'a'));
const written = writeRunReport({ runId: 'run-1', model: 'm', final: FINAL, usage: USAGE, startedAt: 1, endedAt: 2, finalText: 'x' });
check('⑫ 落盘成功返回报告对象，文件真的存在',
  !!written && fs.existsSync(path.join(tmpRoot, 'a', 'reports', 'run-1.json')));
const back = readRunReport('run-1');
check('⑬ 读回内容与写入一致（JSON 可解析、字段不丢）',
  back?.outcome?.stopReason === 'total-cap' && back?.acceptance?.total === 4);
check('⑭ 读不存在的报告 ⇒ null（不抛）', readRunReport('nope') === null);

initRunReports(path.join(tmpRoot, 'b'));
writeRunReport({ runId: 'old', endedAt: 100, final: {} });
writeRunReport({ runId: 'new', endedAt: 300, final: { stopReason: 'rounds' } });
const list = listRunReports(5);
check('⑮ 列表按结束时间倒序（最近一次在最上面）',
  list.length === 2 && list[0].runId === 'new' && list[1].runId === 'old', list.map((r) => r.runId).join(','));
check('⑯ 列表只带摘要（tokens 已合并、不含正文）',
  list[0].interrupted === true && list[0].tokens === 0 && list[0].textTail === undefined,
  JSON.stringify(list[0]));
fs.writeFileSync(path.join(tmpRoot, 'b', 'reports', 'broken.json'), '{ 半截', 'utf8');
check('⑰ 坏报告被跳过而不是让整个列表变空（一条坏文件不该毁掉面板）',
  listRunReports(5).length === 2);

initRunReports(path.join(tmpRoot, 'c'));
for (let i = 0; i < MAX_REPORT_FILES + 3; i += 1) writeRunReport({ runId: `r${i}`, endedAt: i, final: {} });
const count = fs.readdirSync(path.join(tmpRoot, 'c', 'reports')).filter((f) => f.endsWith('.json')).length;
check(`⑱ 文件数按上限淘汰（≤ ${MAX_REPORT_FILES}，不无限增长）`, count <= MAX_REPORT_FILES, `存在 ${count} 份`);

// ── D. 写失败不影响主流程 ──
// 注入「目录存在但不可写」：必须只告警、返回 null、**不抛**。
// 为什么这条最重要：报告写在收尾流程里，它一抛，done 之后的所有收尾动作（用量记账、
// 排队接力）都会跟着断——那是拿一份复盘资料换掉运行结局。
const roDir = path.join(tmpRoot, 'readonly');
fs.mkdirSync(roDir, { recursive: true });
fs.chmodSync(roDir, 0o500);
initRunReports(roDir);
let threw = false;
let roResult = 'unset';
try { roResult = writeRunReport({ runId: 'ro', final: {} }); } catch { threw = true; }
fs.chmodSync(roDir, 0o700);
check('⑲ 只读目录 ⇒ 不抛、返回 null（写报告失败绝不改运行结局）', threw === false && roResult === null, String(roResult));
check('⑳ 无落盘位置（非 Electron / 未 init）⇒ 返回 null，不抛',
  (() => { initRunReports(null); try { return writeRunReport({ runId: 'x', final: {} }) === null; } catch { return false; } })());

// ── E. 接线闭合 ──
const runnerSrc = read('main', 'agentRunner.js');
const diagSrc = read('main', 'diagExport.js');
const preloadSrc = read('main', 'preload.js');
const uiSrc = read('renderer', 'src', 'components', 'RunReportsSection.tsx');
const settingsSrc = read('renderer', 'src', 'components', 'SettingsModal.jsx');
const zhSettings = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'zh-CN', 'settings.json'));
const enSettings = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'en-US', 'settings.json'));

check('㉑ 宿主在收尾写报告（带终态真值 + 用量 + 路由判定）',
  /runReport\.writeRunReport\(\{/.test(runnerSrc) && /final, usage, aborted, routeMode, finalText: outText, startedAt, endedAt: Date\.now\(\),/.test(runnerSrc));
check('㉒ 写盘点在 done 之后（报告晚于结果，不能挡在结果前面）',
  runnerSrc.indexOf("emit('done', {") < runnerSrc.indexOf('runReport.writeRunReport({'));
check('㉓ 诊断包收录运行报告（导出即复盘）', /reports\/\$\{f\}/.test(diagSrc) && /reportDir = path\.join\(userData, 'reports'\)/.test(diagSrc));
check('㉔ 列表 IPC + preload 桥都在（否则面板永远空）',
  /ipcMain\.handle\('diag:reports'/.test(diagSrc) && /diagReports: \(limit = 5\) => ipcRenderer\.invoke\('diag:reports', limit\)/.test(preloadSrc));
check('㉕ 前端区块已挂进设置页', /import RunReportsSection from '\.\/RunReportsSection'/.test(settingsSrc) && /<RunReportsSection \/>/.test(settingsSrc));
check('㉖ 面板：读不到 ≠ 没跑过（两态分开渲染）',
  /runReportsError/.test(uiSrc) && /runReportsEmpty/.test(uiSrc));
check('㉗ 面板：验收 total=0 显示「—」而不是 0/0（同 M5 口径）',
  /r\.acTotal > 0 \? t\('settings\.runReportAc'/.test(uiSrc) && /settings\.runReportAcNone/.test(uiSrc));
check('㉘ 双语齐备（14 个键）',
  ['runReports', 'runReportsDesc', 'runReportsEmpty', 'runReportsError', 'runReportsLoading',
    'runReportsRefresh', 'runReportsExport', 'runReportDone', 'runReportInterrupted',
    'runReportRounds', 'runReportAc', 'runReportAcNone', 'runReportTokens', 'runReportExportFailed']
    .every((k) => !!zhSettings[k] && !!enSettings[k]));

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
