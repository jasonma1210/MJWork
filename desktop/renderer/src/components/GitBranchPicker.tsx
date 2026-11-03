// 输入框下方的分支选择器（语义对齐 WorkBuddy 的 WorktreeBranchTrigger）
//
// 核心约定（这是与上一版最大的区别）：**选分支 ≠ 切分支**。
//   · 这里只记「本次任务从哪个分支出发」（selectedBranch），不碰工作目录；
//   · 真正 checkout 发生在发送前，由确认卡把关（干净→确认卡；脏→提交/暂存/丢弃三选一）。
// 为什么必须分开：切分支会让正在跑的 Agent 的文件在脚下变化，也会在用户只是想「看看有哪些
// 分支」时改掉他的 HEAD。WorkBuddy 把这一步推迟到「你按下发送」的那一刻，等于把它变成
// 一次需要签字确认的破坏性动作。
//
// 列表分「本地 / 远程」两组也是同一逻辑：点本地分支是切过去，点 `origin/x` 要新建本地跟踪
// 分支——两者后果不同，混在一个列表里用户没法预期 HEAD 会变成什么。
import { useCallback, useEffect, useRef, useState } from 'react';
import Button from './ui/Button';
import ChipButton from './ui/ChipButton';
import MenuItem from './ui/MenuItem';
import { Input } from './ui/Input';
import { IconGitBranch, IconRefresh, IconSpinner } from './icons';
import { useI18n } from '../i18n';
import { BRANCH_RENDER_LIMIT } from '../constants/worktree';

/** 列表渲染上限：WB 实测 80（`rU=80`），与 constants/worktree.ts 同源 */
const RENDER_LIMIT = BRANCH_RENDER_LIMIT;

interface BranchRow { name: string; current?: boolean; short?: string }

interface BranchListResult {
  ok?: boolean;
  error?: string;
  isRepo?: boolean;
  current?: string;
  detached?: boolean;
  local?: BranchRow[];
  remote?: BranchRow[];
  fetched?: boolean;
  noRemote?: boolean;
  /** 空仓库：已 git init 但还没有首个提交（refs/heads 为空，HEAD 有符号引用） */
  unborn?: boolean;
  /** 空仓库时 HEAD 指向的分支名（main / master …） */
  unbornBranch?: string;
}

/** `git:init` 的返回形状（主进程 worktree.initRepo） */
interface InitRepoResult {
  ok?: boolean;
  error?: string;
  created?: boolean;
  branch?: string;
  committed?: boolean;
  identityMissing?: boolean;
  stagedPending?: boolean;
  unborn?: boolean;
}

export interface GitBranchPickerProps {
  /** 仓库目录（项目根）。缺省时不渲染：没有工作区就没有「当前分支」可言 */
  cwd?: string;
  /** 工作目录**实际所在**分支（事实，来自 git） */
  currentBranch?: string;
  /** 本次任务选中的基线分支（空 = 跟随当前） */
  selectedBranch?: string;
  /** 选中一个分支：只更新状态，不切换 */
  onSelect: (branch: string) => void;
  /** 副本已建/任务已开始：改分支不再影响任何东西，置灰并说明原因 */
  locked?: boolean;
  lockedHint?: string;
  /** 结果反馈（读取/拉取失败、选择提示），由对话区统一走消息条 */
  onMsg?: (msg: string) => void;
}

