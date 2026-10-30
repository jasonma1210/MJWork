// F-005（2026-10-30）：摘除文件级类型检查豁免并补类型（正文零改动，只补签名与接口）。
import { IconZap } from './icons';
import InlineAlert from './InlineAlert';
import WorktreeBar from './WorktreeBar';
import AgentDock from './AgentDock';
import Composer from './Composer';
import ScenarioCards from './desk/ScenarioCards';
import { projectDisplayName } from '../lib/projectName';
import { useI18n } from '../i18n';

// T2-2：欢迎页（新建任务空态）自主进程 ChatArea.jsx 原样搬移，行为不变。
// Composer 及其容器经 composerProps 与对话页共享同一份接线（ChatArea 组装）。
//
// 2026-10-26：4 张快捷动作卡（探索 / 构建 / 审查 / 修复）替换为 4 张**工作场景预设卡**
//   （文档协作 / 软件开发 / 内容创作 / 数据调研），从工作台迁来。两条理由：
//   ① 工作台是「开工前一屏」的概览面，原型 desk 的接单区只有输入框 + 一行工具条；
//      四张预设卡会把下面六个状态板块全推出首屏（真机截图已确认）。
//   ② 这里才是「从零起步」、最需要引导的地方，而原快捷动作是泛泛的动作词，
//      不如带目标模板与常用指令的场景卡贴合「以工作为主」的定位。
//   点击语义也一并改了：从「直接发送」改为「填入输入框」—— 模板里含 {source} 这类占位，
//   直接发出去等于把花括号当业务参数喂给模型，必须先让用户替换。

export interface WelcomePageProps {
  /** Composer 的整包接线（ChatArea 装配后整体透传）。类型直接从 Composer 自身参数派生：
   *  Composer 补全/调整类型时本页自动跟随，不会出现「两处声明各自漂移」。
   *  setInput 是 useState 的 setter 形态（字符串或更新函数都收），本页只按字符串用。 */
  composerProps: Parameters<typeof Composer>[0];
  /** 环境建议（基于项目真实状态生成），不足 4 条时用默认建议补齐 */
  ambient: string[];
  project: { path?: string; name?: string } | null;
  /** 本轮是否**主动**选过项目（重启后残留的上次项目不算） */
  projectPicked: boolean;
  onOpenProjectPicker: () => void;
  send: (text: string) => void;
  modelWarning: boolean;
  setModelWarning: (v: boolean) => void;
  runMode: string;
  worktree: { path?: string; branch?: string } | null;
  setWorktree: (v: { path?: string; branch?: string } | null) => void;
  setRunMode: (mode: string) => void;
  setModeMsg: (msg: string) => void;
}

export default function WelcomePage({
  composerProps, ambient, project, projectPicked, onOpenProjectPicker,
  send, modelWarning, setModelWarning,
  runMode, worktree, setWorktree, setRunMode, setModeMsg,
}: WelcomePageProps) {
  const { t } = useI18n();
  return (
    <div className="flex-1 overflow-y-auto">
      {/* P1-14（2026-10-26）：根容器改为可滚动；内容少时内层 min-h-full + justify-center 居中，
          内容多（如 700px 小窗）时滚动而非被裁切——此前 justify-center 无 overflow-y-auto，
          标题与 Composer 被 body overflow:hidden 切掉，只能拉大窗口才能开工。 */}
      <div className="min-h-full flex flex-col items-center justify-center px-8 py-10">
      <h1 className="text-3xl font-semibold text-center mb-3">{t('welcome.heading')}</h1>
      {/* 副标题 = 项目入口（真机反馈：新建任务页找不到「选择目录/创建项目」入口）。
          只在本轮主动选择过项目时才说「在 X 中」——重启后残留的上次项目
          不是用户的选择，不得当默认事实展示（空态不得伪装成已选） */}
      <p className="text-text2 text-sm mb-6">
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

      {/* 工作场景预设（主力引导）：点「套用模板」/ 指令只填入输入框，不直接发送。
          列宽 minmax(420px) 而非 220px —— 场景卡的每条指令是一整句话（20 字上下），
          4 列时每列只剩 240px，指令会被截成「把这份材料压成 300 字摘要，保…」，
          用户看不出这条指令要干什么，引导就失效了。2 列能放下完整一句。 */}
      <div className="w-full max-w-5xl mb-4">
        <p className="mb-2 text-caption text-text2">{t('desk.intake.presetsLabel')}</p>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))]">
          <ScenarioCards onApply={(text) => composerProps.setInput(text)} />
        </div>
      </div>

      <div className="grid gap-3 w-full max-w-5xl mb-8 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {/* C5：环境建议固定 4 槽位（ambient 不足用默认建议补齐），避免排列不齐。
            上限 4 是因为上方场景卡已占 4 张，两区合计 8 张与改造前一致。 */}
        {(() => {
          const DEFAULT_TIPS = [t('welcome.defaultTip1'), t('welcome.defaultTip2')];
          const slots = [...ambient];
          for (const tip of DEFAULT_TIPS) {
            if (slots.length >= 4) break;
            if (!slots.includes(tip)) slots.push(tip);
          }
          return slots.map((tip) => (
            <button key={tip} onClick={() => send(tip)}
              className="border border-accent/40 rounded-2xl p-5 text-left hover:bg-hover transition-colors">
              <div className="mb-3 text-accent"><IconZap size={22} /></div>
              <div className="text-sm text-text leading-snug">{tip}</div>
            </button>
          ));
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
        onMsg={(m: string) => setModeMsg(m)}
      />
      {/* P0-6（2026-10-22）：此处原本挂任务清单组件但从不传 runId。
          欢迎页属于「无会话」态，按定义不存在在役 run，组件首行 `if (!runId) return`
          使它恒为 null——是一个永不渲染的挂载（死代码）。真实的任务清单挂在 ChatArea
          （那里能拿到 activeRunId）。 */}
      {/* WorkBuddy 式 Agent 运行胶囊：在役数字员工一览（点击展开流程与强制关闭） */}
      <AgentDock />
      <Composer {...composerProps} workspaceBound={false} />
      </div>
    </div>
  );
}
