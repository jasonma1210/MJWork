// DS Bots / T6-10：工件侧面板（设计稿 §12.1 / §12.3）。
//
// 定位：右侧常驻面板的一个 tab（不新增全屏页），三段内容：
//   ① 文档：只读当前版本（或选定历史版本）+ 章节导航；
//   ② 版本：版本快照列表（点击后回到「文档」按该版本只读回放）；
//   ③ 待办：复用 TeamBoardBody（与弹层看板同一份渲染，不另写一套列逻辑）。
//
// 三条约束：
//   · 默认收起，**首次生成工件后自动展开一次**（§12.3）——由 onAutoOpen 交父层切 tab + 开面板；
//   · 正文永远只按「单章节 + 分页」拉取（artifacts:section 有 8000 字符硬上限），
//     不做全文加载，避免 2MB 工件一次性穿过 IPC；
//   · 无项目 / 无工件都是常态，显示空态而不是报错。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import Button from './ui/Button';
import { TeamBoardBody, type TeamBoardCard } from './TeamBoard';
import { projectTeamRuns } from '../../../shared/teamStream.mjs';
import { formatTokens } from '../../../shared/teamTrace.mjs';

const REFRESH_DEBOUNCE_MS = 500;

interface ArtifactMeta {
  artifactId: string;
  projectId: string;
  kind: string;
  title: string;
  currentVersion: string;
  snapshotPolicy: string;
  sizeBytes: number;
  updatedAt: number;
}

interface SectionInfo {
  key: string;
  title: string;
  level: number;
  version: string;
  chars: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

interface ArtifactIndex {
  artifactId: string;
  title: string;
  currentVersion: string;
  sizeBytes: number;
  chars: number;
  outline: SectionInfo[];
}

interface VersionInfo {
  version: string;
  sectionKeys: string[];
  changeSummary: string;
  authorMemberId: string;
  createdAt: number;
}

interface SectionRead {
  sectionKey: string;
  title: string;
  version: string;
  content: string;
  chars: number;
  truncated: boolean;
  nextOffset: number | null;
}

type TabId = 'doc' | 'versions' | 'todo';

// 静态 key 表：i18n 语言包 key 存在性校验只认字面量，动态拼接的 key 校验不到
const PANEL_TAB_ITEMS: Array<{ id: TabId; key: string }> = [
  { id: 'doc', key: 'projectSpace.panelTabDoc' },
  { id: 'versions', key: 'projectSpace.panelTabVersions' },
  { id: 'todo', key: 'projectSpace.panelTabTodo' },
];

interface ArtifactPanelProps {
  threadId: string | null;
  onOpenFile?: (path: string) => void;
  // 首次生成工件 → 父层把右栏切到本 tab 并展开一次
  onAutoOpen?: () => void;
}

export default function ArtifactPanel({ threadId, onOpenFile, onAutoOpen }: ArtifactPanelProps) {
  const { t } = useI18n();
  const [project, setProject] = useState<{ projectId: string; name: string } | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [index, setIndex] = useState<ArtifactIndex | null>(null);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [runs, setRuns] = useState<unknown[]>([]);
  const [tab, setTab] = useState<TabId>('doc');
  const [sectionKey, setSectionKey] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState<string | null>(null);
  const [section, setSection] = useState<SectionRead | null>(null);
  const [error, setError] = useState('');
  const autoOpenedRef = useRef<string | null>(null);
  // 回调进 ref：父层每次渲染都会新建 onAutoOpen，直接进 load 的依赖会导致反复重拉
  const autoOpenRef = useRef(onAutoOpen);
  useEffect(() => { autoOpenRef.current = onAutoOpen; }, [onAutoOpen]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 会话 → 项目 → 工件 / 索引 / 版本 / 团队 run（一次并行，不串行往返）
  const load = useCallback(async () => {
    if (!threadId) {
      setProject(null); setArtifacts([]); setArtifactId(null); setIndex(null); setVersions([]); setRuns([]);
      return;
    }
    try {
      const r = (await window.mjcode?.artifactsForProject?.({ threadId })) as
        { ok?: boolean; project?: { projectId: string; name: string }; artifacts?: ArtifactMeta[]; error?: string } | undefined;
      if (!r?.ok) {
        setError(r?.error || '');
        setProject(null); setArtifacts([]); setArtifactId(null);
        return;
      }
      setError('');
      setProject(r.project || null);
      const list = r.artifacts || [];
      setArtifacts(list);
      const first = list[0] || null;
      setArtifactId(first ? first.artifactId : null);
      if (!first) { setIndex(null); setVersions([]); return; }
      // 首次生成工件（版本离开 V0.0）→ 自动展开一次；同一会话只触发一次
      if (first.currentVersion !== 'V0.0' && autoOpenedRef.current !== threadId) {
        autoOpenedRef.current = threadId;
        autoOpenRef.current?.();
      }
      const [idxRaw, versRaw, runRaw] = await Promise.all([
        window.mjcode?.artifactsIndex?.({ artifactId: first.artifactId, projectId: first.projectId }),
        window.mjcode?.artifactsVersions?.({ artifactId: first.artifactId }),
        window.mjcode?.teamsListThreadRuns?.({ threadId }),
      ]);
      const idx = idxRaw as { ok?: boolean; index?: ArtifactIndex; error?: string } | undefined;
      const vers = versRaw as { ok?: boolean; versions?: VersionInfo[] } | undefined;
      const runRes = runRaw as { ok?: boolean; runs?: unknown[] } | undefined;
      setIndex(idx?.ok ? (idx.index || null) : null);
      setVersions(vers?.ok ? (vers.versions || []) : []);
      setRuns(runRes?.ok ? (runRes.runs || []) : []);
    } catch (e) {
      setError((e as Error)?.message || '');
    }
  }, [threadId]);

  useEffect(() => { load(); }, [load]);

  // 任务/团队事件 → 500ms 防抖重拉（版本/任务都在这两条事件流之后落库）
  useEffect(() => {
    const mj = window.mjcode;
    if (!threadId || (!mj?.onTeamsEvent && !mj?.onTasksEvent)) return undefined;
    const bump = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { load(); }, REFRESH_DEBOUNCE_MS);
    };
    const offTeams = mj.onTeamsEvent?.(bump) as (() => void) | undefined;
    const offTasks = mj.onTasksEvent?.(bump) as (() => void) | undefined;
    return () => {
      clearTimeout(timerRef.current);
      offTeams?.();
      offTasks?.();
    };
  }, [threadId, load]);

