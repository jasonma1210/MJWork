// 批次 1 安全门禁的变异验证：证明 security-guards 每条断言都有判别力。
// 铁律：变异打在真实调用点、变异前先证基线绿、还原后校验文件指纹。
// 改动未提交 ⇒ 禁止 git checkout 还原，一律 /tmp 备份 + md5。
//
// ⚠ S4 的失败形态特殊：被守护的行为是「patch 缺失时不崩进程」，删掉 error 监听后
//   未捕获的 'error' 事件会**终止整个测试进程**，因此判别力表现为「进程崩溃」而非「❌ 行」。
//   这类结果单独计为 crash-detect，不计入断言命中 —— 如实区分「断言拦住」与「崩了才发现」。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MAIN = path.join(ROOT, 'main');
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

const cases = [
  {
    id: 'S1', desc: '把 never 短路挪回 toolLevel 之前（事故形态）',
    file: 'approval.js',
    from: "  if (level === 'L1') return { need: true, level };\n  if (!level || approvalMode === 'never') return { need: false };",
    to: "  if (approvalMode === 'never') return { need: false };\n  if (!level) return { need: false };\n  if (level === 'L1') return { need: true, level };",
  },
  {
    id: 'S2', desc: '把前台分支重新包进 !breakerOpen',
    file: 'resourceQuotaCenter.js',
    from: '      if (isFg) {',
    to: '      if (isFg && !breakerOpen) {',
  },
  {
    id: 'S3', desc: '去掉 Windows 分支的 .catch（仅源码断言，不 require 该文件）',
    file: 'tools/exec.js',
    from: '}).catch((e) => {\n        // P0-5',
    to: '}).catchRemoved((e) => {\n        // P0-5',
  },
  {
    id: 'S4', desc: '不注册 patch 子进程的 error 监听', expect: 'CRASH',
    file: 'tools/execWrite.js',
    from: "    child.on('error', (e) => {",
    to: "    if (false) child.on('error', (e) => {",
  },
  {
    id: 'S5', desc: 'darwin 分支退回只看二进制是否存在',
    file: 'sandbox.js',
    from: "if (platform === 'darwin') return seatbeltProbe ? seatbeltProbe.ok === true : !!execExists;",
    to: "if (platform === 'darwin') return !!execExists;",
  },
  {
    id: 'S6', desc: '去掉每跳 fetch 前的 DNS 复检',
    file: 'nativeTools.js',
    from: '      try { await assertResolvedPublic(current.hostname); }',
    to: '      try { /* removed */ }',
  },
  {
    id: 'S7', desc: '从危险模式里删掉 constructor.constructor',
    file: 'dangerousPatterns.js',
    from: '  /\\bconstructor\\s*\\.\\s*constructor\\b/,      // Function 构造器自救（vm 逃逸经典形态）\n',
    to: '',
  },
  {
    id: 'S7b', desc: '把宿主 Buffer 注回 vm context',
    file: 'nativeSandbox/childEntry.js',
    from: '    require: makeRestrictedRequire({ allowNetwork, allowFs }),\n',
    to: '    require: makeRestrictedRequire({ allowNetwork, allowFs }),\n    Buffer,\n',
  },
  // ── A-P0-8（checkpoint）：门禁在 checkpointStore.test.js，断言名以「P0-8」开头 ──
  {
    id: 'CP1', expect: 'P0-8 首次运行不产生损坏错误态', file: 'checkpointStore.js',
    testFile: 'test/checkpointStore.test.js',
    desc: '去掉 ENOENT 分支（首次运行被误判为损坏）',
    from: '    if (e && e.code === \'ENOENT\') { loadError = null; return {}; }\n',
    to: '',
  },
  {
    id: 'CP2', expect: 'P0-8 LRU 淘汰 savedAt 最旧者', file: 'checkpointStore.js',
    testFile: 'test/checkpointStore.test.js',
    desc: '去掉按 savedAt 排序（退回插入顺序 FIFO）',
    from: '    unpinned.sort((a, b) => Number(map[a]?.savedAt || 0) - Number(map[b]?.savedAt || 0));\n',
    to: '',
  },
  {
    id: 'CP3', expect: 'P0-8 契约：saveCheckpoint 不使用 fs.promises', file: 'checkpointStore.js',
    testFile: 'test/checkpointStore.test.js',
    desc: '在 saveCheckpoint 内引入 fs.promises（异步化的第一步）',
    from: 'function saveCheckpoint(threadKey, data, opts = {}) {\n',
    to: 'function saveCheckpoint(threadKey, data, opts = {}) {\n  void fs.promises; // 变异：模拟异步化\n',
  },
];

