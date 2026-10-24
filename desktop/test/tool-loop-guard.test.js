// 空转防线：① ESM 边界（主进程 CJS 不得 require ESM 模块）
//           ② editFile 未命中必须回传可行动诊断（否则模型只会原样重试 → 死循环）
//           ③ 重复失败熔断（同一工具 + 同样参数连续失败达阈值必须停止，而非烧到 120 轮硬顶）
//
// 事故背景（真机）：主进程 main.js 用 require('../agent-core/index.js')，
// agent-core/package.json 声明 "type": "module" → Electron 抛 ERR_REQUIRE_ESM。
// **崩在模块加载期**：require 之后的所有 IPC 注册与窗口创建都不执行，表现为「app 起来了但一片空白」。
// 本地 node 22 支持 require(ESM) 所以测试全绿，只有真机 Electron 才炸——这类问题必须用静态检查兜住。
const path = require('path');
const fs = require('fs');
const Module = require('module');

let pass = 0;
let total = 0;
function check(name, cond, detail) {
  total += 1;
  if (cond) {
    pass += 1;
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────
// ① ESM 边界静态检查（不加载 Electron，纯源码分析）
// ─────────────────────────────────────────────
const MAIN_DIR = path.join(__dirname, '..', 'main');

// 目标文件所属包的 type：向上找最近的 package.json
function pkgTypeOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const t = JSON.parse(fs.readFileSync(pj, 'utf8')).type;
        return t === 'module' ? 'module' : 'commonjs';
      } catch {
        return 'commonjs';
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'commonjs';
}

function resolveRequireTarget(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* 跳过不可读取的候选 */ }
  }
  return null;
}

function listMainSources() {
  return fs.readdirSync(MAIN_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(MAIN_DIR, f));
}

// 自检：门禁本身能识别 agent-core 是 ESM 包（否则下面所有断言都可能是假绿）
check('门禁自检：agent-core 被判定为 ESM 包',
  pkgTypeOf(path.join(__dirname, '..', 'agent-core', 'index.js')) === 'module');
check('门禁自检：主进程自身被判定为 CommonJS',
  pkgTypeOf(path.join(MAIN_DIR, 'main.js')) === 'commonjs');

const esmRequireViolations = [];
for (const file of listMainSources()) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // 只管相对路径（裸包由 package.json 声明，另论）
    const target = resolveRequireTarget(file, spec);
    if (!target) continue;
    if (pkgTypeOf(target) === 'module') {
      esmRequireViolations.push(`${path.basename(file)} → ${spec}`);
    }
  }
}
check('主进程不得 require ESM 模块（Electron 会 ERR_REQUIRE_ESM 启动即崩）',
  esmRequireViolations.length === 0, esmRequireViolations.join('; '));

