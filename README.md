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
5. ~~`src/lib/pomodoro/press.ts`：`touchend` + `click` + 280ms 全局锁~~ → 重写：
   `pointerup`/`touchend`/`click` 三路都触发，按元素时间戳去重；touchend 不再
   `preventDefault`（保住 click 兜底）；150ms 元素级 + 200ms 全局幽灵窗口吞掉弹层
   卸载后 iOS 重定向的合成 click；手势起点跟踪 + 24px 位移容差，拖出/滚动释放不
   触发；`detail===0`（键盘/读屏/脚本）点击永远放行；document 级 bubble 清理
   pointer/touch 起点表防指针复用误触发。旧全局锁会把窗口内任何第二次点按连同它
   的 click 兜底一起吞掉，已废弃。
6. 圆环本身也是开始/暂停按钮
7. 立绘 / 花瓣 / 天空 `pointer-events: none`
8. `AppShell` 在 `document` 上挂 passive `touchstart`/`touchend` 空监听 —— iOS 对
   没有文档级触摸监听的跨域 iframe 会整页不派发触摸事件（WebKit 老 bug）。
9. `.app-frame` 强制 `translateZ(0)` 合成层（iOS iframe 命中测试失配 hedge）+
   全局 `touch-action: manipulation`；按钮 `user-select:none` +
   `-webkit-touch-callout:none`（iOS 长按选区/菜单会 touchcancel 掉这次点按）。
10. 任务输入框 IME 守卫：合成中 / `compositionend` 后 50ms 内的 Enter 只确认候选不
    提交（Chrome 先 compositionend 后 keydown 的顺序单靠 `isComposing` 守不住）；
    Enter 在 keydown 里直接提交并 `preventDefault`，不走隐式提交，避免合成 click
    撞上幽灵窗口。
11. 多标签页同步：storage 事件触发 rehydrate，merge 按字段收敛 —— logs/计数取并集
    max、任务按 updatedAt 合并 + tombstone 防复活、计时器 last-writer-wins（本地
    非空闲状态不被远端 idle 快照踩掉，已到期的本地 focus 先入库再让位）；收到的
    快照与本地持久化切片一致时跳过 rehydrate，杜绝 echo 写回环。

仍未排除的宿主侧嫌疑（客端改不到）：父页给 iframe 套 transform/scale 或透明罩层、
iframe 无 `allow`/`sandbox` 配置错误、iPad 端 JS 语法过新导致 hydration 未运行
（页面 SSR 后看着正常但零交互——真机用 Safari 远程调试控制台确认最直接）。

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
