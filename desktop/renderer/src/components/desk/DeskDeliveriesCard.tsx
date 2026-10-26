// 工作台 · 最近交付卡
//
// 取数：window.mjcode.artifactsForProject({ threadId })（lib/api.js 没有封装，必须裸调）。
// **两种「拿不到项目」必须分开显示**，依据 main/ipc/artifacts.js 的注释（真机反馈）：
//   NO_PROJECT ⇒ 会话没绑定项目空间（配置缺失，可引导）· NOT_FOUND ⇒ 传了 thread 却查不到
//   项目（数据不一致，要排查：项目被删/库回滚）。用户遇到后者会以为数据坏了去翻库，文案必须不同。
// 工件行不做「验收状态 / 作者 / 头像墙 / 批次 N/M」—— 返回体里只有
// artifactId / kind / title / currentVersion / updatedAt，画这些就是编数据。
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

/** null = effect 还没回来（"未知"）；code 非空 = 查询失败及其原因 */
export type DeliveriesState = { code: string | null; artifacts: ArtifactRow[] } | null;

/**
 * 提示文案的 key —— 纯函数（状态与会话 id 都从参数进，不读全局），导出以便直接验。
 * 判定顺序（顺序本身是语义）：
 *   ① `state === null`（未回来）⇒ 不表态（原来走 empty ⇒ 有交付物的项目会先闪一帧「还没有
 *      交付物」；同屏运行卡/用量卡在"未知"时都整卡不表态）。
 *   ② 无会话 ⇒ noSession，**排在 NO_PROJECT 之前**：连会话都没有时说「这个会话还没绑定项目」
 *      是虚指，「没有会话」更前置。
 *   ③ NO_PROJECT / NOT_FOUND 各自给人话（可引导 / 要排查，见文件头注）。
 *   ④ 其余任何 code（ERROR / UNAVAILABLE / 未来新增）一律失败态：查询失败不是「确实没有交付物」。
 *   ⑤ 真 0 件 ⇒ empty。
 */
export function deliveriesHintKey(state: DeliveriesState, threadId?: string | null): string {
  if (state === null) return '';
  if (!String(threadId || '').trim()) return 'desk.deliveries.noSession';
  if (state.code === 'NO_PROJECT') return 'desk.deliveries.noProject';
  if (state.code === 'NOT_FOUND') return 'desk.deliveries.notFound';
  if (state.code) return 'desk.deliveries.failed';
  return state.artifacts.length === 0 ? 'desk.deliveries.empty' : '';
}

export default function DeskDeliveriesCard({ threadId = null, onOpenArtifacts }: DeskDeliveriesCardProps) {
  const { t } = useI18n();
  const [state, setState] = useState<DeliveriesState>(null);

  useEffect(() => {
    const mj = window.mjcode as unknown as { artifactsForProject?: (o: unknown) => Promise<ArtifactsResult | undefined> } | undefined;
    // 桥缺失 ≠ 没绑定项目：这属"查不了"，必须走失败态而不是把用户引去选项目
    if (!mj?.artifactsForProject) { setState({ code: 'UNAVAILABLE', artifacts: [] }); return undefined; }
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

  const rows = state?.artifacts || [];
  const hint = deliveriesHintKey(state, threadId);
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.deliveries.title')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-text">{t('desk.deliveries.title')}</h3>
          {rows.length > 0 ? <p className="mt-1 text-caption text-text2">{t('desk.deliveries.subtitle', { n: rows.length })}</p> : null}
        </div>
        {rows.length > 0 && onOpenArtifacts ? (
          <Button variant="ghost" size="xs" className="shrink-0" onClick={() => onOpenArtifacts()}>
            {t('desk.deliveries.openAll')}
          </Button>
        ) : null}
      </div>
      {hint ? <p className="mt-2 text-caption leading-relaxed text-text2">{t(hint)}</p> : null}
      {rows.length > 0 ? (
        <ul className="mt-2 flex flex-col">
          {rows.slice(0, 4).map((a) => (
            <li key={a.artifactId}>
              <Button variant="ghost" size="sm" className="w-full justify-start border-t border-border first:border-t-0" onClick={() => onOpenArtifacts?.()}>
                <span className="min-w-0 flex-1 truncate text-left">{a.title || a.artifactId}</span>
                {a.currentVersion === undefined || a.currentVersion === null ? null : (
                  <span className="shrink-0 font-mono text-caption text-text2">{t('desk.deliveries.version', { version: String(a.currentVersion) })}</span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
