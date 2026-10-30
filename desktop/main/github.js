// GitHub 最小闭环（P0-E）：gh CLI 封装
// 设计取舍：依赖用户本机 gh 登录态（gh auth login），不做云端 OAuth——
// 本地优先产品不引入额外凭证面；gh 不可用时给出明确的安装/登录引导而非裸报错。
// 全部经 execFile argv 数组传参，标题/正文含引号、$()、换行均无注入面。

const { execFile } = require('child_process');

// C-004：三档 gh 超时按语义拆开（此前 10000/15000/60000 散落，且 60000 出现 4 次）。
// 不合并成一档：--version 是毫秒级、auth status 要读本地配置、pr create 要走网络。
/** gh 探测（10s）：--version 属毫秒级，留足冷启动即可 */
const GH_PROBE_TIMEOUT_MS = 10000;
/** gh 登录态（15s）：读本地配置 + 可能的 token 校验 */
const GH_AUTH_TIMEOUT_MS = 15000;
/** gh 写/网络操作（60s）：pr create / comment / review 都要走 GitHub API */
const GH_TIMEOUT_MS = 60000;

// gh 是否安装（stdout 形如 "gh version 2.62.0 (2025-...)"）
function ghAvailable(execFn = execFile) {
  return new Promise((resolve) => {
    execFn('gh', ['--version'], { timeout: GH_PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(!error && /gh version/i.test(stdout || ''));
    });
  });
}

// gh 登录态（gh auth status 退出码 0 = 已登录）
function ghAuthed(execFn = execFile) {
  return new Promise((resolve) => {
    execFn('gh', ['auth', 'status'], { timeout: GH_AUTH_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ ok: !error, detail: String((error ? stderr : stdout) || '').trim().slice(0, 500) });
    });
  });
}

// 创建 Pull Request：{ ok, url } | { ok:false, error }
// gh pr create 成功时 stdout 末行为 PR URL
function createPullRequest({ cwd, title, body = '', base = '', draft = false }, execFn = execFile) {
  return new Promise((resolve) => {
    if (!title || !String(title).trim()) { resolve({ ok: false, error: 'PR 标题不能为空' }); return; }
    const args = ['pr', 'create', '--title', String(title), '--body', String(body || '')];
    if (base && String(base).trim()) args.push('--base', String(base).trim());
    if (draft) args.push('--draft');
    execFn('gh', args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (error) {
        resolve({ ok: false, error: String(stderr || out || error.message || '').trim().slice(0, 500) });
        return;
      }
      const url = out.split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) || out;
      resolve({ ok: true, url });
    });
  });
}

// ═══════════════════════════════════════════
//  PR 审查闭环（2026-10-15，对标 Codex 的 diff 审查「交付」出口）
//  闭环 = 列表 → 拉取结构化 diff（逐文件/逐 hunk）→ 审查 → 提交 review
//  设计约束：
//    · 全部经 gh CLI（复用本机登录态），argv 数组传参无注入面；
//    · 读操作不设审批；提交 review（approve/request_changes）属对外可见动作，
//      由 agent-core 的审批中心按 L3 处理（APPROVAL_TOOLS 收录 pr_review）；
//    · diff 体积上限：超大 PR 截断并提示按文件号分片拉取，避免灌爆上下文。
// ═══════════════════════════════════════════

function ghRun(args, { cwd, timeout = 60000, maxBuffer = 8 * 1024 * 1024 } = {}, execFn = execFile) {
  return new Promise((resolve) => {
    execFn('gh', args, { cwd, timeout, maxBuffer }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      if (error) {
        resolve({ ok: false, error: String(stderr || out || error.message || '').trim().slice(0, 600), stdout: out });
        return;
      }
      resolve({ ok: true, stdout: out });
    });
  });
}

// PR 列表：[{ number, title, author, state, branch, ci }]
function prList({ cwd, state = 'open', limit = 10, author = '' }, execFn = execFile) {
  return (async () => {
    const limitN = Math.max(1, Math.min(Number(limit) || 10, 50));
    const args = ['pr', 'list', '--state', String(state), '--limit', String(limitN),
      '--json', 'number,title,author,state,headRefName,statusCheckRollup'];
    if (author && String(author).trim()) args.push('--author', String(author).trim());
    const r = await ghRun(args, { cwd }, execFn);
    if (!r.ok) return r;
    try {
      const arr = JSON.parse(r.stdout);
      return { ok: true, prs: (Array.isArray(arr) ? arr : []).map((p) => ({
        number: p.number,
        title: String(p.title || ''),
        author: String(p.author?.login || ''),
        state: String(p.state || ''),
        branch: String(p.headRefName || ''),
        ci: summariseChecks(p.statusCheckRollup),
      })) };
    } catch (e) {
      return { ok: false, error: `gh 输出解析失败：${e.message}` };
    }
  })();
}

// CI 汇总：success/failure/pending/none
function summariseChecks(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  if (list.length === 0) return 'none';
  if (list.some((c) => c?.status === 'FAILED' || c?.conclusion === 'FAILURE')) return 'failing';
  if (list.some((c) => c?.status && c.status !== 'COMPLETED')) return 'pending';
  return 'passing';
}

