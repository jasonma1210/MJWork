#!/usr/bin/env node
// mj-code headless CLI：在纯 Node 环境执行 Agent 任务（无 Electron / 无浏览器）
// 用法：node cli.js --task task.json --out report.json [--cwd dir] [--session-dir dir]
// task.json 格式：
// {
//   "objective": "任务目标描述",
//   "provider": { "id": "p1", "base_url": "https://api.deepseek.com/v1", "model_id": "deepseek-chat", "api_key": "sk-..." },
//   "cwd": "/path/to/project",
//   "maxRounds": 15,
//   "approvalMode": "on-request"
// }
// api_key 优先取环境变量 MJ_AGENT_KEY，其次 task.json 中的 provider.api_key。
// MJ_AGENT_MOCK=1 时走确定性假模型（固定一轮 tool_call + 一轮最终文本），用于冒烟测试。

import { exec, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from './index.js';

const HELP_TEXT = `mj-code：MJ Code headless Agent CLI

用法：
  node cli.js --task <task.json> --out <report.json> [--cwd <dir>] [--session-dir <dir>]

参数：
  --task          任务描述文件路径（JSON，必填）
  --out           结果报告输出路径（JSON，必填）
  --cwd           覆盖 task.json 中的项目工作目录
  --session-dir   会话 JSONL 落盘目录（默认与 --out 同目录）
  --help          显示本帮助

环境变量：
  MJ_AGENT_KEY    模型 API Key（优先于 task.json 中的 provider.api_key）
  MJ_AGENT_MOCK   置为 1 时使用确定性假模型（冒烟测试，不发起真实网络请求）

task.json 格式：
  {
    "objective": "任务目标描述",
    "provider": { "id": "p1", "base_url": "https://...", "model_id": "model-name", "api_key": "sk-..." },
    "cwd": "/path/to/project",
    "maxRounds": 15,
    "approvalMode": "on-request"
  }`;

function printHelp() {
  console.log(HELP_TEXT);
}

// ── 参数解析 ──
function parseArgv(argv) {
  const opts = { task: null, out: null, cwd: null, sessionDir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--task') opts.task = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--session-dir') opts.sessionDir = argv[++i];
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

// ── 本地工具实现（execFile argv 化，杜绝 LLM 可控参数注入 shell；shell 工具本身除外）──
function createLocalToolHandlers(defaultCwd) {
  const cwdOf = (c) => c || defaultCwd || process.cwd();

  const shell = ({ command, cwd: c, timeout = 60000 }) => new Promise((resolve) => {
    exec(String(command || ''), { cwd: cwdOf(c), timeout, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000), exitCode: error?.code || 0, error: error?.message || null });
    });
  });

  const runGit = (args, c) => new Promise((resolve) => {
    execFile('git', args, { cwd: cwdOf(c), timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 5000), exitCode: error?.code || 0, error: error ? `git ${args[0]} 失败: ${error.message}` : null });
    });
  });

  return {
    shell,
    readFile: async ({ path: p, offset, limit }) => {
      const content = await fsp.readFile(p, 'utf8');
      const lines = content.split('\n');
      if (offset !== undefined && limit !== undefined) return { path: p, content: lines.slice(offset, offset + limit).join('\n'), totalLines: lines.length };
      return { path: p, content, totalLines: lines.length };
    },
    writeFile: async ({ path: p, content }) => {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, content, 'utf8');
      return { ok: true, path: p };
    },
    editFile: async ({ path: p, search, replace }) => {
      const fileContent = await fsp.readFile(p, 'utf8');
      if (!fileContent.includes(search)) throw new Error('未找到要替换的内容');
      await fsp.writeFile(p, fileContent.replace(search, replace), 'utf8');
      return { ok: true, path: p };
    },
    // apply_patch：stdin 送入 patch，在项目 cwd 执行
    applyPatch: ({ patch, cwd: c }) => {
      if (!patch || typeof patch !== 'string') throw new Error('patch 内容为空');
      return new Promise((resolve) => {
        const child = spawn('patch', ['-p1', '--no-backup-if-mismatch'], { cwd: cwdOf(c) });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
          child.kill();
          resolve({ stdout: stdout.slice(0, 10000), stderr: 'patch 执行超时', error: 'timeout' });
        }, 30000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 5000), exitCode: code ?? 0, error: code ? `patch exit ${code}` : null });
        });
        child.stdin.write(patch);
        child.stdin.end();
      });
    },
    listDir: async ({ path: p }) => {
      const entries = await fsp.readdir(p || '.', { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory(), type: e.isDirectory() ? 'dir' : 'file' }));
    },
    // grep：execFile argv 化
    grep: ({ pattern, path: p, glob: include, cwd: c }) => {
      if (!pattern) return Promise.resolve({ matches: '' });
      const args = ['-rn'];
      if (include) args.push('--include', String(include));
      args.push(String(pattern), p || '.');
      return new Promise((resolve) => {
        execFile('grep', args, { cwd: cwdOf(c), timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
          resolve({ matches: (stdout || '').slice(0, 20000) });
        });
      });
    },
    // glob：find argv 化
    glob: ({ pattern, path: p, cwd: c }) => {
      if (!pattern) return Promise.resolve({ files: [] });
      const args = [p || '.', '-name', String(pattern), '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'];
      return new Promise((resolve) => {
        execFile('find', args, { cwd: cwdOf(c), timeout: 20000 }, (error, stdout) => {
          resolve({ files: (stdout || '').trim().split('\n').filter(Boolean).slice(0, 100) });
        });
      });
    },
    gitStatus: ({ cwd: c }) => runGit(['status', '--short'], c),
    gitDiff: ({ cwd: c, staged }) => runGit(['diff', ...(staged ? ['--staged'] : [])], c),
    gitLog: ({ cwd: c, count = 10 }) => runGit(['log', '--oneline', `-${Math.min(Math.max(Number(count) || 10, 1), 100)}`], c),
    gitAdd: ({ cwd: c, files }) => {
      const list = Array.isArray(files) ? files.map(String) : String(files || '.').split(/\s+/).filter(Boolean);
      return runGit(['add', ...list], c);
    },
    gitCommit: ({ cwd: c, message }) => runGit(['commit', '-m', String(message || '')], c),
    // headless 模式未配置 MCP 服务器
    mcpCallTool: async ({ server, tool }) => ({ error: `headless 模式未配置 MCP 服务器（${server} / ${tool}）` }),
  };
}

