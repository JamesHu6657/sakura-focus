# 樱时 · Sakura Focus — iOS 壳

把番茄钟网页版打包成 iOS App：`ios/web` 是独立的 Vite SPA 构建（绕过
TanStack Start / Nitro，纯前端 zustand + localStorage 本来就够用），
`ios/SakuraFocus` 是一个最小 WKWebView 壳，通过自定义 `sakura://` scheme
从 App bundle 里离线加载整个 `ios/Web` 目录 —— `/assets/...` 绝对路径、
ES module、localStorage 行为与线上站点一致。

## 构建

需要 macOS + Xcode + Node 20+ + Homebrew。

```bash
./ios/build-ipa.sh
```

产出 `ios/out/SakuraFocus.ipa`（**未签名**）。用 Sideloadly 或 AltStore
侧载安装；免费 Apple ID 可签，7 天后需重签。要上 TestFlight 需要付费
Apple Developer 账号 + 常规签名/archive 上传流程。

## 模拟器调试

```bash
cd ios && xcodegen generate && open SakuraFocus.xcodeproj
```

选任意 iPhone/iPad 模拟器 Run 即可。`ios/web/dist` 不存在时先跑
`npx vite build --config ios/web/vite.config.ts`，或让 build-ipa.sh 帮你做。

## 文件

```
ios/web/            SPA 入口（index.html / main.tsx / vite.config.ts）
ios/SakuraFocus/    Swift 源码 + Info.plist + 图标
ios/project.yml     XcodeGen 工程定义（SakuraFocus.xcodeproj 由它生成，不入库）
ios/Web/            构建产物 = ios/web/dist 拷贝（不入库）
ios/build-ipa.sh    一键：web 构建 → 图标 → xcodegen → xcodebuild → IPA
```
