// 通用分页条（2026-11-04）：一页 10 条，上一页/下一页 + 输入页码跳转。
//
// 为什么单独成组件：会话消耗表与用量流水表都要分页，两处各写一遍会把
// 「页码越界钳制」「总页数换算」「跳转后回写输入框」写出两套不一致的口径。
// 纯展示 + 受控 page，数据切片由调用方做（本组件不持有列表）。
//
// 按钮一律走 ui/Button（不新增裸 <button>，ui-conventions 的棘轮只降不升）；
// 文案全部走 i18n，组件内零中文 UI 字面量。
import { useEffect, useState } from 'react';
import Button from './Button';
import { Input } from './Input';
import { useI18n } from '../../i18n';

/** 两个用量列表共用的每页条数（单一事实来源，避免一处改 10 另一处忘改） */
export const DEFAULT_PAGE_SIZE = 10;

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** 页码跳转到尚未加载的页时由调用方补数据，期间禁用操作 */
  busy?: boolean;
}

/** 页码钳制：非数字 / 小数 / 越界一律落到合法区间，绝不把 NaN 传给数组切片。 */
export function clampPage(page: number, pageSize: number, total: number): number {
  const size = Math.max(1, Math.trunc(Number(pageSize) || 1));
  const pages = Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
  const raw = Math.trunc(Number(page));
  if (!Number.isFinite(raw)) return 1;
  return Math.min(pages, Math.max(1, raw));
}

export default function Pagination({ page, pageSize, total, onPageChange, busy = false }: PaginationProps) {
  const { t } = useI18n();
  const size = Math.max(1, Math.trunc(Number(pageSize) || 1));
  const pages = Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
  const current = clampPage(page, size, total);
  const [draft, setDraft] = useState(String(current));

  // 外部翻页（上一页/下一页/数据变少）后，输入框必须跟着回到当前页，
  // 否则用户会看到「第 3 页」但输入框还写着 1。
  useEffect(() => { setDraft(String(current)); }, [current]);

  // 不超过一页时不画分页条：用户口径是「超过 10 条才分页」，
  // 少于 10 条还挂一排控件只是噪音。
  if (total <= size) return null;

  const go = (next: number) => {
    const p = clampPage(next, size, total);
    setDraft(String(p));
    if (p !== current) onPageChange(p);
  };
  const jump = () => { go(Number(draft)); };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button size="xs" variant="secondary" disabled={busy || current <= 1} onClick={() => go(current - 1)}>
        {t('pagination.prev')}
      </Button>
      <span className="text-caption tabular-nums text-text2">{t('pagination.pageInfo', { page: current, pages })}</span>
      <Button size="xs" variant="secondary" disabled={busy || current >= pages} onClick={() => go(current + 1)}>
        {t('pagination.next')}
      </Button>
      <span className="text-caption tabular-nums text-text2">{t('pagination.totalInfo', { n: total })}</span>
      <div className="ml-auto flex items-center gap-1">
        <Input
          type="number"
          min={1}
          max={pages}
          value={draft}
          disabled={busy}
          aria-label={t('pagination.jumpLabel')}
          containerClassName="w-14"
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); jump(); } }}
        />
        <Button size="xs" variant="ghost" disabled={busy} onClick={jump}>{t('pagination.jump')}</Button>
      </div>
    </div>
  );
}
