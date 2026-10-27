#!/usr/bin/env node
// ── 存量收敛台账生成器（F-017 / B2-B-13）──────────────────────────────────────
//
// 治理的问题：两个存量指标都只是「ratchet 上限」，**只防恶化、不防挂账**。
//   · 死 bridge 方法：test/bridge-parity.test.mjs:107 只断言「占比 ≤ 40%」。
//     于是只要别一次加太多，46 个死方法可以永远躺着——40% 的上限对 22.8% 毫无压力。
//   · 裸 button：test/ui-conventions.test.js:26 用 `counts.rawButton <= 258`。
//     只要不超 258，一个都不清也算「通过」。
// 两处共同的失效模式：**数字只被当成天花板，没被当成待办清单**。没人知道 46 条是哪几类、
// 258 个散在哪些文件、下一轮该先动哪一块 —— 于是永远不动。
//
// 本脚本把这两个数字变成**可执行台账**：按功能前缀 / 按文件分组，每组带一个处置状态。
// 配套 test/legacy-ledger.test.mjs 断言「台账与现算完全一致」——任何增或减都红，
// 逼着每轮改完必须更新台账并说明处置（而不是让数字悄悄漂）。
//
// ⚠️ 这是**生成式台账**：明细（46 个方法名 / 258 个标签）不入库，入库的只有
//    「分组 + 计数 + 处置状态」。理由：明细会随每次重构抖动，逐条维护必然腐坏；
//    分组计数才是「可收敛性」的真实度量（一个组清空＝一类问题清零）。
//
// 用法：
//   node scripts/gen-legacy-ledger.mjs            # 打印到 stdout（人眼查看）
//   node scripts/gen-legacy-ledger.mjs --write    # 写入 docs/harness-r7/legacy-ledger.json
//
// 口径来源（**必须与两个门禁逐字一致**，否则台账与门禁会各说各话）：
//   死 bridge 方法 ← test/bridge-parity.test.mjs（preload 顶层键 − 渲染层引用集）
//   裸 button      ← test/ui-conventions.test.js（排除 components/ui/ 与 styles/）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 本文件是 ESM，而共用口径模块 scripts/lib/rawButtonScan.js 是 CJS（门禁 test/*.test.js 用 require 加载）
const require = createRequire(import.meta.url);

const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const PRELOAD = path.join(DESKTOP, 'main/preload.js');
const RENDERER_SRC = path.join(DESKTOP, 'renderer/src');
const OUT_PATH = path.join(REPO, 'docs/harness-r7/legacy-ledger.json');

// 处置状态的三档语义（写进台账与文档，供下一轮据此排期）：
//   pending  还没动，欠账仍在（初始值）
//   consume  已排期在本轮/下轮消费掉（有计划、有 owner）
//   retire   已彻底消灭（组内计数归零；组本身应从台账消失，故该值只作过渡记录）
//   exempt   经评估**接受**这批存量（有明确理由，不再作为欠账追踪）
export const DISPOSITIONS = ['pending', 'consume', 'retire', 'exempt'];

// ─────────────────────────────────────────────────────────────────────────────
// 1) 死 bridge 方法
// ─────────────────────────────────────────────────────────────────────────────
// ① preload 暴露面：exposeInMainWorld('mjcode', { ... }) 对象字面量的顶层键（缩进 2 空格）
function bridgeNames() {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const names = new Set();
  const start = src.indexOf("exposeInMainWorld('mjcode'");
  if (start < 0) throw new Error("preload 中找不到 exposeInMainWorld('mjcode')，桥面提取规则已失效");
  for (const line of src.slice(start).split('\n')) {
    const m = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (m) names.add(m[1]);
    if (/^\}\);/.test(line)) break;
  }
  return names;
}

// ② 渲染层引用面：与 bridge-parity 完全同口径（含整桥别名 `const mj = window.mjcode`）
function walkRenderer(dir, out = [], { skipDotDirs = false } = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    if (skipDotDirs && e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRenderer(full, out, { skipDotDirs });
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

const ALIAS_SRC = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:globalThis\.)?(?:window\??\.)?mjcode\b(?=\s*[;,)\]}\n]|\s*(?:\|\||\?\?))/g;

