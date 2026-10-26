// 工作台 · 待你决定卡（只读入口）
//
// 数据来源就是入参 threads（**不调任何 IPC**）：状态由 App 写回会话记录
// （awaiting_approval 的写入端在 ApprovalCard.onPendingChange），desk 只做投影。
//
// 「只读」的边界：这里**不做审批决策**，也不镜像审批卡的内容（标题/风险级别/diff 都不在此处）——
// 审批的唯一决策面是全局浮层 ApprovalCard（它带 FIFO 队列与归属会话语义）。
// 在 desk 上再放一组「批准/拒绝」会造出第二条决策路径，两处队列不同步就是事故。
// 点击行只做「跳到该会话」，让用户在原位处理。
//
// 空态：0 条待决定 ⇒ **整卡卸载**；0 件不占屏，也不写「0 条」。
// 计数文案复用 hero 的两条 key（hero.decideLine / hero.allClear）——
// 本批 desk.json 的 65 键里没有独立的 decisions 组，避免为一行标题新开一组。
import Button from '../ui/Button';
import { useI18n } from '../../i18n';

interface DeskThreadRow {
  id: string;
  title?: string;
  status?: string;
}

export interface DeskDecisionsCardProps {
  threads: DeskThreadRow[];
  onOpenThread?: (threadId: string) => void;
}

export default function DeskDecisionsCard({ threads, onOpenThread }: DeskDecisionsCardProps) {
  const { t } = useI18n();
  const waiting = threads.filter((x) => x.status === 'awaiting_approval');
  if (waiting.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.hero.decideLine', { n: waiting.length })}>
      <p className="text-xs font-medium text-text">{t('desk.hero.decideLine', { n: waiting.length })}</p>
      <ul className="mt-2 flex flex-col">
        {waiting.slice(0, 5).map((x) => (
          <li key={x.id}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start border-t border-border first:border-t-0"
              onClick={() => onOpenThread?.(String(x.id))}
            >
              <span className="min-w-0 flex-1 truncate text-left">{x.title || x.id}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
