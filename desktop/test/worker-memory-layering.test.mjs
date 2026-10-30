// 第八轮 D-806 / B-11：Worker 派发路径必须走**分层召回**（而不是单空间全量）
//
// 缺陷形态（角度 B 实测）：
//   `main.js` 的 `buildTaskPrompt` 只传 `spaceId + query + topK + domains`，**没传 scopes**。
//   `memory.recall()` 见到「没有 scopes」就走旧的单空间路径：
//     SELECT * FROM memories WHERE space_id = ? AND is_valid = 1 AND compressed = 0
//     ORDER BY tier DESC, updated_at DESC LIMIT ?
//   这条 SQL **完全没有 scope 过滤**——于是：
//     ① 每层配额（session 2 / project 3 / global 2）不生效，Top-3 被 tier 高的项目条目占满；
//     ② 跨层同内容去重不生效；
//     ③ **别的会话的 session 记忆会漏进 Worker**（同 space 下的所有 scope 混在一起返回）。
//   第 ③ 条是这条缺陷最严重的形态：会话级工作现场本该会话隔离，却在派发时被带进无人值守任务。
//
// 本套件锁四件事：
//   ① 行为：传 scopes + conversationId 后，**别的会话的 session 记忆不再出现**（而旧路径会漏）；
//   ② 行为：session 层只在有会话归属时才收；团队层只在有 teamId 时才收（不注入无法归属的记忆）；
//   ③ 接线：`buildTaskPrompt` 真的把 `scopes` 与 `conversationId: group.thread_id` 传下去了
//      （装配是闭包，只能源码形态断言；但配合 ①② 的行为断言，语义是完整的）。
//   ④ 行为（T-05 本轮补）：**每层配额真封顶**。
//      头部一直写着要锁「每层配额不生效」，但此前 10 条断言里没有一条检查「每层取几条」——
//      变异验证 M4 把 LAYER_QUOTA 全放大到 50，本套件仍 10/10 全绿（同变异下 memory-scope /
//      memory-team 都红了）。「库房里有一条自称锁配额的门禁」是最坏的一种安全感，故补行为断言。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDbAsync } = require(path.resolve(import.meta.dirname, '../main/db/index.js'));
const { MemoryManager, LAYER_QUOTA } = require(path.resolve(import.meta.dirname, '../main/memory/index.js'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// A10 守卫辅助：去除 JS 行/块注释（保留 `://` 不被误删），仅保留「生效」源码。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-worker-mem-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  const space = '/proj/demo';
  const put = (extra) => mem.remember({
    spaceId: space, domain: 'global_knowledge', importance: 0.9,
    source: 'user_input', ...extra,
  });

  // 本会话的两条 + 另一个会话的一条 + 项目层一条 + 全局层一条
  put({ content: '【本会话】接口鉴权用 JWT，密钥在 vault', scope: 'session', conversationId: 't-1' });
  put({ content: '【本会话】构建命令是 pnpm build', scope: 'session', conversationId: 't-1' });
  put({ content: '【别的会话】某次实验用了 vue2', scope: 'session', conversationId: 't-2' });
  put({ content: '【项目】仓库约定：提交前跑全量门禁', scope: 'project' });
  put({ content: '【全局】用户偏好中文回复', scope: 'global' });

  const texts = (rows) => rows.map((r) => String(r.content));

  // ── ① 旧路径（不传 scopes）会漏别的会话记忆；新路径（传 scopes）不会 ──
  const legacy = mem.recallContents({ spaceId: space, query: '鉴权 构建', topK: 10 });
  check('① 旧路径（无 scopes）确实会漏出**别的会话**的 session 记忆——这就是要修的缺陷',
    texts(legacy).some((t) => t.includes('别的会话')),
    `旧路径返回 ${legacy.length} 条`);

  const layered = mem.recallContents({
    spaceId: space, query: '鉴权 构建', topK: 10,
    scopes: ['session', 'project', 'global'], conversationId: 't-1',
  });
  check('① 分层路径不再漏出别的会话的 session 记忆',
    !texts(layered).some((t) => t.includes('别的会话')),
    `分层路径返回 ${layered.length} 条`);
  check('① 分层路径仍带本会话 + 项目 + 全局三层内容',
    texts(layered).some((t) => t.includes('本会话'))
    && texts(layered).some((t) => t.includes('【项目】'))
    && texts(layered).some((t) => t.includes('【全局】')));

  // ── ② 无会话归属时不收 session 层 ──
  const noConv = mem.recallContents({ spaceId: space, query: '鉴权', topK: 10, scopes: ['session', 'project', 'global'] });
  check('② 无 conversationId 时 session 层整体跳过（不注入无法归属的工作现场）',
    !texts(noConv).some((t) => t.includes('本会话')));

  // ── ② 无 teamId 时不收团队层 ──
  put({ content: '【团队】本次军团 run 的结论', scope: 'team', teamId: 'team-x' });
  const noTeam = mem.recallContents({ spaceId: space, query: '结论', topK: 10, scopes: ['project', 'global'] });
  check('② scopes 不含 team 时不返回团队记忆（Worker 由专用块处理团队层）',
    !texts(noTeam).some((t) => t.includes('【团队】')));
  const withTeam = mem.recallContents({ spaceId: space, query: '结论', topK: 10, scopes: ['team'], teamId: 'team-x' });
  check('② 传 teamId + team 层时可以取到团队记忆（专用块走的正是这条）',
    texts(withTeam).some((t) => t.includes('【团队】')));

  // ── ③ 接线：buildTaskPrompt 必须传 scopes 与 conversationId ──
  {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../main/main.js'), 'utf8');
    const start = src.indexOf('buildTaskPrompt: async (group, task) => {');
    check('③ 能定位 buildTaskPrompt 装配段', start > 0);
    // 取到该闭包结束（下一个同级注释/键之前的合理窗口）
    const seg = src.slice(start, start + 4000);
    check('③ 传了 scopes（不传就退回单空间全量，B-11 未修）',
      /scopes[,:]/.test(seg), seg.includes('scopes') ? '有 scopes' : '缺 scopes');
    check('③ conversationId 取自 group.thread_id（会话归属唯一判据）',
      /conversationId:\s*groupThreadId/.test(seg) && /groupThreadId\s*=\s*group\.thread_id/.test(seg));
    check('③ 有会话才收 session 层，无会话时 scopes 不含 session',
      /groupThreadId\s*\?\s*\['session',\s*'project',\s*'global'\]\s*:\s*\['project',\s*'global'\]/.test(seg));

    // ── A10 守卫：scopes 与 conversationId 必须作为「去注释生效代码」真的传给 recallContents ──
    // 旧检查只在 4000 字符窗口内比对 token 有无，对「scopes / conversationId 被注释/失效但仍残留在
    // 窗口文本」的回归是盲的（假绿，B-11 单空间全量旧路径会悄悄回来）。这里剥离注释后断言这些 token
    // 真正作为生效代码出现在 recallContents 调用里。
    const segActive = stripJsComments(seg);
    check('③ A10 守卫：buildTaskPrompt 去注释后仍真的把 scopes 与 conversationId 传给 recallContents',
      /scopes[,:]/.test(segActive) && /conversationId:\s*groupThreadId/.test(segActive));
  }

  // ── ④ 每层配额真封顶（T-05：此前无一条断言检查配额）──
  // 判据靠「写入量 > 配额」制造封顶条件，**刻意不用 topK 断言配额**：
  // topK 给到硬上限（50）让配额成为唯一约束；若用 topK 断言，两个口径会混在一起
  // （T-01 修好后 topK 也生效了，用小的 topK 断言配额会误判为「配额生效」）。
  {
    const qSpace = '/proj/quota-probe';
    const qPut = (extra) => mem.remember({
      spaceId: qSpace, domain: 'global_knowledge', importance: 0.9, source: 'user_input', ...extra,
    });
    for (let i = 0; i < 5; i += 1) qPut({ scope: 'project', content: `配额探针-项目 ${i}` });
    for (let i = 0; i < 3; i += 1) qPut({ scope: 'global', content: `配额探针-全局 ${i}` });
    const capped = mem.recallContents({ spaceId: qSpace, scopes: ['project', 'global'], topK: 50 });
    const byScope = (s) => capped.filter((m) => m.scope === s).length;
    const sumQuota = LAYER_QUOTA.project + LAYER_QUOTA.global;
    check('④ project 层库存 5 条但只召回配额条数（配额失效则返回 5）',
      byScope('project') === LAYER_QUOTA.project,
      `实取 ${byScope('project')} / 配额 ${LAYER_QUOTA.project} / 库存 5`);
    check('④ global 层库存 3 条但只召回配额条数（配额失效则返回 3）',
      byScope('global') === LAYER_QUOTA.global,
      `实取 ${byScope('global')} / 配额 ${LAYER_QUOTA.global} / 库存 3`);
    check('④ 分层召回总数恰为配额和，且不超过 Σ LAYER_QUOTA',
      capped.length === sumQuota && capped.length <= sumQuota,
      `实取 ${capped.length} / 配额和 ${sumQuota}`);

    // ── ④-b 小 topK 也必须生效（T-01 回归保护）──
    // 独立验证查出的盲区：上面三条都用 topK=50，**只能证明配额封顶，证明不了 topK 生效**。
    // 原缺陷是「分层模式完全丢弃 topK」，而 topK ≥ 配额和 时丢弃与否结果完全相同 ⇒ 抓不到。
    // 这里必须用**小于配额和**的 topK（1 / 2），否则断言在缺陷复现时同样是绿的。
    const t1 = mem.recallContents({ spaceId: qSpace, scopes: ['project', 'global'], topK: 1 });
    check('④-b 分层模式 topK=1 只返回 1 条（原缺陷：被丢弃 ⇒ 返回配额和条）',
      t1.length === 1, `实取 ${t1.length} 条`);
    const t2 = mem.recallContents({ spaceId: qSpace, scopes: ['project', 'global'], topK: 2 });
    check('④-b 分层模式 topK=2 只返回 2 条',
      t2.length === 2, `实取 ${t2.length} 条`);
  }

  console.log(`\nworker-memory-layering: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
})();
