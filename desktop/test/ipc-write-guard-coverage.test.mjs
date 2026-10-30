// X14 回归门禁：写通道边界校验的覆盖面。
//
// 背景：X14 之前 162 条 ipcMain.handle 里只有 agent:* + tasks:* 有契约，其余写通道直接解构载荷
// （`async (_, { name, base_url }) => ...`）——`{}` 也能写库，超长/错类型直接落盘。本批次给剩余
// 高风险写通道补上了 payloadGuard 边界校验，本文件把「哪些通道已纳入 X14」硬编码下来：
//
//   ① 清单里的每条通道必须在 main/** 源码里真实存在（防清单腐化——改了通道名却没人更新清单）；
//   ② 每条通道的 handler 体内必须出现至少一处边界校验调用（直接 assert* 或注明过的共用出口）；
//   ③ 共用出口本身必须仍然真的调用 assert*（防止有人把出口改成恒真，校验静默失效）。
//
// 为什么不用行为断言：这些 handler 依赖 Electron/磁盘/子进程，单测里跑不起来；静态断言 +
// 清单腐化检查是唯一能长期守住「校验被悄悄删掉」的方式（历史上 X14 前两批的校验无人看守）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAIN = path.join(DESKTOP, 'main');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 已纳入 X14 的写通道清单（按文件分组，便于与 PR 描述逐条对照）──
// 取舍规则见报告：纯读通道、无入参通道、已有 zod 契约（agent:run / tasks 的 cancel·abortTask·
// abortGroup·retryTask·deleteGroup·config·execute）不在此列。
const GUARDED_CHANNELS = [
  // main/main.js —— 这几条是「main.js 里仅剩的直连写通道」（其余由 zod 契约或纯读排除，见下方剔除名单）。
  // 行数不是纳入范围的判据：按 eslint 的 code 口径（skipBlankLines+skipComments）main.js 余量充足，
  // 别把这段读成「main.js 快撞 1500 行」——那是历史上被传错的错误前提（60d989e 已清 7 处）。
  'checkpoint:clear',
  'cua:run',
  'cua:replay',
  'cua:recordings:delete',
  // main/autoLaunch.js
  'app:autoLaunchSet',
  // main/ipc/tasks.js（X14 从 main.js 搬出的任务编排域）
  'tasks:autoRun',
  'tasks:plan',
  // main/ipc/ecosystem.js
  'collab:open',
  'collab:applyUpdate',
  'skills:installEcosystem',
  'skills:importFromDir',
  'app:openInIDE',
  'websearch:setConfig',
  // 2026-10-18（WP-D）：数字员工实体化的三个写通道（落盘 employee 包 + RBAC 校验）。
  // 三者本身已带 guard.assertStrings/assertObject + rbac.assertCan，纳入清单是**防腐化**：
  // 将来有人改这几个通道时，套件会强制要求保留守卫（否则清单腐化检查会红）。
  'ecosystem:employeeCreate',
  'ecosystem:employeeUpdate',
  'ecosystem:employeeDelete',
  // main/ipc/gitHunks.js
  'tool:gitApplyHunk',
  'tool:gitApplyHunkCached',
  'tool:gitApplyHunkUnstage',
  'tool:gitCheckout',
  'tool:gitRestoreStaged',
  'tool:gitDiscardFiles',
  // main/ipc/localData.js
  'local:models-file/remove-model',
  'local:models-file/remove-provider',
  'local:models-file/add-model',
  'model:testConnection',
  'local:preferences/set',
  'local:memories/add',
  // M5 / T5-5：团队记忆一键确认晋升（写通道，落库改 scope/agent_id）——纳入清单防腐化：
  // 将来若删掉 id 的边界守卫，本套件会红。候选读取 memory:teamPromotionCandidates 为纯读，不纳入。
  'memory:confirmTeamPromotion',
  // 2026-10-18（P1-6）：会话分支写通道（复制历史落新会话，threadId/fromMessageId 须为数字）
  'local:threads/fork',
  // main/ipc/mcp.js
  'mcp:disconnect',
  // 2026-10-17：按名重连已保存服务（连接成功会回写 mcp-servers.json）
  'mcp:reconnect',
  'mcp:setConfig',
  'github:createPr',
  // main/ipc/sandbox.js（P1-4：Windows OS 级沙箱接线）
  // setup 属高风险写系统通道（建专用用户 / 改 ACL / 加防火墙规则，提权执行）；
  // teardown 删除专用用户与防火墙规则并清凭据。两条都必须保持 payloadGuard 边界校验。
  'sandbox:windows/setup',
  'sandbox:windows/teardown',
  // main/ipc/plugins.js
  'market:installGit',
  'market:setEnabled',
  'market:uninstall',
  // main/ipc/project.js
  'project:create',
  'worktree:create',
  'worktree:remove',
  'backup:create',
  'backup:restore',
  'files:saveUpload',
  // main/scheduler.js
  'scheduled:delete',
  'scheduled:run',
  'scheduled:setModel',
  // main/tools/exec.js
  'shell:openPath',
  'shell:openExternal',
  'tool:gitCommit',
  'tool:gitAdd',
];

