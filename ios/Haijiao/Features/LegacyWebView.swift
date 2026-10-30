//
//  LegacyWebView.swift
//  Haijiao
//
//  WebView 的包装层：把 UIViewController 里拿到的 webview 暴露给 RootView 的按钮用。
//  用 NotificationCenter 做命令通道，避免把 WKWebView 实例到处传。
//

import SwiftUI
import WebKit

struct LegacyWebView: UIViewControllerRepresentable {
    let url: URL
    @Binding var progress: Double
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var title: String
    let reloadToken: Int
    /// 广告拦截规则（网络层 + css-display-none）。空数组时只靠 CSS/JS 两层。
    let ruleLists: [WKContentRuleList]
    /// 规则是否已编译完（编译失败也算「完」——那时 ruleLists 是空数组）
    let rulesReady: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> Container {
        let c = Container()
        c.install(url: url, coordinator: context.coordinator,
                  ruleLists: ruleLists, rulesReady: rulesReady)
        context.coordinator.didAttachRules = rulesReady
        return c
    }

    func updateUIViewController(_ vc: Container, context: Context) {
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            vc.web?.reload()
        }
        // 规则是异步编译的，WebView 建好时通常还没就绪。
        // 编译完（或编译失败）才把规则挂上去，**并且挂完才去导航首页** ——
        // 顺序反了的话首屏请求会带着「无规则」发出去，横幅先闪一下、再 reload 才干净。
        if rulesReady, !context.coordinator.didAttachRules {
            context.coordinator.didAttachRules = true
            vc.applyRules(ruleLists)
        }
    }

    // MARK: - 容器

    final class Container: UIViewController {
        var web: WKWebView?
        private var homeURL: URL?
        private var started = false

        func install(url: URL, coordinator: Coordinator,
                     ruleLists: [WKContentRuleList], rulesReady: Bool) {
            homeURL = url
            let cfg = WKWebViewConfiguration()

            // 视频不内联，一播进系统全屏播放器
            cfg.allowsInlineMediaPlayback = false
            cfg.mediaTypesRequiringUserActionForPlayback = []
            cfg.allowsPictureInPictureMediaPlayback = true
            cfg.allowsAirPlayForMediaPlayback = true

            // 登录态留得住
            cfg.websiteDataStore = .default()

            cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
            cfg.defaultWebpagePreferences.allowsContentJavaScript = true

            // ── 去广告 ──────────────────────────────────────
            // 规则全部来自对 haijiao.com 的实测（CI 上 Playwright 渲染 + A/B/C 对比）：
            //   顶部博彩横幅 .topbanmer / 底部 PWA 条 .addbox / 开屏三连弹窗 .van-dialog.luodi*
            // 第 1 层：网络层规则（banner 数据源 + banner 图片 + 广告统计域 + css-display-none）
            for list in ruleLists {
                cfg.userContentController.add(list)
            }
            // 第 2 层（可选）：几何开屏杀手 —— 站点目前没有全屏浮层，默认关
            if AdBlock.splashKillerEnabled {
                cfg.userContentController.addUserScript(WKUserScript(
                    source: AdBlock.launchJS,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true))
            }
            // 第 3 层：CSS 立刻隐藏（纯样式，零 CPU 成本）
            let cssScript = WKUserScript(
                source: """
                (function(){
                  var s = document.createElement('style');
                  s.type = 'text/css';
                  s.textContent = `\(AdBlock.css)`;
                  (document.head || document.documentElement).appendChild(s);
                })();
                """,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false)
            cfg.userContentController.addUserScript(cssScript)
            // 第 4 层：精确清理 —— documentStart，盯新增节点删 .topbanmer/.addbox、点掉 luodi 弹窗
            //   · 只看 body 直接子节点的 childList，不开 subtree，不做几何测量
            //   · 20 秒后自动断开，另有 400ms × 40 次兜底
            cfg.userContentController.addUserScript(WKUserScript(
                source: AdBlock.siteJS,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
            // 第 5 层：收尾清理 —— documentEnd，封 window.open、清广告 iframe、每 1.5 秒兜底
            let jsScript = WKUserScript(
                source: AdBlock.js,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: false)
            cfg.userContentController.addUserScript(jsScript)

            let w = WKWebView(frame: .zero, configuration: cfg)
            w.navigationDelegate = coordinator
            w.uiDelegate = coordinator
            w.allowsBackForwardNavigationGestures = true
            w.scrollView.contentInsetAdjustmentBehavior = .never
            w.isOpaque = false
            w.backgroundColor = .black
            w.scrollView.backgroundColor = .black
            w.customUserAgent = HJWeb.mobileUA

            w.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(w)
            NSLayoutConstraint.activate([
                w.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                w.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                w.topAnchor.constraint(equalTo: view.topAnchor),
                w.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            self.web = w

            coordinator.attach(web: w, container: self)
            coordinator.observe(w)

            if rulesReady {
                startIfNeeded()
            } else {
                // 规则还没编译完：先停在本地黑底空白页。
                // 绝不能在「无规则」状态下加载首页 —— 那样横幅会先渲染一次，等规则到位再 reload，白闪一下。
                w.loadHTMLString(Self.blankHTML, baseURL: nil)
            }
        }

        /// 规则就绪后：挂进已有的 userContentController，然后开始导航（或 reload）
        func applyRules(_ lists: [WKContentRuleList]) {
            guard let w = web else { return }
            let ucc = w.configuration.userContentController
            ucc.removeAllContentRuleLists()
            for list in lists { ucc.add(list) }
            startIfNeeded()
        }

        /// 首次 = 导航到首页；之后 = reload（刷新按钮、规则补挂都用它）
        func startIfNeeded() {
            guard let w = web, let url = homeURL else { return }
            if started { w.reload() } else { started = true; w.load(URLRequest(url: url)) }
        }

        private static let blankHTML = """
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">\
        <style>html,body{margin:0;padding:0;background:#000}</style></head><body></body></html>
        """
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let parent: LegacyWebView
        var lastReloadToken: Int = 0
        /// 规则是否已经挂进 userContentController（只挂一次）
        var didAttachRules: Bool = false
        private var observations: [NSKeyValueObservation] = []
        private weak var web: WKWebView?
        private weak var container: UIViewController?
        private var tokens: [NSObjectProtocol] = []

        init(_ parent: LegacyWebView) {
            self.parent = parent
        }

        deinit {
            tokens.forEach { NotificationCenter.default.removeObserver($0) }
        }

        func attach(web: WKWebView, container: UIViewController) {
            self.web = web
            self.container = container

            let n = NotificationCenter.default
            tokens.append(n.addObserver(forName: .hjGoBack, object: nil, queue: .main) { [weak web] _ in
                if web?.canGoBack == true { web?.goBack() }
            })
            tokens.append(n.addObserver(forName: .hjGoForward, object: nil, queue: .main) { [weak web] _ in
                if web?.canGoForward == true { web?.goForward() }
            })
            tokens.append(n.addObserver(forName: .hjHome, object: nil, queue: .main) { [weak self] _ in
                guard let self, let web = self.web else { return }
                web.load(URLRequest(url: URL(string: "https://haijiao.com/home")!))
            })
        }

        func observe(_ web: WKWebView) {
            observations.append(web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in
                let p = w.estimatedProgress
                DispatchQueue.main.async { self?.parent.progress = p }
            })
            observations.append(web.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in
                let v = w.canGoBack
                DispatchQueue.main.async { self?.parent.canGoBack = v }
            })
            observations.append(web.observe(\.canGoForward, options: [.new]) { [weak self] w, _ in
                let v = w.canGoForward
                DispatchQueue.main.async { self?.parent.canGoForward = v }
            })
            observations.append(web.observe(\.title, options: [.new]) { [weak self] w, _ in
                let v = w.title ?? ""
                DispatchQueue.main.async { self?.parent.title = v }
            })
        }

        // 导航拦截
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let u = navigationAction.request.url else {
                decisionHandler(.allow); return
            }
            let scheme = u.scheme?.lowercased() ?? ""
            if !["http", "https", "about", "blob", "data", "file"].contains(scheme) {
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
                return
            }
            if let host = u.host, !HJWeb.isInternal(host) {
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // JS 弹窗
        func webView(_ webView: WKWebView,
                     runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            alert(message: message) { _ in completionHandler() }
        }

        func webView(_ webView: WKWebView,
                     runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            alert(message: message) { ok in completionHandler(ok) }
        }

        func webView(_ webView: WKWebView,
                     runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            a.addTextField { $0.text = defaultText }
            a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
            a.addAction(UIAlertAction(title: "确定", style: .default) { _ in
                completionHandler(a.textFields?.first?.text)
            })
            presenter()?.present(a, animated: true)
        }

        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
        }

        // 失败兜底
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(webView, error)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(webView, error)
        }

        private func fail(_ webView: WKWebView, _ error: Error) {
            let ns = error as NSError
            if ns.code == NSURLErrorCancelled { return }
            let html = """
            <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{background:#000;color:#bbb;font-family:-apple-system;padding:44px 26px;text-align:center}
            h2{color:#fff;font-size:17px;font-weight:600;margin-bottom:14px}
            p{font-size:13px;line-height:1.7;color:#888}
            button{margin-top:28px;background:#e0245e;color:#fff;border:0;padding:12px 36px;
            border-radius:22px;font-size:15px}</style></head>
            <body><h2>打不开</h2>
            <p>\(ns.localizedDescription)</p>
            <p style="font-size:11px;color:#555">code \(ns.code)</p>
            <button onclick="location.reload()">重试</button></body></html>
            """
            webView.loadHTMLString(html, baseURL: nil)
        }

        private func alert(message: String, done: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in done(false) })
            a.addAction(UIAlertAction(title: "确定", style: .default) { _ in done(true) })
            presenter()?.present(a, animated: true)
        }

        private func presenter() -> UIViewController? {
            if let c = container { return c }
            let key = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first { $0.isKeyWindow }
            var top = key?.rootViewController
            while let p = top?.presentedViewController { top = p }
            return top
        }
    }
}

// MARK: - 站点常量

enum HJWeb {
    static let home = URL(string: "https://haijiao.com/home")!

    static let mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    /// 站内域名，其余一律交给系统浏览器
    static func isInternal(_ host: String) -> Bool {
        let h = host.lowercased()
        return h == "haijiao.com" || h.hasSuffix(".haijiao.com")
    }
}