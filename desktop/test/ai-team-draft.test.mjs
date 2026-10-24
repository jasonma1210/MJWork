#!/usr/bin/env node
// AI 建团草案门禁（设计文档 §7.4 路径② / §8.2 / §14 P1-8）
//
// 断言范式纪律：**行为断言**，直接跑真实实现（真目录 + 真 IPC handler + 真 DB），
// 不断言源码形态。覆盖三条产品契约：
//   ① 目录优先匹配：命中数字员工目录 ⇒ 带 source / templateRef / matchScore；
//   ② 覆盖度报告能**看见缺口**（需求要的能力没人扛时必须报出来）；
//   ③ 只出草稿不落库（team_members 表行数不变）——执行前确认的门因此天然存在。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(import.meta.dirname, '..');

// ── electron stub（主进程模块顶层 require electron，纯 node 下需要）──
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-ai-team-'));
const ipcHandlers = new Map();
stub.exports = {
  app: {
    // userData 指向临时目录（自定义员工目录为空 ⇒ 只读内置目录）；
    // getAppPath 指向 desktop/ ⇒ 生态目录回落仓库根 ecosystem/（含 51 条数字员工）
    getPath: () => TMP,
    getAppPath: () => ROOT,
    getHome: () => TMP,
    whenReady: () => Promise.resolve(),
    on: () => {},
  },
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: () => {},
    once: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
};
require.cache[electronPath] = stub;

const { TeamStore } = require(path.join(ROOT, 'main/teamStore.js'));
const { openDbAsync } = require(path.join(ROOT, 'main/db/index.js'));
const { initTeamsIpc } = require(path.join(ROOT, 'main/ipc/teams.js'));

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const FAKE_MODEL = { providerId: 'p', baseUrl: 'https://x.example', model: 'm' };

/** 假模型通道：返回指定的草案 JSON */
function fakeChat(payload) {
  const calls = [];
  const fn = async () => { calls.push(1); return { content: JSON.stringify(payload) }; };
  fn.calls = calls;
  return fn;
}

