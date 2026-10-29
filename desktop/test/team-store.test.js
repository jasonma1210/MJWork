// M5 / T5-1 军团编制存储层测试（sql.js 驱动）：
//   编制持久化 / 重启恢复 / source 两入口同表 / 缺统筹单一判据 / 枚举 fail-closed 回落
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const {
  TeamStore, mapToolAliases, normalizeBudget, leadMissing, MAX_MEMBERS_PER_TEAM,
} = require('../main/teamStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-teams-'));
  // 与 taskStore.test.js 同款：测试走 sql.js（WASM，零原生模块依赖）
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TeamStore(db);

  // ── 建团队与必填校验 ──
  let threw = false;
  try { store.createTeam({ name: '', description: 'd', projectPath: '/p' }); } catch { threw = true; }
  check('缺团队名被拒', threw);
  threw = false;
  try { store.createTeam({ name: 'n', description: '   ', projectPath: '/p' }); } catch { threw = true; }
  check('缺团队目标被拒', threw);

  // 2026-10-20 用户反馈修正：军团不强制绑定项目（原「缺归属项目被拒」断言已反转）——
  // projectPath 留空 = 全局团队，可在任意项目/会话的 `+ → 军团` 中派活
  const globalTeam = store.createTeam({ name: '全局组', description: '跨项目复用', projectPath: '' });
  check('项目留空可建（全局团队）', globalTeam.projectPath === '');

  const team = store.createTeam({
    name: '内容小组', description: '负责内容生产', projectPath: '/proj/a',
  });
  check('建团队成功', !!team.id && team.name === '内容小组' && team.projectPath === '/proj/a');
  check('新团队 default_mode=lead', team.defaultMode === 'lead');
  check('新团队无统筹（单一判据）', team.leadMissing === true && leadMissing(team) === true);

  // ── 全局可见（2026-10-20 修正：原 D1「按 project_path 过滤、切项目各看各的」已废弃）──
  store.createTeam({ name: '别的项目组', description: 'x', projectPath: '/proj/b' });
  const listAll = store.listTeams({});
  check('军团全局可见：不按 project_path 过滤',
    listAll.some((t) => t.id === team.id)
    && listAll.some((t) => t.projectPath === '/proj/b')
    && listAll.some((t) => t.id === globalTeam.id));

  // ── 两入口同一张表（D3）──
  const custom = store.addMember(team.id, {
    name: '写手', source: 'custom', systemPrompt: '负责撰文', toolNames: ['read', 'write'],
  });
  const tpl = store.addMember(team.id, {
    name: '研究员', source: 'template', templateRef: 'de-researcher', toolNames: ['read', 'web', 'grep'],
  });
  const members = store.listMembers(team.id);
  check('招募与自定义同表共存', members.length === 2);
  check('source 两入口被保留', custom.source === 'custom' && tpl.source === 'template');
  check('template_ref 记录员工 id', tpl.templateRef === 'de-researcher');

  // ── 抽象工具名映射（复用 T4-3 字典，未知丢弃）──
  const mapped = mapToolAliases(['read', 'bash', 'web', 'git', 'no-such-tool']);
  check('别名映射为具体工具名', mapped.includes('read_file') && mapped.includes('shell') && mapped.includes('web_fetch'));
  check('未知抽象名被丢弃（fail-closed）', !mapped.includes('git') && !mapped.includes('no-such-tool'));
  check('已有具体名原样保留', JSON.stringify(mapToolAliases(['read_file'])) === JSON.stringify(['read_file']));
  check('落库工具名已是具体名', custom.toolNames.includes('write_file') && custom.toolNames.includes('read_file'));

  // ── 枚举 fail-closed 回落 ──
  const bad = store.addMember(team.id, {
    name: '越权尝试', source: 'bogus-source', roleKind: 'bogus-role',
    approvalPolicy: 'bogus-approval', sandboxPolicy: 'bogus-sandbox', state: 'bogus-state',
  });
  check('非法 source 回落 custom', bad.source === 'custom');
  check('非法 roleKind 回落 member', bad.roleKind === 'member');
  check('非法 approvalMode 回落 on-request', bad.approvalMode === 'on-request');
  check('非法 sandboxPolicy 回落 workspace-write', bad.sandboxPolicy === 'workspace-write');
  check('非法 state 回落 idle', bad.state === 'idle');
  check('allowMcp 缺省为 false（最小权限）', bad.allowMcp === false);
  const mcpOn = store.addMember(team.id, { name: '开 MCP', allowMcp: true });
  check('显式 allowMcp=true 被尊重', mcpOn.allowMcp === true);
  // P1-4（2026-10-29）：成员级 MCP 粒度——走**真实 DB**（sql.js）：列存在、写入不丢、读回一致。
  // 只用源码断言不够：占位符与列数错位、列名拼错都只有在真正 INSERT/SELECT 时才炸。
  const mcpScoped = store.addMember(team.id, { name: '限服务', allowMcp: true, mcpAllow: [' filesystem ', 'time', 'time', ''] });
  check('mcpAllow 落库并读回（去空白/去重/丢空）',
    JSON.stringify(mcpScoped.mcpAllow) === JSON.stringify(['filesystem', 'time']),
    JSON.stringify(mcpScoped.mcpAllow));
  check('缺省 mcpAllow 为空数组（不改既有行为）', Array.isArray(bad.mcpAllow) && bad.mcpAllow.length === 0);
  const mcpPatched = store.updateMember(team.id, mcpScoped.id, { mcpAllow: ['github'] });
  check('updateMember 可改 mcpAllow', JSON.stringify(mcpPatched.mcpAllow) === JSON.stringify(['github']));
  check('改 mcpAllow 不影响 allowMcp（补丁是浅合并，不整对象覆盖）', mcpPatched.allowMcp === true);
  store.removeMember(team.id, mcpScoped.id);
  // 清掉这次多建的成员，避免影响后续上限/计数断言
  store.removeMember(team.id, bad.id);
  store.removeMember(team.id, mcpOn.id);

  // ── 预算归一 ──
  check('预算缺省返回 null（不发明默认）', normalizeBudget(null) === null);
  const b = normalizeBudget({ max_rounds: 9999, max_tokens: -5, max_wall_ms: 1 });
  check('预算越界夹紧', b.max_rounds === 50 && b.max_tokens >= 1000 && b.max_wall_ms >= 1000);

  // ── 统筹负责人：指定 / 降级 / 下架清空 ──
  const asLead = store.setLead(team.id, custom.id);
  check('指定 Lead 后不再缺统筹', asLead.leadMissing === false && asLead.leadMemberId === custom.id);
  check('Lead 成员 role_kind=lead', store.getMember(team.id, custom.id).roleKind === 'lead');
  const reassign = store.setLead(team.id, tpl.id);
  check('改派 Lead 后原 Lead 降级为 member', store.getMember(team.id, custom.id).roleKind === 'member');
  check('改派后 lead_member_id 指向新 Lead', reassign.leadMemberId === tpl.id);
  // 2026-10-28 语义修订（用户裁决「一般团队务必有个负责人一样的角色在」）：
  // 下架 Lead 不再清空 lead_member_id（旧行为：回到缺统筹），而是**自动移交**给第一个
  // 其他在册成员 —— 换任/下架都不需要先「退出统筹」，团队在还有成员时永远有统筹。
  // 推翻理由记录：旧断言锁的正是被推翻的产品语义（允许团队无负责人）。
  store.setMemberEnabled(team.id, tpl.id, false);
  const afterDemote = store.getTeam(team.id);
  check('下架 Lead 自动移交统筹给其他在册成员（团队务必有负责人）',
    !!afterDemote.leadMemberId && afterDemote.leadMemberId !== tpl.id
    && afterDemote.leadMissing === false
    && store.getMember(team.id, String(afterDemote.leadMemberId)).roleKind === 'lead');
  threw = false;
  try { store.setLead(team.id, tpl.id); } catch { threw = true; }
  check('已下架成员不能被指定为 Lead', threw);

  // ── 下架语义（软删，不物理删）──
  const removed = store.removeMember(team.id, custom.id);
  check('removeMember 软删：enabled=0 且记 removed_at', removed.enabled === false && typeof removed.removedAt === 'number');
  check('默认列表不含已下架成员', store.listMembers(team.id).every((m) => m.id !== custom.id));
  check('includeDisabled 可见已下架成员', store.listMembers(team.id, { includeDisabled: true }).some((m) => m.id === custom.id));

  // ── 成员上限（对齐 worker 并发上限）──
  const capTeam = store.createTeam({ name: '满员组', description: 'x', projectPath: '/proj/c' });
  for (let i = 0; i < MAX_MEMBERS_PER_TEAM; i++) store.addMember(capTeam.id, { name: `成员${i}` });
  threw = false;
  try { store.addMember(capTeam.id, { name: '溢出' }); } catch { threw = true; }
  check(`超过成员上限 ${MAX_MEMBERS_PER_TEAM} 被拒`, threw);

  // ── 归档 + 取消归档（均不物理删）──
  store.setTeamArchived(team.id, true);
  check('归档后默认列表不含该团队', store.listTeams({}).every((t) => t.id !== team.id));
  check('includeArchived 可见归档团队', store.listTeams({ includeArchived: true }).some((t) => t.id === team.id));
  // 2026-10-20 新增：归档此前不可逆，导致用户建好的军团在 `+ → 军团` 中永久消失（本次报障成因之一）
  store.setTeamArchived(team.id, false);
  check('取消归档后重新可见', store.listTeams({}).some((t) => t.id === team.id));
  store.setTeamArchived(team.id, true); // 复位为归档，供下方「重启后归档状态保持」断言

  // ── 重启恢复：flush 落盘 → 同目录重新打开 ──
  db.flush();
  const db2 = await openDbAsync(dir, { driver: 'sqljs' });
  const store2 = new TeamStore(db2);
  const reloaded = store2.getTeam(team.id);
  check('重启后团队仍在', !!reloaded && reloaded.name === '内容小组');
  const reloadedMembers = store2.listMembers(team.id, { includeDisabled: true });
  check('重启后成员仍在（软删不物理删，历史可追溯）',
    reloadedMembers.some((m) => m.id === tpl.id) && reloadedMembers.some((m) => m.id === custom.id),
    `len=${reloadedMembers.length}`);
  check('重启后下架状态保持', reloadedMembers.filter((m) => m.enabled).length === 0);
  const tplTeam = store2.getTeam(capTeam.id);
  check('重启后成员数保持', tplTeam.members.length === MAX_MEMBERS_PER_TEAM);
  check('重启后归档状态保持', reloaded.archivedAt !== null && reloaded.archivedAt !== undefined);

  // 显式关闭两个连接再退出（与 taskStore.test.js 同纪律）：
  // sqljsDb 在 process 'exit' 里挂了一次兜底 flush，而 Linux CI runner 上
  // 「退出期 flush + fsync」曾把本套件稳定卡到 180s 超时（断言其实早已全部跑完）。
  // 这里先把 db / db2 的脏数据同步落盘并释放 WASM，退出路径不再有 IO。
  db.close();
  db2.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
