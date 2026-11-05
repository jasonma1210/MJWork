// ═══════════════════════════════════════════════════════════════
// P2-8 / V-L1（N3）：L1「日志对账」规则引擎 —— 规则单一事实来源，零依赖纯函数
// ═══════════════════════════════════════════════════════════════
// 为什么单独成文件（设计 §2.1）：
//   规则必须**跨宿主共用**，否则一定漂移（与 shared/untrustedContent.mjs 同构）。
//   本仓当前接入方：桌面端 main/verifyRun.js（其余宿主——eval/ 与 CLI——尚未接入，
//   属设计目标而非现状；P3 审查曾据此指出原注释「三方必须共用」表述虚高，已更正）。
// 硬纪律：**本文件零依赖**——不 import 任何模块（连 fs 与「派生子进程」类内建模块也不行）。
//   agent-core 被渲染层（Vite 打包）、主进程、引擎子进程三宿主加载，
//   任何一个 node: 内建 import 都会让渲染层打包失败或让判定在多宿主间分叉。
//
// ── 诚实边界（必须随代码一起读，设计 §11）────────────────────────
//   ① L1 只核「有没有发生写操作 / 有没有跑测试」，**不核「改得对不对」**：
//      write_file 成功 ≠ 内容正确；npm test exit 0 ≠ 测到了该测的东西。
//   ② 触发器是**正则匹配模型自述**，是意图识别的最弱形式。
//   ③ **设计取向：宁漏不误报（false negative > false positive）。**
//      理由：误报的形态是「用户对着已经做完的活看到『你说改了你没改』」——这是产品在
//      对用户撒谎，且用户无法自证；漏检的形态是「V 层没吭声」，用户看到的就是既往行为。
//      代价不对称，所以所有拿不准的边缘一律往「不算 claim / 算有证据」的方向倒。
//   ④ 因此**已知漏检必然存在**（不是 bug，是取向的代价），至少包括这些句式：
//      「改动已落地」「按上述方案完成了调整」「逻辑已经调整好了」「done / finished」；
//      以及同句出现「可以/建议/should」时会被建议语气抑制（例：「已修复 a.js，可以继续」
//      整句被抑制——设计 §3.2 如此规定）。漏检率**未知且不可测**（无标注集），
//      且系统性偏向表达多样的强模型 → 弱模型更容易被抓，强模型更容易漏。
//   ⑤ shell 写文件只能靠正则识别（WRITE_SHELL_RE）；node -e / python -c / perl -pi
//      已按「宁可多认证据」纳入，但仍会漏 → R1 的已知假阳性源。
//   ⑥ 拿不到 diff 时 R5 直接降级 SKIP（能力缺失 ≠ 事实冲突）。
//   ⑦ 因此任何文案都**不得**出现「已验证正确」「已通过验证」——
//      只能说「自述与执行记录一致 / 对不上」。
// ═══════════════════════════════════════════════════════════════

// ── 常量（写死，别用「写操作」这种词；设计 §5.2）──
export const VERIFY_DEFAULT_LEVEL = 'l1';
export const VERIFY_LEVELS = Object.freeze(['off', 'l1', 'l3']);
export const VERIFY_L1_BUDGET_MS = 30;      // 纯正则实测 ≤3ms，30ms 留 10× 余量
export const VERIFY_L3_TIMEOUT_MS = 45000;  // J3 用；此处仅作常量出口，本批不发起 L3 调用
export const CLAIM_WINDOW = 12;             // 否定语境扫描窗口（中文否定词 + 修饰语 ≈ 2~12 字符）
export const MAX_LEDGER_ENTRIES = 200;      // ring buffer 上限（120 轮硬顶 × 多工具仍有余量）
export const MAX_LEDGER_KEEP_HEAD = 20;     // 截断时保留「首 20 + 末 180」——首尾都要，中间丢
export const MAX_LEDGER_PATHS = 8;          // 每条记录最多 8 个路径
export const MAX_FIELD_CHARS = 200;         // 单字段上限（路径/命令摘要），绝不记全文
export const MAX_LEDGER_SCAN_CHARS = 200000; // finalText 扫描上限（防病态超长文本拖慢判定）

