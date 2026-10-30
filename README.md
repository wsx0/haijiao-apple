# 海角（haijiao.com）iOS 封装

纯 WKWebView 套壳，站点本身是 Vue SPA（DPlayer + hls.js），iOS 上视频回落原生 HLS。

## 结构

```
ios/Haijiao/          源文件（4 个 swift + Info.plist + AppIcon）
tools/                幂等的 Xcode 工程生成器
scripts/build-ipa.sh  未签名 ipa 构建
scripts/verify_adblock.js   去广告规则的本机回归（不需要 Mac）
scripts/fetch-site*.mjs     抓站点真实结构（借 CI 的海外 runner）
.github/workflows/    build-ipa.yml（出包）/ fetch-site.yml（抓页面做研究）
```

## 本地构建

```bash
python3 tools/gen_ios_xcodeproj.py --verify
./scripts/build-ipa.sh --unsigned
```

产物在 `build/Haijiao-$(VERSION)-unsigned.ipa`。

## 关键实现

| 功能 | 做法 |
|---|---|
| 视频 | `allowsInlineMediaPlayback = false` → 一播进系统全屏播放器 |
| 自动播放 | `mediaTypesRequiringUserActionForPlayback = []` |
| 登录态 | `WKWebsiteDataStore.default()`，Cookie 落盘 |
| 外链 | 非 `*.haijiao.com` 一律交给 Safari |
| 手势 | `allowsBackForwardNavigationGestures = true`，右滑返回 |
| 错误页 | 加载失败给可点重试的 HTML |

## 去广告（1.0.9 —— 规则全部来自实测）

**先说结论**：站点没有「全屏开屏广告图」。真正挡屏的是三个东西，2026-10-30 在 CI 上用
Playwright 渲染 + A/B/C 三组对比实拍确认：

| 挡屏物 | 容器 | 来源 |
|---|---|---|
| 顶部博彩横幅 | `.topbanmer`（内含 `.my-swipe.van-swipe` + `.crossbutton`） | `POST /api/banner/banner_list` → `pic.*.top/hjstore/system/banner/*.gif.txt` |
| 底部 PWA 引导条 | `.addbox` | 「添加海角社区到主屏幕」 |
| 开屏三连弹窗 | `.van-dialog.luodiconfirm` → `.van-dialog.luodisconfirm` | `this.$dialog.alert({...confirmButtonText:"我知道了", className:"luodiconfirm"})` |

四层，代码都在 `ios/Haijiao/Features/AdBlock.swift`：

| 层 | 机制 | 时机 |
|---|---|---|
| 1 | `WKContentRuleList`：block `/api/banner/banner_list`、`hjstore/system/banner/`、广告统计域；`css-display-none` 上面三个容器 | 请求发出前 / 首帧 |
| 2 | 注入 CSS（同一批选择器，带 ` i` 兜大小写） | 首帧 |
| 3 | `siteJS`：MutationObserver 盯 **body 直接子节点**的新增，`.topbanmer`/`.addbox` 立即摘、`.van-dialog.luodi*` 点确认再摘；另有 400ms × 40 次精确选择器兜底 | `atDocumentStart` |
| 4 | `js`：封 `window.open`、过滤广告 alert、清广告 iframe、每 1.5 秒兜底 | `atDocumentEnd` |

性能红线（这 App 曾因强制布局闪退过）：第 3 层只看新增节点，**不遍历全站、不量几何**，
MutationObserver 不开 subtree，20 秒后自动断开；几何杀手 `launchJS` 仍保留但默认关闭
（`AdBlock.splashKillerEnabled = false`），站点哪天真的加了全屏浮层再打开。

实测对比（390×844，iPhone UA）：

| 组 | 8 秒时 DOM | 横幅 | 弹窗 | PWA 条 |
|---|---|---|---|---|
| A 原样 | 9.1 MB | 有 | 有 | 有 |
| B 只拦接口 | 576 KB | 无 | 仍弹 | 无（被点掉） |
| C 完整方案 | 571 KB | 无 | 无 | 无 |

## 调试

Safari 连设备 → 开发 → 该设备 → 页面 Web Inspector：

```js
__hj_strip_log     // 第 3 层摘掉了什么（box:/dialog:/overlay:）
__hj_strip_now()   // 手动再扫一轮
__hj_scan()        // 仅当 splashKillerEnabled = true 时存在
```

## 改完先跑回归（不需要 Mac / 不需要浏览器）

```bash
node scripts/verify_adblock.js
```

