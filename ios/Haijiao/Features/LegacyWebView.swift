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

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> Container {
        let c = Container()
        c.install(url: url, coordinator: context.coordinator, ruleLists: ruleLists)
        context.coordinator.appliedRuleCount = ruleLists.count
        return c
    }

    func updateUIViewController(_ vc: Container, context: Context) {
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            vc.web?.reload()
        }
        // 兜底：万一规则是 WebView 建好之后才编译出来的（UIKit 层不会重建 Container），
        // 这里把规则补挂进已有的 userContentController，否则网络层拦截等于没装。
        if context.coordinator.appliedRuleCount != ruleLists.count, let web = vc.web {
            context.coordinator.appliedRuleCount = ruleLists.count
            let ucc = web.configuration.userContentController
            ucc.removeAllContentRuleLists()
            for list in ruleLists { ucc.add(list) }
            web.reload()
        }
    }

    // MARK: - 容器

    final class Container: UIViewController {
        var web: WKWebView?

        func install(url: URL, coordinator: Coordinator, ruleLists: [WKContentRuleList]) {
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
            // 第 1 层：网络层规则（域名 + 广告路径 + 开屏 css-display-none，已拆成两份编译）
            for list in ruleLists {
                cfg.userContentController.add(list)
            }
            // 第 2 层：开屏杀手 —— documentStart，跑在站点脚本之前
            //   · 不认 class 名，靠 elementsFromPoint 几何判定「谁盖住视口」
            //   · 只在启动窗口内、用户未操作时动手，限次 12 层
            let splashScript = WKUserScript(
                source: AdBlock.launchJS,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true)
            if AdBlock.splashKillerEnabled {
                cfg.userContentController.addUserScript(splashScript)
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
            // 第 4 层：JS 常驻清理（低开销版）
            //   · 只扫 body 的直接子元素，不再遍历全站
            //   · 前 8 秒 300ms 一次，之后 2 秒
            //   · 每个节点只判定一次，避免反复强制布局
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

            w.load(URLRequest(url: url))
        }
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let parent: LegacyWebView
        var lastReloadToken: Int = 0
        /// 已经挂上去的规则条数，用来发现「规则后来才编译好」这种时序问题（-1 = 还不知道）
        var appliedRuleCount: Int = -1
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