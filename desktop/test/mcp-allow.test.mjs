// P1-4（2026-10-29）门禁：成员级 MCP 工具粒度必须「存得下、搬得到、算得对、挡得住」
//
// 缺陷（改前）：
//   成员的 MCP 权限只有 `allowMcp` 一个布尔 —— true = 拿到所有已连接服务的所有工具
//   （含写文件 / 删目录这类破坏性工具），false = 一个都拿不到。中间没有挡位，
//   于是「只读分析员只许用 filesystem 读」这种最基本的角色配置根本表达不出来。
//
// 本套件锁五件事（任一条失效都必须是**红**，不许空过）：
//   ① 匹配语义：服务器名条目放行该服务全部工具；完整工具名条目只放行那一个；
//      非 MCP 工具一律保留（本机制只收窄 MCP 面，不许误伤内置工具）。
//   ② 编码名反解：服务器名含 `__` / 空格 / 中文时，工具名里的服务名片段是**编码过**的 ——
//      朴素「拼前缀」判定必然漏匹配。本套件用「朴素实现」做**反向对照**（8 条），
//      证明 ② 这条断言不是空转（把实现换成前缀比较，② 会给出不同结论 → 断言真的在读逻辑）。
//   ③ fail-closed 方向：空白名单 ⇒ `mcpAllowMatches` 返回 false（漏判空只会「全禁」，
//      绝不「全放」）；`narrowToolsByMcpAllow` 对空白名单原样返回（不抑制既有语义）。
//   ④ 接线（四条，缺一条功能就是死的）：
//      a. DB 迁移 v17 真的加了 `team_members.mcp_allow_json`；
//      b. teamStore 的 INSERT 列清单 / 参数 / UPDATE 列映射都带上了它（漏 INSERT 列 = 永远存空）；
//      c. 名册快照与 rolePreset 都把它搬进运行时（漏搬 = 只在界面显示、运行时不生效）；
//      d. agent-core 的收窄发生在「角色子集把 MCP 加回来」**之后**，且不依赖 toolNames 非空。
//   ⑤ 边界：条数上限 64、单条 128 字符、去重、去空白、非字符串条目丢弃。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { normalizeMcpAllow, mcpAllowMatches, narrowToolsByMcpAllow, MCP_ALLOW_MAX_ENTRIES } =
  await import(path.join(ROOT, 'shared/mcpAllow.mjs'));
