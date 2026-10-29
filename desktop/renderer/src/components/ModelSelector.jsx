import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconChevronDown, IconChevronRight, IconCpu, IconCheck, IconPlus } from './icons';
import {
  getReasoningOptions, getContextOptions, modelKeyOf, getModelConfig, setModelConfig,
  resolveContextWindow, fmtK,
} from '../lib/modelConfig';
import { useI18n } from '../i18n';

// 模型声明的能力（main/modelsFile.js:defaultCaps 的契约：supportsReasoning + supportedEfforts）。
// 返回 null = 完全拿不到能力声明（例如当前桥面还没把 caps 透传到渲染层）——
// 此时**不门控**（保持历史行为，零破坏）；只有明确声明了 caps 才按声明禁用档位。
export function reasoningCapsOf(model, provider) {
  const caps = model?.caps || provider?.caps || null;
  if (!caps || typeof caps !== 'object') return null;
  return {
    supportsReasoning: caps.supportsReasoning === true,
    supportedEfforts: Array.isArray(caps.supportedEfforts) && caps.supportedEfforts.length
      ? caps.supportedEfforts : null,
  };
}

// P0-3③：思考强度选项的可用性判定（纯函数，导出以便单点验证「能力 → 禁用」链路真的通）。
// 返回新数组，不修改入参；disabled 项带 title 说明「已不下发」。
export function reasoningOptionsFor(caps, t) {
  return getReasoningOptions().map((o) => {
    if (!o.value || !caps) return o; // 「默认」= 不下发参数，永远可选；能力未知时不门控
    const ok = caps.supportsReasoning
      && (!caps.supportedEfforts || caps.supportedEfforts.includes(o.value));
    return ok ? o : { ...o, disabled: true, title: t('models.reasoningUnsupported') };
  });
}

// 只认 source='api-show' 的探测值：'fallback-4k' 是探测失败的占位，伪装成「已确认」会把窗口高估
// （H-1 代价不对称：高估 ⇒ 压缩永不触发 ⇒ 击穿）。Ollama 的 name 可能带 ':latest' 后缀，需归一。
export function probedNumCtxOf(list, model) {
  const id = String(model?.model_id || model?.id || '');
  if (!id || !Array.isArray(list)) return 0;
  const norm = (s) => String(s || '').trim().replace(/:latest$/i, '');
  const hit = list.find((w) => norm(w?.name) === norm(id));
  if (!hit || hit.source !== 'api-show') return 0;
  return Number(hit.numCtx) > 0 ? Number(hit.numCtx) : 0;
}

