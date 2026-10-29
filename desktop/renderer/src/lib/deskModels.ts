// 工作台模型下拉：把 App 的 providers 树摊平成「可选列表」，并把选中的 key 还原成 { provider, model }。
//
// 为什么单独成文件而不写在 App.jsx：
//   App.jsx 已 772 行（水位线 780，判据 >800），任何转换逻辑塞进去都会顶线；
//   而「摊平 → 选择 → 还原」是一次完整往返，放在一处才不容易两边口径漂移。
//
// key 口径：`<providerId>::<modelId>`。刻意用 `::` 而非 `/` 或 `:` ——
//   模型 id 里常见 `:`（ollama 的 `qwen:latest`）与 `/`（`meta-llama/Llama-3`），
//   用它们做分隔符会在 split 时切错。
//
// 为什么不用 ModelSelector 组件：那是带思考档位能力门控的 500 行组件，
//   而原型 desk 的接单区用的就是一个原生 <select>。这里只需要「选一个模型」。

export interface DeskModelOption {
  id: string;
  label: string;
}

/** 结构只取用得到的字段，避免把 App / modelsFile 的完整类型耦进来 */
export interface DeskProvider {
  id?: string;
  name?: string;
  models?: DeskModel[];
}

export interface DeskModel {
  model_id?: string;
  id?: string;
  name?: string;
  display_name?: string;
  /** 主进程/本地库的规范形状是驼峰（localStore 与 modelsFile 一律存 modelId/displayName），
   *  经 api.localProviders() 归一会转成蛇形。两种都认，否则一旦有调用点绕过归一会整列消失。 */
  modelId?: string;
  displayName?: string;
}

export interface DeskSelectedModel {
  provider?: DeskProvider;
  model?: DeskModel;
}

const pidOf = (p: DeskProvider | undefined | null): string => String(p?.id || p?.name || '');
const midOf = (m: DeskModel | undefined | null): string => String(m?.model_id || m?.modelId || m?.id || m?.name || '');
const nameOf = (m: DeskModel): string => String(m.display_name || m.displayName || midOf(m));
const keyOf = (pid: string, mid: string): string => `${pid}::${mid}`;

/** 摊平成下拉项。provider 或 model 缺标识的直接跳过（不渲染一个选了没反应的选项） */
export function deskModelOptions(providers: readonly DeskProvider[] | undefined | null): DeskModelOption[] {
  const out: DeskModelOption[] = [];
  for (const p of providers || []) {
    const pid = pidOf(p);
    if (!pid) continue;
    for (const m of p.models || []) {
      const mid = midOf(m);
      if (!mid) continue;
      out.push({ id: keyOf(pid, mid), label: `${String(p.name || pid)} · ${nameOf(m)}` });
    }
  }
  return out;
}

/** 当前选中模型 → 下拉 value；选不出来时返回空串（select 会显示第一项，但不会谎报选中） */
export function deskModelKey(selected: DeskSelectedModel | null | undefined): string {
  const pid = pidOf(selected?.provider);
  const mid = midOf(selected?.model);
  return pid && mid ? keyOf(pid, mid) : '';
}

/** 下拉 value → { provider, model }。App 的 chooseModel 需要这个形状，不是 id 字符串 */
export function findDeskModel(
  providers: readonly DeskProvider[] | undefined | null,
  key: string,
): { provider: DeskProvider; model: DeskModel } | null {
  const [pid, mid] = String(key || '').split('::');
  if (!pid || !mid) return null;
  for (const p of providers || []) {
    if (pidOf(p) !== pid) continue;
    const model = (p.models || []).find((m) => midOf(m) === mid);
    if (model) return { provider: p, model };
  }
  return null;
}