// PR 元数据 + CI：审查前先看全貌
function prView({ cwd, number }, execFn = execFile) {
  return (async () => {
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'PR 编号非法' };
    const r = await ghRun(['pr', 'view', String(n), '--json',
      'number,title,body,author,state,baseRefName,headRefName,additions,deletions,changedFiles,statusCheckRollup,reviews,comments'],
      { cwd, timeout: GH_TIMEOUT_MS }, execFn);
    if (!r.ok) return r;
    try {
      const p = JSON.parse(r.stdout);
      return {
        ok: true,
        pr: {
          number: p.number,
          title: String(p.title || ''),
          body: String(p.body || '').slice(0, 4000),
          author: String(p.author?.login || ''),
          state: String(p.state || ''),
          base: String(p.baseRefName || ''),
          branch: String(p.headRefName || ''),
          additions: p.additions || 0,
          deletions: p.deletions || 0,
          changedFiles: p.changedFiles || 0,
          ci: summariseChecks(p.statusCheckRollup),
          reviews: (Array.isArray(p.reviews) ? p.reviews : []).slice(-5).map((rv) => ({
            author: rv.author?.login || '', state: rv.state || '',
          })),
        },
      };
    } catch (e) {
      return { ok: false, error: `gh 输出解析失败：${e.message}` };
    }
  })();
}

// PR diff → 结构化（文件 → hunk），供逐 hunk 审查
// 返回 { ok, files: [{ file, additions, deletions, hunks: [{ header, lines }] }], truncated, raw }
const DIFF_MAX_CHARS = 200000;

function parseUnifiedDiff(diffText) {
  const lines = String(diffText || '').split('\n');
  const files = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /diff --git a\/(.+?) b\/(.+?)$/.exec(line);
      cur = { file: (m ? m[2] : line.slice(11)).trim(), additions: 0, deletions: 0, hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) { cur.hunks.push({ header: line, lines: [] }); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) { cur.additions += 1; cur.hunks.at(-1)?.lines.push(line); }
    else if (line.startsWith('-') && !line.startsWith('---')) { cur.deletions += 1; cur.hunks.at(-1)?.lines.push(line); }
    else if (cur.hunks.length && line.startsWith(' ')) { cur.hunks.at(-1)?.lines.push(line); }
  }
  return files.filter((f) => f.hunks.length > 0 || f.additions + f.deletions > 0);
}

function prDiff({ cwd, number, file = '' }, execFn = execFile) {
  return (async () => {
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'PR 编号非法' };
    const r = await ghRun(['pr', 'diff', String(n)], { cwd, timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, execFn);
    if (!r.ok) return r;
    const full = r.stdout;
    const truncated = full.length > DIFF_MAX_CHARS;
    const text = truncated ? full.slice(0, DIFF_MAX_CHARS) : full;
    const files = parseUnifiedDiff(text);
    const wanted = file && String(file).trim() ? files.filter((f) => f.file.includes(String(file).trim())) : files;
    return {
      ok: true,
      totalFiles: files.length,
      files: wanted.slice(0, 30),
      truncated,
      ...(truncated ? { hint: `diff 已截断（原始 ${full.length} 字符）。请用 file 参数按文件分片拉取，或用 gh pr diff --name-only 概览。` } : {}),
    };
  })();
}

// 提交 review：event ∈ approve | request_changes | comment（对外可见动作，上层需审批）
function prReview({ cwd, number, event = 'comment', body = '' }, execFn = execFile) {
  return (async () => {
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'PR 编号非法' };
    const ev = String(event).trim().toUpperCase();
    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(ev)) {
      return { ok: false, error: `event 非法：${ev}（仅 APPROVE / REQUEST_CHANGES / COMMENT）` };
    }
    const text = String(body || '').trim();
    // GitHub 规则：APPROVE/REQUEST_CHANGES 必须带正文；COMMENT 可空
    if (ev !== 'COMMENT' && !text) {
      return { ok: false, error: `${ev} 必须附审查意见（body），空意见的 approve/request-changes 会被 GitHub 拒绝` };
    }
    const args = ['pr', 'review', String(n), '--event', ev];
    if (text) args.push('--body', text.slice(0, 60000));
    const r = await ghRun(args, { cwd, timeout: GH_TIMEOUT_MS }, execFn);
    if (!r.ok) return r;
    return { ok: true, event: ev, number: n, message: `已提交 ${ev} 审查` };
  })();
}

// 在指定文件/hunk 上落行级评论（审查的最小粒度）
function prComment({ cwd, number, body, file, line }, execFn = execFile) {
  return (async () => {
    const n = Number(number);
    const lineN = Number(line);
    const text = String(body || '').trim();
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'PR 编号非法' };
    if (!text) return { ok: false, error: '评论内容不能为空' };
    const args = ['pr', 'comment', String(n), '--body', text.slice(0, 20000)];
    const r = await ghRun(args, { cwd, timeout: GH_TIMEOUT_MS }, execFn);
    if (!r.ok) return r;
    return {
      ok: true,
      number: n,
      // file/line 供审计留痕；gh pr comment 不支持行级定位（需 GraphQL API），如实说明
      ...(file ? { file: String(file).slice(0, 300) } : {}),
      ...(Number.isInteger(lineN) ? { line: lineN } : {}),
      ...((file && Number.isInteger(lineN)) ? { note: '行级定位需 GraphQL API，当前评论落在 PR 会话内，正文已含文件与行号' } : {}),
    };
  })();
}

module.exports = { ghAvailable, ghAuthed, createPullRequest, prList, prView, prDiff, prReview, prComment, parseUnifiedDiff, summariseChecks };