function rendererReferences() {
  const used = new Set();
  for (const file of walkRenderer(RENDERER_SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const aliases = new Set(['mjcode']);
    for (const m of src.matchAll(ALIAS_SRC)) aliases.add(m[1]);
    for (const line of src.split('\n')) {
      for (const alias of aliases) {
        const re = new RegExp(`\\b${alias}\\??\\.([A-Za-z_$][\\w$]*)|\\b${alias}\\??\\[['"]([A-Za-z_$][\\w$]*)['"]\\]`, 'g');
        let m;
        while ((m = re.exec(line)) !== null) {
          const name = m[1] || m[2];
          if (name) used.add(name);
        }
      }
    }
  }
  return used;
}

// ③ 功能前缀推导（**从名字本身推导，不硬编码命名空间清单**）
// 硬编码一份 `['diag','scheduled','ecosystem',…]` 的问题：新增命名空间时它悄悄落入
// 「其他」桶，分组就退化成一个大杂烩，台账等于没分组。改为按命名法机械切分：
//   · 含 ':' 的（`diag:preview`）→ 取 ':' 前那段
//   · camelCase / snake_case → 取首个词（小写→大写边界、或 '_' 前）
//   · 纯小写无分隔（如 `shell`）→ 整名作为前缀（自身即一类）
// 这样任何新增命名都自动成组，无需维护清单。
function functionalPrefix(name) {
  const n = String(name || '');
  if (n.includes(':')) return n.slice(0, n.indexOf(':'));
  if (n.includes('_')) return n.slice(0, n.indexOf('_'));
  // 首个 camelCase 词：从第 2 个字符起找第一个「大写字母且前一位是小写/数字」的位置
  const m = n.match(/^[a-z][a-z0-9]*(?=[A-Z])/);
  if (m) return m[0];
  // 全小写或首字母大写开头（如 `Export`）→ 整名
  return n;
}

function computeDeadBridge() {
  const names = bridgeNames();
  const used = rendererReferences();
  const dead = [...names].filter((n) => !used.has(n)).sort();
  const groups = new Map();
  for (const n of dead) {
    const p = functionalPrefix(n);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(n);
  }
  return {
    total: names.size,
    referenced: used.size,
    dead: dead.length,
    groups: [...groups.entries()]
      // 大组在前（下一轮优先清最大的那些），同数量按前缀字典序保证稳定
      .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))
      .map(([prefix, members]) => ({ prefix, count: members.length, members })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 裸 <button>
// ─────────────────────────────────────────────────────────────────────────────
// 口径**唯一来源**：scripts/lib/rawButtonScan.js（与 test/ui-conventions.test.js 共用同一实现）。
// 为什么不再在本文件里重写一遍：本文件曾自己实现「注释屏蔽 + 数 <button」，
// 而 exemptions（文字链 / 正方形图标按钮）只加在门禁那一侧，于是同一份代码
// 在门禁得 164、在台账得 256 —— 而 legacy-ledger 的断言是「台账 === 门禁基线」，
// 两边都自称权威、数字却不同，人只能靠猜信哪个。
const { blankComments, countButtons } = require('./lib/rawButtonScan.js');

function computeRawButtons() {
  const all = walkRenderer(RENDERER_SRC, [], { skipDotDirs: true })
    .filter((f) => !f.includes(`${path.sep}styles${path.sep}`));
  const byFile = new Map();
  let total = 0;
  for (const file of all) {
    const isPrimitive = file.includes(`${path.sep}components${path.sep}ui${path.sep}`);
    if (isPrimitive) continue;
    const code = blankComments(fs.readFileSync(file, 'utf8'));
    const count = countButtons(code).count; // 已扣除形态豁免
    if (count > 0) {
      byFile.set(path.relative(RENDERER_SRC, file).split(path.sep).join('/'), count);
      total += count;
    }
  }
  return {
    total,
    scannedFiles: all.length,
    groups: [...byFile.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([file, count]) => ({ file, count })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 组装台账（纯计算，不含 disposition）
// ─────────────────────────────────────────────────────────────────────────────
export function computeLedger() {
  const bridge = computeDeadBridge();
  const buttons = computeRawButtons();
  return {
    schemaVersion: 1,
    generator: 'desktop/scripts/gen-legacy-ledger.mjs',
    note: '生成式台账：只记「分组 + 计数 + 处置状态」，不枚举明细。'
      + '任何计数变化（增或减）都必须同步本文件并说明处置，由 test/legacy-ledger.test.mjs 强制。',
    metrics: {
      deadBridgeMethods: {
        // 口径：preload 暴露的顶层方法 − 渲染层（含整桥别名）实际引用
        source: 'desktop/main/preload.js − desktop/renderer/src（口径同 test/bridge-parity.test.mjs）',
        unit: 'method',
        total: bridge.total,
        referenced: bridge.referenced,
        dead: bridge.dead,
        ratio: Number((bridge.dead / bridge.total).toFixed(4)),
        groups: bridge.groups.map((g) => ({ prefix: g.prefix, count: g.count, disposition: 'pending' })),
      },
      rawButtons: {
        source: 'desktop/renderer/src（排除 components/ui/ 与 styles/，口径同 test/ui-conventions.test.js）',
        unit: 'button',
        total: buttons.total,
        scannedFiles: buttons.scannedFiles,
        groups: buttons.groups.map((g) => ({ file: g.file, count: g.count, disposition: 'pending' })),
      },
    },
  };
}

// 详情仅供 stdout 人眼查看，**不入库**
export function computeDetails() {
  return { bridge: computeDeadBridge(), buttons: computeRawButtons() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) disposition 合并（`--write` 时保留人工处置状态，不被覆盖回 pending）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么必须合并：disposition 是**人工判断**（这批欠账是排期、豁免还是假装看不见），
// 生成器不可能算出来。若每次 --write 一律重置为 pending，人改一次就被抹一次，
// 台账立刻沦为一纸空文（和「只防恶化不防挂账」是同一个病）。
export function mergeDisposition(computed, existing) {
  const prevBridge = new Map(
    ((existing && existing.metrics && existing.metrics.deadBridgeMethods
      && existing.metrics.deadBridgeMethods.groups) || []).map((g) => [g.prefix, g.disposition]),
  );
  const prevButtons = new Map(
    ((existing && existing.metrics && existing.metrics.rawButtons
      && existing.metrics.rawButtons.groups) || []).map((g) => [g.file, g.disposition]),
  );
  const pick = (map, key) => {
    const d = map.get(key);
    return DISPOSITIONS.includes(d) ? d : 'pending';
  };
  return {
    ...computed,
    metrics: {
      deadBridgeMethods: {
        ...computed.metrics.deadBridgeMethods,
        groups: computed.metrics.deadBridgeMethods.groups.map((g) => ({ ...g, disposition: pick(prevBridge, g.prefix) })),
      },
      rawButtons: {
        ...computed.metrics.rawButtons,
        groups: computed.metrics.rawButtons.groups.map((g) => ({ ...g, disposition: pick(prevButtons, g.file) })),
      },
    },
  };
}

// 剥掉人工状态后用于「台账 === 现算」比对（状态是人工字段，不参与一致性判定）
export function stripDisposition(ledger) {
  const clone = JSON.parse(JSON.stringify(ledger));
  const m = clone.metrics || {};
  for (const key of ['deadBridgeMethods', 'rawButtons']) {
    const metric = m[key];
    if (!metric || !Array.isArray(metric.groups)) continue;
    metric.groups = metric.groups.map((g) => {
      const { disposition, ...rest } = g; // eslint-disable-line no-unused-vars
      return rest;
    });
  }
  return clone;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) CLI
// ─────────────────────────────────────────────────────────────────────────────
function printHuman() {
  const { bridge, buttons } = computeDetails();
  console.log('── 存量收敛台账（现算）──\n');
  console.log(`[死 bridge 方法] 暴露 ${bridge.total} 个 / 渲染层引用 ${bridge.referenced} 个 `
    + `→ 死 ${bridge.dead} 个（${((bridge.dead / bridge.total) * 100).toFixed(1)}%），分 ${bridge.groups.length} 组`);
  if (bridge.groups.length) {
    const w = Math.max(...bridge.groups.map((g) => g.prefix.length), 6);
    for (const g of bridge.groups) {
      console.log(`  ${g.prefix.padEnd(w)}  ${String(g.count).padStart(3)}  ${g.members.join(' ')}`);
    }
  }
  console.log(`\n[裸 button] 共 ${buttons.total} 个，散在 ${buttons.groups.length} 个文件（扫描 ${buttons.scannedFiles} 个渲染层文件）`);
  for (const g of buttons.groups) {
    console.log(`  ${String(g.count).padStart(3)}  ${g.file}`);
  }
  console.log('');
}

function main() {
  const write = process.argv.includes('--write');
  const computed = computeLedger();
  if (!write) { printHuman(); return; }
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { existing = null; }
  const merged = mergeDisposition(computed, existing);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  printHuman();
  console.log(`已写入 ${path.relative(REPO, OUT_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