// ── 工具分类（写死，不靠「写操作」语义猜测）──
// 反向误报源：模型常用 shell 改文件（sed -i / 重定向 / tee / mv / cp / rm），
// 只认 WRITE_TOOLS 会大量误报「你说了改你没改」→ WRITE_SHELL_RE 也算证据。
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);
export const GIT_WRITE_TOOLS = new Set(['git_commit', 'git_add']);

// shell 侧写文件识别：宁可多认证据（设计 §11-9 明确要求把 node -e / python -c / perl -pi 纳入）。
// 含：就地编辑、写入类命令、重定向、代码执行写文件、包管理器（会改 lock/依赖）、补丁应用。
export const WRITE_SHELL_RE = new RegExp(
  '(?:^|[\\s;&|(])('
  + 'sed\\s+-i|perl\\s+-[a-z]*i|tee\\s|mv\\s|cp\\s|rm\\s|truncate\\s|dd\\s'
  // 只列**会改变文件内容**的命令：mkdir / chmod / git checkout 之类不算写证据
  // （否则「mkdir build 之后自称已修改 a.js」会被误判成有证据）。
  + '|touch\\s|patch\\s|git\\s+apply\\s'
  + '|node\\s+(-e|--eval)\\b|python3?\\s+-c\\b|ruby\\s+-e\\b'
  + '|npm\\s+(install|i|ci|uninstall)\\b|pnpm\\s+(add|install|remove)\\b|yarn\\s+(add|install)\\b|pip3?\\s+install\\b'
  + ')'
  + '|>{1,2}\\s*[^\\s&|]+',
  'i',
);

// 测试命令识别（R2/R3 的「跑了没」判据）
export const TEST_CMD_RE = new RegExp(
  '(^|[\\s;&|])('
  + 'npm\\s+(run\\s+)?test|npx\\s+(jest|vitest|mocha)|vitest|jest|pytest|python3?\\s+-m\\s+pytest'
  + '|go\\s+test|cargo\\s+test|mvn\\s+(test|verify)|gradle\\s+test|make\\s+(test|check)'
  + '|node\\s+(test/|--test)|tsc(\\s|$)|eslint'
  + ')([\\s;&|]|$)',
);

// ── 自述特征（正则，注意：这是「弱意图识别」，见诚实边界②）──
// 命中任一条即视为「模型在声称做了某件事」。
const CLAIM_WRITE_SRC = '(?:已|已经|完成(?:了)?)\\s*(?:修改|改好|更新|编辑|写入|创建|新增|删除|修复|重写)'
  + '|(?:修改|更新|写入|创建|删除)了?\\s*[\\w./\\-]+\\.[a-zA-Z]{1,6}\\b'
  + '|(?:modified|updated|created|deleted|fixed)\\s+[\\w./\\-]+\\.[a-zA-Z]{1,6}\\b';
export const CLAIM_WRITE_RE = new RegExp(CLAIM_WRITE_SRC, 'i');

const CLAIM_TEST_PASS_SRC = '(?:测试|单测|用例|tests?)\\s*(?:全部|均|都)?\\s*(?:通过|passed?|pass\\b)'
  + '|all\\s+tests?\\s+pass|验证通过|构建成功|build\\s+(?:succeeded|passed)'
  + '|(?:lint|tsc|编译)\\s*(?:通过|成功)';
export const CLAIM_TEST_PASS_RE = new RegExp(CLAIM_TEST_PASS_SRC, 'i');

const CLAIM_COMMIT_SRC = '(?:已|已经)\\s*(?:提交|commit)|committed|commit\\s+[0-9a-f]{7,40}\\b';
export const CLAIM_COMMIT_RE = new RegExp(CLAIM_COMMIT_SRC, 'i');

// 「已提交」在技术正文里还有另一个完全不同的意思：**数据库事务已提交**。
// 把这种句子当成「声称 git commit」，会让一段纯文字回答收到「但本轮没有成功的 git_commit 记录」
// 的阻断告警——用户看到一条跟正文毫无关系的批评，实际以「回放 WAL 中已提交的事务」复现过。
// 判据落在整句：句中同时出现「存储/事务」语境词、且没有任何 git 语境词，才算非 git 语义。
// 刻意不写成"句中有事务词就一律忽略"：『已提交到 git 仓库，事务回滚点已建』这种句子必须仍然命中。
const NON_GIT_COMMIT_SRC = '(?:事务|transaction|\\bWAL\\b|checkpoint|SQLite|数据库)';
const GIT_CONTEXT_SRC = '(?:\\bgit\\b|仓库|分支|push|推送|origin\\/|\\bHEAD\\b|\\bPR\\b|pull\\s+request|\\bcommit\\b)';
const NON_GIT_COMMIT_RE = new RegExp(NON_GIT_COMMIT_SRC, 'i');
const GIT_CONTEXT_RE = new RegExp(GIT_CONTEXT_SRC, 'i');

