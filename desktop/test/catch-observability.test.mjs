// C-001 门禁：catch 可观测性（「静默降级」棘轮）
//
// 审计原话：「898 处 catch 大量仅 return {error} 不记日志」。实测（2026-10-30，AST 统计）
// 生产代码 catch 共 1160 个，其中真正**静默降级**的是错误对象被彻底丢弃、且无日志无注释的那批。
//
// 判据（这条比「有几个 catch」重要得多）：
//   静默降级 = catch 里**没有引用错误对象** + 没有日志 + 没有注释 + 不返回错误形态。
//   反例（都不算静默，动辄误判的就是这几类）：
//     · catch (e) { return fail(e) }        —— 错误被传给调用方，能区分
//     · catch (e) { return { ok:false, error } } —— 明确失败形态
//     · catch { /* 已退出 */ }              —— 有注释论证，是「刻意忽略」
//     · catch (e) { setErr(e.message) }     —— 已经显示到界面上
//   为什么用「是否引用错误对象」而不是「返回值长什么样」：前者是结构性的、不会随重构漂移；
//   后者要靠正则猜（`return []` 在「真没数据」和「读失败」时长得一模一样）。
//
// 反向验证：把任意一处 `catch { /* 说明 */ }` 的注释删掉并不留日志，本套件必须红；
// 文件末尾的「自测」段对同一份判定函数做双向断言（坏样本必须命中、好样本必须不命中）。
//
// 棘轮：基线只降不升。降了就要在这里改小（否则等于给自己留了豁免额度）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require(path.join(DESKTOP, 'renderer', 'node_modules', 'typescript'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 只统计生产代码；test/ scripts/ 里的 catch 是测试自身的断言失败处理，不计入。
const ROOTS = ['main', 'agent-core', 'renderer/src', 'chrome-extension'];

// 当前基线。2026-10-30 首次建立时为 144；第一批（MCP 认证链 + 数据读取类）处理后 130；
// 第二批（wave 探活三通道 + chrome 中继 + 定时产出 + 运行追踪）处理后 117；
// 第三批（CUA 屏幕尺寸 + 主进程退出/cwd/消息序号 + MCP 传输四件套）处理后 105；
// 第四批（latex 探测 / 团队调试日志 / agent-core 能力探测与签名 / 审计滚动 / 大负载 / 记忆文件）处理后 90；
// 第五批（调度 id / 任务库损坏备份 / 本机模型探测 / 项目上下文 / KB 运行时 / 诊断导出 / CUA 录制 / 浏览器探测）处理后 74；
// 第六批（日志层 sink / 生态 API / 扩展中继 / 工具轨迹展示 / 四个进程宿主的 electron 能力探测）处理后 58；
// 第七批（引擎落地复查，58 → 0）：把剩余全部逐处读过并按「返回值会不会让上层得出错误结论」分三类处理——
//   ① 真·静默降级（加了日志/warn/error）：服务健康探测、插件注册表损坏、团队消息 payload 序列化失败、
//      worktree 丢弃失败、KB 取消判定抛错、任务状态读取失败导致 defer 误判、tesseract 语言包探测失真、
//      审批档读取失败、写入保护项探测失败、hook 正则非法、模型输出解析失败（teams/entryRouter/teamsDraft）、
//      OCR/预览/员工解析/项目目录探测/后台任务 payload/连接器是否需要配置/git diff 回传；
//   ② 原论证写错位置（注释在 try 上一行或 `}` 之后 ⇒ 从未计入）：jsonSafe、memory/index、modelsFile、
//      preload、sandboxWindows、agentsMd、intentLog、kbPdfImages、verifierL3、nativeSandbox/childEntry；
//   ③ 刻意忽略且已论证（返回值本身带形态字段，或调用方有专门分支）：i18n safeGlob、Modal、校验器类、
//      活动流文本、调试面板占位符、formatter 自身防递归。
const SILENT_BASELINE = 0;

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
};
const kindOf = (f) => (/\.tsx$/.test(f) ? ts.ScriptKind.TSX
  : /\.ts$/.test(f) ? ts.ScriptKind.TS
  : /\.jsx$/.test(f) ? ts.ScriptKind.JSX
  : ts.ScriptKind.JS);