let ok = 0;
let crashed = 0;
let bad = 0;
for (const c of cases) {
  const target = path.join(MAIN, c.file);
  const backup = path.join('/tmp', `mjb1-${c.id}-${path.basename(c.file)}`);
  fs.copyFileSync(target, backup);
  const before = md5(target);
  try {
    const src = fs.readFileSync(target, 'utf8');
    if (!src.includes(c.from)) {
      console.error(`❌ ${c.id} 变异锚点不存在（先修脚本，别当成通过）：${c.from.slice(0, 60)}`);
      bad++;
      continue;
    }
    const next = src.replace(c.from, c.to);
    fs.writeFileSync(target, next);
    if (next === src) { console.error(`❌ ${c.id} 变异未生效`); bad++; continue; }

    let out = '';
    let code = 0;
    // testFile：谓本条守护落在哪个套件里（默认 security-guards）
    const suite = path.join(ROOT, c.testFile || 'test/security-guards.test.mjs');
    try {
      out = execFileSync(process.execPath, [suite],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      code = e.status ?? 1;
    }
    const want = c.expect || c.id;
    const hit = out.includes(`❌ ${want}`);
    if (c.expect === 'CRASH') {
      // 期望：进程崩溃（判别力来自崩溃点，不是断言）—— 必须如实区分
      if (code !== 0 && !hit) { crashed++; console.log(`✅ ${c.id} 变异后进程崩溃（崩溃型判别力，非断言拦截）— ${c.desc}`); }
      else if (code !== 0 && hit) { ok++; console.log(`✅ ${c.id} 变异后变红（命中断言 ${want}）— ${c.desc}`); }
      else { bad++; console.error(`❌ ${c.id} 变异后仍绿 — ${c.desc}`); }
    } else if (code !== 0 && hit) {
      ok++; console.log(`✅ ${c.id} 变异后变红（命中断言 ${want}）— ${c.desc}`);
    } else {
      bad++;
      console.error(`❌ ${c.id} 变异后**仍绿或红的不是它**（code=${code}, 命中=${hit}）— ${c.desc}`);
      console.error(`   ── 实际 ❌ 行 ──\n${out.split('\n').filter((l) => l.includes('❌')).join('\n') || '(无)'}`);
    }
  } finally {
    fs.copyFileSync(backup, target);
    if (md5(target) !== before) { console.error(`❌ ${c.id} 还原失败！指纹不一致`); bad++; }
    fs.unlinkSync(backup);
  }
}

// 收尾：还原后必须两个套件都回到全绿（证明变异是唯一变量）
let bad2 = 0;
for (const suite of ['test/security-guards.test.mjs', 'test/checkpointStore.test.js']) {
  let c = 0;
  try {
    execFileSync(process.execPath, [path.join(ROOT, suite)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { c = e.status ?? 1; }
  if (c !== 0) { console.error(`❌ 还原后 ${suite} 未回到全绿`); bad2++; }
}
if (bad2 === 0) console.log('✅ 全部还原后两个套件均回到全绿');
bad += bad2;

console.log(`\n变异验证: ${ok} 断言命中 / ${crashed} 崩溃型 / ${bad} 异常`);
process.exit(bad === 0 ? 0 : 1);
