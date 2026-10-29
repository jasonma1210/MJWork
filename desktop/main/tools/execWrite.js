// 写工具实现层（2026-10-20 从 ./exec.js 抽出，行为不变）
//
// 为什么抽：exec.js 实测 799 raw / split('\n').length = 800，**800 软档只剩 0 行余量**——
// 加一行 require 就撞 `test/max-lines.test.js` 的 800 软档，而纪律禁止往 BASELINE_800 加条目
// （软档的设计意图是「God File 苗头，先拆再合入」）。这正是 role-clamp-parity 门禁注释里
// 预写的「正确做法是先抽模块再改，属台账 D-13-b」——本文件就是那次抽离。
//
// 边界：只放**写路径的实现与判定**（白名单外判定 / 未命中诊断 / apply_patch 执行）。
// 不持任何模块级状态——deps 由 exec.js 持有，经调用方传参进入，因此本模块可被安全 require。
// 原 exec.js 里的依赖位置清单（随实现一起迁来）：
//   editFile 未命中诊断（diagnoseEditMiss/nearestContext）→ ./editMissDiagnostics.js
//   工具路径解析（resolveToolPath）→ ./execCwd.js
const path = require('path');
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const { app } = require('electron');
const writeGuard = require('../writeGuard');
const { resolveToolPath } = require('./execCwd');
const { diagnoseEditMiss, nearestContext } = require('./editMissDiagnostics');
// P1-2：超时数字单一事实来源（与 exec.js 其余实现同源，见 tools/timeouts.js 的不变式说明）
const { PATCH_IMPL_TIMEOUT_MS } = require('./timeouts');

// P0-D：写工具实现提取为函数（IPC 与定时任务 Agent 通道共用）
// P0-3：写路径白名单——写目标越出 {项目 cwd, userData, 系统临时目录} 时：
//   · auto-safe / on-request：强制弹审批（不走 needsApproval，任何「始终允许」规则不可豁免）；
//   · never 档（全不询问）或 requireApproval=false（无审批通道的调用方）：直接硬拒绝，fail-closed。
//   白名单外的批准也不落地 conversation/always 规则，防止一次批准演变为永久绕过。
function outsideWriteTarget(toolName, args) {
  const roots = writeGuard.allowedWriteRoots({
    cwd: args.cwd,
    userDataDir: app.getPath('userData'),
  });
  if (toolName === 'applyPatch') {
    return writeGuard.firstOutsideTarget(writeGuard.patchTargets(args.patch), roots, args.cwd || process.cwd());
  }
  if (!args.path) return null;
  const target = resolveToolPath(args.path, args.cwd);
  return writeGuard.firstOutsideTarget([target], roots, args.cwd || process.cwd());
}

function targetMissing(err) { return err?.code === 'ENOENT' || err?.code === 'EISDIR'; }

