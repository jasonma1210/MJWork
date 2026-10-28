#!/usr/bin/env node
// 发布前置检查（preflight）—— 发布流水线的第一道闸。
//
// 为什么需要：发版事故的共同形态不是「代码写错」，而是「元数据没跟上」——
// 版本号只改了一处、CHANGELOG 没写、tag 重复、从脏工作区打包、分支不对。
// 这些用眼睛看很容易漏，而且漏了以后补救成本极高（已上架的包要重发、tag 要删）。
// 所以做成可执行断言，人能忘，脚本不会。
//
// 设计纪律：
//   · **fail-closed**：任一硬项不满足 → exit 1。
//   · **只做机器能判的**：签名证书、真机验证、文案审校这类不给假勾选，明列到「人工项」输出里。
//   · **每条断言都要能被证伪**：自证伪见 test/manual/preflight-selftest.mjs。
//
// 用法：
//   node scripts/preflight-release.mjs              # 完整检查
//   node scripts/preflight-release.mjs --skip-git    # 跳过 git 相关（CI 内 tag 触发时用：detached HEAD 不适用分支检查）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '..');
const SKIP_GIT = process.argv.includes('--skip-git');

const results = [];
function check(name, fn) {
  try { results.push({ ok: true, name, detail: fn() || '' }); }
  catch (e) { results.push({ ok: false, name, detail: e?.message || String(e) }); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8'));
// stdio 只取 stdout：P5 用 `rev-parse --verify` 探测 tag 是否存在，不存在时 git 会往 stderr
// 打 "fatal: Needed a single revision" —— 那是**预期探测**，不该污染发布日志（已实测泄漏过一次）。
const git = (args) => execFileSync('git', args, {
  cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

// ── P1 三处 package.json 版本一致 ────────────────────────────────────────────
// CHANGELOG 开头写明「desktop / server / renderer 三个 package.json 必须保持一致」。
// 只改一处会让 server 与客户端握手对不上（/api/v1 版本协商）。
const PKGS = ['desktop/package.json', 'desktop/renderer/package.json', 'server/package.json'];
let version = '';
check('P1 三处 package.json 版本一致', () => {
  const vs = PKGS.map((p) => ({ p, v: readJson(p).version }));
  version = vs[0].v;
  const bad = vs.filter((x) => x.v !== version);
  assert(bad.length === 0, `不一致：${vs.map((x) => `${x.p}=${x.v}`).join(', ')}`);
  return `${version}（3 处）`;
});

// ── P2 版本号格式合法（semver 主体 + 可选预发布标识）────────────────────────
check('P2 版本号格式合法（x.y.z 或 x.y.z-<prerelease>）', () => {
  assert(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version), `版本号不合规：${version}`);
  return version;
});

// ── P3 CHANGELOG 有对应版本条目 ──────────────────────────────────────────────
// 发布产物会被用户拿去对照"这版改了什么"。没有条目的版本等于让用户猜。
check('P3 CHANGELOG 含当前版本条目且内容非空', () => {
  const md = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  // 按二级标题切段再比对版本号 —— 比正则跨段匹配可靠。
  // （正则版曾用 (?=\s*$)，在 m 模式下 $ 是行尾，非贪婪立刻停在第一个空行 ⇒ body 恒为空，假红。）
  const sections = md.split(/^## /m);
  const target = sections.find((s) => s.startsWith(`[${version}]`));
  assert(target, `CHANGELOG.md 中未找到 "## [${version}]" 条目（发布前必须补）`);
  const body = target.split('\n').slice(1).join('\n').trim();
  assert(body.length >= 40, `CHANGELOG [${version}] 条目内容过短（${body.length} 字符），疑似占位`);
  return `${body.split('\n').length} 行`;
});

// ── P4 工作区干净 ────────────────────────────────────────────────────────────
// 发布必须基于一个确定的提交：脏工作区打出来的包无法用 commit 回溯，
// 出问题也没法复现。这一条经常被"我就改了一行"绕过，所以必须机器判。
check('P4 工作区干净（发布必须基于确定提交）', () => {
  if (SKIP_GIT) return '已跳过（--skip-git）';
  const out = git(['status', '--porcelain']);
  assert(out === '', `有未提交改动 ${out.split('\n').length} 处，先提交再发版：\n     ${out.split('\n').slice(0, 5).join('\n     ')}`);
  return `HEAD ${git(['rev-parse', '--short', 'HEAD'])}`;
});

// ── P5 tag 与版本号的关系（两个场景语义相反，必须分开判）──────────────��─────────
//   · 本地发布前：tag 必须**尚未存在**（否则会重发旧包 / CI 直接把 tag 当已发布）
//   · CI tag 触发时：tag 必然已存在（就是它触发的）——此时该判「tag == v<version>」，
//     即校验"打 tag 的时候版本号到底改了没有"。若合成一条断言，CI 里恒定假红。
const FOR_TAG = process.argv.includes('--for-tag') || process.env.GITHUB_REF_TYPE === 'tag';
check(FOR_TAG ? 'P5 触发 tag 与 package.json 版本一致' : 'P5 git tag v<version> 未被占用', () => {
  if (SKIP_GIT) return '已跳过（--skip-git）';
  const want = `v${version}`;
  if (FOR_TAG) {
    const ref = process.env.GITHUB_REF_NAME || git(['describe', '--tags', '--exact-match', 'HEAD']);
    assert(ref === want, `触发 tag "${ref}" ≠ 版本号推出的 "${want}" —— 打 tag 前忘了升版本号？`);
    return `${ref}（tag 触发，已校验一致）`;
  }
  let exists = false;
  try { git(['rev-parse', '--verify', `refs/tags/${want}`]); exists = true; } catch { exists = false; }
  assert(!exists, `tag ${want} 已存在 —— 版本号必须先升（当前 ${version}）`);
  return want;
});

// ── P6 分支正确 ──────────────────────────────────────────────────────────────
// tag 触发时是 detached HEAD，`git branch --show-current` 返回空串 —— 直接判分支会恒定假红。
// 这里只在本地（非 tag 场景）判分支；tag 场景的「tag 必须打在 main 上」列为人工项
// （CI checkout 默认 fetch-depth:1，校验 origin/main 需要额外 fetch，会引入新的失败点）。
check('P6 从 main 分支发布（本地场景）', () => {
  if (SKIP_GIT) return '已跳过（--skip-git）';
  if (FOR_TAG) return 'tag 触发（detached HEAD），分支归属见人工项①';
  const b = git(['branch', '--show-current']);
  assert(b === 'main', `当前分支 ${b || '(detached)'}，发布应从 main 发起`);
  return b;
});

// ── P7 发布期门禁脚本齐备 ────────────────────────────────────────────────────
check('P7 打包冒烟脚本存在（发布前必须能验证产物）', () => {
  const p = path.join(ROOT, 'scripts', 'smoke-packaged.mjs');
  assert(fs.existsSync(p), `缺 ${p}`);
  return 'scripts/smoke-packaged.mjs';
});

check('P8 关键安全门禁套件存在（回归兜底）', () => {
  const need = ['test/security-guards.test.mjs', 'test/renderer-guards.test.mjs', 'test/checkpointStore.test.js'];
  const miss = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert(miss.length === 0, `缺门禁：${miss.join(', ')}`);
  return need.join(', ');
});

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`发布前置检查（版本 ${version || '解析失败'}${SKIP_GIT ? '，git 项已跳过' : ''}）\n`);
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail.split('\n')[0]}` : ''}`);
  if (!r.ok && r.detail.includes('\n')) console.log(r.detail.split('\n').slice(1).join('\n'));
}

// 人工项：机器判不了的，明列出来，不给假勾选
console.log('\n── 以下项目机器无法判定，发布前必须人工确认 ──');
for (const line of [
  '① 签名证书就位后：package.json 的 verifyUpdateCodeSignature 改回 true 并补 build.win.publisherName（值须等于证书 Subject CN）',
  '② macOS 真机安装一次 dmg，确认能启动、能建会话、OCR 可用',
  '③ Windows / Linux 产物尚未纳入自动冒烟（见 B6 报告 5.4），发这两个平台前需人工核验',
  '④ CHANGELOG 面向用户的措辞已审校（不暴露内部代号 / 未定事项）',
  '⑤ 发布流水中冒烟失败时坏包已上架，需人工下架（见 B6 报告 5.3）',
]) console.log(`   ${line}`);

if (failed.length) {
  console.error(`\n❌ 发布前置检查失败 ${failed.length} 项 —— 不满足发布条件。`);
  process.exit(1);
}
console.log('\n✅ 机器可判项全部通过（人工项仍需逐条确认）');
