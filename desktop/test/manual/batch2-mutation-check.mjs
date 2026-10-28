// 批次 2 门禁的变异验证：证明 renderer-guards 的每条断言都有判别力。
// 铁律：变异打在真实调用点、变异前先证基线绿、还原后必须校验文件指纹一致。
// ⚠ 本次改动尚未提交，故**不能**用 git checkout 还原（会丢失修复），一律走备份+md5 校验。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'renderer', 'src');
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

const cases = [
  {
    id: 'G1', desc: '把渲染处还原成裸取 task.prompt.slice（事故形态）',
    file: 'components/ScheduledTasks.jsx',
    from: "{String(task?.prompt || '').slice(0, 100)}",
    to: '{task.prompt.slice(0, 100)}',
  },
  {
    id: 'G2', desc: '去掉 Dashboard 的局部边界',
    file: 'App.jsx',
    from: '{showDashboard && <ErrorBoundary compact><Dashboard',
    to: '{showDashboard && <Dashboard',
  },
  {
    id: 'G3', desc: '删掉 ErrorBoundary 的自动复位',
    file: 'components/ErrorBoundary.jsx',
    from: 'componentDidUpdate(prevProps) {',
    to: 'noopReset(prevProps) {',
  },
  {
    id: 'G4', desc: '把请求序号改名（等价于取消 seq 机制）',
    file: 'components/DiffReviewPanel.jsx',
    from: 'loadSeqRef',
    to: 'loadSeqRefDisabled',
    all: true,
  },
  {
    id: 'G5a', expect: 'G5', desc: '闩锁置位改错方向',
    file: 'hooks/useAgentRun.ts',
    from: 'sendingRef.current = true;',
    to: 'sendingRef.current = false;',
  },
  {
    id: 'G5b', expect: 'G5', desc: '去掉 .finally 释放（提前 return 会永久锁死发送）',
    file: 'hooks/useAgentRun.ts',
    from: 'return doSend(text, forcedThread, opts).finally(() => sendingRef.current = false);',
    to: 'return doSend(text, forcedThread, opts);',
  },
];

let ok = 0;
let bad = 0;
for (const c of cases) {
  const target = path.join(SRC, c.file);
  const backup = path.join('/tmp', `mjbak-${c.id}-${path.basename(c.file)}`);
  fs.copyFileSync(target, backup);
  const before = md5(target);
  let mutated = false;
  try {
    const src = fs.readFileSync(target, 'utf8');
    if (!src.includes(c.from)) {
      console.error(`❌ ${c.id} 变异锚点不存在（先修脚本，不要当成通过）：${c.from}`);
      bad++;
      continue;
    }
    const next = c.all ? src.split(c.from).join(c.to) : src.replace(c.from, c.to);
    fs.writeFileSync(target, next);
    mutated = next !== src;
    if (!mutated) { console.error(`❌ ${c.id} 变异未生效`); bad++; continue; }

    // 跑门禁，期望 exit≠0 且输出含该条 ❌
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'test', 'renderer-guards.test.mjs')],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      code = e.status ?? 1;
    }
    // expect：要匹配的门禁编号。一个门禁有多条变异时，case id 会带后缀（G5a/G5b），
    // 但门禁输出里只出现 G5 —— 用 expect 显式解耦，别让编号命名决定检出结果。
    const want = c.expect || c.id;
    const hit = out.includes(`❌ ${want}`);
    if (code !== 0 && hit) { ok++; console.log(`✅ ${c.id} 变异后变红（命中断言 ${want}）— ${c.desc}`); }
    else {
      bad++;
      console.error(`❌ ${c.id} 变异后**仍绿或红的不是它**（code=${code}, 命中=${hit}）— ${c.desc}`);
      console.error(`   ── 门禁实际输出 ──\n${out.split('\n').filter((l) => l.includes('❌')).join('\n') || '(无 ❌ 行)'}`);
    }
  } finally {
    fs.copyFileSync(backup, target);
    const after = md5(target);
    if (after !== before) { console.error(`❌ ${c.id} 还原失败！指纹不一致`); bad++; }
    fs.unlinkSync(backup);
  }
}

// 收尾：还原后必须回到全绿（证明变异是唯一变量）
let finalCode = 0;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'test', 'renderer-guards.test.mjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { finalCode = e.status ?? 1; }
if (finalCode !== 0) { console.error('❌ 还原后门禁未回到全绿'); bad++; }
else console.log('✅ 全部还原后门禁回到全绿');

console.log(`\n变异验证: ${ok} 条预期红成立 / ${bad} 条异常`);
process.exit(bad === 0 ? 0 : 1);
