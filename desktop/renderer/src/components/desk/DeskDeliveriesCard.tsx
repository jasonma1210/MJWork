// 工作台 · 最近交付卡
//
// 取数：window.mjcode.artifactsForProject({ threadId })（lib/api.js 没有封装，必须裸调）。
//
// **两种「拿不到项目」必须分开显示**，不能合并成「暂无数据」——
// 依据 main/ipc/artifacts.js 的注释（真机反馈）：
//   · code='NO_PROJECT' ⇒ 这个会话没绑定项目空间，属**配置缺失**，可引导（去左侧选/建项目）
//   · code='NOT_FOUND'  ⇒ 传了 thread 却查不到项目，属**数据不一致**，要排查（项目被删/库回滚）
// 用户遇到后者会以为是数据坏了去翻库，所以文案必须不同。
//
// 空态：本项目下 0 件工件 ⇒ 保留卡片 + 引导（「让团队先跑一单」），不留「0 件」这种计数。
//
// 工件行不做「验收状态 / 作者 / 成员头像 / 批次 N/M」—— artifacts 返回体里只有
// artifactId / kind / title / currentVersion / updatedAt，画这些就是在编数据。
// 点击行 = 打开右栏工件面板（按 threadId 定位），不猜文件路径。
import { useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useI18n } from '../../i18n';

interface ArtifactRow {
  artifactId: string;
  kind?: string;
  title?: string;
  currentVersion?: number | string;
  updatedAt?: string | number;
}

interface ArtifactsResult {
  ok?: boolean;
  code?: string | null;
  artifacts?: ArtifactRow[];
}

export interface DeskDeliveriesCardProps {
  threadId?: string | null;
  onOpenArtifacts?: () => void;
}

export default function DeskDeliveriesCard({ threadId = null, onOpenArtifacts }: DeskDeliveriesCardProps) {
  const { t } = useI18n();
  // null = 尚未取到（渲染期不画骨架屏，直接不渲染行）
  const [state, setState] = useState<{ code: string | null; artifacts: ArtifactRow[] } | null>(null);

  useEffect(() => {
    const mj = window.mjcode as unknown as { artifactsForProject?: (o: unknown) => Promise<ArtifactsResult | undefined> } | undefined;
    if (!mj?.artifactsForProject) { setState({ code: 'NO_PROJECT', artifacts: [] }); return undefined; }
    let cancelled = false;
    mj.artifactsForProject({ threadId })
      .then((r) => {
        if (cancelled) return;
        setState({ code: r?.ok ? null : String(r?.code || 'ERROR'), artifacts: Array.isArray(r?.artifacts) ? r.artifacts : [] });
      })
      .catch((err) => {
        console.warn('[desk] artifacts:forProject failed:', err);
        if (!cancelled) setState({ code: 'ERROR', artifacts: [] });
      });
    return () => { cancelled = true; };
  }, [threadId]);

  const code = state?.code || null;
  const rows = state?.artifacts || [];
  const hint = code === 'NO_PROJECT' ? 'desk.deliveries.noProject'
    : code === 'NOT_FOUND' ? 'desk.deliveries.notFound'
      : rows.length === 0 ? 'desk.deliveries.empty' : '';

  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.deliveries.title')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-text">{t('desk.deliveries.title')}</h3>
          {rows.length > 0 ? (
            <p className="mt-1 text-caption text-text2">{t('desk.deliveries.subtitle', { n: rows.length })}</p>
          ) : null}
        </div>
        {rows.length > 0 && onOpenArtifacts ? (
          <Button variant="ghost" size="xs" className="shrink-0" onClick={() => onOpenArtifacts()}>
            {t('desk.deliveries.openAll')}
          </Button>
        ) : null}
      </div>

      {/* 三态分开：配置缺失（可引导）/ 数据不一致（要排查）/ 真的还没有交付物 */}
      {hint ? <p className="mt-2 text-caption leading-relaxed text-text2">{t(hint)}</p> : null}

      {rows.length > 0 ? (
        <ul className="mt-2 flex flex-col">
          {rows.slice(0, 4).map((a) => (
            <li key={a.artifactId}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start border-t border-border first:border-t-0"
                onClick={() => onOpenArtifacts?.()}
              >
                <span className="min-w-0 flex-1 truncate text-left">{a.title || a.artifactId}</span>
                {a.currentVersion !== undefined && a.currentVersion !== null ? (
                  <span className="shrink-0 font-mono text-caption text-text2">
                    {t('desk.deliveries.version', { version: String(a.currentVersion) })}
                  </span>
                ) : null}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
