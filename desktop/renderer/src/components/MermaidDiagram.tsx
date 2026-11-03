// G-visualize（2026-10-19）：对话内 Mermaid 图表渲染。
//
// 目标：模型在回复里写的 ```mermaid 代码块（流程图/时序图/类图/甘特图/饼图等）直接渲染成图，
// 与主流对话产品（ChatGPT / Codex）对齐；不再退化成一大段源码文本让用户自己找工具画。
//
// 为什么用 mermaid（而不是自建 SVG 渲染器或引入图表库）：
//   · 它一份库同时覆盖「关系图 + 时序图 + 状态图 + 甘特图 + 饼图/xychart」，正好对应
//     「图表可视化」这一整类需求，不需要按图种各引一个库；
//   · 纯前端 ESM，可由 Vite 打进 renderer bundle，离线可用（本产品红线：不做云渲染）。
//
// 安全：图表源文本是**模型输出**，视同不可信输入。固定 securityLevel:'strict'
//  ——关闭 click 指令里的 javascript: 跳转、净化 HTML 标签，避免借图表注入脚本
//  （CSP 的 script-src 只放行了打包产物与哈希内联，不构成唯一防线）。
//
// 主题：跟随 data-theme（非 light 一律按深色），用 MutationObserver 监听切换后重渲染，
// 避免用户切主题后图表配色与界面脱节。
import { useEffect, useState } from 'react';
import mermaid from 'mermaid';
import { useI18n } from '../i18n';

let renderSeq = 0;      // render 需要全局唯一的 id，否则并发渲染会互相覆盖目标容器
let initedTheme: string | null = null;

// mermaid 的 theme 是字面量联合类型，这里收敛成两档，避免把 string 直接塞进 initialize
type MermaidTheme = 'dark' | 'default';

function currentTheme(): MermaidTheme {
  const t = document.documentElement.getAttribute('data-theme');
  // 主题枚举：light / dark / midnight / forest / sunset —— 仅 light 走浅色
  return t && t !== 'light' ? 'dark' : 'default';
}

function ensureInit(theme: MermaidTheme) {
  if (initedTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    fontFamily: 'inherit', // 继承应用字体，避免图表里出现与界面不一致的字体族
  });
  initedTheme = theme;
}

export function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(currentTheme());

  // 主题切换（设置页预览会即时改 data-theme）→ 重渲染图表
  useEffect(() => {
    const ob = new MutationObserver(() => setTheme(currentTheme()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    const src = String(code || '').trim();
    if (!src) return undefined;
    let alive = true;
    (async () => {
      try {
        ensureInit(theme);
        const id = `mj-mermaid-${Date.now().toString(36)}-${(renderSeq += 1)}`;
        const out = await mermaid.render(id, src);
        if (alive) { setSvg(out.svg); setError(''); }
      } catch (e) {
        // 语法错误是常态（模型可能写出不合法的图）：不抛到错误边界，就地降级为可读提示 + 原文
        if (alive) { setSvg(''); setError(String((e as Error)?.message || e)); }
      }
    })();
    return () => { alive = false; };
  }, [code, theme]);

  if (error) {
    // 渲染失败时**必须**把源码放出来（2026-11-03 用户反馈 6「识别逻辑图」）：
    // 模型写的图语法不合规是常态，只给一句「渲染失败」等于把内容彻底吞掉；
    // 用户可以自己复制去修，也能看出这张图想表达什么。原文默认折叠，不抢正文注意力。
    return (
      <div className="my-2 rounded-lg border border-border bg-raise px-3 py-2 text-xs text-text2">
        <div className="mb-1">{t('message.diagramRenderFailed')}</div>
        <details>
          <summary className="cursor-pointer select-none">{t('message.diagramShowSource')}</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-text2/80">{code}</pre>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger/80">{error}</pre>
        </details>
      </div>
    );
  }
  if (!svg) {
    return <div className="my-2 text-xs text-text2">{t('message.diagramRendering')}</div>;
  }
  return (
    <div
      className="my-3 flex justify-center overflow-x-auto [&>svg]:max-w-full [&>svg]:h-auto"
      // mermaid 在 securityLevel:'strict' 下已对输出做净化，此处注入的是净化后的 SVG
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
