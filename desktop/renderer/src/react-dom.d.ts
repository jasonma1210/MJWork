// react-dom 类型补缺（环境声明，独立文件）：
//   本仓 @types 只装了 react 没装 react-dom，而 .tsx（DeskIntake 的弹出面板）用到 createPortal
//   —— PlusMenu 是 .jsx 不进 tsc 严格检查所以此前没暴露。
//   ⚠ 必须是**无顶层 import/export 的环境声明文件**：写在带 `export {}` 的模块文件里会退化成
//   「模块增强」，对无类型的包不生效（实测 TS7016 依旧）。
//   只声明实际用到的面，零新依赖。
declare module 'react-dom' {
  import type { ReactNode } from 'react';
  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
    key?: string,
  ): ReactNode;
}