// apply_patch 的路径提取（补丁文本里没有 path 字段，只能从 patch 头取）
export const PATCH_PATH_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;
const PATCH_PATH_SRC = '^\\*\\*\\* (?:Update|Add|Delete) File: (.+)$|^\\+\\+\\+ b\\/(.+)$';

// 假阳性抑制层（设计 §3.2）
const NEGATION_SRC = '没有|没|未|无需|不必|无法|\\bnot\\b|didn\'?t|no\\s+need';
const SUGGESTION_SRC = '建议|可以|should|recommend|下一步';
// 第③层「历史引用」刻意不抑制，因此这里不需要对应正则（原 HISTORY_SRC/RE 已随 no-op 分支删除）

// 文件名 token：与 CLAIM_WRITE_RE 里的 {1,6} 不同，这里要求扩展名 ≥2 字符——
// 否则 "e.g." / "i.e." 会被当成文件名（英文自述里极常见），产生纯噪声的 BLOCK。
const FILE_TOKEN_SRC = '[\\w./\\-]+\\.[a-zA-Z]{2,6}\\b';

const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'notebook_path'];

// ── 小工具（全部纯函数）──
function allMatches(text, src, flags = 'g') {
  const out = [];
  const re = new RegExp(src, flags);
  let m = re.exec(text);
  let guard = 0;
  while (m && guard < 200) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 零长匹配防死循环
    m = re.exec(text);
    guard += 1;
  }
  return out;
}

