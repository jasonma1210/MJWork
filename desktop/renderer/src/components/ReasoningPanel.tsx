// 思考内容折叠行（2026-10-30，用户需求 1）
//
// 为什么默认折叠：推理模型的 reasoning 常常数千字，默认展开会把真正的答复顶出首屏，
// 用户「只想知道它还在想、不想读它的草稿」。折叠态只留一行灰字（图标 + 正在思考中… + 计时/字数），
// 点击才展开思考正文。
//
// 为什么结束后仍保留这一行：此前实现是「loading && reasoningText」才渲染，运行一结束
// 思考内容就永久消失——想复盘「它当时怎么想的」已经看不到了。现在只要有过思考内容就保留，
// 折叠态的文案从「正在思考中…」切到「思考过程」。
//
// 视觉纪律（2026-10-30 用户需求 2 定档）：与 ToolTrace 的折叠行同一套语言——
// 折叠行 12px 灰字（text-code + text-text2）、行首大脑图标、行尾 chevron；
// 展开后的思考正文用 .msg-prose-quiet（13px + 次要文字色），必须比正式答复的
// 15px 主文字色明显弱一档。零硬编码色值（全部走 theme.css 的 Design Token）、无 emoji。
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
// P1（S-005）：markdown 链接协议白名单——渲染面新增一处也必须接，否则门禁按计数不相等判红
import { safeUrlTransform } from '../lib/safeUrl';
import { IconBrain, IconChevronDown, IconChevronRight, IconSpinner } from './icons';

export interface ReasoningPanelProps {
  /** 思考正文（流式累积）；为空表示还没有任何思考内容 */
  text?: string;
  /** 是否仍在运行（决定折叠行文案与计时） */
  loading?: boolean;
  /** 已运行秒数（仅运行态展示） */
  elapsedSec?: number;
  /** 已接收字符数（思考 + 正文合计，沿用原口径） */
  chars?: number;
}

export default function ReasoningPanel({ text = '', loading = false, elapsedSec = 0, chars = 0 }: ReasoningPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const body = String(text || '');
  // 既没内容又不在运行：整块不渲染（历史消息本来就没有 reasoning 字段）
  if (!body && !loading) return null;
  // 有内容才可展开；流式开始但还没吐字时按钮禁用，避免点了没反应
  const canExpand = body.length > 0;
  return (
    <div className="mb-2 max-w-3xl">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        title={canExpand ? (open ? t('message.thinkingCollapse') : t('message.thinkingExpand')) : undefined}
        className={`flex items-center gap-2 text-code text-text2 select-none ${canExpand ? 'hover:text-text cursor-pointer' : 'cursor-default'}`}
      >
        {/* 大脑图标：用户要求「思考时有一个大脑的图标」。
            与工具轨迹行的终端图标（IconTerminal）成对出现，扫读时一眼区分「它在想」还是「它在跑命令」。 */}
        <IconBrain size={12} className="shrink-0" />
        <span>{loading ? t('message.thinkingActive') : t('message.thoughtProcess')}</span>
        {/* 运行中给一个转圈：纯文字「正在思考中…」在长思考时会被误判成卡死（线上真实发生过） */}
        {loading && <IconSpinner size={11} className="animate-spin shrink-0" />}
        {loading && elapsedSec > 0 && <span className="text-text2/70">{t('message.thinkingElapsed', { s: elapsedSec })}</span>}
        {chars > 0 && <span className="text-text2/70">{t('message.receivedChars', { n: chars })}</span>}
        {/* chevron 移到行尾：行首位置留给类型图标，展开指示统一收在右侧（与工具轨迹行同构） */}
        {canExpand && (open
          ? <IconChevronDown size={11} className="shrink-0 opacity-70" />
          : <IconChevronRight size={11} className="shrink-0 opacity-70" />)}
      </button>
      {open && canExpand && (
        // 内容面板：字号/颜色再降一档（msg-prose-quiet = 13px + 次要文字色）。
        // 思考是「过程性内容」，必须比正式答复（15px + 主文字色）弱，否则一段长思考会和答复混成同一层。
        <div className="mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text2">
          <div className="msg-prose msg-prose-quiet">
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrlTransform}>{body}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