async function executeWriteTool(toolName, { path: p, content, search, replace, patch, cwd }) {
  // 相对路径同样以项目 cwd 为基准（此前按主进程 CWD 解析，会写错位置或失败）
  const target = p ? resolveToolPath(p, cwd) : p;
  if (toolName === 'writeFile') {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    return { ok: true, path: target };
  }
  if (toolName === 'editFile') {
    // 空 search 必须先拦：'' 对 includes 恒真，会把 replace 插到文件最开头——静默破坏文件
    if (typeof search !== 'string' || search.length === 0) {
      return { ok: false, path: target, error: 'search 为空：空片段会匹配到文件开头并把内容插到最前面。请先用 read_file 读取当前内容，再给出精确的待替换片段。' };
    }
    if (typeof replace !== 'string') {
      return { ok: false, path: target, error: 'replace 必须是字符串（当前为 ' + typeof replace + '）' };
    }
    let fileContent;
    try {
      fileContent = await fsp.readFile(target, 'utf8');
    } catch (err) {
      const base = cwd || process.cwd();
      return {
        ok: false, notFound: true, path: target, cwd: base,
        error: err.code === 'EISDIR'
          ? `${target} 是目录，不是文件。请改用 list_dir 浏览其内容。`
          : `读取失败：${target} 不存在（项目目录：${base}）。若目标不在当前项目内请改用绝对路径。`,
      };
    }
    if (!fileContent.includes(search)) {
      // 未命中必须给出「为什么 + 现在是什么样」，否则模型只会重复同一片段 → 空转循环
      const d = diagnoseEditMiss(fileContent, search);
      const near = nearestContext(fileContent, search);
      return {
        ok: false, path: target, cwd: cwd || process.cwd(), editMiss: true,
        error: `${d.reason}（文件：${target}；待替换片段 ${search.length} 字符，开头：${d.preview}）`,
        hint: d.hints.join(' '),
        ...(near ? {
          nearest: `${near.matched ? `文件第 ${near.line} 行附近最接近（文件当前内容）` : '文件中没有相似行，这是文件开头'}：\n${near.snippet}`,
        } : {}),
      };
    }
    const occurrences = fileContent.split(search).length - 1;
    // 函数形式替换：避免 replace 文本里的 $& / $1 / $` 被当成特殊替换模式展开（静默写坏内容）
    const next = fileContent.replace(search, () => replace);
    await fsp.writeFile(target, next, 'utf8');
    return {
      ok: true, path: target, replaced: 1, occurrences,
      warn: occurrences > 1
        ? `文件中有 ${occurrences} 处完全相同的片段，本次只替换了第 1 处；若需全部替换请逐次调用，或改用 write_file 重写全文。`
        : null,
    };
  }
  // apply_patch：stdin 送入 patch，在项目 cwd 执行
  if (!patch || typeof patch !== 'string') throw new Error('patch 内容为空');
  // 2026-10-15 加固（三类失败模式全部实测复现后修复）：
  //   · --batch                 永不交互提问。此前 "Reversed (or previously applied)
  //                             patch detected! Assume -R? [n]" 会等 stdin 回答，
  //                             而 stdin 是补丁本身（写完即 end）→ EOF 异常或挂死
  //   · --forward               已应用过的补丁跳过而非报错（重复调用幂等）
  //   · --no-backup-if-mismatch 失败时不落 .orig / .ouD0ErF 备份
  //   · -r /dev/null            失败不再写 app.js.rej —— 此前会在用户项目里留下
  //                             拒绝文件，污染工作区、混进 git status 干扰后续提交
  const runPatchProcess = (extraArgs) => new Promise((resolve) => {
    const child = spawn('patch', ['-p1', '--batch', '--forward', '--no-backup-if-mismatch', '-r', '/dev/null', ...extraArgs], { cwd: cwd || process.cwd() });
    let stdout = '';
    let stderr = '';
    // P0-4：timer 必须先声明 —— spawn 失败的 'error' 与 setTimeout 赋值存在竞态（TDZ）。
    // settled 收口：error / timeout / close 三条路径只认第一条，同时避免定时器与句柄泄漏。
    let timer = null;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    // P0-4：此前没有 'error' 监听。Windows 默认没有 GNU patch ⇒ spawn ENOENT ⇒
    // ChildProcess 派发无人监听的 'error' ⇒ 主进程未捕获异常直接崩溃（全部会话丢失）。
    // 同项目 execFileDetached 早已正确处理同一情形，此处是裸 spawn 未沿用同一纪律。
    child.on('error', (e) => {
      finish({
        stdout: stdout.slice(0, 10000),
        stderr: `patch 不可用（${e.code || e.message}）：本机缺少 GNU patch。请改用 edit_file 精确替换，或先安装 patch。`,
        exitCode: -1,
        error: 'patch-unavailable',
      });
    });
    timer = setTimeout(() => {
      child.kill();
      finish({ stdout: stdout.slice(0, 10000), stderr: 'patch 执行超时', error: 'timeout', exitCode: -1 });
    }, PATCH_IMPL_TIMEOUT_MS);
    child.on('close', (code) => {
      // 已应用过的补丁：--forward 会跳过（hunk ignored），语义上应视为幂等成功。
      // 若当失败返回，模型会反复重试同一个补丁直到轮次耗尽（repeat 熔断）。
      // 注意：GNU patch 的「Reversed / hunk ignored」提示走 **stdout** 而非 stderr（实测），
      // 所以两个流都要查。
      const out = `${stdout}\n${stderr}`;
      if (/previously applied|hunk ignored/i.test(out)) {
        finish({ stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 5000), exitCode: 0, alreadyApplied: true, error: null });
        return;
      }
      finish({
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 5000),
        exitCode: code ?? 0,
        error: code ? `patch exit ${code}` : null,
      });
    });
    // EPIPE：子进程已退出（上面 error 路径）时写 stdin 会抛，必须降级为一条日志。
    child.stdin.on('error', (e) => console.warn('[patch] stdin write failed:', e.code || e.message));
    child.stdin.write(patch);
    child.stdin.end();
  });

  const result = await runPatchProcess([]);
  if (result.exitCode && !result.alreadyApplied) {
    // 二次机会：-l（忽略空白差异）。补丁失败的头号真实原因是空白对不上
    //（缩进空格数/制表符/行尾空白），严格模式拒绝而宽松模式能命中。
    const retry = await runPatchProcess(['-l']);
    if (!retry.exitCode || retry.alreadyApplied) {
      return { ...retry, lenientWhitespace: true, note: '严格模式应用失败后已按宽松空白匹配重试成功。' };
    }
    // P0-4：两次都失败时先判「工具本身不可用」（spawn ENOENT，exitCode=-1）。
    // 若套用下面「补丁上下文与文件当前内容不一致」的文案，会把用户的排障方向从
    // 「装 patch」带偏成「改补丁」—— 真因被上层文案掩盖，与本项目一贯的 fail-closed 叙事相反。
    if (retry.error === 'patch-unavailable' || result.error === 'patch-unavailable') {
      return { ok: false, exitCode: -1, error: retry.stderr || result.stderr, target: null };
    }
    // 两次都失败：必须可行动（与 editFile 未命中诊断同一原则）——
    // 回传目标绝对路径 + 当前内容（截断）+ 最近锚点行，模型据此改用
    // edit_file 精确替换或重新生成补丁，而不是原样重试同一 patch。
    const target = patchTargetPath(patch);
    const abs = target ? resolveToolPath(target, cwd) : null;
    let currentContent = null;
    let nearest = null;
    try {
      if (abs && fs.existsSync(abs)) {
        currentContent = fs.readFileSync(abs, 'utf8');
        const anchor = patchAnchorLine(patch);
        if (anchor) nearest = nearestContext(currentContent, anchor);
      }
    } catch (e) {
      // 读不到就不附加，不掩盖原始错误
      console.warn('[patch] 补丁目标文件读取失败（跳过上下文补充）:', e?.message || e);
    }
    return {
      ...retry,
      error: `patch exit ${retry.exitCode}（补丁上下文与文件当前内容不一致，未做任何修改）`,
      target: abs || target || undefined,
      hint: '不要原样重试同一补丁。请先 read_file 确认现状（下方 currentContent），'
        + '改用 edit_file 精确替换，或基于当前内容重新生成补丁。',
      currentContent: currentContent ? currentContent.slice(0, 4000) : undefined,
      nearest: nearest || undefined,
    };
  }
  return result;
}

// 从补丁解析目标路径（+++ b/ 行）：-p1 语义去一层前缀、去时间戳
function patchTargetPath(patch) {
  const line = String(patch || '').split('\n').find((l) => l.startsWith('+++ '));
  if (!line) return null;
  let p = line.slice(4).trim();
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^[ab]\//, '');
  return p || null;
}

// 首个 hunk 的锚点行：取第一条上下文/删除行的内容（文件中应存在），供 nearestContext 定位
function patchAnchorLine(patch) {
  const lines = String(patch || '').split('\n');
  const hunkIdx = lines.findIndex((l) => l.startsWith('@@'));
  if (hunkIdx < 0) return null;
  for (let i = hunkIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.startsWith(' ') || l.startsWith('-')) {
      const t = l.slice(1).trim();
      if (t) return t;
    }
  }
  return null;
}

module.exports = { outsideWriteTarget, targetMissing, executeWriteTool };
