# 海角（haijiao.com）iOS 封装

纯 WKWebView 套壳，站点本身是 Vue SPA（DPlayer + hls.js），iOS 上视频回落原生 HLS。

## 结构

```
ios/Haijiao/          源文件（3 个 swift + Info.plist + AppIcon）
tools/                幂等的 Xcode 工程生成器
scripts/build-ipa.sh  未签名 ipa 构建
.github/workflows/    自动出包
```

## 本地构建

```bash
python3 tools/gen_ios_xcodeproj.py --verify
./scripts/build-ipa.sh --unsigned
```

产物在 `build/Haijiao-1.0.0-unsigned.ipa`。

## 关键实现

| 功能 | 做法 |
|---|---|
| 视频 | `allowsInlineMediaPlayback = false` → 一播进系统全屏播放器 |
| 自动播放 | `mediaTypesRequiringUserActionForPlayback = []` |
| 登录态 | `WKWebsiteDataStore.default()`，Cookie 落盘 |
| 外链 | 非 `*.haijiao.com` 一律交给 Safari |
| 手势 | `allowsBackForwardNavigationGestures = true`，右滑返回 |
| 错误页 | 加载失败给可点重试的 HTML |

## 去开屏广告（1.0.2）

四层，全部在 `ios/Haijiao/Features/AdBlock.swift`：

| 层 | 机制 | 生效时机 |
|---|---|---|
| 1 | `WKContentRuleList`：广告域 + 广告路径（`/ad/`、`/kaiping`、`/upload/ad`…）+ `css-display-none` 开屏选择器 | 请求发出前 / 首帧 |
| 2 | 启动期开屏杀手：`document.elementsFromPoint` 在视口 6 个点取样，往上找「铺满视口且 fixed/absolute/高 z-index」的层，先点跳过再整层移除 | `atDocumentStart`，站点脚本之前 |
| 3 | 注入 CSS：开屏 / 广告位容器整块 `display:none` | `atDocumentStart` |
| 4 | 常驻清理：定时拆动态弹窗、横幅、广告 iframe，封 `window.open`，点掉「我知道了」 | `atDocumentEnd` |

第 2 层是这次新增的核心：**不依赖 class 名**（站点改个名就废），只看几何
——谁盖住视口就是谁。护栏：只在启动 20 秒内、用户还没碰屏幕时动手，最多拆 12 层，
碰到 `input/textarea/select/video` 或名字含 login/pay/player 的层一律放过。

> 1.0.2 还要修一个时序坑：`UIViewControllerRepresentable.makeUIViewController` 只在视图首次
> 出现时调一次，旧版在 `.task` 里异步编译规则 → WebView 早已建好，规则一条都没挂上，
> **网络层拦截和 css-display-none 全程空转**。现在规则编译完才创建 WebView，
> `updateUIViewController` 里再兜一层（规则数变化就补挂 + reload）。


调试：Safari 连上设备 → Web Inspector → 控制台执行 `__hj_scan()` 手动再扫一轮，
`__hj_splash_kills` 是本次启动被拆掉的层（id/class 片段）。

改完 JS 别急着推，先在本机跑回归（不需要 Mac / 不需要浏览器）：

```bash
node scripts/verify_adblock.js
```

它会按 Swift 多行字符串语义把 `launchJS` / `js` 抽出来，检查「Swift 不认的反斜杠」
（这类错误会让 Xcode 直接编译失败），再验 WKContentRuleList 的 JSON、造一个最小 DOM
跑开屏杀手：杀开屏 / 不误伤登录框与协议页 / 用户触碰后停手 / 20 秒窗口 / 限次 12 层。


