// G-latex（2026-10-19）：LaTeX 编译原生工具（latex_compile）。
//
// 为什么做原生工具而不是继续让模型自己拼 shell 命令：
//   · 原实现只在 SKILL_PROMPTS 里写了「先 command -v tectonic，再 latexmk -pdf …」的操作手册，
//     实际执行全靠模型发 shell —— 工具链探测结果、编译成功与否、日志里的真实报错都要模型自己
//     从一坨 stdout 里抠，容易「没看到成功输出就宣称完成」（skill 里专门写了一条纪律来堵，说明高发）；
//   · 原生工具把「探测 → 选引擎 → 编译 → 结构化报错 → 产物确认」收敛成一次调用，返回值是结构化的
//     （engine / pdfPath / errors[{line,message}] / logTail），模型不必解析自由文本。
//
// 引擎选型：简单项目优先 Tectonic（单命令、按需取包）；含 ctex/xeCJK 的中文文档走 latexmk -xelatex
// （XeLaTeX 才有系统字体与 CJK 支持）；其余回落 latexmk -pdf / 直接 xelatex、pdflatex、lualatex。
//
// 安全：
//   · 一律 `spawn(cmd, argv)` **不经 shell**（tex 路径来自模型，拼 shell 等于开注入面）；
//   · 不传 --shell-escape / -shell-escape —— 不放开 \write18 任意命令执行；
//   · 产物 PDF 落盘前走 main/tools/artifactWriteGate.js 的统一写闸（与 doc_create 同一纪律，L2 审批）；
//   · 探测（probeOnly）只跑 `<engine> --version`，只读、不落盘，不进审批面。
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { resolveToolPath } = require('./tools/execCwd');
const { shellEnv, IS_WIN } = require('./tools/shellEnv');
const { gateArtifactWrite } = require('./tools/artifactWriteGate');
const { audit } = require('./audit/auditLog');
const { LATEX_IMPL_TIMEOUT_MS } = require('./tools/timeouts');

let deps = null;
function initLatexTools(d) {
  deps = d;
}

const TOOL_KEY = 'latex_compile';
// 候选引擎：探测顺序即「体检报告」的展示顺序，不代表 auto 档的选型顺序（选型见 chooseEngine）
const ENGINES = ['tectonic', 'latexmk', 'xelatex', 'pdflatex', 'lualatex'];

// ── TeX 二进制目录 ──
// macOS 的 MacTeX 把可执行文件统一放在 /Library/TeX/texbin，并不软链进 /usr/local/bin；
// shellEnv() 的系统目录表里没有它 —— 不补这一条，装了完整 TeX Live 的用户也会「找不到 latexmk」。
function texBinDirs() {
  const dirs = [];
  if (IS_WIN) {
    for (const root of ['C:\\texlive', 'C:\\Program Files\\texlive']) {
      try {
        for (const y of fs.readdirSync(root)) dirs.push(path.join(root, y, 'bin', 'windows'));
      } catch { /* 目录不存在 */ }
    }
  } else {
    dirs.push('/Library/TeX/texbin');
    // 手动安装的 TeX Live：/usr/local/texlive/<year>/bin/<arch>
    try {
      for (const y of fs.readdirSync('/usr/local/texlive')) {
        const base = path.join('/usr/local/texlive', y, 'bin');
        try { for (const a of fs.readdirSync(base)) dirs.push(path.join(base, a)); } catch { /* 忽略 */ }
      }
    } catch { /* 目录不存在 */ }
  }
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { /* C-001：stat 失败=目录不存在=不加入候选，属正常过滤分支 */ return false; } });
}

function envForTex() {
  const env = shellEnv();
  const extra = texBinDirs();
  if (extra.length) env.PATH = [env.PATH, ...extra].filter(Boolean).join(IS_WIN ? ';' : ':');
  return env;
}

// 通用子进程执行（不经 shell）：返回 { code, out, spawnError, timedOut }
function runCapture(cmd, argv, timeoutMs, cwd) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env: envForTex(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ code: -1, out: '', spawnError: e.message, timedOut: false });
    }
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('error', (e) => finish({ code: -1, out, spawnError: e.message, timedOut: false }));
    child.on('close', (code) => finish({ code, out, timedOut: false }));
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ code: -1, out, timedOut: true });
    }, timeoutMs);
    if (t.unref) t.unref();
  });
}

// 单引擎探测：<cmd> --version 退出码 0 即视为可用（ENOENT → 不可用）
async function probeEngine(cmd) {
  const r = await runCapture(cmd, ['--version'], 6000);
  if (r.spawnError || r.code !== 0) return { available: false, version: null };
  const first = String(r.out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  return { available: true, version: first.slice(0, 120) };
}

async function detectToolchain() {
  const engines = {};
  for (const e of ENGINES) engines[e] = await probeEngine(e);
  const kpse = await probeEngine('kpsewhich');
  // ctex.sty 是 TeX Live 中文支持的代表性宏包；装了才说明「中文文档」这条路通
  let ctexSty = null;
  if (kpse.available) {
    const r = await runCapture('kpsewhich', ['ctex.sty'], 8000);
    ctexSty = r.code === 0 && String(r.out).trim().length > 0;
  }
  return { engines, kpsewhich: kpse, ctexSty };
}

// 中文文档判定：ctex 文档类/宏包、xeCJK、或显式设置了 CJK 主字体
function looksChinese(src) {
  return /\\usepackage(\[[^\]]*\])?\{(ctex|xeCJK)\}/.test(src)
    || /\\documentclass(\[[^\]]*\])?\{(ctexart|ctexrep|ctexbook|ctexbeamer)\}/.test(src)
    || /\\(setCJKmainfont|setmainfont)\b/.test(src);
}