// 直接校验：handler 体内调用 guard.assertXxx
const DIRECT_GUARD = /assert(?:Object|Strings|Ids|Tokens|Array|Enum)\s*\(/;
// 间接校验：调用本仓约定的共用出口（每个出口自身另有断言，见下方「共用出口仍在真校验」）
const INDIRECT_GUARD = /\b(?:payloadShapeError|hunkInputError|payloadRejection)\s*\(/;

// ── 收集 main/** 源码 ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const sources = walk(MAIN).map((file) => ({
  file: path.relative(DESKTOP, file),
  src: fs.readFileSync(file, 'utf8'),
}));

// 通道 → handler 体（从 `ipcMain.handle('<通道>'` 到下一个 `ipcMain.handle(` 之前）
function handlerBody(channel) {
  const needle = `ipcMain.handle('${channel}'`;
  for (const { file, src } of sources) {
    const at = src.indexOf(needle);
    if (at < 0) continue;
    const nextAt = src.indexOf('ipcMain.handle(', at + needle.length);
    return { file, body: nextAt > 0 ? src.slice(at, nextAt) : src.slice(at) };
  }
  return null;
}

// ── ① 清单腐化检查：每条通道都要真实存在 ──
check(`清单中的 ${GUARDED_CHANNELS.length} 条写通道都真实存在于 main/**`, () => {
  const missing = GUARDED_CHANNELS.filter((c) => !handlerBody(c));
  if (missing.length) throw new Error(`以下通道在 main/** 里找不到 ipcMain.handle 注册（改名/搬走后请同步本清单）：${missing.join(', ')}`);
});

// ── ② 逐条断言 handler 体内有边界校验 ──
for (const channel of GUARDED_CHANNELS) {
  check(`${channel} 的 handler 体内有载荷边界校验`, () => {
    const hit = handlerBody(channel);
    if (!hit) throw new Error('通道不存在');
    if (DIRECT_GUARD.test(hit.body) || INDIRECT_GUARD.test(hit.body)) return;
    throw new Error(`${hit.file} 中该 handler 既没有 assert* 也没有走共用校验出口`);
  });
}

