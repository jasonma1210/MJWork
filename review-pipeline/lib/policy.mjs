#!/usr/bin/env node
// review-pipeline/lib/policy.mjs
// 分类 → 证法 的硬绑定校验（单一事实来源：policy/classification.json）。
// 用途：任何 T 脚本在动手前调用；不匹配即退出码 4，不进入取证。
//
// 用法：
//   node policy.mjs --check --task T-07-1 --proof counterfactual
//   node policy.mjs --check --item P0-8  --proof counterfactual
//   node policy.mjs --list
//
// 退出码：0 通过 / 4 违规（含 C 类红线）/ 2 参数错误

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'policy', 'classification.json'), 'utf8'));

const PROOF_TO_CLASSES = {
  counterfactual: ['A', 'B'],
  existence: ['C'],
  mutation: ['D'],
};

function fail(code, payload) {
  console.error(JSON.stringify({ verdict: 'VIOLATION', ...payload }, null, 2));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { mode: null, task: null, item: null, proof: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.mode = 'check';
    else if (a === '--list') out.mode = 'list';
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--item') out.item = argv[++i];
    else if (a === '--proof') out.proof = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.mode === 'list') {
  console.log(JSON.stringify({ tasks: POLICY.tasks, items: POLICY.items, classes: POLICY.classes }, null, 2));
  process.exit(0);
}

if (args.mode !== 'check') fail(2, { reason: 'usage: --check --task <T> --proof <P> | --list' });
if (!args.proof) fail(2, { reason: 'missing --proof' });
if (!['counterfactual', 'existence', 'mutation', 'baseline', 'census', 'premise', 'formalization', 'metrics', 'verify'].includes(args.proof)) {
  fail(2, { reason: `unknown proof kind: ${args.proof}` });
}

// ── 任务级校验 ────────────────────────────────────────────────────────────
if (args.task) {
  const t = POLICY.tasks[args.task];
  if (!t) fail(4, { rule: 'UNKNOWN_TASK', task: args.task, reason: '任务不在计划任务表内（禁止新增/改名任务）' });
  if (t.proof !== args.proof) {
    fail(4, {
      rule: 'PROOF_MISMATCH',
      task: args.task,
      declared: args.proof,
      expected: t.proof,
      reason: '该任务在计划中的合法证法与本次声明不一致（证法不允许混用）',
    });
  }
  const allowed = PROOF_TO_CLASSES[args.proof];
  if (allowed) {
    for (const id of t.items || []) {
      const item = POLICY.items[id];
      if (!item) fail(4, { rule: 'UNKNOWN_ITEM', task: args.task, item: id });
      if (!allowed.includes(item.class)) {
        fail(4, {
          rule: item.class === 'C' ? 'C_CLASS_REDLINE' : 'CLASS_PROOF_MISMATCH',
          task: args.task,
          item: id,
          itemClass: item.class,
          declaredProof: args.proof,
          reason:
            item.class === 'C'
              ? 'C 类条目不存在实现路径，绝对禁止反事实红绿分支，只允许存在性否证'
              : `该条目分类为 ${item.class}，合法证法为 ${POLICY.classes[item.class].legalProof.join('/')}`,
        });
      }
    }
  }
  console.log(JSON.stringify({ verdict: 'PASS', task: args.task, proof: t.proof, items: t.items || [], note: t.note || null }, null, 2));
  process.exit(0);
}

// ── 条目级校验 ────────────────────────────────────────────────────────────
if (args.item) {
  const item = POLICY.items[args.item];
  if (!item) fail(4, { rule: 'UNKNOWN_ITEM', item: args.item, reason: '条目不在计划 P0/P1 表内（禁止新增审查项）' });
  const legal = POLICY.classes[item.class].legalProof;
  const forbidden = POLICY.classes[item.class].forbiddenProof || [];
  if (forbidden.includes(args.proof)) {
    fail(4, {
      rule: item.class === 'C' && args.proof !== 'existence' ? 'C_CLASS_REDLINE' : 'FORBIDDEN_PROOF',
      item: args.item,
      itemClass: item.class,
      declaredProof: args.proof,
      legalProof: legal,
      reason: POLICY.classes[item.class].rule,
    });
  }
  if (!legal.includes(args.proof)) {
    fail(4, { rule: 'CLASS_PROOF_MISMATCH', item: args.item, itemClass: item.class, declaredProof: args.proof, legalProof: legal });
  }
  console.log(JSON.stringify({ verdict: 'PASS', item: args.item, itemClass: item.class, proof: args.proof, rule: POLICY.classes[item.class].rule }, null, 2));
  process.exit(0);
}

fail(2, { reason: 'need --task or --item' });
