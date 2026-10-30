// 定时任务输出落盘：~/Documents/.MJCoder/tasks/<任务名>/<YYYY-MM-DD>.md
//
// 为什么需要：定时任务在无人值守下跑完，结果只存在任务对象里（last_result 截断到 500 字符），
// 用户在应用外没有任何可查阅的产出。这里把每次运行的完整输出按「任务名 + 日期」归档，
// 同一天多次运行追加到同一个文件，形成可翻查的日志。
//
// 纪律：
//   · 目录名必须消毒（防路径穿越 / 非法字符 / Windows 保留名）；
//   · 写盘失败只告警，绝不影响任务本身的成败判定；
//   · 失败运行同样记录（带失败原因），否则「今天为什么没结果」无从追查。
const fs = require('fs');
const path = require('path');

const ROOT_DIR = '.MJCoder';
const SUB_DIR = 'tasks';
const MAX_NAME = 60;
// Windows 保留设备名：即便在类 Unix 上也统一处理，避免同一份数据跨平台不可用
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// 任务名 → 目录名：去掉路径分隔符与控制字符，剥掉前导点（隐藏目录/`..`），兜空与保留名
function safeTaskDirName(name) {
  const cleaned = String(name || '')
    // 这里的控制字符范围是**故意的**：清理任务名里的 \x00-\x1f 才安全
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_') // 连续点（`..` 片段）直接抹平：即使没有分隔符也不留可疑目录名
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .replace(/[.\s]+$/, '');
  // 只剩分隔符残留（`..` / `_ _`）的名字没有可读性，统一回落 untitled
  if (!cleaned || /^[_.\s]+$/.test(cleaned)) return 'untitled';
  return RESERVED.has(cleaned.toLowerCase()) ? `${cleaned}_task` : cleaned;
}

// 当天归档文件路径（导出便于单测与「打开所在目录」等 UI 复用）
function taskOutputPath(baseDir, taskName, date = localDate()) {
  return path.join(baseDir, ROOT_DIR, SUB_DIR, safeTaskDirName(taskName), `${date}.md`);
}

// ── 定时任务的「可写产出目录」（与归档目录 .MJCoder/tasks 同级，刻意复用同一个 safeTaskDirName）──
//
// 为什么需要：定时任务复用会话模型，会话没选项目时 runScheduledAgentTask 拿到的 cwd 为空。
// 而 writeFile 能否落盘由 main/writeGuard.js 的 allowedWriteRoots 决定，它只放行
// {cwd, userData, tmp}（另有 /tmp 与 .git/配置目录的 carve-out）—— cwd 为空时模型写
// ~/Documents/xxx.md 就判「白名单外写入」，无人值守又没有审批通道，只能被拒。
// （注意别把因果写成「read-only 沙箱挡死写文件」：writeFile 走 Node fs，不经过 shell 沙箱；
//   sandboxPolicy 约束的是 shell 子进程，设了 cwd 后它顺带从 read-only 升到 workspace-write。）
//
// 纪律：
//   · 目录名复用 safeTaskDirName —— 目录消毒规则只能有一套，否则归档目录与产出目录会漂移；
//   · 同一任务多次运行必须落到同一个目录（用户要能回去查阅/追加），故目录名只由任务名决定；
//   · 建目录失败只告警并返回空串（调用方据此回落只读），绝不因为建不出目录把任务打成异常。
const OUTPUT_SUB_DIR = 'output';

// 产出目录路径（纯函数，不建目录）。baseDir 通常是 Documents，兜底时是 userData。
function taskWorkDir(baseDir, taskName) {
  return path.join(baseDir, ROOT_DIR, OUTPUT_SUB_DIR, safeTaskDirName(taskName));
}

// app.getPath 可能抛（容器/无 Documents 目录的环境）：取不到给空串，由调用方兜底。
function safeAppPath(app, name) {
  try { return String((app && app.getPath && app.getPath(name)) || ''); } catch {
    // C-001：容器 / 无 Documents 目录等环境下 getPath 抛属预期。空串由调用方回落到 userData，
    // 两处都不可用时 ensureTaskWorkDir 返回 ''，上层已有一条告警可查 —— 这里不再重复刷屏。
    return '';
  }
}

// 建好产出目录并返回绝对路径：优先 Documents，取不到（或被建失败）则兜底 userData。
// 返回空串表示两处都不可用 —— 调用方此时才会回落到只读（并已有一条告警可查）。
function ensureTaskWorkDir({ app, taskName, baseDir } = {}) {
  const docs = String(baseDir || '').trim() || safeAppPath(app, 'documents');
  const ud = safeAppPath(app, 'userData');
  for (const [base, degraded] of [[docs, false], [ud, true]]) {
    if (!base) continue;
    const dir = taskWorkDir(base, taskName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (degraded) console.warn(`[scheduled] 取不到文档目录，产出降级到 ${dir}`);
      return dir;
    } catch (e) {
      console.warn(`[scheduled] 产出目录不可用（${dir}）：${e.message}`);
    }
  }
  return '';
}

