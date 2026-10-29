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
