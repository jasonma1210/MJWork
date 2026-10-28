// 生态中心「本地技能」区（统一入口重构 T3；设置页 skills tab 删除后唯一入口）
// 承接原 SettingsModal 技能 tab 两类内容：内置技能开关（BUILTIN_SKILLS）与
// 磁盘文件技能开关（~/.mjcode/skills，含「从文件夹导入」）。
// 2026-10-28：补「新建技能」表单直建（此前只有文件夹导入）——名称/描述/正文 →
// skills:create 落一个 SKILL.md 到 ~/.mjcode/skills/<名称>/，创建后**自动启用**（创建即可用）。
// 启用语义（D4）：勾选 = 加入 App 的 enabledSkills（localStorage mj_enabled_skills），
// 取消 = 仅摘除启用态、保留磁盘 SKILL.md——非破坏可逆，重启用零成本。
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import Switch from './ui/Switch';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { Input, TextArea } from './ui/Input';
import { confirm } from './feedback';
import { IconChevronDown, IconFilePlus, IconUpload } from './icons';
import { BUILTIN_SKILLS } from '../lib/builtinSkills';
import { skillKeyIn, normSkillKey } from '../lib/skillKey';

// T3-2：内置技能清单已提取至 lib/builtinSkills.ts 共享（+ 菜单同源渲染，2026-10-16）

interface DiskSkill { dir: string; name?: string; description?: string }

interface Props {
  enabledSkills: string[];
  onSkillsChange: (next: string[]) => void;
}

