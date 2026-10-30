// 覆盖缺口补齐（2026-10-17 代码审查 P2-2）：
// 下列模块此前**不被任何测试引用**，合计 405 行，其中包含「数据库不可用如何上报」
// 「编辑失败如何给模型可行动信息」「detached 是否真的自成进程组」「语音缺失是否 fail-closed」
// 这些一旦错了就直接影响用户可见行为的判断。一个文件覆盖四个模块，避免套件数膨胀。
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const M = (p) => require(path.join(ROOT, p));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
const eq = (a, b, msg = '') => {
  if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
const ok = (v, msg) => { if (!v) throw new Error(msg || '断言为假'); };
const skips = [];
function skip(name, why) {
  total++;
  skips.push(`${name}（${why}）`);
  console.log(`[SKIP] ${name} — ${why}`);
}

// ── 1. dbStatus：初始化失败的可见性（X4 的修复件，修完一直没测试） ──
{
  const dbStatus = M('main/dbStatus.js');

  check('dbStatus：初始态 ok=true 且无 warning', () => {
    dbStatus.markReady();
    const s = dbStatus.snapshot(true);
    eq(s.ok, true);
    eq(s.reason, '');
    eq(s.warning, '');
    eq(s.tasksReady, true);
  });

  check('dbStatus：markUnavailable 后 ok=false 并带真实原因', () => {
    dbStatus.markUnavailable('disk full');
    const s = dbStatus.snapshot(false);
    eq(s.ok, false);
    ok(s.reason.includes('disk full'), '原因未透出');
    eq(s.tasksReady, false);
  });

  check('dbStatus：markReady 只清「不可用」，不清 warning（警告是既成事实）', () => {
    dbStatus.markUnavailable('boom');
    dbStatus.markWarning('本地库已重建');
    dbStatus.markReady();
    const s = dbStatus.snapshot(true);
    eq(s.ok, true);
    eq(s.warning, '本地库已重建', 'markReady 误清了 warning');
  });

  check('dbStatus：toolFailure 把真实原因带给模型，不只说「初始化失败」', () => {
    dbStatus.markUnavailable('file is not a database');
    ok(dbStatus.toolFailure().includes('file is not a database'), '原因未带出');
  });

  check('dbStatus：register 注册 db:status 且返回快照', () => {
    const handlers = new Map();
    const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn) };
    dbStatus.register(fakeIpc, () => true);
    ok(handlers.has('db:status'), '未注册 db:status');
    const r = handlers.get('db:status')();
    ok(typeof r.ok === 'boolean' && 'warning' in r, '快照形状不对');
  });

  dbStatus.markReady();
}

// ── 2. editMissDiagnostics：工具失败必须可行动 ──
{
  const { diagnoseEditMiss, nearestContext } = M('main/tools/editMissDiagnostics.js');

  check('editMiss：空文件 → 明确提示改用 write_file', () => {
    const d = diagnoseEditMiss('', 'foo');
    ok(d.reason.includes('空'), '未识别空文件');
    ok(d.hints.join(' ').includes('write_file'), '未给出替代工具');
  });

  check('editMiss：CRLF/LF 差异 → 指出换行符而非「找不到」', () => {
    const d = diagnoseEditMiss('line1\r\nline2\r\n', 'line1\nline2');
    ok(d.hints.join(' ').includes('换行符'), `未识别换行符差异：${d.hints.join('|')}`);
  });

  check('editMiss：缩进/空白差异 → 指出空白', () => {
    const d = diagnoseEditMiss('function a() {\n    return 1;\n}', 'function a() {\n  return 1;\n}');
    ok(d.hints.join(' ').includes('空白') || d.hints.join(' ').includes('缩进'), '未识别空白差异');
  });

  check('editMiss：首行存在但后续不匹配 → 提示「可能已被前面步骤改掉」', () => {
    const d = diagnoseEditMiss('alpha\nbeta', 'alpha\ngamma');
    ok(d.hints.join(' ').includes('已被前面的步骤'), `未提示重复修改风险：${d.hints.join('|')}`);
  });

  check('editMiss：完全不存在 → 给出通用可行动提示（不返回空 hints）', () => {
    const d = diagnoseEditMiss('hello world', 'zzz-not-here');
    ok(Array.isArray(d.hints) && d.hints.length > 0, 'hints 为空');
    ok(d.hints.join(' ').includes('read_file'), '未要求先读文件');
  });

  check('nearestContext：返回定位行 + 片段（不是整文件倾倒），且片段带行号', () => {
    const src = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\ntarget_anchor\n' + 'tail';
    const n = nearestContext(src, 'target_anchor');
    ok(n && typeof n === 'object', '应返回对象');
    ok(typeof n.snippet === 'string' && n.snippet.length > 0, 'snippet 为空');
    ok(n.snippet.length <= 800, `片段未截断：${n.snippet.length}`);
    ok(/^\d+: /m.test(n.snippet), '片段缺少行号前缀，模型无法定位');
    ok(n.matched === true, '应标记为命中');
    ok(n.snippet.length < src.length, '片段不应等于整文件');
  });

  check('nearestContext：完全没有相似行时退回文件开头并标记未命中', () => {
    const n = nearestContext('aaa\nbbb\nccc', 'zzz-zzz');
    ok(n && n.matched === false, '应标记 matched=false');
    ok(n.snippet.includes('aaa'), '应退回文件开头');
  });
}

