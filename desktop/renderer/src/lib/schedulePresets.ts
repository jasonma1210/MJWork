// 定时计划的纯函数层（cron 解析 / 重复模板 / 下次运行 / 人话描述）
//
// 为什么要有这个模块（2026-10-24「发布任务」界面）：
//   定时任务的操作面现在出现在**两个**地方——助理里的「发布任务」（选「定时任务」时内联
//   重复/有效期/时间）与独立的定时任务页（完整表单）。两边必须算出**同一个 cron**，
//   否则「预览写的 09:00、实际跑在 10:00」这类漂移没有任何门禁能发现。
//   故把「重复模板 → cron」「cron → 下次运行」「cron → 人话」收敛到这一份。
//
// 纪律（与项目既有判据一致）：
//   · **纯函数、零 React 依赖** ⇒ Node 侧门禁可直接 import 做行为断言（不必起浏览器）；
//   · **不在模块顶层求值 i18n**：文案一律通过传入的 `t` 求值，切语言即时生效；
//   · 顶层常量只存 labelKey，不存翻译结果。

export type RepeatId = 'daily' | 'weekday' | 'weekly' | 'custom';

export interface RepeatDef {
  id: RepeatId;
  /** i18n key（渲染期经 t() 求值） */
  labelKey: string;
  /** 模板 → cron；`null` 表示由用户自填表达式 */
  toCron: ((hm: { h: number; m: number }) => string) | null;
}

/** 重复模板（顺序即下拉顺序；`custom` 恒在末尾） */
export const REPEATS: readonly RepeatDef[] = [
  { id: 'daily', labelKey: 'scheduled.repeatDaily', toCron: ({ h, m }) => `${m} ${h} * * *` },
  { id: 'weekday', labelKey: 'scheduled.repeatWeekday', toCron: ({ h, m }) => `${m} ${h} * * 1-5` },
  { id: 'weekly', labelKey: 'scheduled.repeatWeekly', toCron: ({ h, m }) => `${m} ${h} * * 1` },
  { id: 'custom', labelKey: 'scheduled.repeatCustom', toCron: null },
];

/** 有效期类型（下拉用） */
export type ValidType = 'forever' | 'until';
export const VALID_TYPES: readonly { id: ValidType; labelKey: string }[] = [
  { id: 'forever', labelKey: 'scheduled.validForever' },
  { id: 'until', labelKey: 'scheduled.validUntilType' },
];

/** 'HH:MM' → {h,m}；非法输入回落 09:00（与既有表单的兜底一致，不抛错） */
export function parseHm(time: string): { h: number; m: number } {
  const [h, m] = String(time || '09:00').split(':').map(Number);
  return { h: Number.isNaN(h) ? 9 : Math.min(23, Math.max(0, h)), m: Number.isNaN(m) ? 0 : Math.min(59, Math.max(0, m)) };
}

/**
 * 重复模板 + 时间 → cron（5 字段）。`custom` 时直接返回用户填的表达式（原样，不 trim 内部空白）。
 * @param repeat 重复模板 id
 * @param time 'HH:MM'
 * @param customRepeat 自定义表达式（仅 repeat==='custom' 时使用）
 */
export function cronOf(repeat: RepeatId, time: string, customRepeat = ''): string {
  const def = REPEATS.find((r) => r.id === repeat);
  if (!def || !def.toCron) return String(customRepeat || '').trim();
  return def.toCron(parseHm(time));
}

// ── cron 解析（5 字段：分 时 日 月 周），支持 * 数字 a-b 列表与 /步进 ──
export function cronFieldOk(f: string): boolean {
  return /^[\d*,\-/]+$/.test(f) && f.length > 0;
}

export function cronFieldMatches(field: string, v: number): boolean {
  return field.split(',').some((p) => {
    let base = p;
    let step = 1;
    if (p.includes('/')) {
      const parts = p.split('/');
      base = parts[0];
      step = Number(parts[1]) || 1;
    }
    if (base === '*' || base === '?') return v % step === 0;
    if (base.includes('-')) {
      const [a, b] = base.split('-').map(Number);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return v >= a && v <= b && (v - a) % step === 0;
    }
    const n = Number(base);
    return !Number.isNaN(n) && v === n;
  });
}