function humanDuration(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

// 一次运行的 Markdown 片段：标题行写清「何时 / 成败 / 花多少」，正文是完整输出
function renderRunSection(run, at = new Date()) {
  const ok = run.status === 'success';
  const head = `## ${localTime(at)} · ${ok ? '成功' : '失败'}`;
  const meta = [
    `- 触发：${run.trigger || 'scheduled'}`,
    `- 耗时：${humanDuration(run.duration_ms)}`,
    run.tokens && (run.tokens.prompt_tokens || run.tokens.completion_tokens)
      ? `- tokens：${Number(run.tokens.prompt_tokens || 0).toLocaleString()} in / ${Number(run.tokens.completion_tokens || 0).toLocaleString()} out`
      : null,
    Number.isFinite(run.tools) ? `- 工具调用：${run.tools} 次` : null,
    ok ? null : `- 失败原因：${String(run.error || '未提供').slice(0, 500)}`,
  ].filter(Boolean).join('\n');
  const body = ok
    ? String(run.output || '（本次运行没有产出文本）').trim()
    : String(run.output || '').trim() || '（无输出）';
  // 待确认动作清单：定时任务默认不执行对外/不可逆动作，把它们攒在这里让人早上处理。
  // 放在产物里而不是只留在任务对象里 —— 归档 md 是应用外唯一可查阅的出口。
  const pending = Array.isArray(run.pending_actions) ? run.pending_actions : [];
  const pendingBlock = pending.length
    ? `\n\n### 待确认动作（${pending.length} 项，本次未执行）\n\n`
      + pending.map((p, i) => `${i + 1}. \`${p.tool}\`${p.command ? `：\`${String(p.command).slice(0, 200)}\`` : ''}`).join('\n')
      + '\n\n> 无人值守不执行对外/不可逆动作。确认无风险后请手动执行，或在该任务设置中允许对外动作。'
    : '';
  return `${head}\n\n${meta}\n\n${body}${pendingBlock}\n\n`;
}

// 追加一次运行记录到当天文件；首次写入时补文件头（任务名 + 日期 + 计划）
async function appendRunRecord({ baseDir, taskName, schedule, run, at = new Date() }) {
  if (!baseDir) return { ok: false, error: '未取到文档目录' };
  const file = taskOutputPath(baseDir, taskName, localDate(at));
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  let prefix = '';
  try {
    await fs.promises.access(file);
  } catch {
    // C-001：access 抛 = 文件尚不存在（ENOENT），这正是「首次写入要加标题前缀」的正常分支，
    // 不是降级。其余错误（权限等）也走同一分支：顶多多一个前缀，内容不丢。
    prefix = `# ${String(taskName || '定时任务')} · ${localDate(at)}\n\n`
      + `- 计划：\`${String(schedule || '')}\`\n\n---\n\n`;
  }
  await fs.promises.appendFile(file, prefix + renderRunSection(run, at), 'utf8');
  return { ok: true, file };
}

