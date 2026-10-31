//
//  KittyClient.swift
//  Haijiao
//
//  kittymao.xyz 的解析接口（从 hj.user.js 1.2.3 逆出来，**不加密**，比 suban 简单）：
//
//    host:  https://www.kittymao.xyz/api
//    口令:  localStorage["kthjau"]（官网领取）
//
//    POST /api/hj/movieInfo?kthjau=<口令>&isPhone=<true|false>&t=<毫秒时间戳>
//    body: {"id": <attachmentId>, "line": "", "resource_id": <topicId>, "resource_type": "topic"}
//
//    校验口令：/api/hj/getPermission
//
//  它的原脚本干的事：发现详情页要请求 /api/attachment（预览），直接 abort，
//  然后拿上面这个接口的地址塞给播放器 —— 也就是说完整流在 kittymao 的服务器上。
//

import Foundation

enum KittyError: LocalizedError {
    case noPasscode
    case http(Int, String)
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .noPasscode: return "还没有填 kitty 口令"
        case .http(let c, let b): return "HTTP \(c)：\(b)"
        case .badResponse(let s): return "响应异常：\(s)"
        }
    }
}

enum KittyClient {

    static let host = "https://www.kittymao.xyz/api"

    /// 解析一个视频附件，返回可播地址
    static func decodeStream(topicId: Int, attachmentId: Int, passcode: String) async throws -> URL {
        let code = passcode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { throw KittyError.noPasscode }

        let ts = String(Int(Date().timeIntervalSince1970 * 1000))
        var comp = URLComponents(string: "\(host)/hj/movieInfo")
        comp?.queryItems = [
            URLQueryItem(name: "kthjau", value: code),
            URLQueryItem(name: "isPhone", value: "true"),
            URLQueryItem(name: "t", value: ts),
        ]
        guard let url = comp?.url else { throw KittyError.badResponse("URL 拼接失败") }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 25
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("https://haijiao.com/", forHTTPHeaderField: "Origin")
        req.setValue("https://haijiao.com/post/details", forHTTPHeaderField: "Referer")
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                     forHTTPHeaderField: "User-Agent")

        let body: [String: Any] = [
            "id": attachmentId,
            "line": "",
            "resource_id": topicId,
            "resource_type": "topic",
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        let raw = String(data: data, encoding: .utf8) ?? ""
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw KittyError.http(http.statusCode, String(raw.prefix(150)))
        }

        // 响应结构没有文档：把里面任何像 .m3u8 / 视频的地址都抓出来
        if let u = firstMediaURL(in: raw) { return u }
        throw KittyError.badResponse(String(raw.prefix(160)))
    }

    /// 校验口令是否有效
    static func checkPasscode(_ passcode: String) async -> Bool {
        let code = passcode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return false }
        guard var comp = URLComponents(string: "\(host)/hj/getPermission") else { return false }
        comp.queryItems = [URLQueryItem(name: "kthjau", value: code)]
        guard let url = comp.url else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        req.setValue("https://haijiao.com/", forHTTPHeaderField: "Origin")
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return false }
        let s = String(data: data, encoding: .utf8) ?? ""
        // 只要响应里出现明确的成功标志就算过；口径宽松一点，交给后续 movieInfo 判真伪
        return s.contains("\"code\":0") || s.contains("\"success\":true") || s.contains("\"ok\":true") || s.contains("true")
    }

    // MARK: - 从任意 JSON 里捞媒体地址

    private static func firstMediaURL(in raw: String) -> URL? {
        // 1) 直接是 JSON：优先找常见字段
        if let d = raw.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: d) {
            if let u = searchInJSON(obj) { return u }
        }
        // 2) 兜底：正则找 m3u8 / mp4
        for pat in [#"https?://[^"'\s\\]+\.m3u8[^"'\s\\]*"#, #"https?://[^"'\s\\]+\.mp4[^"'\s\\]*"#] {
            if let re = try? NSRegularExpression(pattern: pat),
               let m = re.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
               let r = Range(m.range, in: raw) {
                let s = String(raw[r]).replacingOccurrences(of: "\\/", with: "/")
                if let u = URL(string: s) { return u }
            }
        }
        return nil
    }

    private static func searchInJSON(_ obj: Any, depth: Int = 0) -> URL? {
        if depth > 8 { return nil }
        if let s = obj as? String {
            if s.contains(".m3u8") || s.contains(".mp4") {
                let clean = s.replacingOccurrences(of: "\\/", with: "/")
                return URL(string: clean)
            }
            return nil
        }
        if let arr = obj as? [Any] {
            for item in arr { if let u = searchInJSON(item, depth: depth + 1) { return u } }
            return nil
        }
        if let dict = obj as? [String: Any] {
            for key in ["url", "m3u8", "videoUrl", "video_url", "playUrl", "play_url", "src", "data"] {
                if let v = dict[key], let u = searchInJSON(v, depth: depth + 1) { return u }
            }
            for (_, v) in dict { if let u = searchInJSON(v, depth: depth + 1) { return u } }
        }
        return nil
    }
}