它会按 Swift 多行字符串语义把 `launchJS` / `siteJS` / `js` 抽出来，检查「Swift 不认的反斜杠」
（这类错误会让 Xcode 直接编译失败），重建 WKContentRuleList 的 JSON 验一遍，再造一个最小 DOM
（带 MutationObserver / setInterval / 选择器匹配）跑真实脚本：

- `.topbanmer` / `.addbox` 插入即被摘；`.van-dialog.luodi*` 点确认后移除
- 站点**登录弹窗不许动**
- `#app` 内部的横幅靠 400ms 兜底清掉
- `window.open` 被封、广告 iframe 被清
- 几何杀手：拆全屏浮层、放过长文协议页/播放器/登录框、触碰后停手、限次

### 1.0.5 复查出来的三处修复

1. **兜底观察器挂错节点**：`siteJS` 注入在 documentStart，那时 `document.body` 还不存在，
   只能 observe `documentElement`；body 建出来后没有重挂，于是「body 直接子节点新增」根本不触发回调，
   主路径退化成 400ms 一次的全文档 querySelectorAll。→ DOMContentLoaded 时重新 observe body。
2. **可能点到「取消」**：确认键用 `querySelector('.van-dialog__confirm, button')`，
   vant 的 confirm 型 dialog 里取消键排在前面，`button` 兜底会先命中取消。
   → 先 `.van-dialog__confirm`，再 `.van-dialog__footer button:last-child`，最后才 `button`。
3. **首屏会闪一次横幅**：规则是异步编译的，WebView 建好时通常还没就绪，
   直接加载首页 = 首屏请求不带规则，等规则到位再 reload 才干净。
   → 规则没就绪时先停在本地黑底空白页，就绪后挂规则再导航首页（一次干净加载，不 reload）。

### 1.0.6：把「等一会才能操作」去掉了

1.0.5 为了「先挂规则再导航」，让 WebView 先停在本地黑底空白页等 `WKContentRuleList` 编译完 ——
那是自找的等待：**挡横幅/弹窗靠的是 documentStart 就注入的 CSS 与 siteJS，根本不依赖规则列表**。
1.0.6 改成：WebView 一建好立刻导航首页；规则晚几十毫秒到，补挂上就行，**不 reload**。

同时把两条后台开销压小（都在 WebContent 主线程上跑，首屏最敏感）：

| 项 | 1.0.5 | 1.0.6 |
|---|---|---|
| `siteJS` 兜底扫描 | 400ms × 40 次（16 秒） | 350ms × 20 次（约 7 秒） |
| `documentEnd` 兜底 tick | 1.5 秒一次（永久） | 2.5 秒一次 |
| `documentEnd` 的 MutationObserver | `subtree: true`（站点首屏 DOM 变动全打进回调） | 只看 body 直接子节点 |

### 1.0.7：修「点不动屏幕」

站点用 vant 的滚动锁：弹窗一开就给 `<body>` 加 `van-overflow-hidden`。
实测抓到的真实 DOM 就是 `<body class="van-overflow-hidden" style="overflow-y: auto;">`。
我们为了去广告直接把弹窗节点删掉，vant 自己的清理就被「外力移除节点」打断了 ——
这个 class 留在 body 上，整页滚不动，用户感知就是「等一会才能操作 / 点不动」。

1.0.7 在没有 `.van-dialog` / `.van-popup` 时强制解锁（顺手清掉失去配对兄弟的 `.van-overlay`）；
存在真弹窗（登录框之类）时一律不碰。回归里 S9/S10 两条用例专门盯这个。

### 1.0.8：又优化了一轮启动与交互

| 优化 | 为什么 |
|---|---|
| **整屏 `onTapGesture` 换成 WKWebView 上的 `UITapGestureRecognizer`**（`cancelsTouchesInView=false`） | 原来双击隐藏导航栏的手势挂在整屏 ZStack 上，SwiftUI 会**先判定点击再透传**，进页面第一下经常点不动。UIKit 识别器不吞单击。 |
| 规则 identifier 带内容摘要 + 先 `lookUpContentRuleList` | 编译过的规则 WebKit 会落盘，命中就零编译。二次启动规则能赶在首屏请求前就位，不再每次重编译 53 条。 |
| `estimatedProgress` 节流（变化 <0.02 不推） | 加载一个重页面会回调几十次，每次都触发 SwiftUI body 重算 + `updateUIViewController`，纯属浪费。 |
| `allowsLinkPreview = false` | 长按链接预览会在首屏额外发请求，还吃掉长按手势。 |
| `siteJS` 兜底 600ms×10（6 秒） | 首屏期间少扫一半；即时清理仍靠 `MutationObserver`（body 直接子节点）。 |
| `documentEnd` 脚本延后 600ms 启动 | documentEnd 正是站点渲染首屏的时刻，别在这时候抢 WebContent 主线程。 |

