// M7（2026-10-30）：事后任务报告（设计文档 §6.4）。
//
// 为什么需要：任务结束（完成 / 失败 / 熔断）之后，用户与我们都只有一段正文可看。
// 「这次为什么停」「验收做到几成」「花了多少」「审查怎么判」全部散在 trace / 数据库 / 日志里，
// 想统计成功率、想找出「哪种任务老是被预算闸砍」时无从下手。
//
// 落地形态：每次运行结束落一份结构化 JSON（userData/reports/<runId>.json），字段按 §6.4 四块：
//   outcome   是否熔断/中止、为什么停、有没有断点（对应「是否命中熔断、循环告警」）
//   acceptance AC 完成清单（total / satisfied / missing_count）
//   resources 资源消耗（tokens / 轮数 / 工具动作数 / 耗时）
//   judges    独立审查的账单与结论（失败根因的出处）
//
// 纪律（与 runTrace 同语义）：写失败只告警，**绝不影响运行主流程**；
// 目录按文件数 LRU 淘汰，默认保留最近 50 次；数据只在本机，不上报。

const MAX_REPORT_FILES = 50;
const REPORT_VERSION = 1;
const TEXT_TAIL_CHARS = 400;

let reportDir = null;

// 目录：允许显式注入（测试 / 自定义 userData），缺省从 electron 懒取。
// 为什么懒取：main.js 的行数棘轮已满额（见 test/max-lines.test.js 的基线清单），
// 这里少一次显式 init 就少一行接线，且语义上「报告目录」本就属于本模块的实现细节。
function dir() {
  if (reportDir) return reportDir;
  try {
    const { app } = require('electron');
    reportDir = `${app.getPath('userData')}/reports`.replace(/\/+/g, '/');
  } catch {
    // C-001：非 Electron 环境（单测 / CLI）没有 app 可取 —— 返回 null 表示「没有落盘位置」，
    // 调用方据此直接跳过（不是「写失败」，两者在返回值上分开：这里是 null，写失败是 false）。
    return null;
  }
  return reportDir;
}

function initRunReports(userDataPath) {
  reportDir = userDataPath ? `${userDataPath}/reports`.replace(/\/+/g, '/') : null;
}