// 已可观测的出口：日志层 / UI 反馈 / 审计 / 回调上报
const LOGGED = /\b(console\.(error|warn|log|debug|info)|logger\.\w+|log\w*\s*\(|reportError|warn\()/;
// 返回「明确的失败形态」：调用方拿得到 ok:false / error 字段，或 Request/Response 的 4xx-5xx
const ERR_SHAPE = /return\s*\{[^}]*\b(ok\s*:\s*false|error\s*:)|return\s*send\s*\(\s*[45]\d\d\b/;
const UI_FEEDBACK = /\b(set(Err|Error|Msg|Notice|Result|TestResult|TestStatus|UpdateError|OauthState|StatusMap|JsonMsg)\s*\(|toast\(|notify\(|flash\(|say\(|auditCredential\()/;

/**
 * 判断一个 catch 块是否属于「静默降级」。
 * @param {string} body catch 块的源码文本（含花括号）
 * @param {string|null} errName catch 绑定的错误变量名（无参 catch 传 null）
 */
function isSilentCatch(body, errName) {
  if (/\bthrow\b/.test(body)) return false;              // 重抛/自产错误
  if (/\breject\s*\(/.test(body)) return false;          // Promise 拒绝
  if (LOGGED.test(body)) return false;
  if (UI_FEEDBACK.test(body)) return false;
  if (ERR_SHAPE.test(body)) return false;
  if (/\/\/|\/\*/.test(body)) return false;              // 有注释论证
  if (errName) {
    // 引用了错误对象 ⇒ 错误被传递/使用，不算丢弃
    const re = new RegExp(`(?<![\\w$.])${errName.replace(/[$]/g, '\\$')}(?![\\w$])`);
    if (re.test(body)) return false;
  }
  return true;
}

const silent = [];
let total = 0;
for (const r of ROOTS) {
  const dir = path.join(DESKTOP, r);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kindOf(f));
    const visit = (n) => {
      if (ts.isCatchClause(n)) {
        total += 1;
        const body = n.block.getText(sf);
        const errName = n.variableDeclaration ? n.variableDeclaration.name.getText(sf) : null;
        if (isSilentCatch(body, errName)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          silent.push({ file: path.relative(DESKTOP, f).split(path.sep).join('/'), line });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

// 守卫①：扫描规模。AST 加载失败或 walk 退化时，下面每条都会「因为没东西可查」而绿。
check(`扫描规模守卫：catch 总数 ≥ 1000（实际 ${total}）`, total >= 1000);

check(`静默降级不超过基线 ${SILENT_BASELINE}（现状 ${silent.length}）`,
  silent.length <= SILENT_BASELINE,
  silent.length > SILENT_BASELINE
    ? `新增 ${silent.length - SILENT_BASELINE} 处未论证的静默 catch：\n${silent.map((s) => `  ${s.file}:${s.line}`).join('\n')}`
    : (silent.length < SILENT_BASELINE
      ? `已降到 ${silent.length}，请把 SILENT_BASELINE 同步改小（棘轮不留豁免额度）`
      : '持平'));

// 守卫②：基线不能被人为调高来「修绿」。上限锁死在首次建立时的 144。
check('基线未被上调（上限 144）', SILENT_BASELINE <= 144, `当前 ${SILENT_BASELINE}`);

// ── 自测：同一份判定函数，坏样本必须命中、好样本必须不命中 ──────────────────────
// 只测「函数返回 true」不够——必须同时证「它不会把所有 catch 都判成静默」，
// 否则函数退化成恒真时，棘轮反而会因为「数量暴涨」而红，掩盖真正的退化方向。
// 注意：样本只传 catch 的**块**，不能带 `catch (e)` 前缀——
// 否则 `(e)` 里的 e 会被「是否引用错误对象」这条判成「引用了」，恒为非静默（第一版就栽在这）。
const CASES = [
  ['静默：丢弃错误返回空数组', '{ return []; }', null, true],
  ['静默：绑定错误但压根没用', '{ return null; }', 'e', true],
  ['静默：纯 continue', '{ continue; }', null, true],
  ['非静默：传递错误对象', '{ return fail(e); }', 'e', false],
  ['非静默：错误形态返回', '{ return { ok: false, error: "x" }; }', null, false],
  ['非静默：有注释论证', '{ /* 已退出 */ }', null, false],
  ['非静默：有日志', '{ logger.warn("x", e.message); return null; }', 'e', false],
  ['非静默：重抛', '{ throw e; }', 'e', false],
  ['非静默：已显示到界面', '{ setErr(e.message); return null; }', 'e', false],
  ['非静默：4xx 响应即明确失败', '{ return send(400, { error: "bad" }); }', null, false],
];
const bad = CASES.filter(([, body, name, want]) => isSilentCatch(body, name) !== want);
check(`自测：判定函数对 ${CASES.length} 个样本双向正确`, bad.length === 0,
  bad.length ? `判错：${bad.map(([n, b, , w]) => `${n}（期望 ${w}）`).join('; ')}` : '全部符合预期');

console.log(`\ncatch-observability: ${pass}/${pass + fail} 通过（catch 总数 ${total}，静默 ${silent.length}/${SILENT_BASELINE}）`);
process.exit(fail === 0 ? 0 : 1);
