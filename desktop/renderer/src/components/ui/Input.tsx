// UI 原语：文本输入 / 多行文本（P1-9）
//
// 与 Button 同理，只收敛仓库里实际存在的两种输入形态：
//   ① 单行：`h-8/h-9 px-3 rounded-lg border border-border bg-input focus:border-accent`
//   ② 多行：同上 + resize-y，并可选「字符计数」（数字员工 system_prompt 有 12000 上限）
//
// 特性：
//   · label 自动 `htmlFor` 绑定（仓库既有表单大量是「标签与输入框各写一遍、没有关联」）
//   · error 走 aria-invalid + aria-describedby，错误文案进可访问描述
//   · 计数器超限变色（用 danger 语义色），不静默截断
// 配色全部 token 化，组件内零十六进制。
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

const FIELD_BASE = 'w-full rounded-lg border bg-input text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/30';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  error?: string;
  hint?: ReactNode;
  /** 输入框尾部固定后缀（如域名、单位） */
  suffix?: ReactNode;
  containerClassName?: string;
}

export function Input({
  label,
  error,
  hint,
  suffix,
  containerClassName = '',
  className = '',
  id,
  disabled = false,
  ...rest
}: InputProps) {
  const autoId = useId();
  const inputId = id || `input-${autoId}`;
  const errId = `${inputId}-err`;
  return (
    <div className={containerClassName}>
      {label && (
        <label htmlFor={inputId} className="block text-xs text-text2 mb-1">{label}</label>
      )}
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          className={[
            FIELD_BASE,
            'h-8 px-3 text-xs',
            error ? 'border-danger' : 'border-border',
            disabled ? 'opacity-50' : '',
            className,
          ].filter(Boolean).join(' ')}
          {...rest}
        />
        {suffix && <span className="text-xs text-text2 shrink-0">{suffix}</span>}
      </div>
      {hint && !error && <p className="text-caption text-text2 mt-1">{hint}</p>}
      {error && <p id={errId} className="text-caption text-danger mt-1">{error}</p>}
    </div>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: string;
  hint?: ReactNode;
  /** 显示「已用 / 上限」计数（有上限时才有意义） */
  showCount?: boolean;
  containerClassName?: string;
}

export function TextArea({
  label,
  error,
  hint,
  showCount = false,
  containerClassName = '',
  className = '',
  id,
  rows = 6,
  value,
  maxLength,
  disabled = false,
  ...rest
}: TextAreaProps) {
  const autoId = useId();
  const areaId = id || `textarea-${autoId}`;
  const errId = `${areaId}-err`;
  const used = typeof value === 'string' ? value.length : 0;
  const over = typeof maxLength === 'number' && used > maxLength;
  return (
    <div className={containerClassName}>
      {(label || (showCount && typeof maxLength === 'number')) && (
        <div className="flex items-center justify-between mb-1">
          {label && <label htmlFor={areaId} className="block text-xs text-text2">{label}</label>}
          {showCount && typeof maxLength === 'number' && (
            <span className={`text-caption tabular-nums ${over ? 'text-danger' : 'text-text2'}`}>
              {used} / {maxLength}
            </span>
          )}
        </div>
      )}
      <textarea
        id={areaId}
        rows={rows}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className={[
          FIELD_BASE,
          'px-3 py-2 text-xs leading-relaxed resize-y',
          error ? 'border-danger' : 'border-border',
          disabled ? 'opacity-50' : '',
          className,
        ].filter(Boolean).join(' ')}
        {...rest}
      />
      {hint && !error && <p className="text-caption text-text2 mt-1">{hint}</p>}
      {error && <p id={errId} className="text-caption text-danger mt-1">{error}</p>}
    </div>
  );
}

export default Input;