// ── AGENTS.md 项目规范加载（从项目根逐级向上查找，纯 fs 实现）──
const AGENTS_MD_MAX_DEPTH = 5;
async function loadAgentsMd(cwd) {
  if (!cwd) return null;
  let dir = cwd.replace(/\/+$/, '');
  for (let i = 0; i < AGENTS_MD_MAX_DEPTH; i++) {
    const filePath = `${dir}/AGENTS.md`;
    try {
      const content = await fsp.readFile(filePath, 'utf8');
      if (content) return { path: filePath, content };
    } catch {
      // 文件不存在或不可读，继续向上
    }
    const parent = dir.replace(/\/[^/]+$/, '');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── 模型调用：OpenAI 兼容 /chat/completions（非流式）──
async function openaiChat(provider, payload) {
  const baseUrl = String(provider.base_url || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('provider.base_url 未配置');
  const body = {
    model: provider.model_id,
    messages: payload.messages,
  };
  if (payload.tools && payload.tools.length) body.tools = payload.tools;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`模型调用失败 HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  return {
    content: msg.content || '',
    tool_calls: msg.tool_calls || null,
    usage: data.usage || null,
  };
}

// ── 确定性假模型（MJ_AGENT_MOCK=1）：固定一轮 tool_call + 一轮最终文本 ──
function createMockChat() {
  let round = 0;
  return async () => {
    round++;
    if (round === 1) {
      return {
        content: '我先执行一条命令确认环境。',
        tool_calls: [{
          id: 'mock_call_1',
          type: 'function',
          function: { name: 'shell', arguments: JSON.stringify({ command: 'echo mj-agent-mock' }) },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    }
    return {
      content: 'mock 完成：环境确认无误，任务结束。',
      usage: { prompt_tokens: 15, completion_tokens: 8 },
    };
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error(`[mj-code] 参数错误: ${err.message}`);
    console.error('使用 --help 查看用法');
    process.exit(2);
  }
  if (opts.help) { printHelp(); process.exit(0); }
  if (!opts.task || !opts.out) {
    console.error('[mj-code] 缺少必填参数：--task 与 --out 均需提供');
    console.error('使用 --help 查看用法');
    process.exit(2);
  }

  // 读取并校验 task.json
  let task;
  try {
    task = JSON.parse(await fsp.readFile(opts.task, 'utf8'));
  } catch (err) {
    console.error(`[mj-code] task.json 读取或解析失败: ${err.message}`);
    process.exit(2);
  }
  if (!task.objective || typeof task.objective !== 'string') {
    console.error('[mj-code] task.json 缺少 objective（字符串类型的任务目标）');
    process.exit(2);
  }
  if (!task.provider || !task.provider.base_url || !task.provider.model_id) {
    console.error('[mj-code] task.json 缺少 provider.base_url 或 provider.model_id');
    process.exit(2);
  }
  const provider = {
    ...task.provider,
    api_key: process.env.MJ_AGENT_KEY || task.provider.api_key || '',
  };
  const cwd = opts.cwd || task.cwd || process.cwd();
  const sessionDir = opts.sessionDir || path.dirname(path.resolve(opts.out));
  const maxRounds = Number(task.maxRounds) > 0 ? Number(task.maxRounds) : 15;
  const approvalMode = task.approvalMode || 'on-request';
  // P0-9：CLI 通道同样注入 token 预算——headless 场景（CI/定时脚本）无人盯盘，
  // 缺省预算让失控循环一直烧到进程被外部杀掉。口径与 workerPool（200k）对齐，
  // task.json 可显式覆盖。
  const tokenBudget = Number(task.tokenBudget) > 0 ? Number(task.tokenBudget) : 200000;

  const toolHandlers = createLocalToolHandlers(cwd);
  const chatFn = process.env.MJ_AGENT_MOCK === '1'
    ? createMockChat()
    : (payload) => openaiChat(provider, payload);
  const fullToolHandlers = { ...toolHandlers, chat: chatFn };

  const agentsMd = await loadAgentsMd(cwd);

  const report = {
    ok: false,
    objective: task.objective,
    finalText: '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    diff: '',
    sessionPath: `${sessionDir}/session.jsonl`,
  };

  try {
    await runAgent({
      messages: [{ role: 'user', content: task.objective }],
      model: {
        provider: { id: provider.id, base_url: provider.base_url },
        model: { model_id: provider.model_id },
      },
      cwd,
      toolHandlers: fullToolHandlers,
      sessionDir,
      maxRounds,
      approvalMode,
      tokenBudget,
      agentsMd,
      onMessage: () => {},
      onDone: (finalText, usage) => {
        report.finalText = finalText;
        report.usage = usage;
      },
    });
    report.ok = true;
  } catch (err) {
    report.error = err.message;
    console.error(`[mj-code] 任务执行失败: ${err.message}`);
  }

  // 报告附上 git diff 输出（供云端任务回传审查变更）
  try {
    const d = await new Promise((resolve) => {
      execFile('git', ['diff'], { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
        resolve((stdout || '').slice(0, 100000));
      });
    });
    report.diff = d;
  } catch {
    report.diff = '';
  }

  await fsp.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
  await fsp.writeFile(opts.out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[mj-code] 报告已写入 ${opts.out}（ok=${report.ok}）`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[mj-code] 未捕获异常: ${err.message}`);
  process.exit(1);
});
