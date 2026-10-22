// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
import { IconHammer, IconRefresh, IconSearch, IconWrench, IconZap } from './icons';
import InlineAlert from './InlineAlert';
import WorktreeBar from './WorktreeBar';
import AgentDock from './AgentDock';
import Composer from './Composer';
import { projectDisplayName } from '../lib/projectName';
import { useI18n } from '../i18n';

// T2-2：欢迎页（新建任务空态）自主进程 ChatArea.jsx 原样搬移，行为不变。
// Composer 及其容器经 composerProps 与对话页共享同一份接线（ChatArea 组装）。

// 顶层常量只存 i18n key，渲染时经 t() 求值（避免模块加载冻结译文）
const QUICK_ACTIONS = [
  { Icon: IconSearch, titleKey: 'welcome.quickExploreTitle', promptKey: 'welcome.quickExplorePrompt' },
  { Icon: IconHammer, titleKey: 'welcome.quickBuildTitle', promptKey: 'welcome.quickBuildPrompt' },
  { Icon: IconRefresh, titleKey: 'welcome.quickReviewTitle', promptKey: 'welcome.quickReviewPrompt' },
  { Icon: IconWrench, titleKey: 'welcome.quickFixTitle', promptKey: 'welcome.quickFixPrompt' },
];

export default function WelcomePage({
  composerProps, ambient, project, projectPicked, onOpenProjectPicker,
  send, modelWarning, setModelWarning,
  runMode, worktree, setWorktree, setRunMode, setModeMsg,
}) {
  const { t } = useI18n();
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <h1 className="text-3xl font-semibold text-center mb-3">{t('welcome.heading')}</h1>
      {/* 副标题 = 项目入口（真机反馈：新建任务页找不到「选择目录/创建项目」入口）。
          只在本轮主动选择过项目时才说「在 X 中」——重启后残留的上次项目
          不是用户的选择，不得当默认事实展示（空态不得伪装成已选） */}
      <p className="text-text2 text-sm mb-8">
        {project?.path && projectPicked ? (
          <>{t('welcome.inProject', { name: projectDisplayName(project) })} · </>
        ) : (
          <>{t('welcome.tellUs')} · </>
        )}
        <button onClick={onOpenProjectPicker}
          className="text-accent hover:underline underline-offset-2">
          {project?.path && projectPicked ? t('welcome.switchProject') : t('welcome.openOrCreateProject')}
        </button>
      </p>

      <div className="grid gap-3 max-w-3xl mb-8 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {/* C5：固定 8 槽位（ambient 不足用默认建议补齐），避免 4+3 排列不齐 */}
        {(() => {
          const DEFAULT_TIPS = [t('welcome.defaultTip1'), t('welcome.defaultTip2')];
          const slots = [...ambient];
          for (const tip of DEFAULT_TIPS) {
            if (slots.length >= 8 - QUICK_ACTIONS.length) break;
            if (!slots.includes(tip)) slots.push(tip);
          }
          return (
            <>
              {slots.map((tip) => (
                <button key={tip} onClick={() => send(tip)}
                  className="border border-accent/40 rounded-2xl p-5 text-left hover:bg-hover transition-colors">
                  <div className="mb-3 text-accent"><IconZap size={22} /></div>
                  <div className="text-sm text-text leading-snug">{tip}</div>
                </button>
              ))}
              {QUICK_ACTIONS.map((q) => (
                <button key={q.titleKey} onClick={() => send(t(q.promptKey))}
                  className="border border-border rounded-2xl p-5 text-left hover:bg-hover hover:border-accent transition-colors">
                  <div className="mb-3 text-accent"><q.Icon size={22} /></div>
                  <div className="text-sm text-text leading-snug">{t(q.titleKey)}</div>
                </button>
              ))}
            </>
          );
        })()}
      </div>

      {modelWarning && (
        <div className="max-w-3xl w-full mx-auto mb-4">
          <InlineAlert type="warn" onDismiss={() => setModelWarning(false)}>
            {t('welcome.modelWarning')}
          </InlineAlert>
        </div>
      )}

      {/* P1-H：隔离工作区收口条（合并回主目录/提升为分支/清理）——worktree 只建不收的断链修复 */}
      <WorktreeBar
        worktree={runMode === 'worktree' ? worktree : null}
        onClosed={() => { setWorktree(null); setRunMode('local'); }}
        onMsg={(m) => setModeMsg(m)}
      />
      {/* P0-6（2026-10-22）：此处原本挂任务清单组件但从不传 runId。
          欢迎页属于「无会话」态，按定义不存在在役 run，组件首行 `if (!runId) return`
          使它恒为 null——是一个永不渲染的挂载（死代码）。真实的任务清单挂在 ChatArea
          （那里能拿到 activeRunId）。 */}
      {/* WorkBuddy 式 Agent 运行胶囊：在役数字员工一览（点击展开流程与强制关闭） */}
      <AgentDock />
      <Composer {...composerProps} workspaceBound={false} />
    </div>
  );
}