量化脚本 `scripts/perf-probe.mjs`：同一台 CI 机器上跑 A（原样）/ B（去广告），
输出 FCP、DCL、load、请求数、传输字节、longtask 次数与总时长、DOM 节点数。

### 1.0.9：修「往下划不动」

1.0.7 加了「弹窗清掉后解除 vant 滚动锁」，但判据写的是 `querySelector('.van-dialog, .van-popup')` ——
**只看存在性**。站点常在 DOM 里留一个 `display:none` 的 `.van-popup`（抽屉 / 筛选面板），
于是永远判定「有弹窗」，`body` 的 `van-overflow-hidden` 永远解不开 → 整页划不动。

1.0.9 改成看**可见性**：只有存在**有尺寸且可见**的 `.van-dialog` / `.van-popup` 时才保留锁；
否则清掉 `body` / `html` 上的 `van-overflow-hidden` 与内联 `overflow`。
平时零开销（没锁就直接返回）。回归 S11/S12 分别盯「隐藏 popup 要解锁」「可见弹窗保留锁」。

诊断脚本 `scripts/scroll-probe.mjs`：注入 App 同源的 `siteJS` 后，实测
`body/html` 的锁、真实滚动容器、`scrollTo` 是否生效、手动解锁后是否能滚。

### 1.0.11：修「等一会才能划动」

1.0.10 的解锁只在「body 真的被锁」时才跑，而**孤儿遮罩**（`.van-overlay`，全屏、`pointer-events: auto`）
是另一条独立路径：我们把 luodi 弹窗节点删掉后，vant 的遮罩会留在原地继续吃触摸，
直到站点自己把它收掉 —— 表现就是「等一会儿才能划」。

1.0.11：
- 新增 `sweepOverlays()`：每次扫描都把「相邻没有可见 `.van-dialog`/`.van-popup`」的
  `.van-overlay` / `.van-mask` 直接摘掉（不再绑在 `unlockBody` 的锁分支里）
- 遮罩/弹窗类节点一出现，120ms 后复查一次配对（兄弟节点这时才插完）
- 兜底间隔 600ms → **300ms**（15 次，约 4.5 秒），等待窗口砍半
- 回归补 S13（孤儿遮罩要摘）/ S14（有相邻可见弹窗要留）

### 1.0.12：逻辑审查修的五处

审查 1.0.11 的控制流时发现，同一件事有两套判定在互相打架：

| 位置 | 问题 | 修法 |
|---|---|---|
| `sweepOverlays` | 用「相邻兄弟」判断遮罩有没有配对弹窗；vant 的 overlay 与 dialog 未必相邻（可能被 wrapper 隔开）→ 会误删正常模态遮罩，背景能点穿 | 改**全局判定**：有可见弹窗容器就全部保留，没有就全部清 |
| `unlockBody` | 里面还留了一段更粗糙的 stray 遮罩清理（只看 next 兄弟、不看可见性），与 `sweepOverlays` 口径不一致 | 删掉，遮罩只由 `sweepOverlays` 管 |
| `onNode` | 上一个分支已 `return`，后面的 `van-overlay` 分支是**死代码** | 删掉，统一走 120ms 复查 |
| `clickConfirm` | 80ms 后顺手清遮罩 —— 此时站点链式弹的下一个 dialog 还没插入，会把它的遮罩提前清掉 | 只摘自己的节点 + 解锁，遮罩交给周期 sweep |
| `hasVisibleModal` | 只要 >8×8 就算模态；客服悬浮面板/筛选下拉这种小 `.van-popup` 会被当成模态 → 锁永远解不开 | `.van-dialog`/`.van-action-sheet`/`role=dialog` 才算；`.van-popup` 还要高度 ≥ 视口 15% |

另外清掉 `documentEnd` 里没人用的 `HOSTS`（规则早由 `WKContentRuleList` 承担），
并把它的兜底节奏从「永久 1.2 秒」改成递减（前 16 轮 1.2 秒、之后 5 秒）—— 每次都是全文档属性选择器，不必长期高频。

回归补 S15（弹窗不在相邻位置，遮罩仍要留）/ S16（小面板不该挡解锁）。