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

    /// 层级 1：base64 → 若还是文本形式的 base64 再解一层 → JSON Data
    static func decodePayload(_ payload: String) -> Data? {
        guard let layer1 = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else {
            return nil
        }
        if (try? JSONSerialization.jsonObject(with: layer1)) != nil {
            return layer1
        }
        guard let text = String(data: layer1, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return Data(base64Encoded: trimmed, options: .ignoreUnknownCharacters)
    }

    static func fetchTopics(page: Int) async throws -> TopicPage {
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

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw URLError(.badServerResponse)
        }
        guard let env = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        guard let payload = env["data"] as? String, let json = decodePayload(payload) else {
            throw URLError(.cannotDecodeContentData)
        }
        return try JSONDecoder().decode(TopicPage.self, from: json)
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
}