export default function LocalSkillsSection({ enabledSkills, onSkillsChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [diskSkills, setDiskSkills] = useState<DiskSkill[]>([]);
  const [msg, setMsg] = useState('');
  // 技能表单（2026-10-28：创建 / 编辑共用一窗；editDir=null ⇒ 新建）
  const [formOpen, setFormOpen] = useState(false);
  const [editDir, setEditDir] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', content: '' });
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');

  const refreshDisk = useCallback(async () => {
    try {
      const r = (await window.mjcode?.listSkills?.()) as { ok?: boolean; skills?: DiskSkill[] } | undefined;
      if (r?.ok) setDiskSkills(r.skills || []);
    } catch (e) { console.warn('[local-skills] listSkills failed:', e); }
  }, []);

  useEffect(() => { refreshDisk(); }, [refreshDisk]);

  function toggle(id: string, on: boolean) {
    onSkillsChange(on ? [...new Set([...enabledSkills, id])] : enabledSkills.filter((x) => x !== id));
  }

  async function importFromFolder() {
    setMsg('');
    try {
      const picked = (await window.mjcode?.pickDirectory?.()) as { ok?: boolean; path?: string } | undefined;
      if (!picked?.ok || !picked.path) return;
      const r = (await window.mjcode?.importSkillsFromDir?.({ dir: picked.path })) as
        { ok?: boolean; found?: number; installed?: string[]; failed?: string[]; error?: string } | undefined;
      if (r?.ok) {
        setMsg(t('localSkills.importSummary', { found: r.found || 0, installed: (r.installed || []).length })
          + ((r.failed || []).length ? t('localSkills.importFailedSuffix', { failed: r.failed!.length }) : ''));
        await refreshDisk();
      } else {
        setMsg(r?.error || t('localSkills.importFailed'));
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('localSkills.importFailed'));
    }
  }

  // 技能表单提交（创建 / 编辑同一入口）：目录名清洗/去重/路径安全都在主进程 skills.js 单点。
  // 创建成功**自动加入启用集**（创建即可用）；编辑保持启用态不变。
  async function submitSkill() {
    setFormErr('');
    const api = window.mjcode as unknown as {
      skillsCreate?: (p: unknown) => Promise<{ ok?: boolean; dir?: string; name?: string; error?: string } | undefined>;
      skillsUpdate?: (p: unknown) => Promise<{ ok?: boolean; dir?: string; name?: string; error?: string } | undefined>;
    } | undefined;
    try {
      if (!api || typeof api.skillsCreate !== 'function') { setFormErr(t('localSkills.bridgeMissing')); return; }
      setSaving(true);
      const payload = { name: form.name, description: form.description, content: form.content };
      const r = editDir
        ? await api.skillsUpdate?.({ dir: editDir, ...payload })
        : await api.skillsCreate(payload);
      if (r?.ok && r.dir) {
        setFormOpen(false);
        setForm({ name: '', description: '', content: '' });
        if (!editDir) onSkillsChange([...new Set([...enabledSkills, r.dir])]);
        await refreshDisk();
        setMsg(editDir
          ? t('localSkills.updated', { name: r.name || r.dir })
          : t('localSkills.created', { name: r.name || r.dir }));
        setEditDir(null);
      } else {
        setFormErr(r?.error || (editDir ? t('localSkills.updateFailed') : t('localSkills.createFailed')));
      }
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : t('localSkills.createFailed'));
    } finally {
      setSaving(false);
    }
  }

  // 打开编辑：先读正文（skills:read）再预填；读不到给明确提示，不静默开空表单
  async function openEdit(s: DiskSkill) {
    setFormErr('');
    setMsg('');
    try {
      const api = window.mjcode as unknown as {
        skillsRead?: (p: unknown) => Promise<{ ok?: boolean; content?: string; error?: string } | undefined>;
      } | undefined;
      if (typeof api?.skillsRead !== 'function') { setMsg(t('localSkills.bridgeMissing')); return; }
      const r = await api.skillsRead({ dir: s.dir });
      if (!r?.ok) { setMsg(r?.error || t('localSkills.readFailed')); return; }
      setForm({ name: s.name || s.dir, description: s.description || '', content: r.content || '' });
      setEditDir(s.dir);
      setFormOpen(true);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('localSkills.readFailed'));
    }
  }

  // 删除技能：二次确认 + 主进程路径安全校验（只删技能目录根下含 SKILL.md 的直接子目录）；
  // 成功后把该技能的启用项一并摘除（按 dir 与 name 两种键匹配，归一化后比较）。
  async function deleteSkillFlow(s: DiskSkill) {
    const ok = await confirm({
      title: t('localSkills.deleteTitle'),
      message: t('localSkills.deleteMessage', { name: s.name || s.dir }),
      danger: true,
      confirmLabel: t('localSkills.delete'),
    });
    if (!ok) return;
    setMsg('');
    try {
      const r = (await window.mjcode?.skillsDelete?.({ dir: s.dir })) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) {
        const keys = [normSkillKey(s.dir), normSkillKey(s.name || '')].filter(Boolean);
        onSkillsChange(enabledSkills.filter((x) => !keys.includes(normSkillKey(x))));
        await refreshDisk();
        setMsg(t('localSkills.deleted', { name: s.name || s.dir }));
      } else {
        setMsg(r?.error || t('localSkills.deleteFailed'));
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('localSkills.deleteFailed'));
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        <IconChevronDown size={13} className={`text-text2 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-sm font-medium">{t('localSkills.title')}</span>
        {/* 2026-10-16（用户实测反馈「15/13」计数溢出）：enabledSkills 混存生态目录 id，
            直接取 length 会大于本地技能总数。计数改为「本地技能（内置+磁盘）中已启用的数量」。 */}
        <span className="text-xs text-text2">{t('localSkills.count', {
          enabled: BUILTIN_SKILLS.filter((s) => skillKeyIn(s.id, enabledSkills)).length
            + diskSkills.filter((s) => skillKeyIn(s.dir, enabledSkills) || skillKeyIn(s.name, enabledSkills)).length,
          total: BUILTIN_SKILLS.length + diskSkills.length,
        })}</span>
        <span className="flex-1" />
        <span onClick={(e) => { e.stopPropagation(); setEditDir(null); setForm({ name: '', description: '', content: '' }); setFormOpen(true); }}
          className="h-7 inline-flex items-center gap-1 px-3 rounded-lg border border-border text-xs text-text2 hover:text-text cursor-pointer shrink-0">
          <IconFilePlus size={12} /> {t('localSkills.createButton')}
        </span>
        <span onClick={(e) => { e.stopPropagation(); importFromFolder(); }}
          className="h-7 inline-flex items-center gap-1 px-3 rounded-lg border border-border text-xs text-text2 hover:text-text cursor-pointer shrink-0">
          <IconUpload size={12} /> {t('localSkills.importFromFolder')}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          {msg && <p className="text-xs text-text2 mb-2">{msg}</p>}
          {/* 内置技能 */}
          <p className="text-xs text-text2 mt-1 mb-1">{t('localSkills.builtinTitle')}</p>
          {BUILTIN_SKILLS.map((s) => {
            const on = skillKeyIn(s.id, enabledSkills); // 归一化匹配（code_review/code-review 等价）
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{t(s.nameKey)}</div>
                  <div className="text-xs text-text2 truncate">{t(s.descKey)}</div>
                </div>
                <Switch checked={on} onChange={(next) => toggle(s.id, next)} label={t('settings.enableToggle', { name: t(s.nameKey) })} />
              </div>
            );
          })}
          {/* 文件技能（磁盘 SKILL.md） */}
          <p className="text-xs text-text2 mt-3 mb-1">{t('localSkills.fileTitle')}</p>
          {diskSkills.length === 0 ? (
            <p className="text-xs text-text2 py-2 leading-relaxed">
              {t('localSkills.noFiles')}
            </p>
          ) : diskSkills.map((s) => {
            const on = skillKeyIn(s.dir, enabledSkills) || skillKeyIn(s.name, enabledSkills); // 归一化匹配
            return (
              <div key={s.dir} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
                <div className="min-w-0">
                  <div className="text-xs font-mono truncate">{s.name || s.dir}</div>
                  {s.description && <div className="text-xs text-text2 truncate">{s.description}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="ghost" size="xs" onClick={() => openEdit(s)}>{t('localSkills.edit')}</Button>
                  <Button variant="danger-ghost" size="xs" onClick={() => deleteSkillFlow(s)}>{t('localSkills.delete')}</Button>
                  <Switch checked={on} onChange={(next) => toggle(s.dir, next)} label={t('settings.enableToggle', { name: s.name || s.dir })} />
                </div>
              </div>
            );
          }          )}
        </div>
      )}
      {/* 技能表单（创建 / 编辑共用）：表单类弹窗不吃遮罩点击（误触关掉会丢刚写的正文，与 EmployeeFormModal 同纪律） */}
      <Modal
        open={formOpen}
        onClose={() => { if (!saving) { setFormOpen(false); setEditDir(null); } }}
        size="md"
        title={editDir ? t('localSkills.editTitle') : t('localSkills.createTitle')}
        closeOnOverlay={false}
        footer={(
          <div className="flex items-center justify-end gap-2">
            {formErr && <span className="mr-auto text-xs text-danger truncate">{formErr}</span>}
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => { setFormOpen(false); setEditDir(null); }}>
              {t('localSkills.cancel')}
            </Button>
            <Button size="sm" loading={saving} disabled={!form.name.trim() || !form.content.trim()} onClick={submitSkill}>
              {editDir ? t('localSkills.save') : t('localSkills.createConfirm')}
            </Button>
          </div>
        )}
      >
        <div className="flex flex-col gap-3">
          <Input
            label={t('localSkills.fieldName')}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={t('localSkills.phName')}
            maxLength={48}
            autoFocus
          />
          <Input
            label={t('localSkills.fieldDesc')}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder={t('localSkills.phDesc')}
            maxLength={500}
          />
          <TextArea
            label={t('localSkills.fieldContent')}
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            placeholder={t('localSkills.phContent')}
            rows={10}
          />
        </div>
      </Modal>
    </div>
  );
}
