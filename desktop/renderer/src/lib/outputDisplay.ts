// 产出文件展示方式：设置页「默认显示 / 右侧面板」的档位必须真正改变行为
//
// 为什么单独立一个模块（与 lib/linkOpen.js 同一理由）：设置项若只在设置页里存个值、
// 没有任何代码读它，就是「假开关」。MessageStream 的本轮产出卡片在渲染时读这里，
// 档位语义集中在一处定义。
export type OutputDisplay = 'inline' | 'panel';

const KEY = 'mj_output_display';

/** 默认 inline（卡片直接铺在正文里）；panel = 自动打开右侧预览栏，正文只留一个计数 chip */
export function getOutputDisplay(): OutputDisplay {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'panel' ? 'panel' : 'inline';
  } catch (e) {
    console.warn('[outputDisplay] failed to read output-display preference:', e);
    return 'inline';
  }
}

export function setOutputDisplay(v: OutputDisplay): boolean {
  try {
    localStorage.setItem(KEY, v === 'panel' ? 'panel' : 'inline');
    return true;
  } catch (e) {
    console.warn('[outputDisplay] failed to save output-display preference:', e);
    return false;
  }
}
