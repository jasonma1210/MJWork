// 分支切换确认卡（对齐 WorkBuddy 的 branchSwitch 确认框 + BranchSwitchDirtyPicker）
//
// 为什么需要它：分支选择器只记「本次任务的基线」，真正 checkout 发生在发送前。这一步会
// 改主检出目录的 HEAD，工作区不干净时还可能提交/暂存/丢弃用户的未提交文件——所以它必须
// 是一次**需要签字**的动作，而不是点一下分支名就悄悄发生。
//
// 命令式用法（与 components/feedback 的 confirm 同构）：
//   const r = await askBranchSwitch({ folder, current, selected, dirty });
//   if (!r.ok) return;  // 用户取消
//   ... checkoutBranch({ dirtyPolicy: r.policy })
// 为什么用模块级监听而不是把 state 抬到 ChatArea：调用点在 useAgentRun.send 的 async 流程里，
// 拿不到 React state 的 setter 语义（要额外一路 prop 穿透）；宿主组件在 App 根挂一次即可。
//
// 脏工作区三选一里的「提交」标「推荐」是有意的：另外两条都会让用户的东西离开工作区
// （stash 藏起来 / discard 直接没了），只有 commit 把内容留在版本历史里。
import { useEffect, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import MenuItem from './ui/MenuItem';
import { useI18n } from '../i18n';

export type DirtyPolicy = 'commit' | 'stash' | 'discard';
export interface BranchSwitchRequest {
  /** 工作区名（项目目录名），用于卡片文案「当前 X 空间内容归属 …」 */
  folder: string;
  current: string;
  selected: string;
  /** 工作区是否有未提交改动 → 决定给不给三选一 */
  dirty: boolean;
}
export interface BranchSwitchAnswer { ok: boolean; policy: DirtyPolicy }

/** 待确认请求（含 resolve）：listener 的类型必须显式声明，否则 `null | undefined` 推成 never */
type PendingRequest = BranchSwitchRequest & { id: number; resolve: (a: BranchSwitchAnswer) => void };
let listener: ((req: PendingRequest) => void) | null = null;
let seq = 0;

/** 请求一次「是否切换分支」的确认；用户取消 → { ok:false } */
export function askBranchSwitch(req: BranchSwitchRequest): Promise<BranchSwitchAnswer> {
  if (!listener) {
    // 宿主没挂：**不能**默认放行（那等于没确认就切），也不能默认取消（用户点了发送却毫无反应）
    console.warn('[branch-switch] host not mounted; treating as declined');
    return Promise.resolve({ ok: false, policy: 'commit' });
  }
  const notify = listener;
  return new Promise((resolve) => {
    notify({ id: ++seq, ...req, resolve });
  });
}

export default function BranchSwitchHost() {
  const { t } = useI18n();
  const [req, setReq] = useState<PendingRequest | null>(null);
  const [policy, setPolicy] = useState<DirtyPolicy>('commit');

  useEffect(() => {
    listener = (next) => { setPolicy('commit'); setReq(next); };
    return () => { listener = null; };
  }, []);

  if (!req) return null;

  const settle = (ok: boolean) => {
    req.resolve({ ok, policy });
    setReq(null);
  };

  const options: Array<{ value: DirtyPolicy; label: string; recommend?: boolean }> = [
    { value: 'commit', label: t('worktree.branchSwitch.dirty.commit', { branch: req.current }), recommend: true },
    { value: 'stash', label: t('worktree.branchSwitch.dirty.stash') },
    { value: 'discard', label: t('worktree.branchSwitch.dirty.discard') },
  ];

  return (
    <Modal
      open
      onClose={() => settle(false)}
      title={t('worktree.branchSwitch.title')}
      size="sm"
      footer={(
        <>
          <Button variant="secondary" size="md" onClick={() => settle(false)}>
            {t('worktree.branchSwitch.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={() => settle(true)}>
            {t('worktree.branchSwitch.confirm')}
          </Button>
        </>
      )}
    >
      <p className="text-xs text-text2 leading-relaxed">
        {req.dirty
          ? t('worktree.branchSwitch.dirty.desc', {
            folder: req.folder, current: req.current, selected: req.selected,
          })
          : t('worktree.branchSwitch.desc', {
            folder: req.folder, current: req.current, selected: req.selected,
          })}
      </p>
      {req.dirty && (
        <div role="radiogroup" aria-label={t('worktree.branchSwitch.dirty.group')} className="mt-3 border border-border rounded-lg overflow-hidden">
          {options.map((o) => (
            <MenuItem
              key={o.value}
              role="radio"
              aria-checked={policy === o.value}
              selected={policy === o.value}
              onClick={() => setPolicy(o.value)}
            >
              <span className="flex items-center gap-2">
                <span>{o.label}</span>
                {o.recommend && (
                  <span className="text-caption text-success shrink-0">{t('worktree.branchSwitch.dirty.recommend')}</span>
                )}
              </span>
            </MenuItem>
          ))}
        </div>
      )}
    </Modal>
  );
}