// agent-core 必须走动态 import（惰性 + 失败可捕获为任务失败，而非进程崩溃）
const mainSrc = fs.readFileSync(path.join(MAIN_DIR, 'main.js'), 'utf8');
check('agent-core 经动态 import 加载（失败降级为任务失败，不是进程崩溃）',
  /loadAgentCore[\s\S]{0,200}import\(['"]\.\.\/agent-core\/index\.js['"]\)/.test(mainSrc));
check('动态 import 失败后清空缓存以便重试（否则一次失败永久失败）',
  /agentCorePromise\s*=\s*null/.test(mainSrc));

// 打包范围：主进程运行时动态 import agent-core，files 里漏了它 →
// 开发版一切正常、打包版定时任务执行通道必然失败（另一种「本地能跑、真机崩」）
const desktopPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const buildFiles = desktopPkg?.build?.files || [];
check('打包 files 含 agent-core（主进程运行时依赖，漏了打包版必崩）',
  buildFiles.some((f) => String(f).startsWith('agent-core')), JSON.stringify(buildFiles));

// ─────────────────────────────────────────────
// ② editFile 集成：未命中必须可行动
// ─────────────────────────────────────────────
const handlers = new Map();
const noop = () => {};
// P0-2 新审批协议：捕获 tool:approval-response 全局监听器；
// FakeBrowserWindow.send 收到 tool:approval-request 后 5ms 回带 approvalId 的「允许一次」
let approvalResponseCb = null;
const ipcMain = {
  handle: (ch, fn) => handlers.set(ch, fn),
  on: (channel, cb) => { if (channel === 'tool:approval-response') approvalResponseCb = cb; },
  once: noop,
};
function autoRespondApproval(channel, payload) {
  if (channel === 'tool:approval-request' && approvalResponseCb) {
    setTimeout(() => approvalResponseCb({}, { approvalId: payload?.approvalId, decision: 'once' }), 5);
  }
}
class FakeBrowserWindow {
  constructor() { this.webContents = { setWindowOpenHandler: noop, openDevTools: noop, send: autoRespondApproval, on: noop }; }
  isDestroyed() { return false; } // P0-5：requestApproval 现按窗口存活判定 fail-closed，桩需对齐真实契约
  loadURL() {} loadFile() {} on() {} once() {} show() {}
  isMinimized() { return false; } restore() {} focus() {}
  getBounds() { return { width: 1600, height: 1000 }; }
}
const electronStub = {
  app: { whenReady: () => Promise.resolve(), on: noop, requestSingleInstanceLock: () => true, getPath: () => '/tmp/mjcode-test', isPackaged: false, quit: noop },
  BrowserWindow: FakeBrowserWindow,
  ipcMain,
  shell: { openExternal: noop },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

require('../main/main.js');
const h = (name) => handlers.get(name);

// ─────────────────────────────────────────────
// ③ 重复失败熔断（ESM 引擎，动态 import）
// ─────────────────────────────────────────────
(async () => {
  // P0-5 后直连 IPC 恒过审批：先让 whenReady 微任务跑完（FakeBrowserWindow 就位），
  // 审批卡经 autoRespondApproval 自动「允许一次」，后续断言测的是编辑诊断而非审批
  await new Promise((r) => setImmediate(r));
  const TMP = '/tmp/mjcode-edit-guard';
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'app.js');
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconsole.log(a, b);\n');

  // 1. 未命中：必须 ok:false + 可行动 hint + 附近锚点，且不得 throw（throw 会变成 IPC rejection，
  //    渲染层只拿到一句 message，模型无从纠正 → 原样重试 → 空转循环）
  const miss = await h('tool:editFile')({}, {
    path: file, search: '这段根本不在文件里', replace: 'x', requireApproval: false, cwd: TMP,
  });
  check('editFile 未命中返回结构化失败（不 throw，不变成 IPC rejection）',
    miss && miss.ok === false && typeof miss.error === 'string');
  check('未命中错误信息含目标绝对路径（模型才知道改的是哪个文件）',
    typeof miss.error === 'string' && miss.error.includes(file), miss && miss.error);
  check('未命中带可行动提示 hint（说明可能原因 + 下一步）',
    typeof miss.hint === 'string' && miss.hint.length > 10, miss && miss.hint);
  check('未命中必然给出文件当前样貌（模型据此重新对齐，而不是盲改）',
    typeof miss.nearest === 'string' && miss.nearest.includes('const a = 1'), miss && miss.nearest);

  // 2. 换行符差异：CRLF 文件 + LF 片段 → 必须提示换行符（最常见的未命中原因）
  const crlf = path.join(TMP, 'crlf.js');
  fs.writeFileSync(crlf, 'const a = 1;\r\nconst b = 2;\r\n');
  const crlfMiss = await h('tool:editFile')({}, {
    path: crlf, search: 'const a = 1;\nconst b = 2;', replace: 'x', requireApproval: false, cwd: TMP,
  });
  check('CRLF/LF 差异被诊断出来并明确告知',
    typeof crlfMiss.hint === 'string' && crlfMiss.hint.includes('换行符'), crlfMiss && crlfMiss.hint);

  // 3. 空 search 必须被拒：'' 对 includes 恒真，会把内容插到文件最开头（静默破坏文件）
  const before = fs.readFileSync(file, 'utf8');
  const empty = await h('tool:editFile')({}, {
    path: file, search: '', replace: 'INJECTED', requireApproval: false, cwd: TMP,
  });
  check('空 search 被拒绝（否则会静默插到文件开头）', empty && empty.ok === false);
  check('空 search 被拒后文件内容未被改动', fs.readFileSync(file, 'utf8') === before);

  // 4. replace 中的 $& / $1 不得被当成特殊替换模式展开（会静默写坏内容）
  const dollar = path.join(TMP, 'dollar.js');
  fs.writeFileSync(dollar, 'foo');
  await h('tool:editFile')({}, {
    path: dollar, search: 'foo', replace: 'bar$&baz', requireApproval: false, cwd: TMP,
  });
  check('replace 中的 $& 按字面写入（不被展开成匹配内容）',
    fs.readFileSync(dollar, 'utf8') === 'bar$&baz', fs.readFileSync(dollar, 'utf8'));

  // 5. 多处相同片段：只替换第一处并明确告知（避免误伤其它位置还不自知）
  const dup = path.join(TMP, 'dup.js');
  fs.writeFileSync(dup, 'a\na\na\n');
  const dupRes = await h('tool:editFile')({}, {
    path: dup, search: 'a', replace: 'b', requireApproval: false, cwd: TMP,
  });
  check('多处匹配只替换第一处', fs.readFileSync(dup, 'utf8') === 'b\na\na\n', fs.readFileSync(dup, 'utf8'));
  check('多处匹配时回传 occurrences 与 warn（模型知道还有 N-1 处没改）',
    dupRes && dupRes.occurrences === 3 && typeof dupRes.warn === 'string' && dupRes.warn.includes('3'));

  // 6. 文件不存在：必须带项目目录（否则模型只会用同一个错路径反复重试）
  const nf = await h('tool:editFile')({}, {
    path: path.join(TMP, 'nope.js'), search: 'x', replace: 'y', requireApproval: false, cwd: TMP,
  });
  check('editFile 目标不存在时返回 notFound 并带项目目录',
    nf && nf.ok === false && nf.notFound === true && String(nf.error).includes(TMP), nf && nf.error);

  // ── 熔断 ──
  const core = await import('../agent-core/index.js');
  check('toolSignature 对 key 顺序不敏感（换顺序不得绕过熔断）',
    core.toolSignature('edit_file', { path: '/x', search: 's' }) === core.toolSignature('edit_file', { search: 's', path: '/x' }));
  check('isToolFailure 认 ok:false 与显式 error',
    core.isToolFailure({ ok: false }) === true && core.isToolFailure({ error: 'x' }) === true);
  check('isToolFailure 不把 shell 的 exitCode!==0 当失败（grep 没命中是正常的）',
    core.isToolFailure({ stdout: '', exitCode: 1 }) === false);

  let chatCalls = 0;
  const failArgs = JSON.stringify({ path: '/tmp/x', search: 'SAME', replace: 'R' });
  const chat = async () => {
    chatCalls += 1;
    return {
      content: '',
      tool_calls: [{ id: `c${chatCalls}`, type: 'function', function: { name: 'edit_file', arguments: failArgs } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  };
  const out = await core.runAgent({
    messages: [{ role: 'user', content: '改一下文件' }],
    model: { provider: { id: 'p', base_url: 'http://127.0.0.1:1' }, model: { model_id: 'm' } },
    maxRounds: 40,
    toolHandlers: {
      chat,
      editFile: async () => ({ ok: false, error: '未找到要替换的内容' }),
    },
  });
  check('同一工具同样参数连续失败会熔断（不再烧到 40 轮硬顶）',
    chatCalls <= 5, `实际请求 ${chatCalls} 轮`);
  check('熔断后如实告知用户是无效重试而非任务完成',
    String(out).includes('已主动停止') && String(out).includes('edit_file'), String(out).slice(0, 200));

  // 成功后计数清零：正常「失败 → 修正 → 成功」链路不得被误熔断
  let okCalls = 0;
  let attempts = 0;
  const chat2 = async () => {
    okCalls += 1;
    return {
      content: '',
      tool_calls: [{ id: `d${okCalls}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/y' }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  };
  const out2 = await core.runAgent({
    messages: [{ role: 'user', content: '读文件' }],
    model: { provider: { id: 'p', base_url: 'http://127.0.0.1:1' }, model: { model_id: 'm' } },
    maxRounds: 6,
    toolHandlers: {
      chat: chat2,
      readFile: async () => {
        attempts += 1;
        return attempts >= 3 ? { ok: true, content: 'done' } : { ok: false, error: '暂时失败' };
      },
    },
  });
  // 前 2 次失败、第 3 次起成功：熔断不得触发（触发则只会有 4 次调用）
  check('同签名成功后计数清零（正常「失败→修正→成功」不被误熔断）',
    attempts > 6 && !String(out2).includes('已主动停止'),
    `工具调用 ${attempts} 次 / 请求 ${okCalls} 轮`);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`PASS：${pass}/${total} 项通过`);
  // 主进程 stub 里有调度器定时器等常驻 handle，不显式退出会挂住整个 npm test 链
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