await (async () => {
  // 真库：用来证明「只出草稿不落库」
  const db = await openDbAsync(path.join(TMP, 'db'), { driver: 'sqljs' });
  const store = new TeamStore(db);
  const team = store.createTeam({ name: '已有小组', description: '落库计数基准', projectPath: '' });
  store.addMember(team.id, { name: '既有成员', source: 'custom', systemPrompt: 'x', toolNames: ['read'] });
  const countRows = () => db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n;
  const rowsBefore = countRows();

  let chat = fakeChat({});
  initTeamsIpc({
    getTeamStore: () => store,
    chatOnce: (...a) => chat(...a),
    resolveModel: () => FAKE_MODEL,
  });
  const draftTeamHandler = ipcHandlers.get('teams:draftTeam');
  assert.ok(draftTeamHandler, 'teams:draftTeam 必须已注册');

  // ── ① 目录优先匹配 ──

  await check('目录优先：命中数字员工目录 ⇒ 带 source/templateRef/matchScore', async () => {
    chat = fakeChat({
      name: '查证小组',
      description: '联网查证并汇总',
      requiredCapabilities: ['read', 'write', 'plan'],
      members: [
        { roleKind: 'lead', role: '统筹与汇总', source: 'employee', templateRef: 'de-data-analyst', fit: 0.8 },
        { roleKind: 'member', role: '补充分析', source: 'custom', name: '分析员', systemPrompt: '你负责数据分析。', tools: ['read', 'write'], approvalPolicy: 'on-request', sandboxPolicy: 'read-only' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '我要一个能查证并汇总的小组', size: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.draft.members.length, 2);
    const first = r.draft.members[0];
    assert.equal(first.source, 'template', '目录命中的成员来源必须是 template（落库枚举）');
    assert.equal(first.templateRef, 'de-data-analyst');
    assert.equal(first.employeeMatched, true);
    assert.equal(typeof first.matchScore, 'number');
    assert.ok(first.matchScore > 0 && first.matchScore <= 1, `matchScore 应在 (0,1]，实际 ${first.matchScore}`);
    // 模板成员的工具来自目录模板，不是模型凭空给的
    assert.ok(Array.isArray(first.toolNames) && first.toolNames.includes('read_file'));
    assert.ok(first.systemPrompt.length > 0, '模板成员必须带目录里的角色提示');
  });

  await check('目录优先：目录里没有的 templateRef ⇒ 该成员被移除并留下告警（fail-closed）', async () => {
    chat = fakeChat({
      name: 'x', description: 'x', requiredCapabilities: [],
      members: [
        { roleKind: 'member', role: '不存在的人', source: 'employee', templateRef: 'de-not-exist-xyz' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '组个队', size: 3 });
    assert.equal(r.ok, false, '全部成员都无效时应明确失败，而不是返回空草案');
    assert.ok(r.error);
    // 必须是「成员被剔除导致没有可用成员」这一**具体**失败形态：
    // 若实现改成崩在别处（抛错/空指针），错误文案不同 ⇒ 本条会红（防变异空过）
    assert.ok(r.error.includes('没有可用成员'), `失败原因须是成员被剔除，实际：${r.error}`);
  });

  await check('目录优先：成员数受 size 约束（不多给）', async () => {
    chat = fakeChat({
      name: 'x', description: 'x', requiredCapabilities: [],
      members: [
        { roleKind: 'lead', role: 'a', source: 'employee', templateRef: 'de-data-analyst' },
        { roleKind: 'member', role: 'b', source: 'employee', templateRef: 'de-software-engineer' },
        { roleKind: 'member', role: 'c', source: 'employee', templateRef: 'de-researcher' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '组个队', size: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.draft.members.length, 2);
  });

  // ── ② 非法工具别名被丢弃（白名单 = ROLE_TOOL_ALIASES 的键）──

  await check('工具白名单：非法别名被丢弃，合法别名保留', async () => {
    chat = fakeChat({
      name: 'x', description: 'x', requiredCapabilities: [],
      members: [
        { roleKind: 'member', role: 'a', source: 'custom', name: '工具怪', systemPrompt: 'p', tools: ['web', 'evil_tool', 'WEB', 'read', ''], approvalPolicy: 'on-request', sandboxPolicy: 'read-only' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '组个队', size: 3 });
    assert.equal(r.ok, true);
    const m = r.draft.members[0];
    assert.deepEqual(m.tools, ['web', 'read'], `非法别名必须被丢弃，实际 ${JSON.stringify(m.tools)}`);
    assert.ok(m.toolNames.every((t) => ['read_file', 'list_dir', 'web_search', 'web_fetch'].includes(t)),
      `toolNames 只能是引擎具体工具名，实际 ${JSON.stringify(m.toolNames)}`);
  });

  await check('工具白名单：非法审批/沙箱档位被归一到保守默认（fail-closed）', async () => {
    chat = fakeChat({
      name: 'x', description: 'x', requiredCapabilities: [],
      members: [
        { roleKind: 'member', role: 'a', source: 'custom', name: '档位怪', systemPrompt: 'p', tools: ['read'], approvalPolicy: 'yolo', sandboxPolicy: 'root' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '组个队', size: 3 });
    assert.equal(r.ok, true);
    const m = r.draft.members[0];
    assert.equal(m.approvalMode, 'on-request');
    assert.equal(m.sandboxPolicy, 'workspace-write');
  });

  // ── ③ 覆盖度报告能看见缺口 ──

  await check('覆盖度报告：需求要的能力没人扛 ⇒ missing/warnings 非空且 sufficient=false', async () => {
    chat = fakeChat({
      name: 'x', description: 'x',
      requiredCapabilities: ['web', 'execute', 'plan'],
      members: [
        { roleKind: 'member', role: '只会读', source: 'custom', name: '读手', systemPrompt: 'p', tools: ['read'], approvalPolicy: 'on-request', sandboxPolicy: 'read-only' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '要能联网查证并跑命令', size: 3 });
    assert.equal(r.ok, true);
    const cov = r.draft.coverage;
    assert.ok(cov, '必须带覆盖度报告');
    assert.equal(cov.sufficient, false);
    assert.ok(cov.missing.includes('web'), `缺 web，实际 missing=${JSON.stringify(cov.missing)}`);
    assert.ok(cov.missing.includes('execute'));
    assert.ok(cov.missing.includes('plan'), '没有统筹 ⇒ plan 能力缺失');
    assert.ok(cov.warnings.length >= 3, `每条缺口都要有人话提示，实际 ${cov.warnings.length} 条`);
    assert.ok(cov.warnings.some((w) => w.includes('web')), '提示里要点名缺失的能力');
  });

  await check('覆盖度报告：能力都有人扛 ⇒ sufficient=true', async () => {
    chat = fakeChat({
      name: 'x', description: 'x',
      requiredCapabilities: ['read', 'web'],
      members: [
        { roleKind: 'lead', role: '统筹', source: 'custom', name: '统筹', systemPrompt: 'p', tools: ['read'], approvalPolicy: 'on-request', sandboxPolicy: 'read-only' },
        { roleKind: 'member', role: '查证', source: 'custom', name: '查证员', systemPrompt: 'p', tools: ['web'], approvalPolicy: 'on-request', sandboxPolicy: 'read-only' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '联网查证', size: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.draft.coverage.sufficient, true);
    assert.deepEqual(r.draft.coverage.missing, []);
  });

  // ── ④ 只出草稿不落库 ──

  await check('只出草稿不落库：team_members 行数不变', async () => {
    chat = fakeChat({
      name: 'x', description: 'x', requiredCapabilities: ['read'],
      members: [
        { roleKind: 'lead', role: 'a', source: 'employee', templateRef: 'de-data-analyst' },
        { roleKind: 'member', role: 'b', source: 'custom', name: '新人', systemPrompt: 'p', tools: ['read'], approvalPolicy: 'on-request', sandboxPolicy: 'read-only' },
      ],
    });
    const r = await draftTeamHandler(null, { requirement: '组个队', size: 3, teamId: team.id });
    assert.equal(r.ok, true);
    assert.equal(r.draft.members.length, 2);
    assert.equal(countRows(), rowsBefore, '出草案不得写 team_members 表');
    assert.equal(store.getTeam(team.id).members.length, 1, '既有团队的成员数不得变化');
  });

  await check('只出草稿不落库：草案里没有落库 id（成员只有目录/模型来源信息）', async () => {
    const r = await draftTeamHandler(null, { requirement: '组个队', size: 3 });
    for (const m of r.draft.members) {
      assert.equal(m.id, undefined, '草案成员不应带落库 id（未落库）');
      assert.ok(['template', 'custom'].includes(m.source));
    }
  });

  // ── ⑤ 契约健壮性 ──

  await check('需求为空 ⇒ 明确失败（不返回空草案）', async () => {
    chat = fakeChat({ name: 'x', description: 'x', members: [] });
    const r = await draftTeamHandler(null, { requirement: '   ' });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  await check('模型输出不可解析 ⇒ 明确失败', async () => {
    const bad = async () => ({ content: '完全不是 JSON' });
    const r = await draftTeamHandler(null, { requirement: '组个队' });
    // 上面用的是正常 chat；这里单独覆盖异常分支
    const prev = chat;
    chat = bad;
    const r2 = await draftTeamHandler(null, { requirement: '组个队' });
    chat = prev;
    assert.equal(r2.ok, false);
    assert.ok(r2.error);
    assert.ok(r);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  console.log(`\nai-team-draft: ${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})();
