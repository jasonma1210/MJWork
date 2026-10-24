// 三层记忆 M3 门禁：管理 UI + 记忆文件双通道 + 分层召回注入。
//
// 背景（README L1936-2010 实现设计 / 决策 4）：
//   · 分层召回——recallContents 输出 scope，渲染层加 `[个人]/[项目]/[本次会话]` 前缀注入，
//     引擎仍吃 string[]（agent-core 零改动）；
//   · 文件双通道——SQLite 唯一事实来源，`<project>/.mjcode/memory.md`（L2）与
//     `~/.mjcode/user_profile.md`（L3）为导出视图：写路径变更 → 防抖落盘；外部编辑 → 按基线导入；
//   · gitignore——默认忽略 `.mjcode/`，团队共享开关开启时移除。
//
// 本套件锁四组：
//   A. 纯函数行为（路径 / 渲染 / 解析 / 原子写 / gitignore 策略）；
//   B. MemoryFileSync 端到端（导出落盘 / 幂等导入 / 基线自写自读防护 / 团队共享）；
//   C. 分层召回（scope 输出 / conversationId 控制会话层 / 跨层去重 / 管理取数 API）；
//   D. 源码接线（IPC / preload / main.js 装配 / ChatArea 前缀 / MemorySection UI / i18n key）。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

const { openDbAsync } = require(path.join(ROOT, 'main/db'));
const { MemoryManager, LAYER_QUOTA } = require(path.join(ROOT, 'main/memory'));
const mf = require(path.join(ROOT, 'main/memory/memoryFile.js'));
const {
  MemoryFileSync, projectMemoryPath, globalMemoryPath, renderMarkdown, parseMarkdown,
  writeIfChanged, applyGitignore, GITIGNORE_LINE, MODEL_DOMAINS,
} = mf;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const tmp = (pfx) => fs.mkdtempSync(path.join(os.tmpdir(), pfx));