function clip(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function basenameOf(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

// 取匹配点所在句子（以中英文句末标点 + 换行切句）——建议语气判定必须「同句」。
// 注意 lastIndexOf 返回 -1 时**不能**再做 +len（-1+2=1 会把句首切掉，导致「建议…」漏判）。
const SENTENCE_BREAKS = ['。', '！', '？', '\n', '. ', '! ', '? '];
function sentenceAround(text, idx) {
  let start = 0;
  for (const ch of SENTENCE_BREAKS) {
    const i = text.lastIndexOf(ch, idx);
    if (i !== -1) start = Math.max(start, i + ch.length);
  }
  let end = text.length;
  for (const ch of SENTENCE_BREAKS) {
    const i = text.indexOf(ch, idx);
    if (i !== -1) end = Math.min(end, i + ch.length);
  }
  return text.slice(start, end);
}

const NEGATION_RE = new RegExp(NEGATION_SRC, 'i');
const SUGGESTION_RE = new RegExp(SUGGESTION_SRC, 'i');

// 三层假阳性抑制（设计 §3.2）：
//   ① 否定语境：匹配点前 CLAIM_WINDOW 字符内出现「没有/未/无法/not…」→ 丢弃该 claim
//   ② 建议语气：同句出现「建议/可以/should/recommend…」→ 丢弃（那是提议，不是完成声明）
//   ③ 历史引用（「之前已」「原本就」）→ **刻意不抑制**（保守：宁多提示，不少提示）。
//      注意：这里曾有一句 `if (HISTORY_RE.test(sentence)) return false;`，与末尾
//      `return false` 同值（纯 no-op），却让后人误以为第③层参与了判定——已删除。
function isSuppressed(text, idx, sentence) {
  if (NEGATION_RE.test(text.slice(Math.max(0, idx - CLAIM_WINDOW), idx))) return true;
  if (SUGGESTION_RE.test(sentence)) return true;
  return false;
}

// 从「声称所在句子」里抽具体文件名（上限 5 个，去重）
function filesInSentence(sentence) {
  const out = [];
  for (const m of allMatches(sentence, FILE_TOKEN_SRC)) {
    const tok = m[0];
    if (!tok || tok.length > MAX_FIELD_CHARS) continue;
    const bn = basenameOf(tok);
    if (!bn || bn.length < 3) continue;
    if (!out.includes(bn)) out.push(bn);
    if (out.length >= 5) break;
  }
  return out;
}

function collectClaims(text, src) {
  const out = [];
  for (const m of allMatches(text, src, 'gi')) {
    const sentence = sentenceAround(text, m.index);
    if (isSuppressed(text, m.index, sentence)) continue;
    out.push({ text: m[0], index: m.index, sentence, files: filesInSentence(sentence) });
    if (out.length >= 12) break; // 病态长文本保护：判定只需要「有没有」，不需要枚举全部
  }
  return out;
}

// ── ledger 归一化（跨宿主来的数据不可信：字段可能缺失/类型漂移）──
export function normalizeLedger(ledger) {
  if (!Array.isArray(ledger)) return [];
  const cap = MAX_LEDGER_ENTRIES + 50;
  const out = [];
  for (const e of ledger.slice(0, cap)) {
    if (!e || typeof e !== 'object') continue;
    out.push({
      name: String(e.name || ''),
      ok: e.ok === true,
      ms: Number(e.ms) || 0,
      round: Number(e.round) || 0,
      paths: Array.isArray(e.paths)
        ? e.paths.map((p) => String(p).slice(0, MAX_FIELD_CHARS)).slice(0, MAX_LEDGER_PATHS)
        : [],
      command: typeof e.command === 'string' ? e.command.slice(0, MAX_FIELD_CHARS) : '',
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
    });
  }
  return out;
}

// ── 台账条目构造（引擎侧 N1 调用；宿主侧也复用于离线分析）──
// 只提取白名单元数据：工具名 + 关键路径/命令摘要（≤200 字符）+ 成败 + 耗时。
// **绝不记录**完整 args / 文件内容 / 工具输出（可能含密钥、超长正文）。
export function extractPaths(name, args) {
  const a = (args && typeof args === 'object') ? args : {};
  const out = [];
  const push = (p) => {
    const s = String(p || '').trim();
    if (!s || s.length > 2000) return;
    const clipped = s.slice(0, MAX_FIELD_CHARS);
    if (!out.includes(clipped) && out.length < MAX_LEDGER_PATHS) out.push(clipped);
  };
  for (const k of PATH_KEYS) if (typeof a[k] === 'string') push(a[k]);
  if (name === 'apply_patch' || name === 'patch' || name === 'apply_diff') {
    const src = a.patch || a.input || a.patch_text || a.diff || '';
    if (typeof src === 'string' && src) {
      for (const m of allMatches(src, PATCH_PATH_SRC, 'gm')) push(m[1] || m[2] || '');
    }
  }
  return out;
}

// 凭证脱敏（第二轮审查抓到的真实缺陷）：ledger.command 会随 verify_ledger 事件进
// traces/*.jsonl 落盘，而命令里常内联凭证（`curl -H "Authorization: Bearer sk-..."`）。
// 落盘面必须比屏幕更严——这里在**提取时**就打码，不依赖后续导出环节过滤。
// ⚠️ 两条硬约束（第三轮审查实测踩到，两根都是「打码区污染命令」）：
// 1) **不许用位置参数取前缀**：`String.replace` 的 replacer 在「只有一个捕获组」时签名是
//    (match, g1, offset, s)。写成 (m, p1, p2) 会把 **offset 当成 p2** —— 实测：
//      `Bearer abcdefghijklmnop` → `Bearer24***`（24 = 匹配起点偏移）
//      `sk-abcdefghijklmnopqrst`  → `sk11***`
//    一律改用命名组，位置参数只当不存在。
// 2) **值不许用 \S+**：它会把 shell 分隔符一起吃掉 —— 实测
//      `export TOKEN=abc;npm test` → `export TOKEN=*** test`
//    分号被吞掉，R2「改完代码跑过测试吗」于是拿到一条**不存在的命令**（误报/漏报都来了）。
//    值只吃到空白与 shell 分隔符为止。
const SECRET_PATTERNS = [
  /\b(?<head>Bearer)(?<sep>\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}/g,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{10,}/g,
  /\b(?:xox[baprs])-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b(?<head>password|passwd|token|secret|api[_-]?key)(?<sep>\s*[=:]\s*)[^\s;&|()<>"']+/gi,
];
export function redactSecrets(s) {
  let out = String(s == null ? '' : s);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      // 末位参数在有命名组时是 groups 对象；无命名组时是原字符串 → typeof 判别
      const groups = args[args.length - 1];
      const named = groups && typeof groups === 'object' ? groups : null;
      if (!named) return '***';
      return `${named.head || ''}${named.sep || ' '}***`;
    });
  }
  return out;
}

