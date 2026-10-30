// T1-1 工具轨迹语义化渲染（M1，2026-10-15）
// 背景：工具轨迹此前一律 `JSON.stringify(args).slice(0, 120)` 裸截断——命令/路径/补丁
// 全部糊成一坨转义 JSON，失败原因藏在未展开的字段里，轨迹不可读（差距审查 4.10）。
// 现按工具类型渲染语义化轨迹卡：
//   · edit_file / apply_patch → 内联迷你 diff（- 删除 / + 新增）
//   · shell → 折叠 stdout/stderr + 退出码徽标
//   · read_file / list_dir / glob / grep → 文件路径 chip
//   · web_search / web_fetch → 来源链接
//   · git_* → 状态徽标
//   · 其余（write_file / spawn_subagent / todo_write / mcp__*）→ 关键参数摘要 + 展开完整
// 设计约束：零硬编码色值（theme.css Design Token）、无 emoji、无第三方依赖。
// 统一输入形状 { name, args(object|string), result(unknown) }——运行态与历史态两处复用。
import { useState } from 'react';
import { useI18n, tGlobal } from '../../i18n'; // T3-2：i18n（组件内 useI18n；toolNameCN 纯函数/异步加载用 tGlobal）
import {
  IconBot, IconCheck, IconChevronDown, IconChevronRight, IconEdit, IconFile,
  IconFileDiff, IconGlobe, IconPlug, IconSearch, IconSpinner, IconTerminal, IconWrench,
} from '../icons';
// T3-1：超限工具结果以句柄 { __bigStr/__bigJson, bytes } 到达——按需拉取 + 虚拟滚动
import { isBigRef, bigRefId, loadBigText, type BigRef } from '../../lib/bigPayload';
import VirtualText from '../VirtualText';
// A3：沙箱/执行失败的结构化说明（原因 / 受影响动作 / 当前档位 / 安全下一步）
import { sandboxNoticeOf } from '../../../../shared/sandboxNotice.mjs';

/** 工具名（含全部内置工具与兜底原样显示）；纯函数渲染期求值，tGlobal 保证语言切换即时生效 */
export function toolNameCN(name: string): string {
  const map: Record<string, string> = {
    shell: 'toolTrace.shell', read_file: 'toolTrace.readFile', write_file: 'toolTrace.writeFile',
    edit_file: 'toolTrace.editFile', list_dir: 'toolTrace.listDir', grep: 'toolTrace.grep',
    glob: 'toolTrace.glob', apply_patch: 'toolTrace.applyPatch', git_status: 'toolTrace.gitStatus',
    git_diff: 'toolTrace.gitDiff', git_log: 'toolTrace.gitLog', git_commit: 'toolTrace.gitCommit',
    git_add: 'toolTrace.gitAdd', git_branch: 'toolTrace.gitBranch', web_search: 'toolTrace.webSearch',
    web_fetch: 'toolTrace.webFetch', spawn_subagent: 'toolTrace.spawnSubagent', todo_write: 'toolTrace.todoWrite',
    browser_navigate: 'toolTrace.browserNavigate', browser_click: 'toolTrace.browserClick',
    browser_fill: 'toolTrace.browserFill', browser_select: 'toolTrace.browserSelect',
    browser_screenshot: 'toolTrace.browserScreenshot', browser_extract: 'toolTrace.browserExtract',
    chrome_status: 'toolTrace.chromeStatus', chrome_tabs: 'toolTrace.chromeTabs',
    chrome_navigate: 'toolTrace.chromeNavigate', chrome_click: 'toolTrace.chromeClick',
    chrome_fill: 'toolTrace.chromeFill', chrome_screenshot: 'toolTrace.chromeScreenshot',
    chrome_extract: 'toolTrace.chromeExtract',
    code_exec: 'toolTrace.codeExec',
    clipboard: 'toolTrace.clipboard', notify: 'toolTrace.notify',
    http_request: 'toolTrace.httpRequest', sqlite: 'toolTrace.sqlite',
    sandbox_code_run: 'toolTrace.sandboxCodeRun',
    deep_research: 'toolTrace.deepResearch',
    // G-doc：文档生成原生工具
    doc_create: 'toolTrace.docCreate', xlsx_create: 'toolTrace.xlsxCreate',
    pptx_create: 'toolTrace.pptxCreate', pdf_generate: 'toolTrace.pdfGenerate',
    // G-CUA：桌面自动化
    computer_use: 'toolTrace.computerUse',
    // G-latex：LaTeX 编译
    latex_compile: 'toolTrace.latexCompile',
    // M5 / T5-8：军团协同工具（B-04 起含读消息）
    team_list_members: 'toolTrace.teamListMembers', team_send_message: 'toolTrace.teamSendMessage',
    team_board: 'toolTrace.teamBoard', team_wait: 'toolTrace.teamWait',
    team_read_messages: 'toolTrace.teamReadMessages',
    // T6-6：工件协同四工具
    artifact_index: 'toolTrace.artifactIndex', artifact_get_section: 'toolTrace.artifactGetSection',
    artifact_patch_section: 'toolTrace.artifactPatchSection', artifact_get_diff: 'toolTrace.artifactGetDiff',
  };
  return map[name] ? tGlobal(map[name]) : name;
}