// ══════════════════════════════════════════════════════════════
// A. 纯函数
// ══════════════════════════════════════════════════════════════
{
  const p = path.join('x', 'proj');
  check('A1 projectMemoryPath 指向 .mjcode/memory.md',
    projectMemoryPath(p) === path.join(p, '.mjcode', 'memory.md'), projectMemoryPath(p));
  check('A1 globalMemoryPath 指向 ~/.mjcode/user_profile.md',
    globalMemoryPath() === path.join(os.homedir(), '.mjcode', 'user_profile.md'), globalMemoryPath());
  check('A1 MODEL_DOMAINS 五域齐备',
    MODEL_DOMAINS.length === 5 && MODEL_DOMAINS.includes('global_knowledge'));

  const items = [
    { domain: 'global_knowledge', content: '项目用 pnpm monorepo' },
    { domain: 'session', content: '今天修复了审批竞态' },
    { domain: 'entity', summary: '摘要优先展示' },
    { domain: 'bogus', content: '未知域回落' },
    { domain: 'reflection', content: '   ' },
  ];
  const md = renderMarkdown(items);
  const parsed = parseMarkdown(md);
  check('A2 renderMarkdown 一行一条且未知域回落 global_knowledge',
    md.includes('- [global_knowledge] 项目用 pnpm monorepo')
    && md.includes('- [global_knowledge] 未知域回落'), md.split('\n').slice(3).join(' | '));
  check('A2 renderMarkdown 摘要优先于正文（entity 用 summary）',
    md.includes('- [entity] 摘要优先展示'));
  check('A2 renderMarkdown 空白内容被丢弃（reflection 不落行）',
    !md.includes('[reflection]'), md);
  check('A3 导出→解析往返 4 条（含未知域回落），域与内容一致',
    parsed.length === 4 && parsed[0].domain === 'global_knowledge'
    && parsed[2].domain === 'entity' && parsed[2].content === '摘要优先展示', JSON.stringify(parsed));

  const hand = parseMarkdown('# 手写\n- 用户手加的第一条\n- [session] 第二条\n无关行\n-   \n');
  check('A3 手写无域条目被接受（content 原样，无 domain）',
    hand.length === 2 && hand[0].content === '用户手加的第一条' && !hand[0].domain
    && hand[1].domain === 'session', JSON.stringify(hand));

  const fp = path.join(tmp('mj-mf-w-'), 'a.md');
  const w1 = writeIfChanged(fp, 'hello\n');
  const w2 = writeIfChanged(fp, 'hello\n');
  check('A4 首次写入落盘、内容未变不重写',
    w1.wrote === true && fs.readFileSync(fp, 'utf8') === 'hello\n' && w2.wrote === false,
    `w1=${w1.wrote} w2=${w2.wrote}`);
  const w3 = writeIfChanged(fp, 'changed\n');
  check('A4 内容变化后重写且返回新 mtime', w3.wrote === true && w3.mtime >= w1.mtime);

  // gitignore：非 git 仓库跳过 / git 仓库默认加行 / 团队共享移除行
  const nonGit = tmp('mj-mf-nogit-');
  check('A5 非 git 仓库跳过 gitignore',
    applyGitignore(nonGit).reason === 'not-a-git-repo'
    && !fs.existsSync(path.join(nonGit, '.gitignore')));

  const gitProj = tmp('mj-mf-git-');
  fs.mkdirSync(path.join(gitProj, '.git'));
  const g1 = applyGitignore(gitProj);
  const giText = fs.readFileSync(path.join(gitProj, '.gitignore'), 'utf8');
  check('A5 默认把 `.mjcode/` 写入 .gitignore',
    g1.changed === true && giText.split('\n').includes(GITIGNORE_LINE), giText.trim());
  const g2 = applyGitignore(gitProj); // 已存在 → 幂等不再追加
  check('A5 重复调用不重复追加该行',
    g2.changed === false && fs.readFileSync(path.join(gitProj, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() === GITIGNORE_LINE).length === 1);
  const g3 = applyGitignore(gitProj, { teamSharing: true });
  check('A5 团队共享开启后移除忽略行',
    g3.changed === true && !fs.readFileSync(path.join(gitProj, '.gitignore'), 'utf8').split('\n').includes(GITIGNORE_LINE));
}

// ══════════════════════════════════════════════════════════════
// B. MemoryFileSync 端到端
// ══════════════════════════════════════════════════════════════
{
  const proj = tmp('mj-mf-proj-');
  fs.mkdirSync(path.join(proj, '.git'));
  const db = await openDbAsync(tmp('mj-mf-db-'), { driver: 'sqljs' });
  let teamSharing = false;
  let sync = null;
  // 装配顺序与 main.js 一致：先建 sync（lazy getter 反向引用 manager），manager 构造时回指 onChange
  const mem = new MemoryManager({ db, onChange: (e) => sync?.onChange(e) });
  sync = new MemoryFileSync({
    getManager: () => mem,
    getTeamSharing: () => teamSharing,
    debounceMs: 5,
  });

  mem.remember({ spaceId: proj, domain: 'global_knowledge', content: '项目约定使用 pnpm', source: 'user_input' });
  mem.remember({ spaceId: proj, domain: 'entity', content: '核心入口是 desktop/main/main.js', source: 'user_input' });
  const n = sync.flushAll(); // 立即落盘（等价退出兜底路径）
  const fp = projectMemoryPath(proj);
  const text = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  check('B1 写路径变更经防抖导出落盘（含两条项目记忆）',
    n >= 1 && text.includes('- [global_knowledge] 项目约定使用 pnpm')
    && text.includes('- [entity] 核心入口是 desktop/main/main.js'), `flush=${n}`);
  check('B1 导出文件含说明头（SQLite 为唯一事实来源）',
    text.includes('MJCode 记忆导出视图') && text.includes('SQLite 为唯一事实来源'));
  check('B2 导出后 .gitignore 已被写入 `.mjcode/`',
    fs.readFileSync(path.join(proj, '.gitignore'), 'utf8').split('\n').includes(GITIGNORE_LINE));

  // 幂等导入：新库把该文件导入 → 命中两条；再次导入（基线重置后）→ 0（onlyNew 跳过已存在）
  const db2 = await openDbAsync(tmp('mj-mf-db2-'), { driver: 'sqljs' });
  const mem2 = new MemoryManager({ db: db2 });
  const sync2 = new MemoryFileSync({ getManager: () => mem2 });
  const first = sync2.importProject(proj);
  check('B3 文件导入首次命中全部条目', first === 2, `imported=${first}`);
  sync2.baseline.delete(fp); // 抹掉基线，验证 onlyNew 兜底（而非基线）
  const second = sync2.importProject(proj);
  check('B3 基线失效后仍不重复导入（onlyNew 幂等安全网）', second === 0, `imported=${second}`);

  // 自写自读防护：未外部编辑时再次 importProject 返回 0（mtime <= 基线）
  const noTouch = sync.importProject(proj);
  check('B4 未外部编辑时导入为 0（基线自写自读防护）', noTouch === 0, `imported=${noTouch}`);

  // 外部编辑：追加一条手写记忆并推进 mtime → syncProject 应先导入再落盘
  fs.appendFileSync(fp, '- [global_knowledge] 团队手写：发布走 GitHub Release\n');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(fp, future, future);
  const r = sync.syncProject(proj);
  check('B5 外部编辑后 syncProject 导入 1 条（团队手写记忆进入 SQLite）',
    r.imported === 1, `imported=${r.imported}`);
  const inDb = mem.listScope({ scope: 'project', spaceId: proj });
  check('B5 导入内容已落库且可被管理 UI 取到',
    inDb.some((m) => m.content.includes('团队手写：发布走 GitHub Release')), `count=${inDb.length}`);
  check('B5 导入条目来源保持 legacy-import（不污染既有来源）',
    inDb.find((m) => m.content.includes('团队手写'))?.source === 'legacy-import');

  // 团队共享：开启后导出视图不再被 gitignore 忽略
  teamSharing = true;
  sync.exportProject(proj);
  check('B6 团队共享开启后 `.mjcode/` 忽略行被移除',
    !fs.readFileSync(path.join(proj, '.gitignore'), 'utf8').split('\n').includes(GITIGNORE_LINE));
  teamSharing = false;
  sync.exportProject(proj);
  check('B6 团队共享关闭后忽略行恢复（安全默认）',
    fs.readFileSync(path.join(proj, '.gitignore'), 'utf8').split('\n').includes(GITIGNORE_LINE));

  // 全局文件的真实路径在 ~/.mjcode/，此处刻意不做真机写测试（避免污染/误删用户目录）；
  // 全局层导出视图的渲染与解析已由 A2/A3 纯函数覆盖，导入准入由 C 组 recallContents 覆盖。
  check('B7 全局层导出视图渲染与解析往返（纯函数，不触真实用户目录）',
    parseMarkdown(renderMarkdown([{ domain: 'private', content: '跨项目偏好：中文沟通' }]))
      .some((it) => it.domain === 'private' && it.content === '跨项目偏好：中文沟通'));
}

// ══════════════════════════════════════════════════════════════
// C. 分层召回 + 管理取数
// ══════════════════════════════════════════════════════════════
{
  const space = '/proj-layered';
  const db = await openDbAsync(tmp('mj-mf-db3-'), { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  mem.remember({ spaceId: space, domain: 'session', scope: 'session', conversationId: 'c1', content: '本次会话：正在调试分层召回', source: 'model_conclusion' });
  mem.remember({ spaceId: space, domain: 'global_knowledge', scope: 'project', content: '项目级：使用 sql.js 驱动', source: 'user_input' });
  mem.remember({ spaceId: space, domain: 'private', scope: 'global', content: '全局级：用户偏好中文沟通', source: 'user_input' });

  const layered = mem.recallContents({ spaceId: space, scopes: ['session', 'project', 'global'], conversationId: 'c1', topK: 7 });
  const scopes = layered.map((m) => m.scope);
  check('C1 分层召回输出 scope 字段且三层齐备',
    layered.length === 3 && scopes.includes('session') && scopes.includes('project') && scopes.includes('global'),
    scopes.join(','));
  check('C1 会话层条目确实被召回',
    layered.some((m) => m.scope === 'session' && m.content.includes('分层召回')));

  const noConv = mem.recallContents({ spaceId: space, scopes: ['session', 'project', 'global'], conversationId: null, topK: 7 });
  check('C2 无 conversationId 时不注入会话层（无法归属的工作记忆不跨会话泄漏）',
    !noConv.some((m) => m.scope === 'session'), noConv.map((m) => m.scope).join(','));
  const otherConv = mem.recallContents({ spaceId: space, scopes: ['session', 'project', 'global'], conversationId: 'c2', topK: 7 });
  check('C2 别的会话同样召回不到本会话记忆',
    !otherConv.some((m) => m.content.includes('分层召回')));

  // 跨层去重：同内容同时存在于 session 与 project → 只保留更高层（session）
  const dupText = '同一条内容跨层去重';
  mem.remember({ spaceId: space, domain: 'session', scope: 'session', conversationId: 'c1', content: dupText, source: 'model_conclusion' });
  mem.remember({ spaceId: space, domain: 'global_knowledge', scope: 'project', content: dupText, source: 'user_input' });
  const deduped = mem.recallContents({ spaceId: space, scopes: ['session', 'project', 'global'], conversationId: 'c1', topK: 7 });
  const dupHits = deduped.filter((m) => m.content === dupText);
  check('C3 跨层同内容去重仅保留高层（session）',
    dupHits.length === 1 && dupHits[0].scope === 'session', `hits=${dupHits.length}`);

  const ls = mem.listScope({ scope: 'project', spaceId: space });
  check('C4 listScope 按作用域+空间取数（管理 UI 分层列表）',
    ls.length >= 2 && ls.every((m) => m.scope === 'project'), `count=${ls.length}`);
  const spaces = mem.projectSpaces();
  check('C4 projectSpaces 返回存在项目级记忆的空间且过滤 default',
    spaces.includes(space) && !spaces.includes('default'), spaces.join(','));
  const st = mem.stats();
  check('C4 stats.byScope 提供分层计数（管理 UI 仪表盘）',
    Array.isArray(st.byScope) && st.byScope.some((r) => r.scope === 'project' && r.n >= 2), JSON.stringify(st.byScope));
}

// ══════════════════════════════════════════════════════════════
// D. 接线断言（**行为优先**；源码形态仅作辅助，不能是唯一判据）
// ══════════════════════════════════════════════════════════════
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // D1 起是「源码形态」判据（辅助）。**必须剥离注释**再匹配——否则把字面量挪进注释
  // 仍然算通过，正是本项目反复踩的「读了文件但只做文本匹配」空过形态（独立验证 M3a 实证：
  // 当时 D1 绿而行为组 D0 红）。剥离时保留换行，避免跨行结构被拼歪。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  const readCode = (rel) => stripComments(read(rel));

  // ── D0（T-03 本轮补）：`local:memories/list` 真的走分层模式 —— **行为断言** ──
  // 缺陷回顾：旧版这里只有源码正则（`/scopes:\s*\[\.\.\.SCOPES\]/.test(localData)`）。
  //   变异验证 M3 把那一行**整行挪进注释**（实际调用已断），本套件仍 52/52 全绿 ⇒ 空过假闸。
  // 现在直接调用 IPC handler 看真实产出。分层模式一旦失效，行为上可判的形态是：
  //   别的会话的 session 记忆会漏进当前对话（正是 B-11 在主对话路径上的形态），
  //   且返回条数会从「配额和」涨到「该空间全部记忆」。
  const ModuleMod = require('module');
  const electronPath = require.resolve('electron');
  const ipcHandlers = {};
  const stubModule = new ModuleMod(electronPath, null);
  stubModule.filename = electronPath;
  stubModule.loaded = true;
  stubModule.exports = { ipcMain: { handle: (n, f) => { ipcHandlers[n] = f; } }, shell: {} };
  require.cache[electronPath] = stubModule;
  const localDataModule = require(path.join(ROOT, 'main/ipc/localData.js'));

  const ipcDb = await openDbAsync(tmp('mj-mf-db-ipc-'), { driver: 'sqljs' });
  const ipcMem = new MemoryManager({ db: ipcDb });
  localDataModule.initLocalDataIpc({
    getLocalStore: () => null,
    getCredentialCrypto: () => null,
    localVault: new Map(),
    serverBase: () => '',
    MJ_SERVER_DEFAULT: '',
    getMemoryManager: () => ipcMem,
    getMemoryScheduler: () => null,
  });

  // 四条记忆：本会话 session / 别的会话 session / 项目 / 全局
  const ipcSpace = '/proj-ipc-layered';
  ipcMem.remember({ spaceId: ipcSpace, domain: 'session', scope: 'session', conversationId: 'conv-A', content: '【A 会话】本会话的工作现场', source: 'model_conclusion', importance: 0.9 });
  ipcMem.remember({ spaceId: ipcSpace, domain: 'session', scope: 'session', conversationId: 'conv-B', content: '【B 会话】别的会话的工作现场', source: 'model_conclusion', importance: 0.9 });
  ipcMem.remember({ spaceId: ipcSpace, domain: 'global_knowledge', scope: 'project', content: '【项目】仓库约定：提交前跑全量门禁', source: 'user_input', importance: 0.9 });
  ipcMem.remember({ spaceId: ipcSpace, domain: 'private', scope: 'global', content: '【全局】用户偏好中文沟通', source: 'user_input', importance: 0.9 });

  const listA = await ipcHandlers['local:memories/list'](null, { projectPath: ipcSpace, conversationId: 'conv-A', limit: 7 });
  const listB = await ipcHandlers['local:memories/list'](null, { projectPath: ipcSpace, conversationId: 'conv-B', limit: 7 });
  const sumQuota = LAYER_QUOTA.session + LAYER_QUOTA.project + LAYER_QUOTA.global;
  const scopesOf = (rows) => rows.map((m) => m.scope).join(',');
  const has = (rows, kw) => rows.some((m) => String(m.content || '').includes(kw));

  check('D0 行为：local:memories/list 返回非空且条数 ≤ Σ 每层配额（单空间旧路径会返回该空间全部）',
    Array.isArray(listA) && listA.length > 0 && listA.length <= sumQuota,
    `${listA.length} 条 / 上限 ${sumQuota}`);
  check('D0 行为：当前会话召回**不含别的会话**的 session 记忆（分层失效即泄漏）',
    !has(listA, 'B 会话'), `命中 ${scopesOf(listA)}`);
  check('D0 行为：返回项携带正确 scope 且三层齐备（渲染层据此加层级前缀）',
    listA.every((m) => ['session', 'team', 'project', 'global'].includes(m.scope))
    && listA.some((m) => m.scope === 'session')
    && listA.some((m) => m.scope === 'project')
    && listA.some((m) => m.scope === 'global'),
    scopesOf(listA));
  check('D0 行为：换一个 conversationId 只看到它自己的 session 记忆',
    has(listB, 'B 会话') && !has(listB, 'A 会话'), scopesOf(listB));

  // ── D1 起：源码形态（**辅助判据**，单独不足以证明行为未断）──
  const localData = readCode('main/ipc/localData.js');
  check('D1 源码形态（辅助）local:memories/list 的 scopes + conversationId 字面量仍在',
    /local:memories\/list/.test(localData) && /scopes:\s*\[\.\.\.SCOPES\]/.test(localData)
    && /conversationId:\s*conversationId \|\| null/.test(localData));
  check('D1 localData 引入 SCOPES 单一事实来源',
    /const \{ SCOPES \} = require\('\.\.\/memory'\)/.test(localData));
  check('D1 新增 local:memories/syncFile 与 memory:resetScope 通道',
    /local:memories\/syncFile/.test(localData) && /memory:resetScope/.test(localData)
    // M5 / T5-5：resetScope 白名单纳入 'team'（团队层清空需携带 teamId，见 localData 守卫）
    && /assertEnum\(\{ scope \}, 'scope', \['session', 'team', 'project', 'global'\]\)/.test(localData));

  const preload = readCode('main/preload.js');
  check('D2 preload 暴露 memorySyncFile / memoryResetScope',
    /memorySyncFile:\s*\(payload\) => ipcRenderer\.invoke\('local:memories\/syncFile'/.test(preload)
    && /memoryResetScope:\s*\(payload\) => ipcRenderer\.invoke\('memory:resetScope'/.test(preload));

  const mainjs = readCode('main/main.js');
  check('D3 main.js 装配 MemoryFileSync（lazy getManager + 团队共享偏好）',
    /new MemoryFileSync\(\{/.test(mainjs) && /getManager:\s*\(\) => memoryManager/.test(mainjs)
    && /getTeamSharing:[\s\S]{0,120}memory\.teamSharing/.test(mainjs));
  check('D3 MemoryManager 注入 onChange → 文件导出视图触发源',
    /new MemoryManager\(\{ db, onChange: \(e\) => memoryFileSync\?\.onChange\(e\) \}\)/.test(mainjs));
  check('D3 initLocalDataIpc 注入 getMemoryFileSync',
    /getMemoryFileSync:\s*\(\) => memoryFileSync/.test(mainjs));
  check('D3 退出路径 flushAll 兜底落盘',
    /memoryFileSync\?\.flushAll\(\)/.test(mainjs));

  const chat = read('renderer/src/components/ChatArea.jsx');
  check('D4 ChatArea 分层召回带 conversationId',
    /localListMemories\(\{[\s\S]{0,160}conversationId/.test(chat));
  check('D4 ChatArea 注入层级前缀（chat.memoryScope*）',
    /chat\.memoryScopeSession/.test(chat) && /chat\.memoryScopeProject/.test(chat) && /chat\.memoryScopePersonal/.test(chat));
  check('D4 ChatArea 打开项目时先同步记忆文件（fail-open）',
    /memorySyncFile\(\{ projectPath: project\.path \}\)/.test(chat));
  // 依赖数组：既要含「切项目/切会话」信号，也要含「本轮刷新」信号。
  // T-08（渲染层由并行成员本轮实现）：依赖从 `[project?.path, thread?.id]` 扩为
  // `[project?.path, thread?.id, recallQuery, recallTick]` —— 同会话内新写入的记忆
  // （如 /mem）也要在后续轮次生效。本断言随之收紧为「两段都要有」，不放宽：
  //   ① 切项目/切会话仍要重新召回（否则切了会话还看旧记忆）；
  //   ② 还必须有轮次级信号（否则 T-08 那个缺陷会原地复活）。
  const depsMatch = chat.match(/\}, \[project\?\.path, thread\?\.id([^\]]*)\]\);/);
  const refreshDeps = (depsMatch ? depsMatch[1] : '').split(',').map((s) => s.trim()).filter(Boolean)
    .filter((d) => /tick|query|round|version/i.test(d));
  check('D4 ChatArea 记忆召回依赖含 project?.path + thread?.id（切项目/切会话重新召回）',
    !!depsMatch, depsMatch ? depsMatch[0] : '未找到对应的 useEffect 依赖数组');
  check('D4 ChatArea 记忆召回依赖含轮次/query 刷新信号（T-08：同会话内新记忆也要生效）',
    refreshDeps.length > 0, refreshDeps.join(',') || '缺少轮次/query 类依赖，同会话新记忆不会生效');

  const ui = read('renderer/src/components/MemorySection.tsx');
  check('D5 MemorySection 作用域徽章 + 筛选档',
    /SCOPE_KEYS/.test(ui) && /SCOPE_FILTERS/.test(ui) && /filteredItems/.test(ui) && /scopeFilter/.test(ui));
  check('D5 MemorySection 高级管理：团队共享 + 按层清空',
    /memoryTeamSharingLabel/.test(ui) && /memoryResetScopeAction/.test(ui)
    && /memoryResetScope\?\.\(\{ scope, projectPath \}\)/.test(ui));
  check('D5 MemorySection 分层计数（byScope）',
    /memoryByScopeTitle/.test(ui) && /scopeCount/.test(ui) && /byScope/.test(ui));

  const zhChat = JSON.parse(read('renderer/src/i18n/locales/zh-CN/chat.json'));
  const enChat = JSON.parse(read('renderer/src/i18n/locales/en-US/chat.json'));
  check('D6 chat 双语含三层前缀 key',
    ['memoryScopeSession', 'memoryScopeProject', 'memoryScopePersonal'].every((k) => k in zhChat && k in enChat));

  const zhSet = JSON.parse(read('renderer/src/i18n/locales/zh-CN/settings.json'));
  const enSet = JSON.parse(read('renderer/src/i18n/locales/en-US/settings.json'));
  const m3Keys = ['memoryByScopeTitle', 'memoryScopeAll', 'memoryScopeSession', 'memoryScopeProject',
    'memoryScopePersonal', 'memoryAdvancedTitle', 'memoryTeamSharingLabel', 'memoryTeamSharingDesc',
    'memoryTeamSharingOn', 'memoryTeamSharingOff', 'memoryResetScopeHint', 'memoryResetScopeAction',
    'memoryResetScopeTitle', 'memoryResetScopeMsg', 'memoryResetDone'];
  const missZh = m3Keys.filter((k) => !(k in zhSet));
  const missEn = m3Keys.filter((k) => !(k in enSet));
  check('D6 settings 双语含 M3 全部新增 key（防漏登记）',
    missZh.length === 0 && missEn.length === 0, `zh缺=${missZh.join(',')} en缺=${missEn.join(',')}`);
  check('D6 插值参数 zh/en 一致（{scope}/{n}）',
    /\{scope\}/.test(zhSet.memoryResetScopeTitle) && /\{scope\}/.test(enSet.memoryResetScopeTitle)
    && /\{scope\}/.test(zhSet.memoryResetScopeAction) && /\{scope\}/.test(enSet.memoryResetScopeAction)
    && /\{n\}/.test(zhSet.memoryResetDone) && /\{n\}/.test(enSet.memoryResetDone));
}

console.log(`\nmemory-file-channel: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