  // 章节默认选择：首个有内容的章节，否则第一个章节；切换工件/版本时重置
  useEffect(() => {
    if (!index) { setSectionKey(null); return; }
    const withContent = index.outline.find((s) => s.chars > 0);
    setSectionKey(withContent ? withContent.key : (index.outline[0]?.key || null));
  }, [index]);

  // 读取选中章节（版本为空 = 当前版本；给定版本 = 只读回放）
  useEffect(() => {
    let alive = true;
    const fetchSection = async () => {
      if (!artifactId || !sectionKey) { setSection(null); return; }
      try {
        const r = (await window.mjcode?.artifactsSection?.({
          artifactId, sectionKey, version: previewVersion || undefined,
          projectId: project?.projectId,
        })) as { ok?: boolean; section?: SectionRead; error?: string } | undefined;
        if (!alive) return;
        if (r?.ok) { setSection(r.section || null); setError(''); }
        else { setSection(null); setError(r?.error || ''); }
      } catch (e) {
        if (alive) { setSection(null); setError((e as Error)?.message || ''); }
      }
    };
    fetchSection();
    return () => { alive = false; };
  }, [artifactId, sectionKey, previewVersion, project?.projectId]);

  const card = runs.length > 0 ? (projectTeamRuns(runs) as TeamBoardCard[]) : [];
  const latestCard = card.length > 0 ? card[card.length - 1] : null;

  if (!threadId) return <div className="p-3 text-caption text-text2">{t('projectSpace.panelNoThread')}</div>;
  if (!project) {
    return (
      <div className="p-3 text-caption text-text2">
        {error ? t('projectSpace.panelLoadFailed', { error }) : t('projectSpace.panelNoProject')}
      </div>
    );
  }
  if (!artifacts.length) {
    return <div className="p-3 text-caption text-text2">{t('projectSpace.panelNoArtifact')}</div>;
  }

