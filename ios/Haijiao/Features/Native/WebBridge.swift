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
    private var waiters: [CheckedContinuation<Void, Never>] = []

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

    /// 保证页面已加载完成（首次调用会真的去加载 /home）。
    /// 必须带超时：didFinish 可能永远不来（网络不通/被拦），否则这里会永远 await，
    /// 表现就是列表一直转圈、什么错都不报。
    func prepare(timeout: TimeInterval = 12) async {
        if ready { return }
        if web == nil { web = makeWebView() }
        if loading {
            await waitFinish(timeout: timeout)
            return
        }
        guard let w = web else { return }
        loading = true
        w.load(URLRequest(url: URL(string: "\(TopicAPI.base)/home")!))
        await waitFinish(timeout: timeout)
    }

    private func waitFinish(timeout: TimeInterval) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            waiters.append(c)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(false)      // 超时：resume 所有等待者，让上层拿到错误而不是干等
            }
        }
    }

    /// 页面把加密的 .txt 在自己 JS 里解成了 data:image/jpeg;base64,… 直接塞进 img.src。
    /// 与其逆那层变换，不如直接把它解好的结果收下来：按 attachment id 建表。
    /// 边滚边收，滚几次就覆盖前几十条的图。
    func collectImages(scrolls: Int = 6) async -> [String: String] {
        await prepare(timeout: 12)
        guard let w = web else { return [:] }
        var map: [String: String] = [:]
        let js = """
        (function(){
          var out = [];
          var imgs = document.querySelectorAll('img[data-id]');
          for (var i = 0; i < imgs.length; i++) {
            var s = imgs[i].src || '';
            if (s.indexOf('data:image') === 0 && s.length > 2000) {
              var k = s.indexOf(',');
              if (k > 0) out.push([imgs[i].getAttribute('data-id'), s.slice(k + 1)]);
            }
          }
          return JSON.stringify(out);
        })()
        """
        for _ in 0..<max(1, scrolls) {
            if let s = try? await w.evaluateJavaScript(js) as? String,
               let d = s.data(using: .utf8),
               let arr = (try? JSONSerialization.jsonObject(with: d)) as? [[Any]] {
                for pair in arr {
                    if pair.count == 2, let k = pair[0] as? String, let v = pair[1] as? String, !v.isEmpty {
                        map[k] = v
                    }
                }
            }
            _ = try? await w.evaluateJavaScript("window.scrollBy(0, 1800); true")
            try? await Task.sleep(nanoseconds: 1_200_000_000)
        }
        if !map.isEmpty {
            for (k, v) in map where images[k] == nil { images[k] = v }
        }
        return map
    }

    /// attachment id(String) → 已解码的图片 base64
    private(set) var images: [String: String] = [:]

    func cachedImage(_ id: Int?) -> String? {
        guard let id else { return nil }
        return images[String(id)]
    }

    /// 用页面内 fetch 取一张图片，返回**纯 base64**（不含 data: 前缀）。
    /// 图片域名（pic.*.top）也有防盗链/风控，URLSession 拿不到时就走这条路。
    func fetchBase64Image(_ urlString: String) async throws -> String {
        await prepare(timeout: 8)
        guard let w = web else { throw TopicAPI.APIError.envelope("WebView 不可用") }
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let js = """
        (function(){
          window.__hj_img = window.__hj_img || {};
          window.__hj_img['$TOKEN'] = '';
          fetch('$URL').then(function(r){ return r.blob(); })
            .then(function(b){
              var fr = new FileReader();
              fr.onload = function(){
                var s = String(fr.result);
                var i = s.indexOf(',');
                window.__hj_img['$TOKEN'] = '__OK__' + (i >= 0 ? s.slice(i + 1) : s);
              };
              fr.readAsDataURL(b);
            })
            .catch(function(e){ window.__hj_img['$TOKEN'] = '__E__' + (e && e.message ? e.message : String(e)); });
          return true;
        })()
        """
            .replacingOccurrences(of: "$TOKEN", with: token)
            .replacingOccurrences(of: "$URL", with: urlString)
        _ = try? await w.evaluateJavaScript(js)
        for _ in 0..<80 {                                  // 最多 8 秒
            try? await Task.sleep(nanoseconds: 100_000_000)
            let v = try? await w.evaluateJavaScript("(window.__hj_img && window.__hj_img['\(token)']) || ''")
            guard let s = v as? String, !s.isEmpty else { continue }
            if s.hasPrefix("__OK__") { return String(s.dropFirst(6)) }
            throw TopicAPI.APIError.envelope("图片 fetch 失败：" + String(s.prefix(60)))
        }
        throw TopicAPI.APIError.envelope("图片通道超时")
    }

    /// 把 WebView 已拿到的站点 Cookie 导出成 Cookie 头。
    /// 站点前面挂了 WAF（首次访问下发 __cf_bm 一类的 cookie），
    /// URLSession 与 WKWebView 不共享 cookie 池 —— 不带这串就直接被拦成 HTML。
    func cookieHeader() async -> String? {
        await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { list in
                let parts = list
                    .filter { $0.domain.contains("haijiao") || $0.domain.contains("hj") }
                    .map { "\($0.name)=\($0.value)" }
                c.resume(returning: parts.isEmpty ? nil : parts.joined(separator: "; "))
            }
        }
    }

    private func finish(_ ok: Bool) {
        loading = false
        if ok { ready = true }
        let list = waiters
        waiters = []
        list.forEach { $0.resume() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(false) }

    /// 在页面上下文里请求某个 API 路径，返回原始响应文本。
    /// 不依赖 evaluateJavaScript 对 Promise 的处理（真机上不可靠）：
    /// JS 只负责把结果写进 window.__hj_r[token]，原生轮询取。
    func fetchRaw(path: String) async throws -> String {
        await prepare()
        guard let w = web else { throw TopicAPI.APIError.envelope("WebView 不可用") }
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let js = """
        (function(){
          window.__hj_r = window.__hj_r || {};
          window.__hj_r['\(token)'] = '';
          fetch('\(path)', { headers: { 'accept': 'application/json, text/plain, */*' } })
            .then(function(r){ return r.text().then(function(t){ window.__hj_r['\(token)'] = '__S__' + r.status + '|' + t; }); })
            .catch(function(e){ window.__hj_r['\(token)'] = '__E__' + (e && e.message ? e.message : String(e)); });
          return true;
        })()
        """
        _ = try? await w.evaluateJavaScript(js)

        for _ in 0..<120 {                       // 最多等 12 秒
            try? await Task.sleep(nanoseconds: 100_000_000)
            let v = try? await w.evaluateJavaScript("(window.__hj_r && window.__hj_r['\(token)']) || ''")
            guard let s = v as? String, !s.isEmpty else { continue }
            if s.hasPrefix("__E__") {
                throw TopicAPI.APIError.envelope("页面内 fetch 失败：" + String(s.dropFirst(5).prefix(80)))
            }
            if s.hasPrefix("__S__"), let bar = s.firstIndex(of: "|") {
                let status = String(s[s.index(s.startIndex, offsetBy: 5)..<bar])
                let body = String(s[s.index(after: bar)...])
                if status != "200" {
                    throw TopicAPI.APIError.envelope("HTTP \(status)：" + String(body.prefix(100)))
                }
                return body
            }
            return s
        }
        throw TopicAPI.APIError.envelope("网页通道超时（12s 无响应）")
    }
}
