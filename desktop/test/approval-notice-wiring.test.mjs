#!/usr/bin/env node
// P2-7「执行后告知」的 UI 接线门禁
//
// 背景：这一项的缺陷不是「代码没写」，而是**主进程在发事件、渲染层没人收、设置页没开关**——
// 机制全对但用户完全看不见。它和 mcp_status 死信是同型问题：
//   生产方存在 + 消费方为零 ⇒ 所有测试绿，功能对用户不存在。
//
// 因此在加完 UI 之后必须有一条门禁锁住「生产 → 消费 → 开关 → 持久化同步」整条链，
// 否则某次重构删掉其中一环，仍然全绿。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
const read = (p) => {
  const f = path.join(SRC, p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));

const fb = read('components/feedback.jsx');
const settings = read('components/SettingsModal.jsx');
const app = read('App.jsx');
const zh = readJson('i18n/locales/zh-CN/settings.json');
const en = readJson('i18n/locales/en-US/settings.json');

// ── 自检：文件都读到了 ─────────────────────────
check('被测文件均存在且非空', [fb, settings, app].every((s) => typeof s === 'string' && s.length > 500));

// ── ① 消费方：feedback.jsx 真的在收 approval_notice 并弹 toast ──
const consumeBlock = (fb?.match(/onTasksEvent\(\(evt\)\s*=>\s*\{[\s\S]{0,900}/) || [''])[0];
check('feedback.jsx 订阅了 tasks:event', /onTasksEvent/.test(fb || ''));
check('消费回调按 approval_notice 过滤（不是把所有任务事件都弹出来）',
  /evt\.type\s*!==\s*'approval_notice'/.test(consumeBlock));
check('消费回调真的调用 toast 展示',
  /toast\(\{/.test(consumeBlock));
check('不可补偿时单独追加 reversibleNote（通知的核心价值）',
  /reversible\s*===\s*false/.test(consumeBlock) && /reversibleNote/.test(consumeBlock));

// ── ② 设置开关 ────────────────────────────────
check('SettingsModal 渲染 approvalNotice 开关',
  /settings\.approvalNotice/.test(settings || ''));
check('开关读写 approvalSettings.approval_notice（严格 === true 语义）',
  /approval_notice/.test(settings || ''));
check('开关回调走 onApprovalSettingsChange（与档位设置同一状态源）',
  /onApprovalSettingsChange\?\.\(\{\s*\.\.\.approvalSettings,\s*approval_notice/.test(settings || ''));

// ── ③ 持久化同步：主进程靠 preferences 读取，渲染层必须同步 ──
// F-004：这段同步随偏好持久化搬进了 hooks/useUiPreferences.ts，判据跟到新家；
// 同时也要求 App.jsx 真的接了这个 hook（否则 hook 内正则绿、接线已断）。
check('App 把 approval_settings 同步到主进程偏好',
  /localSetPreference\?\.\(\{[\s\S]{0,80}approval_settings/.test(read('hooks/useUiPreferences.ts') || '')
  && /\} = useUiPreferences\(\)/.test(app || ''));

// ── ④ 双语 key 齐备且占位一致 ──────────────────
const KEYS = [
  'approvalNotice', 'approvalNoticeDesc', 'approvalNoticeOk', 'approvalNoticeFail',
  'approvalNoticeExecuted', 'approvalNoticeExecutedNoMs', 'approvalNoticeIrreversible',
];
check('zh-CN 七个 key 齐备', KEYS.every((k) => typeof zh[k] === 'string' && zh[k].length > 0),
  KEYS.filter((k) => !(typeof zh[k] === 'string' && zh[k].length > 0)).join(',') || '全有');
check('en-US 七个 key 齐备', KEYS.every((k) => typeof en[k] === 'string' && en[k].length > 0),
  KEYS.filter((k) => !(typeof en[k] === 'string' && en[k].length > 0)).join(',') || '全有');
check('插值占位在两种语言里一致（否则译后丢参数）', (() => {
  const ph = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
  return KEYS.every((k) => ph(zh[k]) === ph(en[k]));
})());

// ── ⑤ 主进程侧：textKey 与 emit 出口仍在（防「备了 key 没人发」反向复发）──
const approvalSrc = fs.readFileSync(path.join(DESKTOP, 'main/approval.js'), 'utf8');
check('主进程仍以 approval_notice 事件类型产出', /type:\s*'approval_notice'/.test(approvalSrc));
check('主进程仍带 textKey（非桌面宿主可用）', /textKey:\s*'approval\.notice\.executed'/.test(approvalSrc));

console.log(`\napproval-notice-wiring: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