// auto 档选型：中文走 XeLaTeX 系；否则 Tectonic 优先（单命令 / 免维护）
function chooseEngine(engines, src) {
  const has = (e) => !!(engines[e] && engines[e].available);
  if (looksChinese(src)) {
    if (has('latexmk') && has('xelatex')) return 'latexmk-xelatex';
    if (has('xelatex')) return 'xelatex';
    if (has('tectonic')) return 'tectonic'; // Tectonic 自带 ctex 支持
    if (has('lualatex')) return 'lualatex';
    if (has('pdflatex')) return 'pdflatex';
  } else {
    if (has('tectonic')) return 'tectonic';
    if (has('latexmk')) return 'latexmk';
    if (has('pdflatex')) return 'pdflatex';
    if (has('xelatex')) return 'xelatex';
    if (has('lualatex')) return 'lualatex';
  }
  return null;
}

// 显式 engine 参数 → 内部选型键（engine 只能落在 ENGINES 里；latexmk 的中文用法需固定它自己的组合）
function explicitEngine(engines, requested) {
  const want = String(requested || '').toLowerCase();
  if (!ENGINES.includes(want)) return { error: `engine 取值非法：${requested}（可选 auto/tectonic/latexmk/xelatex/pdflatex/lualatex）` };
  if (!engines[want] || !engines[want].available) {
    return { error: `指定的引擎 ${want} 在本机不可用（未安装或不在 PATH）。可先用 probeOnly:true 查看本机工具链。` };
  }
  return { engine: want };
}

function buildInvocation(engine, texFile) {
  switch (engine) {
    case 'tectonic': return { cmd: 'tectonic', args: [texFile], label: 'tectonic' };
    case 'latexmk': return { cmd: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', texFile], label: 'latexmk -pdf' };
    case 'latexmk-xelatex': return { cmd: 'latexmk', args: ['-xelatex', '-interaction=nonstopmode', '-halt-on-error', texFile], label: 'latexmk -xelatex' };
    default: return { cmd: engine, args: ['-interaction=nonstopmode', '-halt-on-error', texFile], label: engine };
  }
}

// 日志 → 结构化错误：LaTeX（! 开头）与 Tectonic（error: 开头）两种形态都覆盖。
// 每条尽量带上 "l.NN" 行号（模型据此直接定位改哪一行，而不是让它再翻一遍日志）。
function parseLatexLog(log) {
  const lines = String(log || '').split(/\r?\n/);
  const errors = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const m = /^\s*!\s*(.+)$/.exec(raw) || /^\s*error[:!]\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const message = m[1].trim().slice(0, 300);
    if (!message) continue;
    const ctx = String(lines[i + 1] || '').trim();
    const lm = /^l\.(\d+)\b/.exec(ctx);
    errors.push({ message, line: lm ? Number(lm[1]) : null, context: ctx.slice(0, 200) });
    if (errors.length >= 8) break; // 8 条足够定位；再多只是同一错误的连锁
  }
  return errors;
}