// ── 定时任务通道的「产出契约」提示词（拼在 BASE_PROMPT 之后，不替换它）──
//
// 为什么必须是**追加**而不是替换：agent-core 的 systemPrompt 参数是整体替换语义
// （`customSystemPrompt || BASE_PROMPT`，见 agent-core/index.js 的 sysSections.base），
// 用它当定时通道的系统提示，会把 BASE_PROMPT 里「你会用 write_file/read_file、默认在当前目录
// 读写、路径怎么给」这些能力说明整段丢掉 —— 模型连自己在哪个目录、能不能写都不知道。
// 真机事故就是这种形态：5 次工具调用、0 次写文件，最后只回了一段文本。
//
// 三条硬约束（缺一条都会退化成「只回文本」）：
//   ① 产物必须写成文件，并给出绝对目录（且说明目录已建好、不用它 mkdir）；
//   ② 最终回答只给「一句汇总 + 产物绝对路径」——把正文再贴一遍是最贵的浪费（进上下文还要重读）；
//   ③ 需要读项目文件时从 contextCwd 读（读走绝对路径、不受写白名单限制），但产出只写产出目录。
function buildScheduledPrompt({ dir, contextCwd } = {}) {
  const outDir = String(dir || '').trim();
  const readDir = String(contextCwd || '').trim();
  // 目录都建不出来时不追加空契约：没有可写目录时「必须写入 X」是一条无法执行的指令，
  // 只会让模型去找别的路径（然后被判白名单外）。调用方（scheduledRunContext）会同时 warn 留痕，
  // 任务最终会失败在「未产出文件」这条判定上 —— 那才是用户该看到的原因。
  if (!outDir) return '';
  return [
    '## 无人值守任务契约（定时任务通道，必须遵守）',
    `1. 必须把产物写成文件：所有产出文件一律写入 ${outDir}（该目录已创建、可写）。不需要你 mkdir，也不要写到别处——白名单外写入会被立即拒绝。`,
    '2. 文件名建议「<主题>-YYYY-MM-DD.md」（用当天日期）。分批抓取时每批立即追加到同一个文件，写完不要再引用该批原文。',
    '3. 最终回答只给「一句汇总 + 产物绝对路径」，不要重复正文/表格。回读/校验产物时请用**绝对路径** '
      + `${outDir}/<文件名>（相对路径会按项目目录解析，读不到刚写的文件）。`,
    readDir
      ? `4. 需要读项目/参考文件时可以从 ${readDir} 读取（读不受写白名单限制），但产出只写 ${outDir}。`
      : '4. 本次没有可参考的项目目录，需要外部信息时用联网工具获取。',
    '5. 不要反问、不要寒暄；工具失败就换方式重试或如实说明，不要假装完成。',
    '遇到需要枚举/抓取/处理大量条目（超过 10 条）的任务，自动分批：每批不超过 10 条。',
    // 编排：定时通道此前只有 23 个工具、没有 orchestrate_task，于是「同一句话在对话里能 4 个 Agent
    // 并行抓、在定时任务里只能串行」。补上工具还不够 —— 模型不会主动想到用，得在契约里点名。
    '6. 条目多（超过 30 条）且彼此独立时，**优先用 orchestrate_task 并行**：'
      + '把总量拆成 3–5 个互不重复的子任务，goal 里写清每个子任务要抓什么、要什么格式'
      + '（要点列表 + 来源 URL）。子任务只返回结构化要点，**不要让子任务写文件、也不要让子任务之间重复抓同一来源**；'
      + `最后由你汇总成一份文件写入 ${outDir}。`,
  ].join('\n');
}

// 定时任务一次运行的「工作区约定」：产出目录（已建好）+ 追加提示词。
// cwd 一律用产出目录，**不再复用会话 cwd**：
//   · 真机事故里任务是有 cwd 的（/Users/.../Documents/.MJCoder/20261017-5742），
//     沿用会话 cwd 等于「产出目录这件事完全没生效」，模型仍然只会回文本；
//   · 会话 cwd 不丢：作为 contextCwd 写进提示词，读能力不受影响（读走绝对路径）。
// 两个副作用（有意，不是 bug）：
//   ① runAgent 的 sandboxPolicy 因此变 workspace-write —— shell 也能在产出目录写，这是顺带收益；
//   ② 定时任务不再写用户项目目录 —— 无人值守不该往用户工程里丢文件，这是产品决策。
function scheduledRunContext({ app, taskName, contextCwd } = {}) {
  const dir = ensureTaskWorkDir({ app, taskName });
  if (!dir) {
    console.warn(`[scheduled] 任务「${String(taskName || '')}」解析不到可写的产物目录：本轮不追加产出契约（很可能无法落盘）`);
  }
  // 参考目录必须真实存在（S-2）：项目被删/移动后，git_* 与读类会全部指向不存在的路径
  //（fatal / ENOENT），而产出目录其实完全可用。这里退化成「无项目上下文」，契约自动走
  //「本次没有可参考的项目目录」那条分支，并留一条 warn 说明原因。
  let ctxDir = String(contextCwd || '').trim();
  try {
    if (ctxDir && !fs.existsSync(ctxDir)) {
      console.warn(`[scheduled] 任务「${String(taskName || '')}」的参考项目目录已不存在（${ctxDir}），本次按「无项目上下文」执行`);
      ctxDir = '';
    }
  } catch {
    // C-001：existsSync 基本不抛（内部已吞 ENOENT/EPERM），这里的兜底是防「路径对象异常」；
    // 后果与目录不存在同形 —— 按「无项目上下文」执行，上面那条 warn 已覆盖可观测性。
    ctxDir = '';
  }
  // 无条件追加（有目录就下发契约）：与会话有没有 cwd 无关 —— 那正是上一版对事故场景零生效的原因
  return { dir, appendPrompt: dir ? buildScheduledPrompt({ dir, contextCwd: ctxDir }) : '' };
}

module.exports = {
  ROOT_DIR, SUB_DIR, OUTPUT_SUB_DIR, safeTaskDirName, taskOutputPath, renderRunSection, appendRunRecord, localDate, localTime,
  // 定时任务的「可写产出目录」：taskWorkDir 纯路径 / ensureTaskWorkDir 建目录 + 兜底
  taskWorkDir, safeAppPath, ensureTaskWorkDir,
  // 定时任务通道：产出契约提示词（追加在 BASE_PROMPT 之后）+ 一次运行的工作区约定
  buildScheduledPrompt, scheduledRunContext,
};