export function extractCommand(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const raw = typeof a.command === 'string' ? a.command
    : (typeof a.cmd === 'string' ? a.cmd
      : (Array.isArray(a.argv) ? a.argv.map(String).join(' ') : ''));
  // 先截断再脱敏：截断可能把 token 切成半截，交给 redactSecrets 时仍能匹配 `sk-` 前缀
  return redactSecrets(raw.slice(0, MAX_FIELD_CHARS));
}

function extractExitCode(result) {
  const n = result?.exitCode ?? result?.result?.exitCode;
  return typeof n === 'number' ? n : null;
}

/**
 * 构造一条 ledger 记录（引擎在每次工具执行后调用）。
 * ok 由调用方传入（单一事实来源是引擎的 isToolFailure），不传则按同语义兜底推导。
 */
export function buildLedgerEntry({
  i = 0, round = 0, name = '', args = null, result = null, ok, ms = 0,
} = {}) {
  const derivedOk = !(result && (result.ok === false
    || (typeof result.error === 'string' && result.error.length > 0)));
  return {
    i: Number(i) || 0,
    round: Number(round) || 0,
    name: String(name || ''),
    ok: ok === undefined ? derivedOk : !!ok,
    ms: Number(ms) || 0,
    paths: extractPaths(name, args),
    command: extractCommand(args),
    exitCode: extractExitCode(result),
  };
}

// ── 主判定：L1 对账（R1→R6，顺序固定以保证 findings[0] 稳定）──
/**
 * reconcile({ finalText, ledger, diff, level, stopHookActive })
 *   ledger  -> 本轮工具执行事实（null/undefined = **没收到**台账，≠ 空数组）
 *   diff    -> { statusPorcelain, stat } 或 null（拿不到工作区变更）
 *   return  -> { verdict: 'PASS'|'BLOCK'|'SKIP', findings[], stats, reason?, ruleId? }
 *
 * 失败语义（设计 §4.4）：L1 是**确定性事实核对**，不存在基础设施抖动 → fail-close，
 * 唯一例外是 R5 因「拿不到 diff」降级 SKIP（能力缺失，不是事实冲突）。
 */