  const cur = index?.currentVersion || artifacts[0].currentVersion;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-2 py-2 border-b border-border shrink-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs truncate flex-1" title={artifacts[0].title}>{artifacts[0].title}</span>
          <span className="text-caption text-text2 shrink-0 tabular-nums">
            {t('projectSpace.statusVersionGenerated', { version: previewVersion || cur })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {PANEL_TAB_ITEMS.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="xs"
              className={tab === item.id ? 'bg-hover text-text' : 'text-text2'}
              onClick={() => setTab(item.id)}
            >
              {t(item.key)}
            </Button>
          ))}
          <span className="ml-auto text-caption text-text2 shrink-0">
            {previewVersion ? t('projectSpace.panelViewingVersion', { version: previewVersion }) : t('projectSpace.panelReadOnly')}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'doc' && (
          <div className="p-3 space-y-3">
            {previewVersion && (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="xs" onClick={() => setPreviewVersion(null)}>
                  {t('projectSpace.panelBackToCurrent')}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              {(index?.outline || []).map((s) => (
                // 标签 pill：沿用 ui/Button（ghost + xs）而非裸 <button>，保持原语收敛；
                // 圆角/字号/选中配色与本组件既有视觉一致，故用 ! 前缀覆盖尺寸档默认值
                // （Tailwind 同名工具类冲突由样式表顺序决定，只有 ! 能确定性覆盖）。
                <Button
                  key={s.key}
                  variant="ghost"
                  size="xs"
                  onClick={() => setSectionKey(s.key)}
                  title={`${s.title} · ${s.version}`}
                  className={`px-2 border !rounded-lg !text-caption ${
                    sectionKey === s.key
                      ? '!border-accent !text-accent !bg-hover'
                      : '!border-border'
                  }`}
                >
                  {s.title}
                  {s.chars > 0 && <span className="ml-1 tabular-nums">{formatTokens(s.chars)}</span>}
                </Button>
              ))}
            </div>
            {section ? (
              <div className="space-y-1">
                <div className="text-caption text-text2">
                  {section.title} · {section.version} · {t('projectSpace.panelChars', { n: section.chars })}
                </div>
                {section.content
                  ? <pre className="text-xs whitespace-pre-wrap break-words font-sans">{section.content}</pre>
                  : <div className="text-caption text-text2">{t('projectSpace.panelEmptySection')}</div>}
                {section.truncated && (
                  <div className="text-caption text-warn">{t('projectSpace.panelTruncated')}</div>
                )}
              </div>
            ) : (
              <div className="text-caption text-text2">{t('projectSpace.panelNoSection')}</div>
            )}
          </div>
        )}

        {tab === 'versions' && (
          <div className="p-3 space-y-1">
            {versions.length === 0 && (
              <div className="text-caption text-text2">{t('projectSpace.panelVersionsEmpty')}</div>
            )}
            {versions.map((v) => (
              // 列表行按钮（整行可点、两行内容）：走 ui/Button 但用 ! 前缀还原行式度量，
              // 避免新增裸 <button> 让收敛基线回退（详见 ui-conventions 的 ratchet 规则）。
              <Button
                key={v.version}
                variant="ghost"
                size="xs"
                onClick={() => { setPreviewVersion(v.version); setTab('doc'); }}
                className="w-full px-2 py-1 !h-auto !flex-col !items-stretch !justify-start !gap-0 !whitespace-normal !text-text !rounded-lg hover:!bg-hover"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="tabular-nums shrink-0">{v.version}</span>
                  <span className="text-caption text-text2 shrink-0">
                    {v.sectionKeys.join(', ')}
                  </span>
                  <span className="ml-auto text-caption text-text2 shrink-0 tabular-nums">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </div>
                {v.changeSummary && (
                  <div className="text-caption text-text2 break-words">{v.changeSummary}</div>
                )}
              </Button>
            ))}
          </div>
        )}

        {tab === 'todo' && (
          <div className="p-3">
            {latestCard
              ? <TeamBoardBody card={latestCard} onOpenFile={onOpenFile} />
              : <div className="text-caption text-text2">{t('projectSpace.panelNoTodo')}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
