//
//  TopicAPI.swift
//  Haijiao
//
//  原生列表的数据源。实测（2026-10-31，CI 抓包）：
//    GET https://haijiao.com/api/topic/hot/topics?page=N
//    头：mver / x-user-id: null / x-user-token: null / Referer / iPhone UA
//    **没有签名、没有加密密钥**，只是把 JSON 包了两层 base64：
//      { isEncrypted: true, data: "<base64>" }  → base64 解码 → 又是 base64 文本 → 再解码 → JSON
//

import Foundation

enum TopicAPI {

    static let base = "https://haijiao.com"

    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    /// 站点把 JSON 包了**多层** base64（实测三层：WlhsS2… → ZXlKd1… → eyJwYWdl… → {"page":…}）。
    /// 层数可能随接口/版本变化，所以不写死：一直解到「解出来是合法 JSON」为止，最多 6 层。
    static func decodePayload(_ payload: String) -> Data? {
        var current = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<6 {
            guard let bytes = Data(base64Encoded: current, options: .ignoreUnknownCharacters),
                  !bytes.isEmpty else {
                return nil
            }
            if (try? JSONSerialization.jsonObject(with: bytes)) != nil {
                return bytes                    // 已经是 JSON
            }
            guard let text = String(data: bytes, encoding: .utf8) else {
                return nil                      // 解出二进制了，说明不是编码层
            }
            let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if next.isEmpty || next == current { return nil }
            current = next
        }
        return nil
    }

    enum APIError: LocalizedError {
        case http(Int)
        case envelope(String)
        case payload(String)

        var errorDescription: String? {
            switch self {
            case .http(let code):
                return "服务器返回 \(code)"
            case .envelope(let head):
                return "响应不是预期信封：" + head
            case .payload(let head):
                return "数据格式异常：" + head
            }
        }
    }

    /// 把解出来的 JSON 手工映射成模型。任何字段类型异常都只是丢掉那个字段，
    /// 不会像 Codable 那样让整页报「格式不正确」。
    static func parsePage(_ data: Data) throws -> TopicPage {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw APIError.payload(String(data: data.prefix(80), encoding: .utf8) ?? "(非 UTF-8)")
        }
        let infoDict = root["page"] as? [String: Any]
        let info = infoDict.map {
            PageInfo(page: JSON.int($0["page"]),
                     limit: JSON.int($0["limit"]),
                     total: JSON.int($0["total"]))
        }
        let list = (root["results"] as? [[String: Any]]) ?? []
        return TopicPage(page: info, results: list.map { Topic(dict: $0) })
    }

    /// 直连：URLSession 打接口
    static func fetchTopicsDirect(page: Int, cookie: String?) async throws -> TopicPage {
        guard let url = URL(string: "\(base)/api/topic/hot/topics?page=\(page)") else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue("\(base)/home", forHTTPHeaderField: "Referer")
        req.setValue("211112203214", forHTTPHeaderField: "mver")
        req.setValue("null", forHTTPHeaderField: "x-user-id")
        req.setValue("null", forHTTPHeaderField: "x-user-token")
        if let c = cookie, !c.isEmpty {
            req.setValue(c, forHTTPHeaderField: "Cookie")
        }

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.http(http.statusCode)
        }
        guard let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw APIError.envelope(String(data: data.prefix(80), encoding: .utf8) ?? "(非 UTF-8)")
        }
        guard let payload = env["data"] as? String else {
            throw APIError.envelope("无 data 字段")
        }
        guard let json = decodePayload(payload) else {
            throw APIError.payload("两层 base64 解码失败")
        }
        return try parsePage(json)
    }

    /// 详情页（SPA 路由 post/details），点条目时交给内置 WebView 打开
    static func detailURL(topicId: Int) -> URL? {
        URL(string: "\(base)/post/details?topicId=\(topicId)")
    }

    /// 图片地址：站点全部图片都走 pic.*.top 且带 `.txt` 后缀（反拦截伪装）。
    /// 后缀不能去掉 —— 去掉会 404，服务器就认这个路径。
    static func imageURL(_ raw: String?) -> URL? {
        guard let s = raw, !s.isEmpty, s.hasPrefix("http") else { return nil }
        return URL(string: s)
    }

    /// 网页通道：在 WKWebView 里用 fetch 调同一接口（同源/同 UA/同 Cookie，绕过直连可能遇到的拦截页）
    /// 标 @MainActor：WebBridge 是主线程隔离的，跨隔离访问需要 await 或统一到主线程。
    @MainActor
    static func fetchTopicsViaWeb(page: Int) async throws -> TopicPage {
        let raw = try await WebBridge.shared.fetchRaw(path: "/api/topic/hot/topics?page=\(page)")
        guard let data = raw.data(using: .utf8) else {
            throw APIError.payload("响应不是 UTF-8")
        }
        guard let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw APIError.envelope(String(raw.prefix(100)))
        }
        guard let payload = env["data"] as? String, let json = decodePayload(payload) else {
            throw APIError.payload("data 字段解码失败：" + String(raw.prefix(80)))
        }
        return try parsePage(json)
    }

    /// 统一入口：先直连（快），失败自动切网页通道。
    /// 两条路的错误都会带上原始响应前缀，便于定位到底卡在哪一层。
    static func fetchTopics(page: Int) async throws -> TopicPage {
        // 先让隐藏 WebView 打开过首页：一来拿站点 Cookie，二来保证网页通道随时可用
        await WebBridge.shared.prepare()
        let cookie = await WebBridge.shared.cookieHeader()
        var directError: Error?
        do {
            return try await fetchTopicsDirect(page: page, cookie: cookie)
        } catch {
            directError = error
        }
        do {
            return try await fetchTopicsViaWeb(page: page)
        } catch {
            let a = (directError as? APIError)?.errorDescription ?? directError?.localizedDescription ?? "未知"
            let b = (error as? APIError)?.errorDescription ?? error.localizedDescription
            throw APIError.payload("直连：\(a) ｜ 网页通道：\(b)")
        }
    }
}