/**
 * 语法校验：返回错误文案或 null。
 * `t` 由调用方传入（组件传 i18n 的 t，测试传 t => key），从而保持本模块零 i18n 依赖。
 */
export function validateCron(expr: string, t: (key: string) => string): string | null {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return t('scheduled.cronFiveFields');
  if (!fields.every(cronFieldOk)) return t('scheduled.cronFieldChars');
  if (Number(fields[0]) > 59 || Number(fields[1]) > 23) return t('scheduled.cronMinuteHour');
  if (Number(fields[2]) > 31 || Number(fields[3]) > 12) return t('scheduled.cronDayMonth');
  if (Number(fields[4]) > 7) return t('scheduled.cronDow');
  return null;
}

/**
 * 下次运行时间：从 `from`（默认现在）的下一分钟起逐分钟扫描（上限 366 天）。
 * 备注：日/周同时受限时按 AND 处理（本产品模板不涉及 OR 场景）。
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (
      cronFieldMatches(fields[0], d.getMinutes())
      && cronFieldMatches(fields[1], d.getHours())
      && cronFieldMatches(fields[2], d.getDate())
      && cronFieldMatches(fields[3], d.getMonth() + 1)
      && cronFieldMatches(fields[4], d.getDay())
    ) return new Date(d);
  }
  return null;
}

/** 星期名 i18n key（下标与 JS getDay 对齐：0=周日） */
const DOW_KEYS = ['daySun', 'dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat'];

/**
 * cron → 人话（「每天 09:00」样式；无法归约时回退原表达式）。
 * @param t i18n 求值函数
 */
export function humanSchedule(expr: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [m, h, dom, mon, dow] = f;
  const time = /^\d+$/.test(h) && /^\d+$/.test(m)
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
  if (dom === '*' && mon === '*' && dow === '*') {
    return time ? t('scheduled.everyDayTime', { time }) : t('scheduled.everyDayExpr', { expr });
  }
  if (dom === '*' && mon === '*' && dow === '1-5') {
    return time ? t('scheduled.weekdaysTime', { time }) : t('scheduled.weekdaysExpr', { expr });
  }
  if (dom === '*' && mon === '*' && /^\d$/.test(dow)) {
    return time
      ? t('scheduled.weeklyDay', { day: t(`scheduled.${DOW_KEYS[Number(dow) % 7]}`), time })
      : expr;
  }
  return expr;
}

/** 本地时间 → 'YYYY/MM/DD HH:mm'（与既有排期卡片的展示口径一致） */
export function formatDateTime(d: Date | null): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 生成「执行计划」一行（发布任务界面与定时页共用同一句话，避免两处文案分叉）。
 * @returns 形如「每天 09:00 · 下次运行 2026/10/25 09:00」；cron 非法时返回错误文案
 */
export function planSummary(
  repeat: RepeatId,
  time: string,
  customRepeat: string,
  validType: ValidType,
  validUntil: string,
  t: ((key: string, vars?: Record<string, string | number>) => string),
  from: Date = new Date(),
): { ok: boolean; cron: string; text: string } {
  const cron = cronOf(repeat, time, customRepeat);
  const err = cron === '' ? t('scheduled.cronFiveFields') : validateCron(cron, (k) => t(k));
  if (err) return { ok: false, cron, text: err };
  const next = nextCronRun(cron, from);
  const plan = humanSchedule(cron, t);
  const nextText = next ? formatDateTime(next) : t('scheduled.noNextRun');
  // 有效期只影响「以后不再跑」，不改变 cron 本身；预览里显式带上，避免用户以为「长期有效」是默认被改
  const valid = validType === 'until' && validUntil
    ? t('scheduled.planUntil', { plan, date: validUntil, next: nextText })
    : t('scheduled.planForever', { plan, next: nextText });
  return { ok: true, cron, text: valid };
}