export function reconcile({
  finalText, ledger, diff = null, level = VERIFY_DEFAULT_LEVEL, stopHookActive = false,
} = {}) {
  const findings = [];
  const stats = { tools: 0, writes: 0, shellWrites: 0, tests: 0, claims: 0 };

  // ① 级别与防死循环闸——先于一切规则（它们决定「要不要判」）
  if (level === 'off') return { verdict: 'SKIP', reason: 'level_off', findings, stats };
  // Codex 式 stop_hook_active：续跑发起后，第二次判定直接放行，不产生新的 BLOCK（设计 §6）
  if (stopHookActive) return { verdict: 'SKIP', reason: 'stop_hook_active', findings, stats };
  // N9：level 开着但没收到台账 = 调用点可能漏接 —— 绝不静默 PASS
  if (ledger == null) return { verdict: 'SKIP', reason: 'no_ledger', findings, stats };

  const text = String(finalText == null ? '' : finalText).slice(0, MAX_LEDGER_SCAN_CHARS);
  const entries = normalizeLedger(ledger);
  stats.tools = entries.length;

  const okWriteTools = entries.filter((e) => e.ok && WRITE_TOOLS.has(e.name));
  const okShellWrites = entries.filter((e) => e.ok && e.name === 'shell' && WRITE_SHELL_RE.test(e.command));
  const testRuns = entries.filter((e) => e.name === 'shell' && TEST_CMD_RE.test(e.command));
  stats.writes = okWriteTools.length;
  stats.shellWrites = okShellWrites.length;
  stats.tests = testRuns.length;

  const writtenBasenames = [];
  for (const e of okWriteTools) for (const p of e.paths) writtenBasenames.push(basenameOf(p));
  const hasWriteEvidence = okWriteTools.length > 0 || okShellWrites.length > 0;

  const writeClaims = collectClaims(text, CLAIM_WRITE_SRC);
  const testClaims = collectClaims(text, CLAIM_TEST_PASS_SRC);
  // 「数据库事务已提交」不是 git 提交声明：句中有存储语境、且没有 git 语境时丢弃（见常量处注释）。
  const commitClaims = collectClaims(text, CLAIM_COMMIT_SRC)
    .filter((c) => !(NON_GIT_COMMIT_RE.test(c.sentence) && !GIT_CONTEXT_RE.test(c.sentence)));
  stats.claims = writeClaims.length + testClaims.length + commitClaims.length;

  // ── R1 claim_write_no_evidence：说改了 → 必须有成功写入证据 ──
  if (writeClaims.length > 0) {
    if (!hasWriteEvidence) {
      findings.push({
        ruleId: 'claim_write_no_evidence',
        severity: 'block',
        reason: `自述「${clip(writeClaims[0].text, 40)}」，但本轮没有任何成功的写操作记录（写工具或 shell 写命令）`,
        evidence: 'none',
      });
    } else if (okWriteTools.length > 0) {
      // 声称里带具体文件名 → 该文件必须出现在某条成功写入的 paths[] 中（basename 匹配即算）。
      // 例外：**仅有 shell 写证据**时不追究文件名——shell 命令无法可靠归因到具体文件，
      // 追究会把「用 shell 改文件」这类真实改动误判成无证据（设计 §11-9 已知假阳性源）。
      const missing = [];
      for (const c of writeClaims) {
        for (const bn of c.files) {
          if (writtenBasenames.includes(bn)) continue;
          // 再给一次机会：该文件可能正是被 shell 命令改的（命令里出现同名即算证据）——
          // 「宁可多认证据」是 R1 的既定取舍（设计 §11-9），误报代价由 annotate 档兜住。
          if (okShellWrites.some((e) => e.command.includes(bn))) continue;
          missing.push(bn);
        }
      }
      if (missing.length > 0) {
        findings.push({
          ruleId: 'claim_write_no_evidence',
          severity: 'block',
          reason: `自述改了 ${[...new Set(missing)].slice(0, 3).join('、')}，但成功写入记录里没有该文件`
            + `（写入了 ${[...new Set(writtenBasenames)].slice(0, 5).join('、') || '（无路径记录）'}）`,
          evidence: 'path-mismatch',
        });
      }
    }
  }

  // ── R2 claim_test_no_run / R3 claim_test_but_failed ──
  if (testClaims.length > 0) {
    if (testRuns.length === 0) {
      findings.push({
        ruleId: 'claim_test_no_run',
        severity: 'block',
        reason: `自述「${clip(testClaims[0].text, 40)}」，但本轮没有执行过任何测试命令`,
        evidence: 'no-test-run',
      });
    } else {
      const bad = testRuns.filter((e) => (e.exitCode == null ? e.ok !== true : e.exitCode !== 0));
      if (bad.length > 0) {
        const first = bad[0];
        findings.push({
          ruleId: 'claim_test_but_failed',
          severity: 'block',
          reason: `自述测试通过，但 ${bad.length} 次测试命令返回失败`
            + `（${clip(first.command, 60)}${first.exitCode == null ? '' : ` → exit ${first.exitCode}`}）`,
          evidence: 'test-failed',
        });
      }
    }
  }

  // ── R4 claim_commit_no_evidence：说提交了 → 必须有成功的提交证据 ──
  // 证据面必须含 shell 里的 `git commit`：强模型常用 shell 提交，只认 git_commit 工具
  // 会把**真实完成的提交**判成 BLOCK —— 那正是「宁漏不误报」最要避免的一类误报
  // （用户对着已完成的工作看到「你说提交了你没提交」，且无法自证）。
  const hasCommitEvidence = entries.some(
    (e) => e.ok && (
      e.name === 'git_commit'
      || (e.name === 'shell' && /\bgit\s+commit\b/.test(String(e.command || '')))
    ),
  );
  if (commitClaims.length > 0 && !hasCommitEvidence) {
    findings.push({
      ruleId: 'claim_commit_no_evidence',
      severity: 'block',
      reason: `自述「${clip(commitClaims[0].text, 40)}」，但本轮没有成功的 git_commit 记录`,
      evidence: 'no-commit',
    });
  }

  // ── R5 claim_changes_diff_empty：说改了 → 工作区必须真有改动（拿不到 diff → SKIP）──
  if (writeClaims.length > 0) {
    if (diff == null) {
      findings.push({
        ruleId: 'claim_changes_diff_empty',
        severity: 'skip',
        reason: 'diff_unavailable：拿不到工作区变更（非 git 仓库 / 子进程宿主 / 权限不足），本条降级不判',
        evidence: 'diff_unavailable',
      });
    } else {
      const st = String(diff.statusPorcelain || '').trim();
      const stt = String(diff.stat || '').trim();
      if (!st && !stt) {
        findings.push({
          ruleId: 'claim_changes_diff_empty',
          severity: 'block',
          reason: '自述改了文件，但工作区 `git status --porcelain` 与 `git diff --stat` 都为空'
            + '（改动可能落在别的目录，或根本没有改）',
          evidence: 'diff-empty',
        });
      }
    }
  }

  // ── R6 written_no_mention（WARN，永不改变 verdict）：写了但总结里没提 ──
  if (writtenBasenames.length > 0 && !writtenBasenames.some((bn) => bn && text.includes(bn))) {
    findings.push({
      ruleId: 'written_no_mention',
      severity: 'warn',
      reason: `本轮写入了 ${[...new Set(writtenBasenames)].slice(0, 3).join('、')}，但最终总结里没有提到这些文件`,
      evidence: 'silent-write',
    });
  }

  const blocking = findings.filter((f) => f.severity === 'block');
  return {
    verdict: blocking.length > 0 ? 'BLOCK' : 'PASS',
    findings,
    stats,
    ...(blocking.length > 0 ? { ruleId: blocking[0].ruleId, reason: blocking[0].reason } : {}),
  };
}