// 模型选择器（对标 WorkBuddy 双栏 popover）：
// 左栏：按 provider 分组的模型列表（勾选态）+ 底部「配置自定义模型」入口
// 右栏：当前模型的详情 —— 思考强度 / 上下文窗口，点行展开二级选项面板（选中项带勾选标记）
// 反馈修复：setModelConfig 只写 localStorage 不触发渲染，必须用 cfgVer 计数器强制刷新，
// 否则选项高亮永远不动（真机事故：点击无任何反馈）
export default function ModelSelector({ providers, selected, onSelect }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null); // 右栏展示的模型（点列表即切换，同时选中）
  const [expanded, setExpanded] = useState(null); // 'reasoning' | 'context' | null
  const [cfgVer, setCfgVer] = useState(0); // 配置写入计数器 → 强制重渲染让高亮即时生效
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setExpanded(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 每次展开面板时，右栏回到当前选中模型
  useEffect(() => {
    if (open) { setDetail(selected); setExpanded(null); }
    // setDetail/setExpanded 为稳定 setter 无需列入依赖；selected 由父组件受控更新，
    // 随 open 变化重新同步即可。刻意不列 selected：否则父组件每次传新 selected
    // 都会重置展开态，用户点开的模型详情会被反复收起。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // P0-1⑤：Ollama 探测值（hook 必须在任何早退 return 之前，保持调用顺序稳定）
  const probedWindows = useProbedWindows(open);

  if (providers.length === 0) {
    return (
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('mjcode:open-settings'))}
        className="h-7 inline-flex items-center gap-2 rounded-lg border border-dashed border-border px-2 text-xs text-text2 hover:text-text hover:border-accent transition-colors"
        title={t('models.notConfigured')}
      >
        <IconCpu size={12} className="shrink-0" />
        {t('models.notConfigured')}
      </button>
    );
  }

  const valueOf = (p, m) => `${p.isGlobal ? 'g' : p.source || 'u'}:${p.id}/${m.id}`;
  const dKey = detail ? modelKeyOf(detail.provider, detail.model) : null;
  const cfg = cfgVer >= 0 && detail ? getModelConfig(dKey) : null;
  const reasoning = cfg?.reasoning_effort || '';
  const ctxWin = cfg?.context_window || 0;
  const labelOf = (opts, v) => opts.find((o) => o.value === v)?.label || t('models.default');

  // P0-3③: 思考强度能力门控——不支持的档位置灰并说明（H-3：未声明支持也按「已不下发」处理）
  const rCaps = detail ? reasoningCapsOf(detail.model, detail.provider) : null;
  const reasoningOptions = reasoningOptionsFor(rCaps, t);

  // P0-1⑤: Ollama 探测到的 num_ctx（只认 api-show 来源）；拿到后窗口行显示「已探测：N」
  const probedNumCtx = probedNumCtxOf(probedWindows, detail?.model);

  // P1-12: 窗口未确认警示——用户没手选、映射表也没命中时，必须显式告知「按 N 估算」，
  // 而不是像以前那样只显示「默认」（实际算多少完全看不出来）。
  const ctxResolved = detail
    ? resolveContextWindow(detail.provider, detail.model, probedNumCtx)
    : { window: 0, confirmed: true, source: 'default' };
  const ctxUnconfirmed = ctxWin === 0 && !ctxResolved.confirmed;
  const ctxProbed = ctxWin === 0 && ctxResolved.source === 'ollama-probe';
  const baseCtxOptions = getContextOptions();
  // 未确认时把「确认为 N」置顶（= 用户确认这个估算值，之后不再提示）；与既有档位重合时不重复插入
  const ctxOptions = ctxUnconfirmed && !baseCtxOptions.some((o) => o.value === ctxResolved.window)
    ? [{ value: ctxResolved.window, label: t('models.ctxCorrect', { k: fmtK(ctxResolved.window) }) }, ...baseCtxOptions]
    : baseCtxOptions;
  const ctxValueLabel = ctxProbed
    ? t('models.ctxProbed', { k: fmtK(ctxResolved.window), source: 'api-show' })
    : (ctxUnconfirmed
      ? t('models.ctxUnconfirmed', { k: fmtK(ctxResolved.window) })
      : labelOf(baseCtxOptions, ctxWin));
  const ctxTitle = ctxProbed
    ? t('models.ctxProbedHint', { k: fmtK(ctxResolved.window) })
    : (ctxUnconfirmed
      ? t('models.ctxUnconfirmedHint', { k: fmtK(ctxResolved.window) })
      : (ctxWin ? t('models.contextCalcTitle', { label: labelOf(baseCtxOptions, ctxWin) }) : t('models.contextNativeTitle')));

  function choose(p, m) {
    onSelect({ provider: p, model: m });
    setDetail({ provider: p, model: m });
    setExpanded(null);
  }

  function updateCfg(patch) {
    setModelConfig(dKey, patch);
    setCfgVer((v) => v + 1); // 关键：触发重渲染，否则 localStorage 写入不可见
  }

  return (
    <span ref={rootRef} className="relative inline-flex min-w-0">
      {/* 触发器与 Composer 下拉控件同 chip 设计语言（h-7/rounded-lg/text-xs），
          IconCpu 内联进按钮——此前图标挂在 ComposerControls 外层 span，与 chip 脱离不对齐。
          2026-10-29：min-w-0 让它在单行工具行里可收缩（宽度不够时截断模型名，而不是换行）。 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`h-7 min-w-0 inline-flex items-center gap-2 rounded-lg border px-2 text-xs text-text bg-transparent outline-none hover:bg-hover hover:border-accent cursor-pointer transition-colors max-w-[240px] ${
          open ? 'border-accent' : 'border-border'
        }`}
        aria-expanded={open}
        aria-label={t('models.selectModel')}
      >
        <IconCpu size={12} className="shrink-0 text-text2" />
        <span className="truncate">
          {selected ? `${selected.provider.name} / ${selected.model.display_name || selected.model.model_id}` : t('models.selectModelPlaceholder')}
        </span>
        <IconChevronDown size={11} className={`shrink-0 transition-transform ${open ? 'rotate-180 text-accent' : 'text-text2'}`} />
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-2 w-[min(460px,calc(100vw-2rem))] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] z-palette overflow-hidden flex">
          {/* 左栏：模型列表 */}
          <div className="w-[180px] shrink-0 border-r border-border flex flex-col">
            <div className="flex-1 min-h-0 max-h-72 overflow-y-auto py-1">
              {providers.map((p) => (
                <div key={`${p.isGlobal ? 'g' : p.source || 'u'}:${p.id}`}>
                  <div className="px-3 pt-2 pb-1 text-caption text-text2 flex items-center gap-2">
                    <IconCpu size={11} />
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0">{p.isGlobal ? t('models.scopeGlobal') : p.source === 'local' ? t('models.scopeLocal') : t('models.scopePrivate')}</span>
                  </div>
                  {(p.models || []).length === 0 && (
                    <div className="px-3 py-1 text-xs text-text2">{t('models.noModels')}</div>
                  )}
                  {(p.models || []).map((m) => {
                    const active = selected && String(selected.model.id) === String(m.id) && !!selected.provider.isGlobal === !!p.isGlobal && String(selected.provider.id) === String(p.id);
                    return (
                      <button key={valueOf(p, m)} onClick={() => choose(p, m)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs ${active ? 'bg-select-bg text-text font-medium' : 'hover:bg-hover text-text'}`}>
                        <span className="flex-1 truncate">{m.display_name || m.model_id}</span>
                        {active && <IconCheck size={12} className="shrink-0 text-select-fg" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* 底部入口：打开设置管理自定义模型 */}
            <button
              onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('mjcode:open-settings')); }}
              className="shrink-0 border-t border-border px-3 py-2 text-left text-xs text-text2 hover:text-text hover:bg-hover flex items-center gap-2">
              <IconPlus size={12} />
              {t('models.configureCustom')}
            </button>
          </div>

          {/* 右栏：模型详情 + 配置行（点行展开二级选项面板） */}
          {detail ? (
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="px-4 pt-3 pb-2 border-b border-border">
                <div className="text-sm font-medium text-text truncate">
                  {detail.model.display_name || detail.model.model_id}
                </div>
                <div className="text-xs text-text2 mt-1 truncate" title={detail.model.model_id}>
                  {detail.provider.name} · {detail.model.model_id}
                </div>
              </div>

              {/* 思考强度（P0-3③：按模型能力门控，不支持/未声明的档位置灰） */}
              <ConfigRow
                label={t('models.reasoningEffort')}
                value={labelOf(getReasoningOptions(), reasoning)}
                expanded={expanded === 'reasoning'}
                onToggle={() => setExpanded(expanded === 'reasoning' ? null : 'reasoning')}
                options={reasoningOptions}
                picked={reasoning}
                onPick={(v) => { updateCfg({ reasoning_effort: v }); setExpanded(null); }}
                title={reasoning ? t('models.reasoningParamTitle', { v: reasoning }) : t('models.reasoningDefaultTitle')}
              />
              {/* 上下文窗口（P1-12：未确认时显示「未确认（按 N 估算）」+ 告警图标 + 一键校正项） */}
              <ConfigRow
                label={t('models.contextWindow')}
                value={ctxValueLabel}
                expanded={expanded === 'context'}
                onToggle={() => setExpanded(expanded === 'context' ? null : 'context')}
                options={ctxOptions}
                picked={ctxWin}
                onPick={(v) => { updateCfg({ context_window: v }); setExpanded(null); }}
                title={ctxTitle}
                warn={ctxUnconfirmed}
              />
              <div className="mt-auto px-4 py-2 text-caption text-text2">
                {t('models.perModelSaved')}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-text2 py-10">
              {t('models.pickFromLeft')}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

// 配置行：label + 当前值 + 右箭头；点击展开垂直选项列表（对标 WorkBuddy 二级面板）
// P0-3③：选项支持 disabled 渲染态（灰 + aria-disabled + 拦截 onPick），不再是「无条件可点」
// P1-12：warn=true 时行尾显示告警图标（窗口未确认）
function ConfigRow({ label, value, expanded, onToggle, options, picked, onPick, title, warn }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        title={title}
        className={`w-full flex items-center px-4 py-3 text-xs ${expanded ? 'bg-hover' : 'hover:bg-hover'}`}
      >
        <span className="text-text">{label}</span>
        <span className={`ml-auto ${warn ? 'text-warn' : 'text-text2'}`}>{value}</span>
        {warn && <IconAlert size={11} className="ml-2 shrink-0 text-warn" />}
        <IconChevronRight size={12}
          className={`ml-2 text-text2 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="pb-2">
          {options.map((o) => {
            const active = o.value === picked;
            const disabled = o.disabled === true;
            return (
              <button
                key={String(o.value)}
                onClick={() => { if (!disabled) onPick(o.value); }}
                disabled={disabled}
                aria-disabled={disabled || undefined}
                title={o.title || undefined}
                className={`w-full flex items-center px-6 py-2 text-xs ${
                  disabled
                    ? 'text-text2 opacity-50 cursor-not-allowed'
                    : (active ? 'bg-select-bg text-text font-medium' : 'text-text hover:bg-hover')
                }`}
              >
                <span className="flex-1 text-left">{o.label}</span>
                {active && !disabled && <IconCheck size={12} className="shrink-0 text-select-fg" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// P0-1⑤ / P1-12：从资源快照取 Ollama 各模型的探测结果（仅 popover 打开时拉一次，不新增轮询）。
// 探测做了不用等于白做：用户看不到本机真实的 num_ctx，就只能看到「按 4K 估算」的保守值。
// 定义放在组件之后：undef-ident 门禁按文件顺序判定「依赖数组引用后置声明」的 TDZ 风险，
// 参数名与组件内 open 同名，放在前面会被误报（不影响运行，但门禁会红）。
function useProbedWindows(open) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    Promise.resolve(window.mjcode?.quotaSnapshot?.())
      .then((s) => { if (alive) setList(s?.localBackend?.modelWindows || null); })
      .catch(() => { /* 取不到就退回默认档（未确认），不影响配置行可用性 */ });
    return () => { alive = false; };
  }, [open]);
  return list;
}
