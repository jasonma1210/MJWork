// 数学公式渲染（KaTeX）—— 对话正文 / 思考正文 / 文件预览三处共用。
//
// 为什么不用现成的 rehype-katex（2026-11-03 实测结论）：
//   · 它依赖 hast-util-from-html-isomorphic，浏览器构建走 DOMParser，而本仓的渲染冒烟
//     （test/render-smoke.mjs）在 Node 里做 **SSR 首帧渲染** —— 那里没有 DOMParser，
//     一条带公式的消息会直接把整块渲染成「此面板加载出错」。这不是测试环境的怪癖：
//     首帧渲染路径真实存在（React 18 renderToString 被冒烟与部分导出路径使用）。
//   · KaTeX 本身有 renderToString（纯字符串、零 DOM 依赖），remark-math 负责把
//     `$...$` / `$$...$$` 解析成 `<code class="language-math math-inline|math-display">`，
//     我们在 code 渲染器里接住它即可 —— 少一个插件、少一条 DOMParser 依赖链。
//
// 安全：KaTeX 默认 trust:false，`\href`、`\htmlClass` 等命令会被丢弃；
// 输出 HTML 由 KaTeX 自己转义，不再拼任何用户文本进标签。
// 失败降级：非法 TeX（模型写错、流式输出到一半）回落到可读原文，绝不抛错。
import { useMemo } from 'react';
import katex from 'katex';

export interface MathSpanProps {
  /** 公式源码（remark-math 已经去掉 $ 定界符） */
  tex: string;
  /** 块级公式：居中独占一行；行内公式跟文字走 */
  display?: boolean;
}

/** remark-math 交给 code 渲染器的 className 判定（语言标记 + 行内/块级） */
export function isMathClass(className?: string): boolean {
  return /language-math/.test(String(className || ''));
}

export function isDisplayMath(className?: string): boolean {
  return /math-display/.test(String(className || ''));
}

export default function MathSpan({ tex, display = false }: MathSpanProps) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(String(tex || ''), {
        displayMode: display,
        throwOnError: false,
        strict: false,
        trust: false,
      });
    } catch (e) {
      // 走到这里说明 KaTeX 自身出错（而非 TeX 语法问题，后者已被 throwOnError:false 兜住）：
      // 降级成原文，不让一条公式毁掉整条回复。
      console.warn('[math] katex render failed:', e instanceof Error ? e.message : e);
      return '';
    }
  }, [tex, display]);

  if (!html) {
    // 降级：保留原文（可复制去修），与 mermaid 渲染失败的处置同一口径
    return <code className="font-mono text-xs text-text2">{tex}</code>;
  }
  return (
    <span
      className={display ? 'md-math-block' : 'md-math-inline'}
      // 注入内容是 KaTeX 生成的净化 HTML（trust:false），不是模型原文
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