const { buildToolName } = await import(path.join(ROOT, 'shared/mcpNameCodec.mjs'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`❌ ${name}\n   ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}
const eq = (a, b, msg) => assert.deepEqual(a, b, `${msg || ''} 实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

// 工具表夹具：内置工具 3 个 + 三个 MCP 服务的工具（其中 my__svc 的服务名必然被编码）
const tool = (name) => ({ type: 'function', function: { name } });
const FS_READ = buildToolName('filesystem', 'read_file');
const FS_WRITE = buildToolName('filesystem', 'write_file');
const FS_DEL = buildToolName('filesystem', 'delete_path');
const ENC_READ = buildToolName('my__svc', 'read');
const ENC_PURGE = buildToolName('my__svc', 'purge');
const CN_TOOL = buildToolName('中文服务', 'query');
const TOOLS = [
  tool('read_file'), tool('write_file'), tool('run_shell'),
  tool(FS_READ), tool(FS_WRITE), tool(FS_DEL), tool(ENC_READ), tool(ENC_PURGE), tool(CN_TOOL),
];
const names = (list) => list.map((t) => t.function.name);

// ── 夹具自检：如果 buildToolName 没把 my__svc 编码掉，② 整条就变成空转 ──
check('0. 夹具自检：含 __ 的服务名被编码（否则②退化为空转）', () => {
  assert.ok(ENC_READ.startsWith('mcp__'), `不是 mcp 名：${ENC_READ}`);
  assert.ok(!ENC_READ.startsWith('mcp__my__svc__'), `服务名未被编码，朴素前缀会命中，②失效：${ENC_READ}`);
  assert.ok(ENC_READ.includes('%'), `编码痕迹缺失：${ENC_READ}`);
});

// ── ① 匹配语义 ──
check('1. 服务器名条目：放行该服务全部工具（含编码名服务）', () => {
  eq(names(narrowToolsByMcpAllow(TOOLS, ['filesystem'])), ['read_file', 'write_file', 'run_shell', FS_READ, FS_WRITE, FS_DEL]);
  eq(names(narrowToolsByMcpAllow(TOOLS, ['my__svc'])), ['read_file', 'write_file', 'run_shell', ENC_READ, ENC_PURGE]);
  eq(names(narrowToolsByMcpAllow(TOOLS, ['中文服务'])), ['read_file', 'write_file', 'run_shell', CN_TOOL]);
});

check('2. 完整工具名条目：只放行这一个工具', () => {
  eq(names(narrowToolsByMcpAllow(TOOLS, [FS_READ])), ['read_file', 'write_file', 'run_shell', FS_READ]);
});

check('3. 混合条目：服务器级 + 工具级取并集', () => {
  eq(names(narrowToolsByMcpAllow(TOOLS, ['filesystem', ENC_PURGE])),
    ['read_file', 'write_file', 'run_shell', FS_READ, FS_WRITE, FS_DEL, ENC_PURGE]);
});

check('4. 非 MCP 工具一律保留（不许误伤内置工具）', () => {
  const out = names(narrowToolsByMcpAllow(TOOLS, ['filesystem']));
  for (const n of ['read_file', 'write_file', 'run_shell']) assert.ok(out.includes(n), `内置工具 ${n} 被误删`);
});

// ── ③ fail-closed 方向 ──
check('5. 空白名单：matches 返回 false（漏判空只会全禁，不会全放）', () => {
  assert.equal(mcpAllowMatches(FS_READ, []), false);
  assert.equal(mcpAllowMatches(FS_READ, null), false);
  assert.equal(mcpAllowMatches(FS_READ, undefined), false);
});

check('6. 空白名单：narrow 原样返回同一引用（未配置 = 零行为变化）', () => {
  assert.equal(narrowToolsByMcpAllow(TOOLS, []), TOOLS);
  assert.equal(narrowToolsByMcpAllow(TOOLS, ['  ', '']), TOOLS);
});

check('7. 拼错的服务名：该服务工具全移除，不回落全量（fail-closed）', () => {
  eq(names(narrowToolsByMcpAllow(TOOLS, ['filesytem'])), ['read_file', 'write_file', 'run_shell']);
  assert.equal(mcpAllowMatches('run_shell', ['filesystem']), false); // 非 mcp 名永不被“放行”
});

// ── ② 编码名反解（含反向对照：证明这条断言不是空转）──
// 朴素实现：只做字符串前缀拼接，不反解。改前若有人这样写，就会漏掉编码服务名。
function naiveMatches(fullName, allowList) {
  const name = String(fullName || '');
  return (Array.isArray(allowList) ? allowList : []).some((e) => {
    const s = String(e || '').trim();
    return s === name || name.startsWith(`mcp__${s}__`);
  });
}
check('8. 编码服务名必须靠反解匹配（朴素前缀实现会漏 → 证明断言非空转）', () => {
  assert.equal(naiveMatches(ENC_READ, ['my__svc']), false, '朴素实现竟然命中了，夹具失效');
  assert.equal(mcpAllowMatches(ENC_READ, ['my__svc']), true, '真实实现漏了编码服务名');
  // 正向对照：两者在“安全名”上结论必须一致（不是靠放宽判定取胜）
  assert.equal(naiveMatches(FS_READ, ['filesystem']), true);
  assert.equal(mcpAllowMatches(FS_READ, ['filesystem']), true);
});

// ── ⑤ 边界 ──
check('9. normalize：去空白 / 去重 / 丢弃非字符串 / 限条数', () => {
  eq(normalizeMcpAllow(['  a  ', 'a', '', '   ', 1, null, {}, 'b']), ['a', 'b']);
  const many = Array.from({ length: MCP_ALLOW_MAX_ENTRIES + 10 }, (_, i) => `s${i}`);
  assert.equal(normalizeMcpAllow(many).length, MCP_ALLOW_MAX_ENTRIES);
  eq(normalizeMcpAllow(['x'.repeat(129)]), []); // 超长条目被丢弃，而不是原样存进去
  assert.equal(normalizeMcpAllow('not-an-array').length, 0);
});

// ── ④ 接线（源码断言；先读文件，读不到就红，不静默通过）──
const read = (p) => {
  const f = path.join(ROOT, p);
  assert.ok(fs.existsSync(f), `文件不存在：${p}`);
  const s = fs.readFileSync(f, 'utf8');
  assert.ok(s.length > 100, `文件内容异常（疑似读空）：${p}`);
  return s;
};

check('10. DB 迁移 v17 加了 team_members.mcp_allow_json', () => {
  const s = read('main/db/index.js');
  assert.ok(/version:\s*17\b/.test(s), '缺少 version 17 迁移');
  assert.ok(/name:\s*'team-mcp-allow'/.test(s), '缺少 team-mcp-allow 迁移');
  assert.ok(/addColumn\(db,\s*'team_members',\s*'mcp_allow_json'/.test(s), '迁移里没有加列');
});

check('11. teamStore 写路径：INSERT 列/参数 + UPDATE 列映射 + 读回映射都带 mcp_allow_json', () => {
  const s = read('main/teamStore.js');
  const insert = s.slice(s.indexOf('INSERT INTO team_members'), s.indexOf('if (m.roleKind === \'lead\') this.setLead'));
  assert.ok(insert.includes('mcp_allow_json'), 'INSERT 列清单缺 mcp_allow_json（会永远存默认值）');
  assert.ok(/JSON\.stringify\(m\.mcpAllow\)/.test(insert), 'INSERT 参数缺 mcpAllow');
  assert.ok(/mcpAllow:\s*'mcp_allow_json'/.test(s), 'UPDATE 列映射缺 mcpAllow');
  // 解析函数名不锁死（C-004 已把 5 处本地 safeParse 收敛成 lib 里的 safeParseJson）——
  // 锁的是「读回映射确实读了 mcp_allow_json 这一列」这个意图；把列名或映射删掉仍然会红。
  assert.ok(/mcpAllow:\s*[A-Za-z_$][\w$.]*\(r\.mcp_allow_json\)/.test(s), 'rowToMember 没读回 mcp_allow_json');
  // 占位符计数：缺一个 ? 就是运行期绑定错位（比“存空”更隐蔽）。
  // 只截到 VALUES 子句末尾的反引号——否则 `.run()` 参数里的三元 `?` 会被算进来（假红）。
  const valuesClause = insert.slice(insert.indexOf('VALUES'), insert.indexOf('`'));
  const q = (valuesClause.match(/\?/g) || []).length;
  const cols = insert.slice(insert.indexOf('('), insert.indexOf(')'))
    .split(',').map((x) => x.trim()).filter(Boolean);
  eq(q, cols.length - 2, `INSERT 占位符 ${q} 与列数 ${cols.length}（减 2 个字面量 enabled/removed_at）不匹配`);
});

check('12. 名册快照 + rolePreset 搬运 mcpAllow（漏搬 = 只在界面生效）', () => {
  assert.ok(/mcpAllow:\s*Array\.isArray\(m\.mcpAllow\)/.test(read('main/teamRoster.js')), 'snapshotRoster 未搬 mcpAllow');
  assert.ok(/mcpAllow:\s*Array\.isArray\(member\.mcpAllow\)/.test(read('main/rolePresetApply.js')), 'rolePresetFromMember 未搬 mcpAllow');
});

check('13. 引擎收窄在「角色子集把 MCP 加回来」之后，且不依赖 toolNames 非空', () => {
  const s = read('agent-core/index.js');
  const idxAllow = s.indexOf('rolePreset.allowMcp === true');
  const idxNarrow = s.indexOf('narrowToolsByMcpAllow(allTools, mcpAllowList)');
  assert.ok(idxAllow > 0, '找不到 allowMcp 分支（断言锚点失效）');
  assert.ok(idxNarrow > 0, '找不到 ②b 收窄调用（功能未接线）');
  assert.ok(idxNarrow > idxAllow, '收窄发生在加回 MCP 之前 → 白名单形同不存在');
  // ②b 的条件不得包含 toolNames 长度判断（否则 toolNames=[] 的成员绕过白名单）
  const block = s.slice(idxNarrow - 600, idxNarrow);
  assert.ok(/if \(toolCallCapable && mcpAllowList\.length/.test(block), '②b 的前置条件不是「有白名单」而是别的东西');
  assert.ok(!/toolNames\.length/.test(block), '②b 前置条件里出现了 toolNames.length —— 只限 MCP 的配置会失效');
  // 候选池也必须收窄：否则 activate_tools 是一道按需申请任意工具的侧门
  assert.ok(/toolCandidatePool = narrowToolsByMcpAllow\(toolCandidatePool, mcpAllowList\)/.test(s),
    '未收窄 activate_tools 候选池（侧门未关）');
});

console.log(`\nP1-4 MCP 粒度：${pass}/${total} 通过`);
