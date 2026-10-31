import { useCallback, useEffect, useState } from 'react';
import PanelEmpty from './PanelEmpty';
import { IconPlug, IconRefresh } from './icons';
import { useI18n } from '../i18n';
import { androidView } from '../lib/androidView';

// 设备面板（2026-10-31）：把硬件五层模型的结论从「对话里的一坨 JSON」变成一屏能读的事实。
//
// 为什么需要它：L2–L5 的能力全在工具层——模型能调 device_probe / device_flash，人却只能
// 翻聊天记录看 JSON。而「人」在这个链路上恰恰是最该看的人：插上的到底是不是那块板子、
// 缺的是驱动还是执行器、这块能不能现在就烧——这些判断决定他要不要敲 sudo 装 kext。
//
// ── 只读（这是本面板最重要的约束，不是实现细节）──
// 数据只有两条：device:probe（USB/串口/桥接/通道/工具链）与 device:targets（可烧串口/UF2 卷）。
// 面板**不提供**任何写入动作：烧写、擦除、备份、抓日志都不在这里。理由不是"没时间做"，
// 而是那些动作必须经 device_flash 的 `plan → plan_digest → 审批卡 → flash`：
// digest 把「用户确认过的参数」钉到「实际执行的参数」，审批卡让用户在动手前看到目标。
// 在面板上放一个「烧写」按钮，等于从 UI 直连设备、把这两道闸绕成装饰。
// 人要看的是现状与下一步该做什么；真正动手应当回到对话里，让参数先以 plan 结果落地。
//
// ── 懒探测 ──
// 右栏所有面板都是常驻挂载（收起用 hidden，不卸载，见 RightPane 的保活注释），
// 所以不能一挂载就探测：那会在每次启动时替所有用户跑一遍 system_profiler / kmutil /
// pyserial 枚举（几秒的主进程 CPU），而他可能从不打开这个面板。
// 故由 `active` 控制：第一次切到本面板时才探，之后靠手动刷新。
//
// 分级色义与右栏其余面板一致：能跑=success、要人先处理=warn、纯说明=text2。

interface BoardInfo {
  name?: string;
  chip?: string;
  driver?: string;
  note?: string;
  kind?: string;
}

interface UsbDevice {
  name?: string;
  vid?: string;
  pid?: string;
  serial?: string;
  board?: BoardInfo | null;
}

interface ChannelTarget {
  vid?: string;
  pid?: string;
  name?: string;
  ports?: string[];
  channel?: string | null;
  label?: string;
  protocol?: string;
  confidence?: string;
  executor?: string | null;
  installed?: boolean | null;
  implemented?: boolean;
  runnable?: boolean;
  targetReady?: boolean;
  reason?: string;
  todo?: string[];
}

interface ProbeResult {
  ok?: boolean;
  error?: string;
  platform?: string;
  devices?: UsbDevice[];
  ports?: Array<{ port?: string; chip?: string; driver?: string }>;
  channels?: ChannelTarget[];
  // 三态（null=查不到 / 空数组=确实没有 / 有设备），判定与显示口径全在 lib/androidView。
  // 声明成 unknown 是刻意的：它来自 IPC，跨进程边界不假设后端守约。
  android?: unknown;
  notes?: string[];
  toolchain?: { esptool?: boolean; pyserial?: boolean };
}

interface TargetsResult {
  ok?: boolean;
  error?: string;
  ports?: string[];
  uf2Volumes?: string[];
  excludedPorts?: string[];
  notes?: string[];
}

// 通道徽标：判据顺序与 deviceChannels.resolveChannels 造 target 的顺序一致，
// 先判「现在就能跑」，再判四种「差一步」，最后才是「还没结论」——
// 反过来的话，一块能烧的板子会因为 confidence 是 probe-required 被显示成待办。
function channelBadge(c: ChannelTarget): { labelKey: string; tone: string } {
  if (c.runnable) return { labelKey: 'device.badgeRunnable', tone: 'text-success' };
  if (c.channel && !c.implemented) return { labelKey: 'device.badgeNotWired', tone: 'text-text2' };
  if (c.channel && c.installed === false) return { labelKey: 'device.badgeNoExecutor', tone: 'text-warn' };
  if (c.channel && !c.targetReady) return { labelKey: 'device.badgeNoPort', tone: 'text-warn' };
  if (c.confidence === 'probe-required') return { labelKey: 'device.badgeProbe', tone: 'text-warn' };
  return { labelKey: 'device.badgeNoChannel', tone: 'text-text2' };
}

// 目标的显示名：优先串口（用户能直接拿去用），其次 VID:PID（钉得住身份），最后产品名。
function targetName(c: ChannelTarget): string {
  const port = (c.ports || []).find((p) => p);
  if (port) return port;
  if (c.vid && c.pid) return `${c.vid}:${c.pid}`;
  return c.name || '';
}

// 最多展示的提示条数：notes 是「尽量说清现状」的产物，会随探测项增多而变多；
// 全量铺开会把真正的结论挤出屏幕。超出的部分不静默丢弃，改为一条计数提示。
const NOTES_LIMIT = 8;

