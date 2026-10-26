// 设置页共享原语（自 SettingsModal.jsx 原样搬出，文案与 className 零改动）
// 拆分动机：SettingsModal 已超 800 行软档，ModelsTab/NetworkTab 抽到本目录后，
// 这些原语被三方共用，只能上提一层；视觉与结构保持与拆分前逐字一致。
import type { ChangeEvent, ReactNode } from 'react';
import { IconAlert } from '../icons';
import Switch from '../ui/Switch';

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-base font-semibold mb-3">{title}</h2>
      <div className="bg-surface border border-border rounded-2xl px-5">{children}</div>
    </div>
  );
}

export function OptionRow({ name, desc, selected, warn, onSelect }: {
  name: ReactNode;
  desc: ReactNode;
  selected?: boolean;
  warn?: boolean;
  onSelect: () => void | Promise<void>;
}) {
  return (
    <button onClick={onSelect}
      className="w-full text-left py-4 border-b border-border last:border-0 flex items-start gap-3 hover:bg-hover -mx-5 px-5">
      <span className={`mt-1 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${selected ? 'border-accent' : 'border-border'}`}>
        {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
      </span>
      <span className="flex-1">
        <span className="text-sm font-medium flex items-center gap-2">
          {name}
          {warn && <IconAlert size={14} className="text-danger" />}
        </span>
        <span className="block text-xs text-text2 mt-1 leading-relaxed">{desc}</span>
      </span>
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  // ST8：关闭态轨道由 bg-text2（灰字灰底难辨）改为 bg-hover + 边框 → 视觉与语义统一由
  // ui/Switch 承载（P1-9：role="switch" + aria-checked + 可访问名称 + 键盘切换）
  return <Switch checked={on} onChange={() => onChange()} label={label} />;
}

// P1-17（2026-10-26）：扩展 label / hint 为可选 ReactNode，与 ui/Input 形态对齐；
// 既有调用（仅 placeholder/value/onChange/type）不受影响。
export function Input({ placeholder, value, onChange, type = 'text', label, hint }: {
  placeholder?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  label?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      {label && <label className="block text-xs text-text2 mb-1">{label}</label>}
      <input placeholder={placeholder} value={value} onChange={onChange} type={type}
        className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm my-1 outline-none focus:border-accent" />
      {hint && <p className="text-caption text-text2 mt-1">{hint}</p>}
    </div>
  );
}
