# 樱时 · Sakura Focus

日系治愈番茄钟（TanStack Start + React 19 + Tailwind v4 + Zustand）。

25 / 5 / 15 计时、任务列表、立绘状态、本地存储。无账号、无数据库。

## 给审查的人（iPad 点击失效）

用户在 **iPad Safari 的预览 iframe** 里所有按钮都点不动；电脑 Playwright 正常。

已尝试：

1. 去掉 `.app-frame { position:fixed; height:100svh }`，改为 `height:100%`
2. 去掉任务全屏 overlay，改为底部 input + ＋
3. 去掉 `.glass` 的 `backdrop-filter`（iOS 毛玻璃 + overflow 会吞点击）
4. 去掉所有 `active:scale-[0.96]`（按下缩放导致 touchend 打不中）
5. `src/lib/pomodoro/press.ts`：`touchend` + `click` + 280ms 全局锁
6. 圆环本身也是开始/暂停按钮
7. 立绘 / 花瓣 / 天空 `pointer-events: none`

请重点看：

- `src/lib/pomodoro/press.ts`
- `src/components/pomodoro/TaskList.tsx`
- `src/components/pomodoro/TimerPanel.tsx`
- `src/styles.css`（`.app-frame` / `.glass`）
- 是否还有层挡住点击、全局锁会不会吞连点、iOS iframe 更稳的方案

## 本地运行

```bash
npm install
npm run dev
```

开发服务 `http://localhost:8080/`。

## 主要文件

```
src/components/pomodoro/   UI
src/lib/pomodoro/          计时 store / 点击 press / 音频
src/styles.css             布局与 iPad 相关样式
public/assets/char-*.png   四张立绘
```
