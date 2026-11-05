// 数据与备份（ST4-④，2026-11-05）
//
// 为什么单独一页：备份与导入在此之前**只有后端、没有入口**——`maybeDailyBackup` 只在启动时
// 被动跑一次，`stageImport` 全仓只有测试调用。用户既看不到「我的数据在哪、有没有备份」，
// 也没法在换机时把库带走。本页把这三件事补成可操作的面：
//   ① 立即备份（不等每日那一次）② 导出到你选的位置 ③ 从快照导入
//
// 三条产品纪律（都对应真实事故形态）：
//   · **路径只由系统对话框产生**：本组件从不拼路径、也不把路径回传给主进程，
//     所以「导到哪」这件事在渲染层是无法被伪造的。
//   · 导入是**覆盖性操作** ⇒ 两步确认 + 明确写出「重启后生效」。把「已暂存」说成「已导入」
//     是这里最容易犯的谎：真正换库发生在下次启动（连接不能对已打开的库换文件）。
//   · 结果分三态显示：成功 / 未校验（运行时无 node:sqlite，回读不了）/ 失败。
//     「未校验」不能折叠成「成功」，否则用户会以为备份一定可恢复。
import { useState } from 'react';
import { api } from '../../lib/api';
import { Section } from './shared';
import Button from '../ui/Button';
import { toast } from '../feedback';
import { useI18n } from '../../i18n';

type Pick = {
  token: string;
  name: string;
  userVersion: number;
  needsUpgrade: boolean;
  targetVersion: number;
};

function formatBytes(n: unknown): string {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

export default function DataTab() {
  const { t } = useI18n();
  const [busy, setBusy] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const [stagedName, setStagedName] = useState('');

  // fn 用 `() => any` 而不是 `() => Promise<any>`：api 是 JS 模块，其成员经 tsc 推断为
  // `unknown` 返回，写成 Promise 会要求每个调用点先做断言（等于把类型噪音沿调用链扩散）。
  const run = async (kind: string, fn: () => any, onOk: (r: any) => void) => {
    setBusy(kind);
    try {
      const r: any = await fn();
      if (!r || r.ok === false) {
        // 取消不是错误：用户点了「取消」不该看到红色报错。
        const cancelled = r && /CANCELLED/.test(String(r.code || ''));
        if (cancelled) return;
        toast({ message: (r && r.error) || t('settings.dataFailed') });
        return;
      }
      onOk(r);
    } catch (e: any) {
      // IPC 抛错（主进程 handler 崩了）也要给用户一句话，不能只在控制台里红。
      toast({ message: e?.message || t('settings.dataFailed') });
    } finally {
      setBusy('');
    }
  };

  const onBackup = () => run('backup', api.dbBackupCreate, (r) => {
    toast({
      message: r.verified
        ? t('settings.dataBackupOk', { name: r.name, size: formatBytes(r.bytes) })
        : t('settings.dataBackupUnverified', { name: r.name, size: formatBytes(r.bytes) }),
    });
  });

  const onExport = () => run('export', api.dbBackupExport, (r) => {
    toast({ message: t('settings.dataExportOk', { path: r.path, size: formatBytes(r.bytes) }) });
  });

  const onPick = () => run('pick', api.dbImportPick, (r) => {
    setPick({
      token: r.token,
      name: r.name,
      userVersion: r.userVersion,
      needsUpgrade: !!r.needsUpgrade,
      targetVersion: r.targetVersion,
    });
    setStagedName('');
  });

  const onCommit = () => {
    if (!pick) return;
    run('commit', () => api.dbImportCommit({ token: pick.token }), (r) => {
      setPick(null);
      setStagedName(r.name || '');
      toast({ message: t('settings.dataImportStaged', { name: r.name || '' }) });
    });
  };

  return (
    <div>
      <p className="text-xs text-text2 mb-6 leading-relaxed">{t('settings.dataIntro')}</p>

      <Section title={t('settings.dataBackupTitle')}>
        <div className="py-4 border-b border-border">
          <div className="text-sm font-medium">{t('settings.dataBackupNowTitle')}</div>
          <div className="text-xs text-text2 mt-1 leading-relaxed">{t('settings.dataBackupNowDesc')}</div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" onClick={onBackup} disabled={!!busy}>
              {busy === 'backup' ? t('settings.dataWorking') : t('settings.dataBackupNow')}
            </Button>
            <Button size="sm" variant="secondary" onClick={onExport} disabled={!!busy}>
              {busy === 'export' ? t('settings.dataWorking') : t('settings.dataBackupExport')}
            </Button>
          </div>
        </div>

        <div className="py-4">
          <div className="text-sm font-medium">{t('settings.dataImportTitle')}</div>
          <div className="text-xs text-text2 mt-1 leading-relaxed">{t('settings.dataImportDesc')}</div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" onClick={onPick} disabled={!!busy}>
              {busy === 'pick' ? t('settings.dataWorking') : t('settings.dataImportPick')}
            </Button>
            {pick && (
              <Button size="sm" variant="danger" onClick={onCommit} disabled={!!busy}>
                {busy === 'commit' ? t('settings.dataWorking') : t('settings.dataImportCommit')}
              </Button>
            )}
          </div>
          {pick && (
            <div className="mt-3 text-xs text-text2 leading-relaxed">
              <div>{t('settings.dataImportFile', { name: pick.name })}</div>
              <div>
                {t('settings.dataImportVersion', { version: String(pick.userVersion), target: String(pick.targetVersion) })}
                {pick.needsUpgrade ? ` · ${t('settings.dataImportUpgrade')}` : ''}
              </div>
              <div className="text-danger mt-1">{t('settings.dataImportWarn')}</div>
            </div>
          )}
          {stagedName && (
            <div className="mt-3 text-xs leading-relaxed">
              <div>{t('settings.dataImportStaged', { name: stagedName })}</div>
              <div className="text-text2 mt-1">{t('settings.dataImportRestart')}</div>
            </div>
          )}
        </div>
      </Section>

      <Section title={t('settings.dataRetentionTitle')}>
        <div className="py-4 text-xs text-text2 leading-relaxed">
          <div>{t('settings.dataRetentionDesc')}</div>
          <div className="mt-2">{t('settings.dataRetentionDetail')}</div>
        </div>
      </Section>
    </div>
  );
}
