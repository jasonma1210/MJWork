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
import { useEffect, useRef, useState } from 'react';
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
  const [isRepo, setIsRepo] = useState(true);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false); // 拉取更新中
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
    setLocal([]); setRemote([]); setLiveCurrent(''); setQuery(''); setErr(''); setIsRepo(true);
  }, [cwd]);

  function applyList(r: BranchListResult) {
    setIsRepo(r.isRepo !== false);
    setLiveCurrent(r.current || '');
    setLocal(Array.isArray(r.local) ? r.local : []);
    setRemote(Array.isArray(r.remote) ? r.remote : []);
  }

  // 读列表：**每个 cwd 挂载时探一次**（决定 chip 是否该置灰——非 Git 仓库时它必须是禁用态，
  // 不能等用户点开才发现），之后只在展开时重读（关着的时候轮询仓库等于持续 fork git 进程）
  const probedRef = useRef('');
  useEffect(() => {
    if (!cwd) return undefined;
    if (!open && probedRef.current === cwd) return undefined;
    probedRef.current = cwd;
    let cancelled = false;
    setLoading(true);
    setErr('');
    void (async () => {
      try {
        const r = (await window.mjcode?.listBranches?.({ cwd })) as BranchListResult | undefined;
        if (cancelled) return;
        if (!r?.ok) {
          // 失败与「没有分支」必须是两种形态：都渲染成空列表，用户会把故障当成仓库本来就没分支
          setErr(t('worktree.listFailed', { error: String(r?.error || '') }));
          return;
        }
        applyList(r);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[git-branch] listBranches failed:', msg);
        setErr(t('worktree.listFailed', { error: msg }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, cwd, t]);

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

  return (
    <div ref={rootRef} className="relative shrink-0">
      <ChipButton
        icon={loading ? <IconSpinner size={12} className="animate-spin" /> : <IconGitBranch size={12} />}
        onClick={() => { if (!locked && isRepo) setOpen((v) => !v); }}
        disabled={locked || !isRepo}
        aria-expanded={open}
        title={locked && lockedHint ? lockedHint : (isRepo ? t('worktree.branchTitle') : t('worktree.initGitHint'))}
        className={`max-w-[150px] ${locked || !isRepo ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {shown || t('worktree.selectBranch')}
      </ChipButton>

      {open && !locked && (
        <div className="absolute left-0 bottom-full mb-2 w-[268px] bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)] overflow-hidden z-30">
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
            {!loading && !isRepo && (
              <div className="px-3 py-2 text-xs text-text2">{t('worktree.initGitHint')}</div>
            )}
            {!loading && isRepo && total === 0 && (
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

          <div className="border-t border-border p-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={busy || !isRepo}
              className="w-full justify-start text-text2"
            >
              {busy ? <IconSpinner size={12} className="animate-spin" /> : <IconRefresh size={12} />}
              {busy ? t('worktree.fetching') : t('worktree.fetchRefresh')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
