// M5 / T5-4 统筹负责人 + 派活校验测试（sql.js 驱动）：
//   一键创建 Lead（模板/默认值/边界） / dispatchGate 三码单一判据 / 派活上下文装配 / 派活错误码
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const {
  TeamStore, leadMissing, dispatchGate,
  LEAD_DEFAULT_NAME, LEAD_DEFAULT_TOOLS, LEAD_SYSTEM_PROMPT,
} = require('../main/teamStore');
// buildTeamContext / DISPATCH_ERRORS / snapshotRoster 是 ipc/teams.js 导出的纯函数（不触发 register，require 安全）
const { buildTeamContext, DISPATCH_ERRORS, snapshotRoster } = require('../main/ipc/teams');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 从 startIdx 处的开括号起，返回配对闭括号的下标（跳过字符串/模板串/注释里的括号）。 */
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === quote) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-team-dispatch-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TeamStore(db);

  // ── 默认模板常量（单一事实来源）──
  check('统筹默认名称存在', LEAD_DEFAULT_NAME === '统筹负责人');
  check('统筹默认工具为抽象名并含读写与检索',
    LEAD_DEFAULT_TOOLS.includes('read') && LEAD_DEFAULT_TOOLS.includes('write')
    && LEAD_DEFAULT_TOOLS.includes('grep') && LEAD_DEFAULT_TOOLS.includes('glob'));
  check('统筹系统提示模板自包含（含职责边界）',
    LEAD_SYSTEM_PROMPT.includes('统筹负责人') && LEAD_SYSTEM_PROMPT.includes('职责边界'));

  // ── dispatchGate：三码单一判据 ──
  check('团队不存在 → TEAM_NOT_FOUND', dispatchGate(null).code === 'TEAM_NOT_FOUND');

  const team = store.createTeam({ name: '交付组', description: '负责交付', projectPath: '/proj/a' });
  const gate0 = dispatchGate(store.getTeam(team.id));
  check('缺统筹 → LEAD_MISSING（派活时才触发强校验）', gate0.ok === false && gate0.code === 'LEAD_MISSING');

  const other = store.addMember(team.id, { name: '工程师', toolNames: ['read', 'write'] });
  check('普通成员不解除缺统筹', leadMissing(store.getTeam(team.id)) === true);

  // ── 一键创建统筹负责人 ──
  const lead = store.createLead(team.id, {});
  const detail = store.getTeam(team.id);
  check('createLead 落库 role_kind=lead', lead.roleKind === 'lead');
  check('createLead 名称缺省回落默认名', lead.name === LEAD_DEFAULT_NAME);
  check('createLead 提示词=默认模板（未落空）', lead.systemPrompt === LEAD_SYSTEM_PROMPT);
  check('createLead 工具名已映射为引擎具体名',
    lead.toolNames.includes('read_file') && lead.toolNames.includes('write_file')
    && lead.toolNames.includes('grep') && lead.toolNames.includes('glob'));
  check('createLead 审批档=on-request / 沙箱=workspace-write',
    lead.approvalMode === 'on-request' && lead.sandboxPolicy === 'workspace-write');
  check('createLead 最小权限（allowMcp=false）', lead.allowMcp === false);
  check('createLead 后 lead_member_id 指向该成员', detail.leadMemberId === lead.id);
  check('createLead 后不再缺统筹', detail.leadMissing === false);

  // ── 边界：已有 Lead / 归档团队均拒绝 ──
  let threw = false;
  try { store.createLead(team.id, {}); } catch { threw = true; }
  check('已有统筹时 createLead 被拒（一键创建=补缺口）', threw);

  threw = false;
  try { store.createLead('no-such-team', {}); } catch { threw = true; }
  check('团队不存在时 createLead 被拒', threw);

  const arch = store.createTeam({ name: '归档组', description: 'x', projectPath: '/proj/b' });
  store.setTeamArchived(arch.id, true);
  threw = false;
  try { store.createLead(arch.id, {}); } catch { threw = true; }
  check('归档团队 createLead 被拒', threw);

  // 自定义名与模型被尊重
  const custom = store.createTeam({ name: '自定义组', description: 'x', projectPath: '/proj/c' });
  const lead2 = store.createLead(custom.id, { name: '  总指挥  ', model: null });
  check('createLead 自定义名去空格生效', lead2.name === '总指挥');

  // ── dispatchGate：齐备 → ok ──
  const gate1 = dispatchGate(store.getTeam(team.id));
  check('有统筹且未归档 → 派活校验通过', gate1.ok === true && gate1.code === null);
  const gateArch = dispatchGate(store.getTeam(arch.id));
  check('已归档 → TEAM_ARCHIVED', gateArch.ok === false && gateArch.code === 'TEAM_ARCHIVED');

  // ── buildTeamContext：派活三件 + 编制清单 + 拆解要求 ──
  const ctx = buildTeamContext(store.getTeam(team.id), {
    mode: 'lead', budget: { max_rounds: 6, max_tokens: 120000, max_wall_ms: 600000 },
  });
  check('上下文含团队名与目标', ctx.includes('交付组') && ctx.includes('负责交付'));
  check('上下文含协作模式说明', ctx.includes('lead'));
  check('上下文含预算上限三键',
    ctx.includes('max_rounds=6') && ctx.includes('max_tokens=120000') && ctx.includes('max_wall_ms=600000'));
  check('上下文标注统筹成员', ctx.includes(LEAD_DEFAULT_NAME) && ctx.includes('统筹'));
  check('上下文要求显式声明 dependsOn（防并行死锁）', ctx.includes('dependsOn'));
  check('上下文要求能力匹配（不串并行任务）', ctx.includes('能力最匹配'));

  // 成员子集：只注入被选中的成员
  const ctxSubset = buildTeamContext(store.getTeam(team.id), {
    mode: 'select', budget: null, memberIds: [lead.id],
  });
  check('memberIds 子集过滤生效（软约束）',
    ctxSubset.includes(LEAD_DEFAULT_NAME) && !ctxSubset.includes('工程师'));
  check('未传 budget 时不渲染预算行', !ctxSubset.includes('预算上限'));

  // ── 派活失败码（渲染层据此分支弹「一键创建」）──
  check('LEAD_MISSING 文案与 §6 F1 一致',
    DISPATCH_ERRORS.LEAD_MISSING === '缺少编排/统筹负责人，需要帮你创建吗？');
  check('错误码覆盖三件必填与三码校验',
    !!DISPATCH_ERRORS.MISSING_GOAL && !!DISPATCH_ERRORS.MISSING_MODE && !!DISPATCH_ERRORS.MISSING_BUDGET
    && !!DISPATCH_ERRORS.TEAM_NOT_FOUND && !!DISPATCH_ERRORS.TEAM_ARCHIVED && !!DISPATCH_ERRORS.LEAD_MISSING);

  // ── T5-9 编制快照（§9.1）：run 启动时对编制打不可变快照，运行期只读快照 ──
  const liveMembers = [
    { id: 'm1', name: '统筹', roleKind: 'lead', systemPrompt: '负责分派', toolNames: ['read_file'], model: 'p::m' },
    { id: 'm2', name: '工程师', roleKind: 'member', toolNames: ['write_file'], enabled: false },
    { name: '缺 id 的脏数据' },
  ];
  const snap = snapshotRoster(liveMembers);
  check('快照只收纳有 id 的成员', snap.length === 2 && snap.every((m) => !!m.id));
  check('快照保留角色/提示词/工具/模型（运行期不再读实时名册）',
    snap[0].roleKind === 'lead' && snap[0].systemPrompt === '负责分派'
    && snap[0].toolNames[0] === 'read_file' && snap[0].model === 'p::m');
  check('快照与实时名册不共享数组引用（运行期改动不影响本次 run）',
    snap[0].toolNames !== liveMembers[0].toolNames);

  // ── B-10：编制快照整体体积闸（成员提示词总字节超限 ⇒ 均分截断 + 可诊断标记）──
  {
    const rosterMod = require('../main/teamRoster');
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `big${i}`, name: `成员${i}`, systemPrompt: '角'.repeat(12000),
    }));
    const bigSnap = snapshotRoster(many);
    const total = bigSnap.reduce((n, m) => n + Buffer.byteLength(m.systemPrompt, 'utf8'), 0);
    check('B-10 编制提示词总量被压到预算内',
      total <= rosterMod.ROSTER_PROMPT_TOTAL_MAX_BYTES, `${total}B`);
    check('B-10 被截断成员带可诊断标记',
      bigSnap.every((m) => m.systemPromptTruncated === true && m.systemPromptChars === 12000));
    check('B-10 截断不切坏多字节字符',
      !bigSnap.some((m) => m.systemPrompt.includes('\uFFFD')));
    const small = snapshotRoster([{ id: 's1', systemPrompt: '短提示' }]);
    check('B-10 未超限时零改动（无 truncated 标记）',
      small[0].systemPrompt === '短提示' && small[0].systemPromptTruncated === undefined);
  }
  const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const rosterDecl = mainSrc.indexOf('resolveTeamRoster:');
  const snapRead = mainSrc.indexOf('group?.dag?.roster', rosterDecl);
  const liveRead = mainSrc.indexOf('findTeamByRun', rosterDecl);
  check('主进程名册反查先读 run 快照，缺失才回落实时名册',
    rosterDecl > 0 && snapRead > rosterDecl && liveRead > snapRead);
  // 快照之外的第二层保障：参与过 run 的成员下架只做软删（enabled=0 + removed_at），
  // 物理删除会让历史 run 的 owner_member_id 变成悬空引用、审计不可追溯。
  //
  // 口径收紧（2026-10-22 / T6-9）：原断言是全文扫描，等价于「teamStore 里一个
  // DELETE FROM team_members 都不许有」。T6-9 的初始化失败补偿需要整体撤销刚建的团队
  // （此刻该团队尚无任何 run，不存在悬空引用），故允许且仅允许 deleteTeam 方法体内物理删除。
  // 三条断言替代原单条：
  //   ① 下架路径 setMemberEnabled 必须仍是 UPDATE 软删；
  //   ② 全文 DELETE FROM team_members 只能出现一次，且落在 deleteTeam 方法体内；
  //   ③ deleteTeam 不得被 IPC / preload 暴露，保证只可能是初始化补偿调用。
  const teamStoreSrc = fs.readFileSync(path.join(__dirname, '../main/teamStore.js'), 'utf8');
  const bodyOf = (marker) => {
    const start = teamStoreSrc.indexOf(marker);
    if (start < 0) return '';
    const end = teamStoreSrc.indexOf('\n  }', start);
    return end < 0 ? '' : teamStoreSrc.slice(start, end);
  };
  const setEnabledBody = bodyOf('setMemberEnabled(');
  // A10（窗口外扩守卫）：bodyOf 用「首个 \n  }」切函数体，启发式脆弱（缩进错位 / 嵌套块都会外扩或截断）。
  // 双路径互证：bodyOf 命中的闭括号必须与括号配对算出的闭括号一致。
  {
    const g = (() => {
      try {
        const start = teamStoreSrc.indexOf('setMemberEnabled(');
        if (start < 0) return { ok: false, detail: '找不到 setMemberEnabled(' };
        const openBrace = teamStoreSrc.indexOf('{', start);
        const byBracket = matchBracket(teamStoreSrc, openBrace);
        const byBodyOfNl = teamStoreSrc.indexOf('\n  }', start);
        const byBodyOfBrace = byBodyOfNl + 3; // bodyOf 命中 \n，+3 指到 } 自身，与括号配对口径一致
        if (byBracket < 0 || byBodyOfNl < 0) return { ok: false, detail: '窗口边界未配对/未找到' };
        if (byBracket !== byBodyOfBrace) return { ok: false, detail: `窗口边界错位：括号配对到 ${byBracket}，bodyOf 命中 ${byBodyOfBrace}（窗口外扩/截断，setMemberEnabled 体被切错）` };
        return { ok: true, detail: '' };
      } catch (e) { return { ok: false, detail: e.message }; }
    })();
    check('setMemberEnabled 窗口边界与括号配对一致（未被 bodyOf 的 \\n  } 启发式外扩/截断）', g.ok, g.detail);
  }
  check('编制下架只做软删（setMemberEnabled 用 UPDATE 写 enabled/removed_at）',
    setEnabledBody.includes('UPDATE team_members SET enabled = ?') && !/DELETE\s+FROM/i.test(setEnabledBody));
  const delTeamStart = teamStoreSrc.indexOf('deleteTeam(');
  const delTeamBody = bodyOf('deleteTeam(');
  const delMemberSites = [...teamStoreSrc.matchAll(/DELETE\s+FROM\s+team_members/gi)].map((m) => m.index);
  check('物理删除 team_members 仅限 deleteTeam（初始化失败补偿）',
    delMemberSites.length === 1 && delMemberSites[0] >= delTeamStart && delTeamBody.includes('DELETE FROM team_members'),
    `${delMemberSites.length} 处`);
  const ipcTeamsSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/teams.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  check('deleteTeam 不暴露给 IPC / 渲染层（仅补偿调用）',
    !ipcTeamsSrc.includes('deleteTeam') && !preloadSrc.includes('deleteTeam'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