export interface ToolTraceProps {
  name: string;
  /** 运行态为 object；历史态可能是 JSON 字符串（旧会话兜底） */
  args?: Record<string, unknown> | string | null;
  /** 工具结果：null/undefined 视为进行中；形状因工具而异，仅做防御性读取 */
  result?: unknown;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const parseArgs = (a: ToolTraceProps['args']): Obj => {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') { try { const p = JSON.parse(a); return asObj(p) || {}; } catch { /* C-001：args 不是 JSON（纯文本命令等）⇒ 按「无结构化参数」展示 */ return {}; } }
  return {};
};

// ── 通用小组件 ──

/** T3-1：大载荷输出块——折叠态只显示体量元信息，展开时才拉全文并虚拟滚动渲染 */
function BigOutputBlock({ refObj, className }: { refObj: BigRef; className?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const load = async () => {
    setState('loading');
    const r = await loadBigText(bigRefId(refObj));
    if (r.ok) {
      setText((r.text || '') + (r.truncated ? '\n' + tGlobal('toolTrace.outputTruncated') : ''));
      setState('ready');
    } else {
      setErr(r.expired ? tGlobal('toolTrace.contentExpired') : r.error || tGlobal('toolTrace.fetchFailed'));
      setState('error');
    }
  };
  return (
    <>
      <div className="text-caption text-text2 mt-1 mb-1">
        {t('toolTrace.bigOutputNote', { kb: (refObj.bytes / 1024).toFixed(0) })}
      </div>
      {state === 'idle' && (
        <button onClick={load} className="text-caption text-accent hover:underline mb-1">{t('toolTrace.loadFullOutput')}</button>
      )}
      {state === 'loading' && <div className="text-caption text-text2 mb-1">{t('toolTrace.loading')}</div>}
      {state === 'error' && <div className="text-caption text-danger mb-1">{err}</div>}
      {state === 'ready' && (
        <VirtualText text={text} className={`text-code font-mono p-2 rounded border ${className}`} height={320} />
      )}
    </>
  );
}

/** 截断输出块：截断显示 + 「展开完整输出」（沿袭 ChatArea 原 OutputBlock 语义，迁入本目录）
 *  T3-1：主进程卸载的大字段（isBigRef）分流到按需加载块——分流在外层做，
 *  两个分支各自持有 hooks，避免同一组件内 hooks 数量随 props 漂移。 */
export function OutputBlock({ text, className, max = 500 }: { text: unknown; className?: string; max?: number }) {
  if (isBigRef(text)) return <BigOutputBlock refObj={text} className={className || ''} />;
  return <PlainOutputBlock text={text} className={className} max={max} />;
}

function PlainOutputBlock({ text, className, max = 500 }: { text: unknown; className?: string; max?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const full = asStr(text);
  const truncated = full.length > max;
  return (
    <>
      <pre className={className}>{expanded ? full : full.slice(0, max)}{truncated && !expanded ? '…' : ''}</pre>
      {truncated && (
        <button onClick={() => setExpanded((v) => !v)} className="text-caption text-text2 hover:text-text mb-1">
          {expanded ? t('toolTrace.collapseOutput') : t('toolTrace.expandFullOutput', { n: full.length })}
        </button>
      )}
    </>
  );
}

/** 关键参数：纯文本 mono 展示（2026-10-30 起不再带 chip 底色——轨迹行整体是灰字，
 *  行内再套一层浅底方块会让「一行灰字」变成「一行方块」；详情区同样受益于更少的框线）。 */
function PathChip({ text }: { text: string }) {
  return (
    <span className="font-mono truncate" title={text}>{text}</span>
  );
}

/** 内联迷你 diff：sign 前缀行着色（- 删除 / + 新增 / @@ 定位），零语法依赖 */
function DiffLines({ text, max = 24 }: { text: string; max?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lines = asStr(text).split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  const shown = expanded ? lines : lines.slice(0, max);
  return (
    <div className="mt-1 font-mono text-code rounded overflow-hidden border border-border">
      {shown.map((l, i) => {
        const cls = l.startsWith('+') ? 'bg-success-bg text-success'
          : l.startsWith('-') ? 'bg-danger-bg text-danger'
            : l.startsWith('@@') ? 'text-text2 bg-hover' : 'bg-surface text-text2';
        return <div key={i} className={`px-2 py-1 whitespace-pre-wrap break-all ${cls}`}>{l || ' '}</div>;
      })}
      {lines.length > shown.length && (
        <button onClick={() => setExpanded(true)} className="w-full text-left px-2 py-1 text-text2 hover:text-text bg-hover">
          {t('toolTrace.moreLines', { n: lines.length - shown.length })}
        </button>
      )}
    </div>
  );
}

/** edit_file 的 search/replace 映射为 diff 行 */
function SearchReplaceDiff({ search, replace }: { search: string; replace: string }) {
  const del = asStr(search).split('\n').map((l) => `-${l}`);
  const add = asStr(replace).split('\n').map((l) => `+${l}`);
  return <DiffLines text={[...del, ...add].join('\n')} />;
}

/** 来源链接列表（web_search 结果） */
function SourceLinks({ items }: { items: unknown }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="mt-1 space-y-1">
      {items.slice(0, 10).map((it, i) => {
        const o = asObj(it);
        const url = asStr(o?.url);
        const title = asStr(o?.title) || url;
        if (!url) return null;
        return (
          <div key={i} className="text-xs leading-snug">
            <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">{title}</a>
            {asStr(o?.snippet) && <div className="text-text2 line-clamp-2">{asStr(o?.snippet)}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** 完整参数 JSON（兜底展开：任何工具的原始入参） */
function FullArgs({ args }: { args: Obj }) {
  const { t } = useI18n();
  let text = '';
  try { text = JSON.stringify(args, null, 2); } catch { /* C-001：不可序列化（循环引用）⇒ 退化 String，仍要能把参数摊给用户看 */ text = String(args); }
  if (!text || text === '{}') return null;
  return (
    <div className="mt-1">
      <div className="text-caption text-text2 mb-1">{t('toolTrace.fullArgs')}</div>
      <pre className="text-code font-mono bg-hover rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{text}</pre>
    </div>
  );
}

// ── 摘要行（header 内的关键参数展示，替代 JSON 裸截断）──
function ParamSummary({ name, a }: { name: string; a: Obj }) {
  const { t } = useI18n();
  const s = (k: string) => asStr(a[k]);
  switch (name) {
    case 'shell': return <PathChip text={s('command') || t('toolTrace.emptyCommand')} />;
    case 'read_file': {
      const extra = [Number(a.offset) > 0 ? `offset=${Number(a.offset)}` : '', Number(a.limit) > 0 ? `limit=${Number(a.limit)}` : ''].filter(Boolean).join(', ');
      return <PathChip text={s('path') + (extra ? t('toolTrace.withParams', { p: extra }) : '')} />;
    }
    case 'write_file': case 'edit_file': return <PathChip text={s('path')} />;
    case 'apply_patch': {
      const m = s('patch').match(/^\+\+\+ b\/(.+)$/m);
      return <PathChip text={m ? m[1].trim() : t('toolTrace.inlinePatch')} />;
    }
    case 'list_dir': return <PathChip text={s('path')} />;
    case 'grep': case 'glob': return <PathChip text={[s('pattern'), s('path')].filter(Boolean).join(' · ')} />;
    case 'web_search': return <span className="truncate">{s('query')}</span>;
    case 'web_fetch': return <PathChip text={s('url')} />;
    case 'git_commit': return <span className="truncate">{s('message')}</span>;
    case 'git_status': case 'git_diff': case 'git_log': case 'git_add': case 'git_branch':
      return null;
    case 'spawn_subagent': return <span className="truncate">{s('objective')}</span>;
    case 'todo_write': {
      const todos = Array.isArray(a.todos) ? a.todos.length : 0;
      return <span className="text-text2">{t('toolTrace.todoCount', { n: todos })}</span>;
    }
    case 'browser_navigate': return <PathChip text={s('url') || t('toolTrace.browserEmptyUrl')} />;
    case 'browser_click': case 'browser_select': return <PathChip text={s('selector')} />;
    case 'browser_fill': return <PathChip text={`${s('selector')} = ${s('value').slice(0, 60)}`} />;
    case 'browser_screenshot': return <span className="text-text2 truncate">{a.full_page || a.fullPage ? t('toolTrace.browserEvidence') : ''}</span>;
    case 'browser_extract': return <PathChip text={s('selector')} />;
    // T4-2 Chrome 接管：参数摘要与 browser_* 同形，tab_id 附加标注
    case 'chrome_navigate': return <PathChip text={s('url') || t('toolTrace.browserEmptyUrl')} />;
    case 'chrome_click': return <PathChip text={s('selector')} />;
    case 'chrome_fill': return <PathChip text={`${s('selector')} = ${s('value').slice(0, 60)}`} />;
    case 'chrome_tabs': case 'chrome_status': return null;
    case 'chrome_screenshot': return <span className="text-text2 truncate">{a.tab_id != null ? `tab ${a.tab_id}` : ''}</span>;
    case 'chrome_extract': return <PathChip text={s('selector')} />;
    // T4-7 Code Mode：摘要显示代码首行（多行代码在详情区看全文）
    case 'code_exec': return <PathChip text={s('code').split('\n')[0].slice(0, 80) || t('toolTrace.codeEmpty')} />;
    // G-deep-research：摘要显示研究主题（子问题/证据数在详情区展开看）
    case 'deep_research': return <span className="truncate">{s('topic')}</span>;
    // G-doc：文档生成——摘要显示输出路径（内容体量在详情区/审批卡看）
    case 'doc_create': case 'xlsx_create': case 'pptx_create': case 'pdf_generate':
      return <PathChip text={s('path')} />;
    // G-latex：编译摘要显示入口文件；体检模式（probeOnly）显示提示文案
    case 'latex_compile':
      return a.probeOnly === true
        ? <span className="text-text2 truncate">{t('toolTrace.latexProbe')}</span>
        : <PathChip text={s('path')} />;
    // M5 / T5-8：军团协同——发言显示摘要、等待显示目标数、名册/看板无参数
    case 'team_send_message': return <span className="truncate">{s('summary')}</span>;
    case 'team_wait': {
      const ids = Array.isArray(a.taskIds) ? a.taskIds.length : 0;
      return <span className="text-text2">{t('toolTrace.teamWaitCount', { n: ids })}</span>;
    }
    case 'team_list_members': case 'team_board': return null;
    // T6-6：工件——索引无参；读章节显示 key@version；写入显示目标章节与变更摘要；差异显示版本对
    case 'artifact_index': return null;
    case 'artifact_get_section': {
      const key = s('section_key') || s('sectionKey');
      const ver = s('version');
      return <PathChip text={ver ? `${key} @ ${ver}` : key} />;
    }
    case 'artifact_patch_section': {
      const key = s('section_key') || s('sectionKey');
      const summary = s('change_summary') || s('changeSummary');
      return <PathChip text={summary ? `${key} · ${summary.slice(0, 60)}` : key} />;
    }
    case 'artifact_get_diff': {
      const from = s('from_version') || s('fromVersion');
      const to = s('to_version') || s('toVersion');
      return <span className="text-text2 truncate">{[from, to].filter(Boolean).join(' → ')}</span>;
    }
    default: {
      // mcp__server__tool / 未知工具：给出首个字符串参数或参数个数
      const keys = Object.keys(a);
      const firstStr = keys.find((k) => typeof a[k] === 'string');
      return <span className="text-text2 truncate">{firstStr ? asStr(a[firstStr]) : keys.length ? t('toolTrace.paramCount', { n: keys.length }) : ''}</span>;
    }
  }
}

function toolIcon(name: string, failed: boolean) {
  // 2026-10-30：图标由 accent 改为 text2——轨迹行整体降为灰色次要信息（用户需求 1），
  // 只有失败态保留红色（错误必须在扫读时就能看见，不藏在展开后）。
  const cls = failed ? 'text-danger shrink-0' : 'text-text2 shrink-0';
  if (name === 'shell' || name === 'code_exec' || name === 'sandbox_code_run' || name.startsWith('mcp__')) return <IconTerminal size={12} className={cls} />;
  if (name === 'read_file' || name === 'write_file' || name === 'list_dir' || name === 'sqlite'
    || name === 'doc_create' || name === 'xlsx_create' || name === 'pptx_create' || name === 'pdf_generate'
    || name === 'latex_compile' || name === 'artifact_index' || name === 'artifact_get_section') return <IconFile size={12} className={cls} />;
  if (name === 'edit_file' || name === 'apply_patch'
    || name === 'artifact_patch_section' || name === 'artifact_get_diff') return <IconFileDiff size={12} className={cls} />;
  if (name === 'grep' || name === 'glob' || name === 'web_search' || name === 'deep_research') return <IconSearch size={12} className={cls} />;
  if (name === 'web_fetch' || name === 'http_request' || name.startsWith('browser_') || name.startsWith('chrome_')) return <IconGlobe size={12} className={cls} />;
  if (name.startsWith('git_')) return <IconEdit size={12} className={cls} />;
  if (name === 'spawn_subagent') return <IconBot size={12} className={cls} />;
  if (name === 'todo_write') return <IconCheck size={12} className={cls} />;
  return <IconPlug size={12} className={cls} />;
}

// ── 类型特定详情区（展开后显示）──
/**
 * A3：沙箱/执行失败的结构化说明块。
 * 四要素固定顺序：原因 → 受影响动作 → 当前档位与隔离状态 → 安全下一步。
 * 安全下一步由 lib/sandboxErrors 按错误码与后端选择（Windows 与「结果不可知」各有专用文案），
 * 且任何分支都不建议改为 full-access。
 */
function SandboxNoticeBlock({ result }: { result: Obj | null }) {
  const { t } = useI18n();
  const n = sandboxNoticeOf(result);
  if (!n) return null;
  return (
    <div className="mt-1 text-xs leading-relaxed p-2 rounded border border-warn bg-warn-bg text-text">
      <p className="font-medium text-warn">{t(n.titleKey)}</p>
      <p className="text-text2 mt-1">{t(n.reasonKey, { detail: n.detail || t('runtime.unknownError') })}</p>
      <p className="text-text2 mt-1">{t(n.actionKey)}</p>
      <p className="text-text2 mt-1">
        {t('runtime.sandboxPolicyLine', {
          policy: n.policy,
          sandboxed: n.sandboxed ? t('runtime.sandboxIsolatedYes') : t('runtime.sandboxIsolatedNo'),
        })}
      </p>
      <p className="mt-1">{t(n.nextStepKey)}</p>
    </div>
  );
}

function DetailBody({ name, a, res }: { name: string; a: Obj; res: Obj | null }) {
  const { t } = useI18n();
  const out = (text: unknown, cls: string, max = 500) => (
    <OutputBlock className={`mt-1 text-code font-mono p-2 rounded whitespace-pre-wrap border ${cls}`} text={text} max={max} />
  );
  switch (name) {
    case 'edit_file': return <SearchReplaceDiff search={asStr(a.search)} replace={asStr(a.replace)} />;
    case 'apply_patch': return <DiffLines text={asStr(a.patch)} />;
    case 'write_file': return out(`${t('toolTrace.writtenChars', { n: asStr(a.content).length })}\n${asStr(a.content).slice(0, 2000)}`, 'bg-hover border-border text-text2');
    case 'read_file': return out(res?.content ?? '', 'bg-hover border-border text-text2');
    case 'shell':
      return (
        <>
          {res?.stdout ? out(res.stdout, 'bg-hover border-border text-text2') : null}
          {res?.stderr ? out(res.stderr, 'bg-danger-bg border-danger text-danger', 300) : null}
          <SandboxNoticeBlock result={res} />
        </>
      );
    case 'git_status': case 'git_diff': case 'git_log': case 'git_add': case 'git_branch':
      return out(res?.stdout ?? '', 'bg-hover border-border text-text2');
    case 'list_dir': {
      const items = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : null;
      if (!items || items.length === 0) return null;
      return (
        <div className="mt-1 flex flex-wrap gap-1">
          {(items as unknown[]).slice(0, 40).map((it, i) => (
            <PathChip key={i} text={asStr(asObj(it)?.name) || asStr(it)} />
          ))}
          {items.length > 40 && <span className="text-caption text-text2 self-center">{t('toolTrace.moreItems', { n: items.length })}</span>}
        </div>
      );
    }
    case 'glob': {
      const files = Array.isArray(res?.files) ? res.files : Array.isArray(res) ? res : null;
      if (!files || files.length === 0) return null;
      return (
        <div className="mt-1 flex flex-wrap gap-1">
          {(files as unknown[]).slice(0, 24).map((f, i) => <PathChip key={i} text={asStr(f)} />)}
          {files.length > 24 && <span className="text-caption text-text2 self-center">{t('toolTrace.moreFiles', { n: files.length })}</span>}
        </div>
      );
    }
    case 'grep': {
      const text = res?.matches ?? res?.content ?? '';
      return out(text, 'bg-hover border-border text-text2', 400);
    }
    case 'web_search': return <SourceLinks items={res?.results} />;
    case 'web_fetch': return out(res?.content ?? '', 'bg-hover border-border text-text2', 800);
    // T4-1：浏览器工具详情——导航/交互回显当前页面，截图回显证据图，读取回显正文
    case 'browser_navigate': case 'browser_click': case 'browser_fill': case 'browser_select':
      return (
        <>
          {asStr(res?.url) && <div className="mt-1"><PathChip text={asStr(res?.url)} /></div>}
          {asStr(res?.title) && <div className="mt-1 text-xs text-text2">{t('toolTrace.browserPageTitle')}: {asStr(res?.title)}</div>}
        </>
      );
    case 'browser_screenshot':
      return res?.previewUrl ? (
        <div className="mt-1">
          <div className="text-caption text-text2 mb-1">{t('toolTrace.browserEvidence')} ({((Number(res?.bytes) || 0) / 1024).toFixed(0)}KB)</div>
          <img src={asStr(res.previewUrl)} alt={t('toolTrace.browserEvidence')} className="max-w-full rounded border border-border" loading="lazy" />
        </div>
      ) : null;
    case 'browser_extract': return out(res?.text ?? '', 'bg-hover border-border text-text2', 1200);
    // T4-2：Chrome 接管详情——交互回显标签页现状；截图同 browser；tabs 列表；status 连接态
    case 'chrome_navigate': case 'chrome_click': case 'chrome_fill':
      return (
        <>
          {asStr(res?.url) && <div className="mt-1"><PathChip text={asStr(res?.url)} /></div>}
          {asStr(res?.title) && <div className="mt-1 text-xs text-text2">{t('toolTrace.browserPageTitle')}: {asStr(res?.title)}</div>}
        </>
      );
    case 'chrome_screenshot':
      return res?.previewUrl ? (
        <div className="mt-1">
          <div className="text-caption text-text2 mb-1">{t('toolTrace.browserEvidence')} ({((Number(res?.bytes) || 0) / 1024).toFixed(0)}KB)</div>
          <img src={asStr(res.previewUrl)} alt={t('toolTrace.browserEvidence')} className="max-w-full rounded border border-border" loading="lazy" />
        </div>
      ) : null;
    case 'chrome_extract': return out(res?.text ?? '', 'bg-hover border-border text-text2', 1200);
    case 'chrome_tabs': {
      const tabs = Array.isArray(res?.tabs) ? res.tabs : [];
      if (!tabs.length) return <div className="mt-1 text-xs text-text2">{t('toolTrace.chromeNoTabs')}</div>;
      return (
        <div className="mt-1 flex flex-col gap-1">
          {tabs.slice(0, 12).map((tab) => (
            <div key={tab.id} className="flex items-center gap-2 text-xs min-w-0">
              <span className="text-text2 font-mono shrink-0">#{tab.id}</span>
              {tab.active && <span className="text-accent shrink-0">{t('toolTrace.activeTab')}</span>}
              <span className="truncate">{asStr(tab.title)}</span>
              <span className="text-text2 truncate">{asStr(tab.url)}</span>
            </div>
          ))}
          {tabs.length > 12 && <span className="text-caption text-text2">{t('toolTrace.moreItems', { n: tabs.length })}</span>}
        </div>
      );
    }
    case 'chrome_status':
      return (
        <div className="mt-1 text-xs">
          {res?.connected
            ? <span className="text-success">{t('toolTrace.chromeConnected')} · {asStr(res?.browser).slice(0, 60)}</span>
            : <span className="text-warn">{t('toolTrace.chromeDisconnected')}</span>}
        </div>
      );
    // T4-7 Code Mode：stdout 输出 + 返回值 + saveImage 产物图（previewUrl 走 mjpreview:// 句柄）
    case 'code_exec': {
      const imgs = Array.isArray(res?.images) ? (res.images as Obj[]) : [];
      return (
        <>
          {res?.stdout ? out(res.stdout, 'bg-hover border-border text-text2') : null}
          {asStr(res?.result) ? out(`=> ${asStr(res?.result)}${res?.resultTruncated ? ' …' : ''}`, 'bg-hover border-border text-text2', 1200) : null}
          {imgs.length > 0 && (
            <div className="mt-1 space-y-2">
              {imgs.slice(0, 8).map((im, i) => (
                <div key={i}>
                  <div className="text-caption text-text2 mb-1">{asStr(im?.name) || t('toolTrace.codeImage')} ({((Number(im?.bytes) || 0) / 1024).toFixed(0)}KB)</div>
                  {asStr(im?.previewUrl) && <img src={asStr(im.previewUrl)} alt={asStr(im?.name) || t('toolTrace.codeImage')} className="max-w-full rounded border border-border" loading="lazy" />}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    case 'spawn_subagent': {
      const tokens = Number(res?.tokens_used) || 0;
      const kind = asStr(res?.budget_kind);
      return (
        <>
          {kind && kind !== 'normal' && (
            <div className="mt-1 text-xs text-warn">
              {t('toolTrace.earlyStop', { reason: kind === 'tokens' ? t('toolTrace.stopTokens') : kind === 'rounds' ? t('toolTrace.stopRounds') : kind === 'repeat' ? t('toolTrace.stopRepeat') : t('toolTrace.stopAborted') })}
            </div>
          )}
          {tokens > 0 && <div className="mt-1 text-xs text-text2">{t('toolTrace.subagentTokens', { n: tokens.toLocaleString() })}</div>}
          {out(res?.result ?? '', 'bg-hover border-border text-text2', 600)}
        </>
      );
    }
    // G-deep-research：报告路径 + 证据/精读/失败计数 + 研究子问题
    case 'deep_research': {
      const subs = Array.isArray(res?.subquestions) ? res.subquestions : [];
      const failures = Number(res?.search_failures) || 0;
      return (
        <>
          {asStr(res?.path) && <div className="mt-1"><PathChip text={asStr(res?.path)} /></div>}
          <div className="mt-1 text-xs text-text2">
            {t('toolTrace.researchEvidence', { n: Number(res?.evidence_count) || 0 })}
            {' · '}{t('toolTrace.researchDeepRead', { n: Number(res?.deep_read_count) || 0 })}
            {failures > 0 ? ` · ${t('toolTrace.researchFailures', { n: failures })}` : ''}
          </div>
          {subs.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {subs.slice(0, 6).map((q, i) => <PathChip key={i} text={asStr(q)} />)}
            </div>
          )}
        </>
      );
    }
    default: return null; // 其余工具：详情即 FullArgs + error
  }
}

/**
 * 语义化工具轨迹卡。
 * 运行态：result 为 null → 显示「运行中」；历史态：result 已配对。
 * 失败（result.error）恒红且 error 必然可见（不折叠进参数里）。
 */
export default function ToolTrace({ name, args, result }: ToolTraceProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const a = parseArgs(args);
  const res = asObj(result);
  // 历史态 JSON.parse 失败时 ChatArea 会包成 {stdout}；这里兜底字符串结果
  const rawStr = typeof result === 'string' ? result : '';
  const failed = !!res?.error;
  const running = result == null;
  const exitCode = res && 'exitCode' in res ? Number(res.exitCode) : null;
  // 可展开条件：有类型特定详情、error、原始兜底文本或非空参数
  const hasDetail = !!res?.error || !!rawStr || Object.keys(a).length > 0
    || ['edit_file', 'apply_patch', 'write_file', 'read_file', 'shell', 'git_status', 'git_diff', 'git_log',
      'git_add', 'git_branch', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'spawn_subagent',
      'browser_navigate', 'browser_click', 'browser_fill', 'browser_select', 'browser_screenshot', 'browser_extract',
      'chrome_navigate', 'chrome_click', 'chrome_fill', 'chrome_screenshot', 'chrome_extract', 'chrome_tabs', 'chrome_status', 'code_exec',
      'deep_research'].includes(name);
  return (
    // 2026-10-30（用户需求 1）：由「带边框卡片」改为「一行灰字」。理由：一轮任务动辄十几次工具调用，
    // 每次一个卡片会把正文切成碎片；灰字行只占一行、可扫读，详情点击后展开在圆角面板里。
    // 2026-10-30（用户需求 2）：整块字号再降一档到 12px（text-code），与正式答复 15px 拉开层级——
    // 命令行/工具输出属于「过程性内容」，用户只看进不进度，不需要阅读字号。
    <div className="text-code">
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
        className={`w-full flex items-center gap-2 py-1 text-left text-text2 ${hasDetail ? 'hover:text-text cursor-pointer' : 'cursor-default'}`}
        title={hasDetail ? (open ? t('toolTrace.collapseDetail') : t('toolTrace.expandDetail')) : undefined}
      >
        {toolIcon(name, failed)}
        <span className={failed ? 'text-danger shrink-0' : 'shrink-0'}>{toolNameCN(name)}</span>
        <span className="min-w-0 truncate flex-1"><ParamSummary name={name} a={a} /></span>
        {/* 状态徽标：失败 / 退出码 / 运行中（同为灰字，只有失败与运行中带色） */}
        {failed && <span className="shrink-0 text-caption text-danger">{t('toolTrace.failed')}</span>}
        {!failed && exitCode != null && (
          <span className={`shrink-0 text-caption ${exitCode === 0 ? 'text-text2/70' : 'text-warn'}`}>{t('toolTrace.exitCode', { code: exitCode })}</span>
        )}
        {!failed && exitCode == null && (running ? (
          <span className="shrink-0 text-caption text-text2 inline-flex items-center gap-1"><IconSpinner size={10} className="animate-spin" />{t('toolTrace.running')}</span>
        ) : res ? <span className="shrink-0 text-caption text-text2/70">{t('toolTrace.done')}</span> : null)}
        {/* chevron 收在行尾（与思考折叠行同构）：行首位置留给类型图标，扫读时左对齐的是图标而不是箭头 */}
        {hasDetail && (open
          ? <IconChevronDown size={11} className="shrink-0 opacity-70" />
          : <IconChevronRight size={11} className="shrink-0 opacity-70" />)}
      </button>
      {failed && !!res?.error && (
        <OutputBlock className="ml-4 mb-2 text-code font-mono text-danger bg-danger-bg border border-danger p-2 rounded whitespace-pre-wrap" text={String(res.error)} />
      )}
      {open && (
        <div className="ml-4 mb-2 rounded-lg border border-border bg-surface px-3 py-2">
          <DetailBody name={name} a={a} res={res} />
          <FullArgs args={a} />
          {!res && !!rawStr && (
            <OutputBlock className="mt-1 text-code font-mono text-text2 bg-hover border border-border p-2 rounded whitespace-pre-wrap" text={rawStr} />
          )}
        </div>
      )}
    </div>
  );
}

// ── T1-2：轨迹组——同轮（或本轮运行）的多次工具调用聚合一处、可折叠 ──
// 兼容两种输入形状：
//   · 运行态 onToolCall：{ name, args(object), result }
//   · 历史态 assistant.tool_calls：{ id, function: { name, arguments(字符串) } } + toolResults Map 配对
export interface ToolTraceGroupProps {
  calls: unknown[];
  /** 历史态工具结果索引（tool_call_id → tool 消息）；运行态可省略 */
  toolResults?: Map<unknown, { content?: string } | undefined>;
  /** 组标签（如「本轮」）；缺省不显示标签行 */
  label?: string;
  /** 默认展开（运行态本轮传 true；历史轮折叠只留摘要行） */
  defaultOpen?: boolean;
}

export function ToolTraceGroup({ calls, toolResults, label, defaultOpen = false }: ToolTraceGroupProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const items = calls.map((tc, i) => {
    const o = asObj(tc);
    const fn = asObj(o?.function);
    const name = asStr(o?.name) || asStr(fn?.name);
    let result: unknown = o?.result ?? null;
    if (result == null && toolResults) {
      const tr = toolResults.get(o?.id);
      if (tr) {
        try { result = JSON.parse(asStr(tr.content)); }
        catch { /* C-001：工具输出不是 JSON（大量 CLI 就是纯文本）⇒ 当 stdout 展示，是有意的形态分流 */ result = { stdout: asStr(tr.content) }; }
      }
    }
    return { key: asStr(o?.id) || `t-${i}`, name, args: o?.args ?? fn?.arguments ?? null, result };
  });
  const failedCount = items.filter((it) => asObj(it.result)?.error).length;
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 mb-1">
        {label && <span className="text-code text-text2 shrink-0">{label}</span>}
        {!open ? (
          <button onClick={() => setOpen(true)}
            className="flex items-center gap-2 text-code text-text2 hover:text-text">
            <IconWrench size={11} className="shrink-0" />
            {t('toolTrace.callCount', { n: items.length })}{failedCount > 0 ? <span className="text-danger">{t('toolTrace.failedCount', { n: failedCount })}</span> : null}
            <span className="text-text2/70">{t('toolTrace.clickExpand')}</span>
            <IconChevronRight size={11} className="shrink-0 opacity-70" />
          </button>
        ) : (
          <button onClick={() => setOpen(false)} className="flex items-center gap-2 text-code text-text2 hover:text-text">
            <IconWrench size={11} className="shrink-0" />
            {t('toolTrace.collapseTrace')}
            <IconChevronDown size={11} className="shrink-0 opacity-70" />
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-1">
          {items.map((it) => (
            <ToolTrace key={it.key} name={it.name} args={(it.args ?? null) as Record<string, unknown> | string | null} result={it.result} />
          ))}
        </div>
      )}
    </div>
  );
}
