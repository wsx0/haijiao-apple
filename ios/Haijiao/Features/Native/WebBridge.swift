//
//  WebBridge.swift
//  Haijiao
//
//  为什么需要它：原生 URLSession 直接打站点接口时，服务器/中间层可能因为会话、UA、TLS 指纹、
//  Cookie 缺失而返回拦截页（HTML），把它当 JSON 解就会报「格式不正确」。
//  但同一个 URL 在 WKWebView 里是**能拿到数据的**（网页版一直正常）。
//
//  做法：一个 1×1 的隐藏 WKWebView 常驻，加载 /home，之后所有接口都在页面里用 fetch 调，
//  再把响应文本回传给原生解析。网络层完全复用 WebKit 的上下文，成功率最高。
//

import Foundation
import UIKit
import WebKit

@MainActor
final class WebBridge: NSObject, WKNavigationDelegate {

    static let shared = WebBridge()

    private var web: WKWebView?
    private var ready = false
    private var loading = false
    private var waiters: [CheckedContinuation<Bool, Never>] = []

    private func makeWebView() -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let w = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: cfg)
        w.customUserAgent = TopicAPI.ua
        w.navigationDelegate = self
        w.isUserInteractionEnabled = false
        w.alpha = 0.01
        w.isHidden = false          // 必须真的在视图层级里，否则 WebKit 会挂起页面里的 JS
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
           let win = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
            win.addSubview(w)
            win.sendSubviewToBack(w)
        }
        return w
    }

    /// 保证页面已加载完成（首次调用会真的去加载 /home）
    func prepare() async {
        if ready { return }
        if web == nil { web = makeWebView() }
        if loading {
            _ = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in waiters.append(c) }
            return
        }
        guard let w = web else { return }
        loading = true
        w.load(URLRequest(url: URL(string: "\(TopicAPI.base)/home")!))
        _ = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in waiters.append(c) }
    }

    private func finish(_ ok: Bool) {
        loading = false
        if ok { ready = true }
        let list = waiters
        waiters = []
        list.forEach { $0.resume(returning: ok) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(false) }

    /// 在页面上下文里请求某个 API 路径，返回原始响应文本
    func fetchRaw(path: String) async throws -> String {
        await prepare()
        guard let w = web else { throw TopicAPI.APIError.envelope("WebView 不可用") }
        let js = """
        (function(){
          return fetch('\(path)', { headers: { 'accept': 'application/json, text/plain, */*' } })
            .then(function(r){ return '__STATUS__' + r.status + '__BODY__' + r.text(); })
            .catch(function(e){ return '__ERR__' + (e && e.message ? e.message : e); });
        })()
        """
        // evaluateJavaScript 会自动等待 Promise 的 resolve
        let result = try await w.evaluateJavaScript(js)
        guard let s = result as? String else { throw TopicAPI.APIError.payload("JS 返回非字符串") }
        if s.hasPrefix("__ERR__") { throw TopicAPI.APIError.envelope("fetch 失败：" + String(s.dropFirst(7).prefix(60))) }
        if s.hasPrefix("__STATUS__"), let range = s.range(of: "__BODY__") {
            let status = String(s[s.index(s.startIndex, offsetBy: 10)..<range.lowerBound])
            let body = String(s[range.upperBound...])
            if status != "200" {
                throw TopicAPI.APIError.envelope("HTTP \(status)：" + String(body.prefix(80)))
            }
            return body
        }
        return s
    }
}