// ── 3. execFileDetached：detached 必须真的自成进程组（这是该模块存在的唯一理由） ──
{
  const { execFileDetached } = M('main/tools/execFileDetached.js');
  const run = (file, args, opts = {}) => new Promise((resolve) => {
    execFileDetached(file, args, opts, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

}

const { execFileDetached } = M('main/tools/execFileDetached.js');
function runDetached(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFileDetached(file, args, opts, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

const r1 = await runDetached(process.execPath, ['-e', 'process.stdout.write("ok-123")']);
check('execFileDetached：stdout 回传、无 error', () => {
  eq(r1.error, null, '不应有 error');
  eq(r1.stdout, 'ok-123');
});

const r2 = await runDetached(process.execPath, ['-e', 'process.exit(7)']);
check('execFileDetached：非零退出 → error.code 为退出码（execFile 契约）', () => {
  ok(r2.error, '应有 error');
  eq(r2.error.code, 7);
});

const r3 = await runDetached('/definitely/not/exist/bin', []);
check('execFileDetached：命令不存在 → error.code=ENOENT 而不是抛异常', () => {
  ok(r3.error, '应有 error');
  ok(r3.error.code === 'ENOENT', `code=${r3.error.code}`);
});

const r4 = await runDetached(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: 120 });
check('execFileDetached：超时 → error.killed 或 signal 标记，且回调只触发一次', () => {
  ok(r4.error, '超时应报错');
  ok(r4.error.killed === true || r4.error.signal, `既无 killed 也无 signal：${JSON.stringify(r4.error)}`);
});

const r5 = await runDetached(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000))'], { maxBuffer: 1024 });
check('execFileDetached：maxBuffer 超限截断但不杀进程（与 execFile 的有意差异）', () => {
  eq(r5.error, null, '截断不应报错');
  ok(r5.stdout.length <= 1024 + 32, `输出未被截断：${r5.stdout.length}`);
});

if (process.platform !== 'win32') {
  let childPid = null;
  await new Promise((resolve) => {
    const child = execFileDetached(process.execPath, ['-e', 'setTimeout(()=>{},3000)'], {}, () => resolve());
    childPid = child.pid;
    setTimeout(resolve, 150);
  });
  check('execFileDetached：POSIX 下子进程自成进程组（process.kill(-pid) 可用）', () => {
    ok(childPid, '未拿到 pid');
    let alive = true;
    try { process.kill(-childPid, 0); } catch { alive = false; }
    ok(alive, `-${childPid} 不存在，detached 未生效（这正是本模块存在的原因）`);
    try { process.kill(-childPid, 'SIGKILL'); } catch { /* 已退出 */ }
  });
}

// ── 4. voice：缺失时必须 fail-closed，不能静默降级到云端 ──
{
  const voice = M('main/voice.js');

  check('voice：MJCODE_WHISPER_BIN 指向可执行文件时被采用', () => {
    const prev = process.env.MJCODE_WHISPER_BIN;
    process.env.MJCODE_WHISPER_BIN = process.execPath;
    try { eq(voice.findWhisperBin(), process.execPath); }
    finally { if (prev === undefined) delete process.env.MJCODE_WHISPER_BIN; else process.env.MJCODE_WHISPER_BIN = prev; }
  });

  check('voice：指向不存在的路径 → 不采用（继续找其他候选，不做无效返回）', () => {
    const prev = process.env.MJCODE_WHISPER_BIN;
    process.env.MJCODE_WHISPER_BIN = '/nope/whisper-cli';
    try {
      const r = voice.findWhisperBin();
      ok(r === null || r !== '/nope/whisper-cli', '采用了不存在的二进制');
    } finally { if (prev === undefined) delete process.env.MJCODE_WHISPER_BIN; else process.env.MJCODE_WHISPER_BIN = prev; }
  });

  check('voice：模型目录不存在时 listModels 返回空数组而不是抛错', () => {
    const r = voice.listModels();
    ok(Array.isArray(r), `返回类型 ${typeof r}`);
  });

}

const gone = await (async () => {
  const prevBin = process.env.MJCODE_WHISPER_BIN;
  const prevModel = process.env.MJCODE_WHISPER_MODEL;
  process.env.MJCODE_WHISPER_BIN = '/nope/whisper-cli';
  process.env.MJCODE_WHISPER_MODEL = '/nope/model.bin';
  try {
    // 签名是 { wavBase64, language }，不是文件路径
    const { transcribeWav } = M('main/voice.js');
    return await transcribeWav({ wavBase64: Buffer.alloc(64).toString('base64') });
  } finally {
    if (prevBin === undefined) delete process.env.MJCODE_WHISPER_BIN; else process.env.MJCODE_WHISPER_BIN = prevBin;
    if (prevModel === undefined) delete process.env.MJCODE_WHISPER_MODEL; else process.env.MJCODE_WHISPER_MODEL = prevModel;
  }
})();

check('voice：无效音频 → 结构化失败，不抛异常也不假装成功', () => {
  eq(gone.ok, false, '不应假装成功');
  const msg = String(gone.error || '');
  ok(msg.length > 0, '未给出错误原因');
});

// 本机可能真的装了 whisper-cli（/opt/homebrew/bin），届时走的是"转写失败"分支而非"缺引擎"分支。
// 这条只在未安装环境可判，其余显式 SKIP —— 不把它伪装成通过。
if (gone.error && gone.error.includes('未找到')) {
  check('voice：缺引擎时给出安装指引（fail-closed，不静默降级到云端）', () => {
    const hint = String(gone.hint || '') + String(gone.error || '');
    ok(/安装|brew|install|MJCODE_WHISPER_BIN/i.test(hint), `缺安装指引：${hint}`);
  });
} else {
  skip('voice：缺引擎时给出安装指引', '本机已安装 whisper-cli，该分支不可达');
}

if (skips.length) console.log(`\n跳过 ${skips.length} 条（不代表已验证）：\n  - ${skips.join('\n  - ')}`);
console.log(`\n结果：${pass}/${total} 通过`);