function tailLines(s, n = 40) {
  const lines = String(s || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}

const MISSING_TOOLCHAIN_HINT = '本机未找到任何 LaTeX 引擎。安装建议：简单单文件项目 → Tectonic'
  + '（brew install tectonic 或 cargo install tectonic，轻量免维护）；含参考文献/多图/跨文件的完整论文 → '
  + '安装 MacTeX（tug.org/mactex）。装完请新开终端让 PATH 生效，再重试。';

async function toolLatexCompile(args = {}) {
  // ── 体检模式：只探测工具链，不编译、不落盘、不审批 ──
  if (args.probeOnly === true) {
    const probe = await detectToolchain();
    const available = ENGINES.filter((e) => probe.engines[e].available)
      .map((e) => ({ engine: e, version: probe.engines[e].version }));
    const missing = ENGINES.filter((e) => !probe.engines[e].available);
    return {
      ok: true,
      probeOnly: true,
      available,
      missing,
      ctexSty: probe.ctexSty,
      ready: available.length > 0,
      hint: available.length ? '' : MISSING_TOOLCHAIN_HINT,
    };
  }

  // ── 编译模式 ──
  const rawPath = String(args.path || '').trim();
  if (!rawPath) return { ok: false, error: 'path 必填（入口 .tex 文件的路径，含 \\documentclass 的那个）' };
  const cwd = String(args.cwd || '').trim() || process.cwd();
  let texPath;
  try {
    texPath = resolveToolPath(rawPath, cwd);
  } catch (e) {
    return { ok: false, error: `入口文件路径解析失败：${e.message}` };
  }

  // 先看原始路径：是目录就明确拒绝——否则「缺扩展名自动补 .tex」会把目录拼成**不存在**的
  // 路径，报出误导性的「入口文件不存在」，用户拿着错误信息找半天目录问题。
  let st = null;
  try { st = await fsp.stat(texPath); } catch { /* C-001：stat 失败=路径不存在，下面据此判「补 .tex」或报「入口文件不存在」，是正常探测 */ st = null; }
  if (st && st.isDirectory()) return { ok: false, error: `${texPath} 是目录，请指定具体的 .tex 文件` };
  // 原始路径不存在且缺扩展名：按模型常省略扩展名的习惯补 .tex 后再 stat
  if (!st && !texPath.toLowerCase().endsWith('.tex')) texPath = `${texPath}.tex`;
  if (!st) {
    try { st = await fsp.stat(texPath); } catch { return { ok: false, notFound: true, error: `入口文件不存在：${texPath}` }; }
  }
  if (st.isDirectory()) return { ok: false, error: `${texPath} 是目录，请指定具体的 .tex 文件` };

  let src = '';
  try { src = await fsp.readFile(texPath, 'utf8'); } catch (e) { return { ok: false, error: `无法读取入口文件：${e.message}` }; }

  const probe = await detectToolchain();
  const requested = String(args.engine || 'auto').toLowerCase();
  let engineKey;
  if (requested === 'auto' || !requested) {
    engineKey = chooseEngine(probe.engines, src);
    if (!engineKey) return { ok: false, error: MISSING_TOOLCHAIN_HINT, probeOnly: false, missing: ENGINES };
  } else {
    const pick = explicitEngine(probe.engines, requested);
    if (pick.error) return { ok: false, error: pick.error };
    engineKey = pick.engine;
  }

  const texDir = path.dirname(texPath);
  const base = path.basename(texPath, path.extname(texPath));
  const pdfPath = path.join(texDir, `${base}.pdf`);
  const inv = buildInvocation(engineKey, path.basename(texPath));

  // 产物落盘统一走写闸（与 doc_create 同一 L2 分级；输出路径由入口文件推导，模型无法指定)
  const gate = await gateArtifactWrite(deps, TOOL_KEY, { ...args, path: pdfPath }, pdfPath);
  if (gate.ok === false) return gate;

  const startedAt = Date.now();
  const run = await runCapture(inv.cmd, inv.args, LATEX_IMPL_TIMEOUT_MS, texDir);
  const durationMs = Date.now() - startedAt;

  if (run.timedOut) {
    audit(TOOL_KEY, texPath, `编译超时（${inv.label}）`, 'error');
    return {
      ok: false, engine: inv.label, timedOut: true, durationMs,
      error: `编译超时：超过 ${Math.round(LATEX_IMPL_TIMEOUT_MS / 1000)}s 未结束（已强杀）。大型论文项目请改用 latexmk 增量编译，或先检查是否卡在交互提示上。`,
      logTail: tailLines(run.out),
    };
  }
  if (run.spawnError) {
    audit(TOOL_KEY, texPath, `引擎启动失败（${inv.label}）：${run.spawnError}`, 'error');
    return { ok: false, engine: inv.label, spawnError: run.spawnError, error: `引擎 ${inv.cmd} 启动失败：${run.spawnError}` };
  }

  let pdfMtime = 0;
  try { pdfMtime = (await fsp.stat(pdfPath)).mtimeMs; } catch { /* 未产出：下面的分支会给结论 */ }
  const produced = pdfMtime >= startedAt - 2000;

  if (run.code !== 0 || !produced) {
    const errors = parseLatexLog(run.out);
    audit(TOOL_KEY, texPath, `编译失败（${inv.label}，exit=${run.code}）`, 'error');
    return {
      ok: false,
      engine: inv.label,
      durationMs,
      exitCode: run.code,
      errors,
      error: errors.length
        ? `LaTeX 编译失败，首条错误：${errors[0].message}${errors[0].line ? `（第 ${errors[0].line} 行）` : ''}`
        : `编译未成功（exit=${run.code}），且未产出 PDF。请查看 logTail 定位原因。`,
      logTail: tailLines(run.out),
      texPath,
    };
  }

  const bytes = (() => { try { return fs.statSync(pdfPath).size; } catch { /* C-001：取不到大小按 0 记——审计里 0B 表示未知，不是空文件 */ return 0; } })();
  audit(TOOL_KEY, texPath, `ok ${bytes}B（${inv.label}）`, gate.asked ? 'approved' : 'recorded');
  return {
    ok: true,
    engine: inv.label,
    durationMs,
    pdfPath,
    bytes,
    // 编译成功的日志里也可能有 warning；给一段尾部让模型判断要不要提示用户
    logTail: tailLines(run.out, 15),
  };
}

module.exports = { initLatexTools, toolLatexCompile, detectToolchain, parseLatexLog, _envForTex: envForTex };