/**
 * verify({ ledger, finalText, diff, level, opts }) —— 宿主友好的薄封装。
 * status: 'pass' | 'warn' | 'block' | 'skip' | 'no_ledger'
 * verdicts: [{ rule, level: 'block'|'warn'|'skip', reason }]
 *   （skip 是 R5 的「能力缺失」降级，单独一档，便于宿主区分「没判」与「判过」）
 */
export function verify({ ledger, finalText, diff = null, level = VERIFY_DEFAULT_LEVEL, opts = {} } = {}) {
  const r = reconcile({
    finalText, ledger, diff, level, stopHookActive: opts?.stopHookActive === true,
  });
  const verdicts = r.findings.map((f) => ({
    rule: f.ruleId,
    level: f.severity === 'block' ? 'block' : (f.severity === 'skip' ? 'skip' : 'warn'),
    reason: f.reason,
  }));
  let status = 'pass';
  if (r.verdict === 'BLOCK') status = 'block';
  else if (r.reason === 'no_ledger') status = 'no_ledger';
  else if (r.verdict === 'SKIP') status = 'skip';
  else if (verdicts.some((v) => v.level === 'warn')) status = 'warn';
  return {
    verdicts,
    status,
    verdict: r.verdict,
    findings: r.findings,
    stats: r.stats,
    reason: r.reason,
    ruleId: r.ruleId,
  };
}

/**
 * BLOCK 的「标注告知」文案（annotate 档唯一动作：只在 finalText 末尾追加，不续跑、不改语义）。
 * 文案纪律（设计 §11-1）：只说「自述与执行记录对不上」，**绝不说「已验证正确/已通过验证」**。
 */
export function formatAnnotation(findings) {
  const blocks = (Array.isArray(findings) ? findings : []).filter((f) => f.severity === 'block');
  if (blocks.length === 0) return '';
  const lines = blocks.slice(0, 4).map((f) => `- ${f.reason}`);
  return '\n\n---\n【自检提示】本轮自述与执行记录对不上'
    + '（只核对「有没有发生」，不核对「改得对不对」，因此也不代表改动是正确的）：\n'
    + `${lines.join('\n')}\n如已实际完成，请忽略本提示。`;
}

/** 级别归一：未知值一律回落 off（fail-safe：宁可不开，也不要按未定义行为判） */
export function normalizeLevel(level) {
  return VERIFY_LEVELS.includes(level) ? level : 'off';
}
