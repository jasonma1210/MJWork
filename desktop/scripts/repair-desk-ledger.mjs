// 修复：把「压缩抹掉的用量记账」从按日备份回填到当前库（2026-10-29）
//
// 背景：/compact 曾把消息整体替换成引擎格式（只有 role/content/tool_calls），
// 导致该会话 tokensInput/tokensOutput/modelName 归零。真机实测两次压缩抹掉 11,878,938 tokens，
// 工作台「模型 / 会话 / 每日」三张表当天全空。代码侧已修（lib/ledgerCarry.ts +
// localStore.replaceMessages），但**已经写坏的数据不会自己回来**，需要本脚本回填一次。
//
// 安全设计：
//   · 默认 dry-run：只打印「将补多少」，不写盘；确认后加 --apply 才落盘。
//   · 落盘前自动把当前库复制一份 `<file>.pre-repair-<时间戳>.bak`。
//   · 只做**加法**：每条消息的 token/modelName/createdAt 只会被补上或保持不变，
//     不会删消息、不改正文、不改会话结构。总量只会向备份的值靠拢，不会超过它。
//   · 复用 lib/ledgerCarry.ts 的 carryLedger（与运行时同一份实现，不复制算法）。
//
// ⚠ 必须在应用**完全退出**后执行：应用内存里有一份 localStore，运行中写盘会被它覆盖。
//
// 用法：
//   node --experimental-strip-types desktop/scripts/repair-desk-ledger.mjs                # 演练
//   node --experimental-strip-types desktop/scripts/repair-desk-ledger.mjs --apply        # 执行
//   node --experimental-strip-types desktop/scripts/repair-desk-ledger.mjs --from <file>  # 指定备份
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const { carryLedger } = await import(pathToFileURL(path.join(import.meta.dirname, '../renderer/src/lib/ledgerCarry.ts')).href);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fromArg = (() => {
  const i = args.indexOf('--from');
  return i >= 0 ? args[i + 1] : '';
})();
// 兜底模型名：备份里若该会话的 modelName 也已被更早一次压缩抹空，回填只能补 token 不能补模型名。
// 此时由调用方显式给出（例：--fallback-model=flint，依据是该会话最近一次运行的 trace run_start.model）。
const fallbackModelArg = (() => {
  const hit = args.find((a) => a.startsWith('--fallback-model='));
  return hit ? hit.slice('--fallback-model='.length) : '';
})();

const dataDir = path.join(os.homedir(), 'Library/Application Support/mj-code-desktop');
const curFile = path.join(dataDir, 'local-data.json');

const sumOf = (msgs) => msgs.reduce((s, m) => s + (Number(m.tokensInput) || 0) + (Number(m.tokensOutput) || 0), 0);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** 候选备份：同目录 local-data.YYYY-MM-DD.json，按日期倒序 */
function candidates() {
  if (fromArg) return [fromArg];
  return fs.readdirSync(dataDir)
    .filter((n) => /^local-data\.\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .reverse()
    .map((n) => path.join(dataDir, n));
}

if (!fs.existsSync(curFile)) {
  console.error(`找不到当前库：${curFile}`);
  process.exit(1);
}
const cur = readJson(curFile);
const curMsgs = cur.messages || [];

// 选「能补得最多」的备份，而不是最新那份：最新那份本身可能已是压缩后的坏数据。
let best = null;
for (const f of candidates()) {
  let d;
  try { d = readJson(f); } catch { continue; }
  const total = sumOf(d.messages || []);
  if (!best || total > best.total) best = { file: f, data: d, total };
}
if (!best) {
  console.error('没有可用备份（local-data.YYYY-MM-DD.json 或 --from 指定文件）');
  process.exit(1);
}

const bakMsgs = best.data.messages || [];
const curTotal = sumOf(curMsgs);
console.log(`当前库: ${curFile}  消息 ${curMsgs.length} 条 / token ${curTotal.toLocaleString()}`);
console.log(`参照备份: ${path.basename(best.file)}  消息 ${bakMsgs.length} 条 / token ${best.total.toLocaleString()}`);

// 按会话分组，只处理「备份里比我多」的会话（多出来的就是被压缩抹掉的部分）
const groupBy = (msgs) => {
  const m = new Map();
  for (const x of msgs) {
    const k = String(x.threadId);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};
const curByThread = groupBy(curMsgs);
const bakByThread = groupBy(bakMsgs);

const titleOf = new Map((cur.threads || []).map((t) => [String(t.id), t]));
const bakTitleOf = new Map((best.data.threads || []).map((t) => [String(t.id), t]));

const nextMessages = [];
let restored = 0;
const report = [];

for (const x of curMsgs) {
  const k = String(x.threadId);
  nextMessages.push(x); // 占位，稍后按会话整段替换
}

for (const [tid, bakList] of bakByThread) {
  const curList = curByThread.get(tid);
  if (!curList || curList.length === 0) continue; // 当前已无该会话：不动（可能是用户删了）
  const curSum = sumOf(curList);
  const bakSum = sumOf(bakList);
  if (bakSum <= curSum) continue; // 没被抹过
  const patched = carryLedger(bakList, curList, fallbackModelArg);
  const newSum = sumOf(patched);
  const gained = newSum - curSum;
  restored += gained;
  // 整段替换：保持当前库的消息顺序与 id
  const startIdx = nextMessages.findIndex((m) => String(m.threadId) === tid);
  let cursor = 0;
  for (let i = 0; i < nextMessages.length; i += 1) {
    if (String(nextMessages[i].threadId) === tid) {
      const p = patched[cursor];
      cursor += 1;
      if (p) {
        nextMessages[i] = {
          ...nextMessages[i],
          tokensInput: Number(p.tokensInput) || 0,
          tokensOutput: Number(p.tokensOutput) || 0,
          modelName: String(p.modelName || nextMessages[i].modelName || ''),
          createdAt: Number(p.createdAt) || nextMessages[i].createdAt,
        };
      }
    }
  }
  if (startIdx < 0) continue;
  // 会话级模型名同样可能被抹空（thread.modelName=''），从备份补
  const t = titleOf.get(tid);
  const bt = bakTitleOf.get(tid);
  if (t && !String(t.modelName || '').trim()) {
    const fromBak = String(bt?.modelName || '').trim();
    if (fromBak) t.modelName = fromBak;
    else if (fallbackModelArg) t.modelName = fallbackModelArg;
  }
  report.push({ tid, title: String(t?.title || '').slice(0, 20), curSum, newSum, gained });
}

report.sort((a, b) => b.gained - a.gained);
console.log('\n可回填的会话：');
for (const r of report) {
  console.log(`  会话 ${r.tid} ${r.title}  ${r.curSum.toLocaleString()} → ${r.newSum.toLocaleString()}  (+${r.gained.toLocaleString()})`);
}
console.log(`\n合计可回填 ${restored.toLocaleString()} tokens（${report.length} 个会话）`);

if (report.length === 0) {
  console.log('无需修复：当前库记账已不低于备份。');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n[dry-run] 未写盘。确认无误后加 --apply 执行（请先完全退出应用）。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${curFile}.pre-repair-${stamp}.bak`;
fs.copyFileSync(curFile, backupPath);
cur.messages = nextMessages;
fs.writeFileSync(curFile, JSON.stringify(cur, null, 2));
console.log(`\n已写盘。原文件备份：${backupPath}`);
console.log(`复核：token 总量 ${sumOf(nextMessages).toLocaleString()}`);
