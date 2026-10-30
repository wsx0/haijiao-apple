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

## 去广告（1.0.6 —— 规则全部来自实测）

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