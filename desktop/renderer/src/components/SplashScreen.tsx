import { useEffect, useRef, useState } from 'react';
import logo from '../assets/logo.png';
import { useI18n } from '../i18n';

// 启动页（Splash）：冷启动的 2.4s「仪器自检」瞬间。
//
// 设计取舍：
// · 只讲三件事——品牌、版本、进度；不放功能卖点轮播（那是营销页，不是桌面工具）。
// · 进度线是**确定性动画**（时长等于展示时长），不是假的加载百分比；
//   文案也只说「恢复工作区 / 就绪」这种与真实启动动作对得上的话。
// · 任意点击/按键可跳过：老用户不该被品牌页拦 2.4 秒（reduced-motion 下缩短到 0.6s）。
// · 层级用 --z-splash（200），高于审批卡（130），保证覆盖一切。
type Props = {
  onDone: () => void;
  /** 展示时长（ms），默认 2400 */
  duration?: number;
};

export default function SplashScreen({ onDone, duration = 2400 }: Props) {
  const { t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState('');
  // 一次性收尾守卫：点击跳过与定时器可能同时到达，避免 onDone 被调两次
  const doneRef = useRef(false);
  // onDone 走 latest-ref：父组件传的是内联箭头，每次渲染都是新引用；
  // 若列入 effect 依赖，App 每次状态变化（数据加载、流式消息）都会重置计时器 → 启动页永不消失
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    // preload 桥无全局类型声明：这里用最小局部契约收口，避免 any 扩散
    type Bridge = { getAppVersion?: () => Promise<string> };
    const bridge = (window as unknown as { mjcode?: Bridge }).mjcode;
    bridge?.getAppVersion?.()
      .then((v) => { if (v) setVersion(String(v)); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const total = reduce ? 600 : duration;
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDoneRef.current();
    };
    const t1 = setTimeout(() => setReady(true), Math.max(200, total - 500));
    const t2 = setTimeout(() => setLeaving(true), total);
    const t3 = setTimeout(finish, total + 220);
    const skip = () => { setLeaving(true); setTimeout(finish, 160); };
    window.addEventListener('pointerdown', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, [duration]);

  return (
    <div
      className={`fixed inset-0 z-splash flex flex-col items-center justify-center bg-bg transition-opacity duration-200 ${leaving ? 'opacity-0' : 'opacity-100'}`}
    >
      <img src={logo} alt="" className="w-14 h-14 rounded-2xl object-cover shrink-0" draggable={false} />
      <div className="mt-4 text-xl font-semibold tracking-tight text-text">MJ Nexus</div>
      <div className="mt-1 text-caption text-text2">
        {version ? `v${version}` : ''}{version ? ' · ' : ''}{t('splash.tagline')}
      </div>

      {/* 进度线：宽度固定 160px，用 scaleX 生长（不触发布局），时长与展示时长同步 */}
      <div className="mt-6 w-40 h-px bg-border overflow-hidden" aria-hidden="true">
        <div
          className="h-full bg-accent origin-left"
          style={{ animation: `splash-progress ${Math.max(400, (duration || 2400) - 300)}ms var(--ease-standard) forwards` }}
        />
      </div>

      <div className="mt-3 text-caption text-text2" role="status">
        {ready ? t('splash.ready') : t('splash.loading')}
      </div>
    </div>
  );
}