// ── ③ 共用出口仍在真校验（防止出口被改成恒真）──
check('共用出口 payloadShapeError 仍调用 assertStrings', () => {
  const file = sources.find((s) => s.file.endsWith(path.join('ipc', 'toolPayload.js')));
  if (!file) throw new Error('找不到 main/ipc/toolPayload.js');
  if (!/guard\.assertStrings\s*\(/.test(file.src)) throw new Error('payloadShapeError 未调用 guard.assertStrings');
  if (!/guard\.assertArray\s*\(/.test(file.src)) throw new Error('payloadShapeError 未调用 guard.assertArray（files 数组上限失效）');
});

check('hunkInputError 走 payloadShapeError（hunk 三通道的唯一入口）', () => {
  const file = sources.find((s) => s.file.endsWith(path.join('ipc', 'gitHunks.js')));
  if (!file) throw new Error('找不到 main/ipc/gitHunks.js');
  if (!/function hunkInputError[\s\S]{0,200}?payloadShapeError\s*\(/.test(file.src)) {
    throw new Error('hunkInputError 未走 payloadShapeError');
  }
});

check('tasks 的 payloadRejection 仍调用 guard.assertStrings', () => {
  const file = sources.find((s) => s.file.endsWith(path.join('ipc', 'tasks.js')));
  if (!file) throw new Error('找不到 main/ipc/tasks.js');
  if (!/function payloadRejection[\s\S]{0,300}?guard\.assertStrings\s*\(/.test(file.src)) {
    throw new Error('payloadRejection 未调用 guard.assertStrings');
  }
});

// ── ④ 反向检查：明确剔除的高风险通道名单（纯读 / 无入参 / zod 已覆盖）不许出现在清单里 ──
// 这条断言的作用：以后有人「顺手」把它们也加进来时，会先看到这里记录过的取舍理由。
const EXCLUDED_WITH_REASON = {
  'market:listInstalled': '纯读（读注册表返回列表）',
  'scheduled:runs': '纯读（读运行历史）',
  'local:threads/archived': '纯读（读归档会话）',
  'ecosystem:connectors': '纯读（读生态连接器目录）',
  'ecosystem:employeeRuntime': '纯读（读数字员工预设，不写库）',
  'collab:closeAll': '无入参（关闭全部本地文档句柄）',
  'local:models-file/open': '无入参（打开 models.json）',
  'cua:stop': '无入参（停止当前循环）',
  'cua:recordings:list': '纯读（列出录制）',
  'diag:export': '无入参（导出诊断包，载荷不进业务）',
  'agent:run': '已有 zod 契约（shared-ipc/contract.mjs agentRunPayloadSchema）',
  'tasks:execute': '已有 zod 契约（taskGroupRefSchema，与 tasks:cancel 同构）',
  'tasks:cancel': '已有 zod 契约（taskGroupRefSchema）',
  'tasks:abortTask': '已有 zod 契约（taskRefSchema）',
  'tasks:abortGroup': '已有 zod 契约（taskGroupRefSchema）',
  'tasks:retryTask': '已有 zod 契约（taskRetryPayloadSchema）',
  'tasks:deleteGroup': '已有 zod 契约（taskGroupRefSchema）',
  'tasks:config': '已有 zod 契约（taskConfigPayloadSchema）',
  'approval:deleteRule': '既有实现已判 typeof id !== "number" 且校验数组下标存在',
};

check('剔除名单未被重复纳入（取舍理由见本文件 EXCLUDED_WITH_REASON）', () => {
  const overlap = Object.keys(EXCLUDED_WITH_REASON).filter((c) => GUARDED_CHANNELS.includes(c));
  if (overlap.length) throw new Error(`以下通道既在剔除名单又在校验清单里：${overlap.join(', ')}`);
});

check('剔除名单里的通道确实仍存在于源码（防清单腐化）', () => {
  const missing = Object.keys(EXCLUDED_WITH_REASON).filter((c) => !handlerBody(c));
  if (missing.length) throw new Error(`剔除名单中的通道已不存在：${missing.join(', ')}`);
});

// ── C-001 失败可观测性：写通道的 catch 不得再「只回错误、不留痕」────────────────
// 2026-10-30 全量核查 C-001：`main/ipc/*.js` 大量 `catch (e) { return { ok:false, error: e.message } }`，
// 渲染层能看到一句话，主进程什么都不留 —— 用户报「创建项目失败」时无法定位是哪一步。
// 第一批已在 `ipc/project.js` 收敛为 `fail(scope, e)`（落 logger.warn 后返回同一形状）。
// 这里守两件事：① 该文件里每个 catch 都必须走统一落点（结构断言，不数常量，新增 handler 自动纳入）；
// ② `fail` 自身必须真的调用 logger.warn（防有人把它改成恒静默的壳，让上面那条全绿却毫无意义）。
const OBSERVABILITY_FILES = ['main/ipc/project.js'];

for (const rel of OBSERVABILITY_FILES) {
  check(`${rel}：每个 catch 都经统一落点记录（不再裸 return 错误）`, () => {
    const src = fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
    const lines = src.split('\n');
    const bad = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/catch\s*\(\w+\)\s*\{/.test(lines[i])) continue;
      // catch 之后的第一个**非注释非空**行（跨最多 4 行找）必须是落点。
      // 只看 1 行会误判「catch 后先写一行注释、再打日志」的形态；把注释当语句则会把
      // 「注释里写着 logger.warn」判成已落日志 —— 两种错法都会让门禁骗人，故显式跳过注释。
      const next = lines.slice(i + 1, i + 5).find((l) => l.trim() !== '' && !/^\s*\/\//.test(l)) || '';
      if (!/\bfail\(|logger\.(warn|error|info)|console\.(warn|error)/.test(next)) bad.push(`第 ${i + 1} 行 → ${next.trim().slice(0, 60)}`);
    }
    if (bad.length) throw new Error(`${bad.length} 处 catch 未落日志：\n     ${bad.join('\n     ')}`);
  });
}

check('main/ipc/project.js：fail() 真的调用 logger.warn（不是恒静默的壳）', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main/ipc/project.js'), 'utf8');
  const m = src.match(/function fail\(scope, e\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error('未找到 fail(scope, e) 定义');
  if (!/logger\.warn\(/.test(m[1])) throw new Error('fail() 体内没有 logger.warn —— 落点被改成静默壳');
  if (!/return \{ ok: false, error:/.test(m[1])) throw new Error('fail() 未返回 { ok:false, error } 形状，调用方契约被破坏');
});

console.log(`\nipc-write-guard-coverage: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
