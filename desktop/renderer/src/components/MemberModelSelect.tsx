// M5 / T5-7：军团成员「per-agent 模型绑定」选择器（从 TeamsPage 抽出，避免其突破 800 行 God File 黄线）。
//
// 为什么渲染层只认 {providerId, modelId} 这对 id、永不自己拼 `providerId::modelId`：
//   引用串格式的唯一事实来源是主进程 `main/modelShape.js`（含分隔符、长度上限、fail-closed 规则）。
//   若界面自己拼接，格式就有了第二份实现——一旦与主进程漂移，表现是「界面显示已绑定、
//   实际却跑默认模型」这种**静默**错误（不报错、难发现），正是本项目反复吃亏的形态。
//   故：选择器回传对象 → 主进程 `canonicalizeModelRef` 单点 canonical 化 → 落库。
import type { ReactNode } from 'react';

type TFunc = (key: string, params?: Record<string, string | number>) => string;

/** 成员的最小形状（只取本组件需要的字段，避免与页面级 TeamMember 类型耦合） */
export interface MemberLike {
  model?: string | null;
  modelRef?: { providerId: string; modelId: string } | null;
  modelLabel?: string | null;
}

/** 模型选项：供应商 · 模型，值只用下标回指（见上方「只认 id」注释） */
export interface ModelOption { providerId: string; modelId: string; label: string; }

/** 本机供应商列表的宽松形状（`window.mjcode.localProviders()` 的返回，字段可缺） */
export interface ProviderLike {
  id?: string | number;
  name?: string;
  models?: Array<{ modelId?: string; model_id?: string; displayName?: string }>;
}

/** 本机供应商列表 → 模型选项（label = 供应商名 · 模型名，纯数据拼接不涉 i18n 文案） */
export function toModelOptions(providers: ProviderLike[] | undefined): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of Array.isArray(providers) ? providers : []) {
    if (!p || p.id == null) continue;
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const modelId = String((m?.modelId ?? m?.model_id) || '');
      if (!modelId) continue;
      const name = String(m?.displayName || modelId);
      out.push({ providerId: String(p.id), modelId, label: p.name ? `${p.name} · ${name}` : name });
    }
  }
  return out;
}

/** 两个模型引用是否指向同一条（按 id 字符串比，与服务端 's…' 串 id 兼容） */
export function sameModelRef(
  a?: { providerId: string; modelId: string } | null,
  b?: { providerId: string; modelId: string } | null,
): boolean {
  return !!a && !!b
    && String(a.providerId) === String(b.providerId)
    && String(a.modelId) === String(b.modelId);
}

/**
 * 成员行内的模型绑定下拉。
 * 选项值用**下标**：渲染层不必知道引用串格式，选中下标直接对回 modelOptions 里的
 * {providerId, modelId} 对象交给主进程做唯一的 canonical 化。
 * 2026-10-28（用户裁决）：「默认模型」空选项取消——未绑定的成员显示模型列表第一项
 * （TeamsPage 的迁移 effect 会把它落成真实绑定：显示即事实，不再有「看着有值、实际跑默认」）。
 */
export default function MemberModelSelect({ member, options, t, busy, onChange }: {
  member: MemberLike; options: ModelOption[]; t: TFunc; busy: boolean;
  onChange: (model: { providerId: string; modelId: string } | null) => void;
}): ReactNode {
  const idx = options.findIndex((o) => sameModelRef(o, member.modelRef));
  // 已有绑定却在本机供应商列表里找不到（供应商/模型被删，或列表尚未加载）：
  // 显示为失效回显项——语义与运行期一致（该成员实际跑的是默认模型），且不可点选为「有效」。
  const stale = !!member.model && idx < 0;
  // 未绑定 ⇒ 显示第一项（迁移 effect 会把它落成真实绑定；选项列表为空时 value 无匹配，显示空）
  const value = idx >= 0 ? String(idx) : (stale ? 'stale' : (options.length ? '0' : ''));
  return (
    <select
      value={value}
      disabled={busy}
      title={t('teams.modelSelectLabel')}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'stale') return; // 失效项只是回显，改绑请选其余项
        const opt = options[Number(v)];
        if (opt) onChange({ providerId: opt.providerId, modelId: opt.modelId });
      }}
      className="h-7 max-w-[180px] px-2 rounded-lg bg-input text-caption text-text2"
    >
      {stale && <option value="stale">{member.modelLabel || t('teams.modelUnresolved')}</option>}
      {options.map((o, i) => (
        <option key={`${o.providerId}#${o.modelId}`} value={String(i)}>{o.label}</option>
      ))}
    </select>
  );
}