function sanitizeRunId(runId) {
  return String(runId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

// 纯函数：把终态真值 + 用量装配成报告。抽成纯函数是为了能脱离文件系统断言「字段齐不齐」——
// 字段缺失是这份报告唯一的致命缺陷（少一个 stopReason，整份报告就退化成一段废话）。
function buildRunReport({
  runId = '', conversationId = '', model = '', final = null, usage = null,
  aborted = false, routeMode = '', finalText = '', startedAt = 0, endedAt = Date.now(),
} = {}) {
  const f = final || {};
  const stopReason = String(f.stopReason || '');
  const acTotal = Number(f.acTotal) || 0;
  const acSatisfied = Number(f.acSatisfied) || 0;
  return {
    version: REPORT_VERSION,
    runId: sanitizeRunId(runId),
    conversationId: String(conversationId || ''),
    model: String(model || ''),
    startedAt: Number(startedAt) || 0,
    endedAt: Number(endedAt) || 0,
    durationMs: startedAt ? Math.max(0, Number(endedAt) - Number(startedAt)) : 0,
    // ── §6.4 ① 是否命中熔断 / 为什么停 ──
    outcome: {
      // stopReason 取值见 agent-core/exhaustedNotice.js（'' = 正常完成；context/total-cap/
      // wallclock/rounds/repeat = 各类熔断与循环检测）
      stopReason,
      aborted: aborted === true,
      interrupted: stopReason !== '' || aborted === true,
      // 有断点 = 「继续」能接着跑；没有断点 = 用户只能重来（M2 的两态之分在这里落成字段）
      checkpointSaved: f.checkpointSaved === true,
      routeMode: String(routeMode || ''),
    },
    // ── §6.4 ② AC 完成清单 ──
    acceptance: {
      // 0 = 没有验收基线或 Judge 未判定（不是「一条都没做到」，两者必须能分开）
      total: acTotal,
      satisfied: acSatisfied,
      missing: Math.max(0, acTotal - acSatisfied),
      judged: acTotal > 0,
    },
    // ── §6.4 ③ 资源消耗 ──
    resources: {
      promptTokens: Number(usage?.prompt_tokens) || 0,
      completionTokens: Number(usage?.completion_tokens) || 0,
      lastPromptTokens: Number(usage?.lastPromptTokens) || 0,
      rounds: Number(f.rounds) || 0,
      toolCalls: Number(f.toolCalls) || 0,
    },
    // ── §6.4 ④ 失败根因（独立 Judge）──
    judges: {
      tokens: Number(f.judgeTokens) || 0,
      calls: Number(f.judgeCalls) || 0,
      // 判过才有结论；没判过保持 null，不要用「已满足」冒充
      verdict: f.judged === false || acTotal === 0 ? null : (acSatisfied >= acTotal ? 'satisfied' : 'partial'),
    },
    // 正文只留尾巴：正文本身已在会话库里，这里只做「对得上号」的锚点
    textTail: String(finalText || '').slice(-TEXT_TAIL_CHARS),
  };
}

function evictOldReports(max = MAX_REPORT_FILES) {
  const base = dir();
  if (!base) return 0;
  const fs = require('fs');
  try {
    const files = fs.readdirSync(base)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = `${base}/${f}`;
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { /* 竞态删除：排最旧 */ }
        return { p, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    while (files.length - removed > max) {
      try { fs.rmSync(files[removed].p); } catch {
        // C-001：删不掉（占用/权限）就停下 —— 已删数量如实返回，下一轮再试；
        // 不重抛是因为淘汰是后台维护，不该让写入路径失败。
        break;
      }
      removed += 1;
    }
    return removed;
  } catch {
    return 0; // 目录还不存在：无需淘汰
  }
}

// 写一份报告。返回值：报告对象（成功）/ null（没有落盘位置或写失败）。
// 调用方**不需要**判断结果——写报告失败绝不该改变运行结局。
function writeRunReport(input) {
  const report = buildRunReport(input);
  const base = dir();
  if (!base) return null;
  const fs = require('fs');
  try {
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(`${base}/${report.runId}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    evictOldReports();
    return report;
  } catch (e) {
    console.warn(`[runReport] 报告落盘失败（不影响运行） runId=${report.runId}:`, e?.message || String(e));
    return null;
  }
}

// 最近 N 份报告的摘要（UI 列表用：不把整份报告搬进渲染层）。
// 坏文件（半截 JSON / 权限）逐条跳过并留痕——一份坏报告不该让整个列表变空。
function listRunReports(limit = 5) {
  const base = dir();
  if (!base) return [];
  const fs = require('fs');
  let names = [];
  try {
    names = fs.readdirSync(base).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // 目录不存在 = 还没跑过任何任务（正常态，不是故障）
  }
  const rows = [];
  for (const f of names) {
    const p = `${base}/${f}`;
    try {
      const r = JSON.parse(fs.readFileSync(p, 'utf8'));
      rows.push({
        runId: r.runId || f.replace(/\.json$/, ''),
        endedAt: Number(r.endedAt) || 0,
        durationMs: Number(r.durationMs) || 0,
        model: r.model || '',
        stopReason: r.outcome?.stopReason || '',
        interrupted: r.outcome?.interrupted === true,
        checkpointSaved: r.outcome?.checkpointSaved === true,
        acTotal: Number(r.acceptance?.total) || 0,
        acSatisfied: Number(r.acceptance?.satisfied) || 0,
        rounds: Number(r.resources?.rounds) || 0,
        toolCalls: Number(r.resources?.toolCalls) || 0,
        tokens: (Number(r.resources?.promptTokens) || 0) + (Number(r.resources?.completionTokens) || 0),
      });
    } catch (e) {
      console.warn(`[runReport] 跳过坏报告 ${f}:`, e?.message || String(e));
    }
  }
  return rows.sort((a, b) => b.endedAt - a.endedAt).slice(0, Math.max(0, Number(limit) || 5));
}

function readRunReport(runId) {
  const base = dir();
  if (!base) return null;
  const fs = require('fs');
  try {
    return JSON.parse(fs.readFileSync(`${base}/${sanitizeRunId(runId)}.json`, 'utf8'));
  } catch (e) {
    // C-001：ENOENT（还没写过）与被删/损坏压成同一个 null，但调用方只做「有没有」判断，
    // 且非 ENOENT 一律留痕 —— 不会让谁把「读失败」当成「没有这份报告」后继续做决策。
    if (e?.code !== 'ENOENT') console.warn(`[runReport] 报告读取失败 runId=${runId}:`, e?.message || String(e));
    return null;
  }
}

module.exports = {
  REPORT_VERSION, MAX_REPORT_FILES, TEXT_TAIL_CHARS,
  initRunReports, buildRunReport, writeRunReport, listRunReports, readRunReport, evictOldReports, sanitizeRunId,
};