export default function GitBranchPicker({
  cwd, currentBranch = '', selectedBranch = '', onSelect, onMsg, locked = false, lockedHint = '',
}: GitBranchPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [local, setLocal] = useState<BranchRow[]>([]);
  const [remote, setRemote] = useState<BranchRow[]>([]);
  const [liveCurrent, setLiveCurrent] = useState('');
  // null = **尚未探明**（探测中 / 探测命令失败）。三态而不是布尔：
  // 2026-11-03（用户反馈 5「初始化 git 失败，卡死在选择分支上」）：
  // 此前失败只写 err，isRepo 仍是 true，于是触发器永远停在「选择分支」并且点开是一句报错——
  // 用户看到的就是一个点不动也说不清楚的按钮。现在把「不是仓库」与「探不到」分开呈现。
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false); // 拉取更新中
  // 空仓库（已 init、无首个提交）时 HEAD 指向的分支名；空串 = 不是空仓库
  const [unbornBranch, setUnbornBranch] = useState('');
  const [initializing, setInitializing] = useState(false); // 正在初始化仓库/补首个提交
  const [initNote, setInitNote] = useState(''); // 初始化后的提示（身份缺失 / 有暂存内容）
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 展开态：点外面 / Esc 收起（与 ModelSelector 同一套交互，避免同一界面两种关闭习惯）
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 换仓库：把上一个仓库读到的东西清掉，否则触发器会短暂显示**上一仓库**的分支名
  useEffect(() => {
    setLocal([]); setRemote([]); setLiveCurrent(''); setQuery(''); setErr(''); setIsRepo(null);
    setUnbornBranch(''); setInitNote('');
  }, [cwd]);

  function applyList(r: BranchListResult) {
    setIsRepo(r.isRepo !== false);
    setLiveCurrent(r.current || '');
    setLocal(Array.isArray(r.local) ? r.local : []);
    setRemote(Array.isArray(r.remote) ? r.remote : []);
    setUnbornBranch(r.unborn ? (r.unbornBranch || 'main') : '');
  }

  // 读列表：**每个 cwd 挂载时探一次**（决定 chip 是否该置灰——非 Git 仓库时它必须是禁用态，
  // 不能等用户点开才发现），之后只在展开时重读（关着的时候轮询仓库等于持续 fork git 进程）。
  // 2026-11-03：抽成可复用的 probe()，让「未初始化 Git」面板里的「重新检测」走同一条路径——
  // 用户在终端里 git init 完回来点一下即可，不必重启应用。
  const probe = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setErr('');
    try {
      const r = (await window.mjcode?.listBranches?.({ cwd })) as BranchListResult | undefined;
      if (!r?.ok) {
        // 命令失败（git 缺失 / 权限 / 目录已删）⇒ 结论是「探不到」，不是「没有分支」
        setIsRepo(null);
        setErr(t('worktree.listFailed', { error: String(r?.error || '') }));
        return;
      }
      applyList(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[git-branch] listBranches failed:', msg);
      setIsRepo(null);
      setErr(t('worktree.listFailed', { error: msg }));
    } finally {
      setLoading(false);
    }
  }, [cwd, t]);

  const probedRef = useRef('');
  useEffect(() => {
    if (!cwd) return undefined;
    if (!open && probedRef.current === cwd) return undefined;
    probedRef.current = cwd;
    void probe();
    return undefined;
  }, [open, cwd, probe]);

  if (!cwd) return null;

  const shown = selectedBranch || liveCurrent || currentBranch || '';

  // 拉取更新 = fetch --prune + 重列（不动工作区；合并是另一件事，由 Agent 走审批通道）
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = (await window.mjcode?.refreshBranches?.({ cwd })) as BranchListResult | undefined;
      if (!r?.ok) {
        setErr(String(r?.error || t('worktree.listFailed', { error: '' })));
        return;
      }
      applyList(r);
      if (r.noRemote) setErr(t('worktree.noRemote'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[git-branch] refreshBranches failed:', msg);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  // 初始化仓库 / 补首个提交（2026-11-03，用户反馈 5「应该是你帮我主动创建」）。
  // 两条入口共用一个动作：非仓库 ⇒ git init + 首个空提交；空仓库 ⇒ 只补首个空提交。
  // 主进程侧幂等（已有提交时什么都不做），所以这里不必判断当前处于哪一档。
  async function initRepo() {
    if (initializing || !cwd) return;
    setInitializing(true);
    setInitNote('');
    setErr('');
    try {
      const r = (await window.mjcode?.initRepo?.({ cwd })) as InitRepoResult | undefined;
      if (!r?.ok) {
        setErr(String(r?.error || t('worktree.initFailed')));
        return;
      }
      // 身份缺失 ⇒ 仓库建好了但没提交，分支仍然不存在：必须把「下一步」写清楚，
      // 否则界面看起来和「初始化失败」一模一样（这正是用户抱怨的那种卡死）。
      if (r.identityMissing) setInitNote(t('worktree.initNeedIdentity'));
      else if (r.stagedPending) setInitNote(t('worktree.initStagedPending'));
      await probe();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[git-branch] initRepo failed:', msg);
      setErr(t('worktree.initFailed'));
    } finally {
      setInitializing(false);
    }
  }

  function pick(name: string) {
    setOpen(false);
    setQuery('');
    // 选中「当前分支」= 清除选择（下次任务继续跟随 HEAD）：把当前分支存成「选中」会让
    // 界面出现两个都带勾的项，也让「要不要弹确认卡」这个判断依赖一个假的差异
    onSelect(name === liveCurrent ? '' : name);
    onMsg?.(t('worktree.selectedHint', { branch: name }));
  }

  const keyword = query.trim().toLowerCase();
  const match = (b: BranchRow) => !keyword || b.name.toLowerCase().includes(keyword);
  const localHits = local.filter(match);
  const remoteHits = remote.filter(match);
  const total = localHits.length + remoteHits.length;
  const truncated = localHits.length > RENDER_LIMIT || remoteHits.length > RENDER_LIMIT;
  const active = selectedBranch || liveCurrent;
  // 触发器文案（2026-11-03 反馈 5）：**永远说清当前状态**，不再一律显示「选择分支」。
  //   · 探测中且还没有名字 ⇒ 读取中（否则空文案看起来像坏了）
  //   · 确定不是仓库 ⇒ 未初始化 Git（可点开看原因 + 重新检测）
  //   · 探不到（命令失败）⇒ 未初始化 Git（同一档，面板里给具体错误）
  //   · 正常 ⇒ 当前/选中的分支名
  const triggerLabel = (isRepo !== true && !shown && loading)
    ? t('worktree.loadingBranches')
    : (isRepo === false || (isRepo === null && !loading))
      ? t('worktree.notRepo')
      // 空仓库：分支名其实已经定了（HEAD 指向 main），只是还没有 ref —— 必须显示它，
      // 否则界面又回到「无当前分支」，用户会以为初始化没生效。
      : (shown || unbornBranch || t('worktree.noCurrentBranch'));

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* 形态对齐设计稿（2026-11-03）：无边框 inline 触发器 —— 分支图标 + 分支名 + 下拉箭头，
          悬停才现底色。原先的描边芯片在一排控件里像个按钮，而它其实只是「当前基线」的状态显示。 */}
      <ChipButton
        bare
        icon={loading ? <IconSpinner size={12} className="animate-spin" /> : <IconGitBranch size={12} />}
        onClick={() => { if (!locked) setOpen((v) => !v); }}
        disabled={locked}
        aria-expanded={open}
        title={locked && lockedHint ? lockedHint : (isRepo === false ? t('worktree.notRepoHint') : t('worktree.branchTitle'))}
        className={`max-w-[150px] ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {triggerLabel}
      </ChipButton>

      {open && !locked && (
        <div className="absolute left-0 bottom-full mb-2 w-[268px] bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)] overflow-hidden z-30">
          {isRepo === false ? (
            // 非仓库：不给搜索框与「拉取更新」（它们在这里必然失败），只给原因 + 可执行动作。
            // 这是「卡死」的直接修复点：以前这里是一个能点开、点开只报错的死列表。
            <div className="px-3 py-3 text-xs text-text2 space-y-2">
              <div className="text-text">{t('worktree.notRepoTitle')}</div>
              <div>{t('worktree.notRepoHint')}</div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void initRepo()}
                disabled={initializing || loading}
                className="w-full justify-start"
              >
                {initializing ? <IconSpinner size={12} className="animate-spin" /> : <IconGitBranch size={12} />}
                {t('worktree.initRepo')}
              </Button>
              {/* 重新检测留给「在终端里自己 init 过」的用户：点一下即重读，不必重启 */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void probe()}
                disabled={loading}
                className="w-full justify-start text-text2"
              >
                <IconRefresh size={12} />
                {t('worktree.reprobe')}
              </Button>
            </div>
          ) : (
          <>
          <div className="p-2 border-b border-border">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const first = localHits[0] || remoteHits[0];
                if (e.key === 'Enter' && first) { e.preventDefault(); pick(first.name); }
              }}
              placeholder={t('worktree.searchBranch')}
              aria-label={t('worktree.searchBranch')}
              containerClassName="flex-1 min-w-0"
            />
          </div>

          <div role="listbox" aria-label={t('worktree.selectBranch')} className="max-h-64 overflow-y-auto">
            {loading && (
              <div className="px-3 py-2 text-xs text-text2 flex items-center gap-2">
                <IconSpinner size={11} className="animate-spin" />{t('worktree.loadingBranches')}
              </div>
            )}
            {!loading && isRepo === null && (
              <div className="px-3 py-2 text-xs text-text2">{t('worktree.notRepoHint')}</div>
            )}
            {!loading && isRepo && total === 0 && unbornBranch && (
              <div className="px-3 py-3 text-xs text-text2 space-y-2">
                <div className="text-text">{t('worktree.unbornTitle', { branch: unbornBranch })}</div>
                <div>{t('worktree.unbornHint')}</div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void initRepo()}
                  disabled={initializing}
                  className="w-full justify-start"
                >
                  {initializing ? <IconSpinner size={12} className="animate-spin" /> : <IconGitBranch size={12} />}
                  {t('worktree.createInitialCommit')}
                </Button>
              </div>
            )}
            {!loading && isRepo && total === 0 && !unbornBranch && (
              <div className="px-3 py-2 text-xs text-text2">{t('worktree.noBranches')}</div>
            )}
            {!loading && localHits.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-caption text-text2">{t('worktree.localBranches')}</div>
                {localHits.slice(0, RENDER_LIMIT).map((b) => (
                  <MenuItem
                    key={b.name}
                    role="option"
                    aria-selected={b.name === active}
                    icon={<IconGitBranch size={12} />}
                    selected={b.name === active}
                    onClick={() => pick(b.name)}
                  >
                    {b.name}
                  </MenuItem>
                ))}
              </>
            )}
            {!loading && remoteHits.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-caption text-text2">{t('worktree.remoteBranches')}</div>
                {remoteHits.slice(0, RENDER_LIMIT).map((b) => (
                  <MenuItem
                    key={b.name}
                    role="option"
                    aria-selected={b.name === selectedBranch}
                    selected={b.name === selectedBranch}
                    onClick={() => pick(b.name)}
                  >
                    {b.name}
                  </MenuItem>
                ))}
              </>
            )}
            {!loading && truncated && (
              <div className="px-3 py-2 text-caption text-text2">
                {t('worktree.branchRenderLimitHint', { count: String(RENDER_LIMIT) })}
              </div>
            )}
          </div>

          {err && <div className="px-3 py-2 text-caption text-danger border-t border-border">{err}</div>}
          {initNote && <div className="px-3 py-2 text-caption text-warn border-t border-border">{initNote}</div>}

          <div className="border-t border-border p-1">
            {/* 探不到（命令失败 / git 缺失）时不能只留一个禁用的「拉取更新」——
                那又是一个点不动的按钮，正是用户反馈的「卡死」。这里改成「重新检测」。 */}
            {isRepo === true ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                disabled={busy}
                className="w-full justify-start text-text2"
              >
                {busy ? <IconSpinner size={12} className="animate-spin" /> : <IconRefresh size={12} />}
                {busy ? t('worktree.fetching') : t('worktree.fetchRefresh')}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void probe()}
                disabled={loading}
                className="w-full justify-start text-text2"
              >
                {loading ? <IconSpinner size={12} className="animate-spin" /> : <IconRefresh size={12} />}
                {t('worktree.reprobe')}
              </Button>
            )}
          </div>
          </>
          )}
        </div>
      )}
    </div>
  );
}