export default function DevicePanel({ active = false }: { active?: boolean }) {
  const { t } = useI18n();
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [targets, setTargets] = useState<TargetsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const mj = window.mjcode;
    // 桥缺失（老构建 / 非 Electron 宿主）按「未探测」降级，不当错误：面板空态本身已说明该怎么做
    if (!mj?.deviceProbe) { setLoaded(true); return; }
    setBusy(true);
    try {
      const probeFn = mj.deviceProbe as () => Promise<ProbeResult | undefined>;
      const targetsFn = mj.deviceTargets as (() => Promise<TargetsResult | undefined>) | undefined;
      // 两条通道互不依赖：并行发，避免串成两倍等待（探测本身已是 6 条只读命令并发）
      const [p, tg] = await Promise.all([
        probeFn(),
        typeof targetsFn === 'function' ? targetsFn() : Promise.resolve(undefined),
      ]);
      setProbe(p ?? null);
      setTargets(tg ?? null);
    } catch (err) {
      // C-001：这里必须留痕。探测失败时面板会停在空态，若不记日志，
      // 「什么都没显示」与「真的没有设备」在事后完全无法区分。
      // 日志用英文：i18n-scan 把「代码里的裸中文」一律判红（界面文案必须走 key），
      // 而诊断日志不是界面文案——按仓库既有做法（TaskSummaryPanel 同款）用英文区分两类字符串。
      console.warn('[devicePanel] probe failed:', err);
      setProbe({ ok: false, error: String((err as Error)?.message || err) });
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!active || loaded) return;
    void refresh();
  }, [active, loaded, refresh]);

  const av = androidView(probe?.android);
  const devices = Array.isArray(probe?.devices) ? probe.devices : [];
  const channels = Array.isArray(probe?.channels) ? probe.channels : [];
  const uf2Volumes = Array.isArray(targets?.uf2Volumes) ? targets.uf2Volumes : [];
  const excludedPorts = Array.isArray(targets?.excludedPorts) ? targets.excludedPorts : [];
  // 提示合并两处来源：probe 的（USB/驱动/执行器）与 targets 的（串口/卷/磁盘）。
  // 去重后统一排序会打乱「先因后果」的叙述，故只做拼接与去重，顺序按探测本身的固定顺序。
  const notes = [...new Set([
    ...(Array.isArray(probe?.notes) ? probe.notes : []),
    ...(Array.isArray(targets?.notes) ? targets.notes : []),
  ])];

  const empty = loaded && !busy && devices.length === 0 && channels.length === 0 && uf2Volumes.length === 0
    // Android 设备也算「有东西」：手机在用户态时 USB 枚举可能没认出它（VID/PID 不在表里），
    // 若只按 devices/channels 判空，会出现「明明识别到手机，面板却说没检测到设备」。
    && av.kind !== 'device';
  const failed = probe?.ok === false;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-2 h-9 border-b border-border flex items-center gap-2 shrink-0">
        <IconPlug size={12} className="text-text2 shrink-0" />
        <span className="text-xs text-text2">{t('device.panelTitle')}</span>
        {!busy && devices.length > 0 && (
          <span className="text-caption text-text2">{t('device.deviceCount', { n: devices.length })}</span>
        )}
        <button
          onClick={() => { if (!busy) void refresh(); }}
          disabled={busy}
          className="ml-auto w-6 h-6 rounded-lg flex items-center justify-center text-text2 hover:text-text disabled:opacity-50"
          title={t('device.refreshTitle')}
          aria-label={t('device.refresh')}
        >
          <IconRefresh size={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {busy && !loaded && (
          <div className="text-xs text-text2 px-2 py-2">{t('device.loading')}</div>
        )}

        {failed && (
          <div className="mx-2 mt-2 rounded-lg border border-border bg-bg px-2 py-2">
            <div className="text-xs text-warn">{t('device.probeFailed')}</div>
            <div className="text-caption text-text2 break-all mt-1">{String(probe?.error || '')}</div>
          </div>
        )}

        {empty && !failed && (
          <PanelEmpty icon={IconPlug} title={t('device.emptyTitle')} hint={t('device.emptyHint')} />
        )}

        {/* 工具链：决定「能不能动手」的最前置条件，单独一行放在最上面——
            它缺失时下面所有通道结论都会显示成「未装执行器」，先看到这行才不会误解 */}
        {loaded && !failed && (
          <div className="flex items-center gap-2 px-2 pt-2 text-caption text-text2">
            <span className="shrink-0">{t('device.toolchain')}</span>
            <span className="truncate">
              {`esptool ${probe?.toolchain?.esptool ? t('device.installed') : t('device.missing')}`}
            </span>
            <span className="truncate">
              {`pyserial ${probe?.toolchain?.pyserial ? t('device.installed') : t('device.missing')}`}
            </span>
          </div>
        )}

        {targets?.ok === false && (
          <div className="mx-2 mt-2 rounded-lg border border-border bg-bg px-2 py-2">
            <div className="text-xs text-warn">{t('device.targetsFailed')}</div>
            <div className="text-caption text-text2 break-all mt-1">{String(targets?.error || '')}</div>
          </div>
        )}

        {channels.length > 0 && (
          <div className="p-2 space-y-1">
            <div className="text-caption text-text2 px-1">{t('device.sectionPorts')}</div>
            {channels.map((c, i) => {
              const badge = channelBadge(c);
              const name = targetName(c);
              return (
                <div key={`${name || 'ch'}-${i}`} className="rounded-lg border border-border bg-bg px-2 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs truncate flex-1 font-mono" title={name}>{name}</span>
                    <span className={`text-caption shrink-0 ${badge.tone}`}>{t(badge.labelKey)}</span>
                  </div>
                  {c.label && (
                    <div className="text-caption text-text2 mt-1 truncate" title={c.label}>
                      {t('device.channelLine', { channel: c.label, protocol: c.protocol || '' })}
                    </div>
                  )}
                  {c.reason && <div className="text-caption text-text2 mt-1 break-all">{c.reason}</div>}
                  {c.executor && (
                    <div className={`text-caption mt-1 ${c.installed === false ? 'text-warn' : 'text-text2'}`}>
                      {c.installed === null || c.installed === undefined
                        ? t('device.executorUnknown', { name: c.executor })
                        : c.installed
                          ? t('device.executorInstalled', { name: c.executor })
                          : t('device.executorMissing', { name: c.executor })}
                    </div>
                  )}
                  {(c.todo || []).map((td, j) => (
                    <div key={`todo-${j}`} className="text-caption text-warn mt-1 break-all">{td}</div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {uf2Volumes.length > 0 && (
          <div className="px-2 pb-2 space-y-1">
            <div className="text-caption text-text2 px-1">{t('device.sectionUf2')}</div>
            {uf2Volumes.map((v) => (
              <div key={v} className="rounded-lg border border-border bg-bg px-2 py-1 text-xs font-mono truncate" title={v}>{v}</div>
            ))}
          </div>
        )}

        {excludedPorts.length > 0 && (
          <div className="px-2 pb-2 text-caption text-text2 break-all">
            {t('device.excludedPorts', { list: excludedPorts.join(' / ') })}
          </div>
        )}

        {devices.length > 0 && (
          <div className="p-2 space-y-1">
            <div className="text-caption text-text2 px-1">{t('device.sectionUsb')}</div>
            {devices.map((d, i) => {
              const board = d.board || undefined;
              const driver = board?.driver;
              const needDriver = Boolean(driver && driver !== 'builtin' && driver !== 'unknown');
              return (
                <div key={`${d.vid}:${d.pid}-${i}`} className="rounded-lg border border-border bg-bg px-2 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs truncate flex-1" title={d.name}>{d.name || board?.name || ''}</span>
                    <span className="text-caption text-text2 shrink-0 font-mono">{`${d.vid}:${d.pid}`}</span>
                  </div>
                  <div className="text-caption text-text2 mt-1 truncate">{board?.name || ''}</div>
                  <div className={`text-caption mt-1 ${needDriver ? 'text-warn' : 'text-text2'}`}>
                    {needDriver
                      ? t('device.driverNeed', { driver: String(driver) })
                      : t('device.driverBuiltin')}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {av.kind === 'unavailable' && (
          // 查不到 ≠ 没有：adb 没装/未接线时如实说出来，否则用户会以为「手机没被识别」
          // 而跑去换线。这一行刻意比卡片轻（只是一行提示），因为它不构成结论。
          <div className="px-2 pb-2 text-caption text-text2 break-all leading-relaxed">
            {t('device.androidUnavailable')}
          </div>
        )}

        {av.kind === 'device' && (
          <div className="p-2 space-y-1">
            <div className="text-caption text-text2 px-1">{t('device.sectionAndroid')}</div>
            <div className="rounded-lg border border-border bg-bg px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs truncate flex-1" title={av.name}>{av.name}</span>
                {av.more > 0 && (
                  <span className="text-caption text-text2 shrink-0">
                    {t('device.androidMore', { n: String(av.more) })}
                  </span>
                )}
              </div>
              {av.meta && (
                <div className="text-caption text-text2 mt-1 truncate font-mono">{av.meta}</div>
              )}
              <div className={`text-caption mt-1 ${av.tone}`}>{av.stateLabel}</div>
              {av.hint && (
                <div className="text-caption text-text2 mt-1 break-all leading-relaxed">{av.hint}</div>
              )}
              {av.error && (
                <div className="text-caption text-warn mt-1 break-all leading-relaxed">{av.error}</div>
              )}
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="px-2 pb-3 space-y-1">
            <div className="text-caption text-text2 px-1">{t('device.sectionNotes')}</div>
            {notes.slice(0, NOTES_LIMIT).map((n, i) => (
              <div key={`note-${i}`} className="text-caption text-text2 break-all leading-relaxed">{n}</div>
            ))}
            {notes.length > NOTES_LIMIT && (
              <div className="text-caption text-text2 px-1">
                {t('device.notesMore', { n: notes.length - NOTES_LIMIT })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
