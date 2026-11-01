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
import UIKit

/// 顶部导航项：真实站点板块（nodeId）+ 一个客户端「最新」排序
struct FeedTab: Identifiable, Hashable {
    let id: Int          // nodeId；0 表示客户端「最新」
    let name: String
}

/// 站点板块（/api/topic/nodes_by_ver/v2）
struct NodeInfo: Identifiable, Hashable {
    let id: Int
    let name: String
}

enum TopicAPI {

    static let base = "https://haijiao.com"

    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    /// 站点把 JSON 包了**多层** base64（实测三层：WlhsS2… → ZXlKd1… → eyJwYWdl… → {"page":…}）。
    /// 层数可能随接口/版本变化，所以不写死：一直解到「解出来是合法 JSON」为止，最多 6 层。
    static func decodePayload(_ payload: String) -> Data? {
        var current = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        // 登录等接口的 data 可能是「带换行/长度非 4 倍数」的 base64，
        // Data(base64Encoded:) 遇到这种会直接返回 nil，所以先规整再解。
        for _ in 0..<10 {
            var cleaned = current
                .replacingOccurrences(of: "\n", with: "")
                .replacingOccurrences(of: "\r", with: "")
                .replacingOccurrences(of: " ", with: "")
                .replacingOccurrences(of: "\t", with: "")
            // URL-safe base64 先转回来
            cleaned = cleaned
                .replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            // 补齐到 4 的倍数
            while cleaned.count % 4 != 0 { cleaned += "=" }
            guard let bytes = Data(base64Encoded: cleaned, options: .ignoreUnknownCharacters),
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
    static func fetchTopicsDirect(page: Int, cookie: String?, nodeId: Int = 0, keyword: String? = nil) async throws -> TopicPage {
        // 侦察结论（tabs-probe + nodes-probe）：
        // · 站点真正的频道是「板块」（137 个），接口 /api/topic/nodes_by_ver/v2?ver=0
        // · 按板块取帖子：/api/topic/hot/topics?page=N&nodeId=<id>（实测可用）
        // · 「最新」「精华」不是板块，是首页前端 Tab，没有独立数据源
        // · 搜索：/api/topic/search?keyword=
        let path: String
        if let kw = keyword?.trimmingCharacters(in: .whitespacesAndNewlines), !kw.isEmpty {
            let enc = kw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? kw
            path = "/api/topic/search?keyword=\(enc)&page=\(page)"
        } else if nodeId > 0 {
            // 真实接口（从站点 home.js 挖到）：/topic/node/topics?nodeId=&page=&type=1
            // 注意 /topic/hot/topics 会忽略 nodeId（实测所有 nodeId 返回同一批）。
            path = "/api/topic/node/topics?nodeId=\(nodeId)&page=\(page)&type=1"
        } else {
            path = "/api/topic/hot/topics?page=\(page)"
        }
        guard let url = URL(string: base + path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue("\(base)/home", forHTTPHeaderField: "Referer")
        req.setValue("211112203214", forHTTPHeaderField: "mver")
        req.setValue(authUid ?? "null", forHTTPHeaderField: "x-user-id")
        req.setValue(authToken ?? "null", forHTTPHeaderField: "x-user-token")
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

    // MARK: - 详情

    /// GET /api/topic/<id> —— 与列表同一套信封（三层 base64）。
    static func fetchDetail(topicId: Int) async throws -> TopicDetail {
        guard let url = URL(string: "\(base)/api/topic/\(topicId)") else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue("\(base)/home", forHTTPHeaderField: "Referer")
        req.setValue("211112203214", forHTTPHeaderField: "mver")
        req.setValue(authUid ?? "null", forHTTPHeaderField: "x-user-id")
        req.setValue(authToken ?? "null", forHTTPHeaderField: "x-user-token")

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.http(http.statusCode)
        }
        guard let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let payload = env["data"] as? String,
              let json = decodePayload(payload),
              let root = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else {
            throw APIError.payload("详情解析失败：" + (String(data: data.prefix(80), encoding: .utf8) ?? ""))
        }
        return TopicDetail(dict: root)
    }

    // MARK: - 图片

/// 图片请求并发闸门（同时最多 6 个）
@MainActor
final class ImageGate {
    static let shared = ImageGate()
    private var inFlight = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let limit = 10

    func acquire() async {
        if inFlight < limit { inFlight += 1; return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in waiters.append(c) }
        inFlight += 1
    }

    func release() {
        inFlight -= 1
        if let c = waiters.first { waiters.removeFirst(); c.resume() }
    }
}

    /// 取一张列表缩略图。
    /// 图片在独立域名（pic.*.top）上，同样有防盗链/风控：
    ///   ① URLSession + 站点 Cookie + Referer（快）
    ///   ② 失败就回退到页面内 fetch（base64），和网页版走同一条路（慢但一定能成）


    /// 拿图片：下载 .txt 原文 → 用站点那套打乱字母表的 base64 解 → 下采样 → UIImage。
    ///
    /// 解码（30KB 文本 → 字节 → base64 → UIImage）必须放到后台：
    /// 一屏 120 张图，全在主线程做会把滚动卡住。
    @MainActor
    static func fetchImage(_ url: URL, maxSide: CGFloat = 300) async -> UIImage? {
        // 不再用自建闸门：原来那个用 withCheckedContinuation 排队，
        // 而 SwiftUI 的 .task 在单元格滚出屏幕时会**取消**任务 ——
        // continuation 永远不会被 resume，inFlight 也就永远不归零，
        // 排队的图全部卡死。这就是「只加载一部分」的根因。
        // URLSession 自己就有每主机连接上限（约 6），限流交给它更安全。
        guard let raw = await fetchImageData(url) else {
            ImageStats.shared.record(failure: "下载失败 \(url.host ?? "?")")
            return nil
        }
        let side = max(maxSide, 120)
        let decoded = await Task.detached(priority: .utility) { () -> UIImage? in
            // 关键：传 Data 而不是 String —— 密文含非 UTF-8 字节，
            // 一旦经过 String(data:encoding:) 再取 .utf8，字节会膨胀错位。
            guard let full = SiteImage.image(from: raw) else { return nil }
            return full.preparingThumbnail(of: CGSize(width: side, height: side)) ?? full
        }.value
        if decoded == nil {
            let head = String(decoding: raw.prefix(20), as: UTF8.self)
                .replacingOccurrences(of: "\n", with: " ")
            ImageStats.shared.record(failure: "解码失败 n=\(raw.count) head=\(head)")
        }
        return decoded
    }

    /// 拿图片原始字节（不做任何编码转换）
    static func fetchImageData(_ url: URL) async -> Data? {
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("\(base)/home", forHTTPHeaderField: "Referer")
        req.setValue("image/avif,image/webp,image/apng,image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
        if let (data, resp) = try? await URLSession.shared.data(for: req) {
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                // 失败再走页面内 fetch
                if let s = try? await WebBridge.shared.fetchRaw(path: url.absoluteString), !s.isEmpty {
                    return Data(s.utf8)
                }
                return nil
            }
            return data
        }
        if let s = try? await WebBridge.shared.fetchRaw(path: url.absoluteString), !s.isEmpty {
            return Data(s.utf8)
        }
        return nil
    }

    /// 给诊断页用的文本版本（内部仍走 fetchImageData，不做编码中转）
    static func fetchImageText(_ url: URL) async -> String? {
        guard let d = await fetchImageData(url) else { return nil }
        return String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1)
    }

    /// 旧路径：逐个 Referer 试（留着兜底，正常不会走到）
    static func directImage(_ url: URL) async -> UIImage? {
        let referers: [String?] = ["\(base)/home", "\(base)/", nil]
        let cookie = await WebBridge.shared.cookieHeader()
        for referer in referers {
            var req = URLRequest(url: url)
            req.timeoutInterval = 12
            req.setValue(ua, forHTTPHeaderField: "User-Agent")
            req.setValue("image/avif,image/webp,image/apng,image/*,*/*;q=0.8", forHTTPHeaderField: "Accept")
            req.setValue("zh-CN,zh;q=0.9", forHTTPHeaderField: "Accept-Language")
            if let r = referer { req.setValue(r, forHTTPHeaderField: "Referer") }
            if let c = cookie, !c.isEmpty { req.setValue(c, forHTTPHeaderField: "Cookie") }
            guard let (data, resp) = try? await URLSession.shared.data(for: req) else { continue }
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 { continue }
            if let img = UIImage(data: data) { return img }
        }
        return nil
    }

    /// 详情页（SPA 路由 post/details），点条目时交给内置 WebView 打开
    // MARK: - 登录态

    /// 已登录的 uid / token（存 UserDefaults，未登录为 nil）
    static var authUid: String? {
        let v = UserDefaults.standard.string(forKey: "hj.uid")
        return (v?.isEmpty == false) ? v : nil
    }
    static var authToken: String? {
        let v = UserDefaults.standard.string(forKey: "hj.token")
        return (v?.isEmpty == false) ? v : nil
    }
    static var isLoggedIn: Bool { authToken != nil }

    /// 登录：POST /api/login/signin {username, password}
    /// 验证码实测非必需；响应里 token 的字段名不确定，这里做多字段兼容。
    static func login(username: String, password: String) async throws -> (uid: Int, token: String) {
        guard let url = URL(string: "\(base)/api/login/signin") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 25
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("\(base)/login", forHTTPHeaderField: "Referer")
        req.setValue(base, forHTTPHeaderField: "Origin")
        req.setValue("211112203214", forHTTPHeaderField: "mver")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "username": username.trimmingCharacters(in: .whitespacesAndNewlines),
            "password": password,
        ])

        let (data, _) = try await URLSession.shared.data(for: req)
        let raw = String(data: data, encoding: .utf8) ?? ""
        guard let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw APIError.envelope("登录响应非 JSON：" + String(raw.prefix(120)))
        }
        // 失败：{success:false, message:"..."}
        if let ok = env["success"] as? Bool, ok == false {
            throw APIError.envelope((env["message"] as? String) ?? "登录失败")
        }
        // 成功后 data 可能是加密的，也可能直接是对象
        var payload: [String: Any] = env
        if let s = env["data"] as? String, let plain = decodePayload(s),
           let obj = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] {
            payload = obj
        } else if let d = env["data"] as? [String: Any] {
            payload = d
        }

        // 掏 uid / token（多字段兼容）
        // 登录响应实测结构：
        // { "token":"ad3c…",                       ← 顶层
        //   "user": { "id":20326334, "nickname":"…" },   ← uid 嵌在 user 里
        //   "domain": …, "type": 3, … }
        // 所以先看顶层，再遍历一层嵌套对象。
        func find(_ keys: [String]) -> String? {
            func pick(_ dict: [String: Any]) -> String? {
                for k in keys {
                    if let v = dict[k] as? String, !v.isEmpty, v != "null" { return v }
                    if let v = dict[k] as? Int { return String(v) }
                }
                return nil
            }
            if let v = pick(payload) { return v }
            for (_, value) in payload {
                guard let nested = value as? [String: Any] else { continue }
                if let v = pick(nested) { return v }
            }
            return nil
        }
        let token = find(["token", "userToken", "user_token", "accessToken", "x-user-token"])
        let uidStr = find(["userId", "user_id", "id", "uid", "x-user-id"])
        guard let tk = token, let uidS = uidStr, let uid = Int(uidS) else {
            // 解析失败时把「解码后的 payload」也带出来，方便看真实字段名
            let payloadDesc: String
            if let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
               let s = String(data: d, encoding: .utf8) {
                payloadDesc = String(s.prefix(400))
            } else {
                payloadDesc = "(payload 不可序列化)"
            }
            let decodedNote: String
            if let s = env["data"] as? String {
                if let plain = decodePayload(s),
                   let txt = String(data: plain, encoding: .utf8) {
                    decodedNote = "解码后：" + String(txt.prefix(300))
                } else {
                    decodedNote = "解码失败，data 前 60 字符：" + String(s.prefix(60))
                }
            } else {
                decodedNote = "data 不是字符串（\(type(of: env["data"]))）"
            }
            throw APIError.envelope("登录成功但没解析出 token/uid。\n\(decodedNote)\npayload：\(payloadDesc)")
        }
        return (uid, tk)
    }

    /// 取视频播放地址：`GET /api/video/<attachmentId>`（实测未登录返回「请先登录」）
    /// 响应结构未知，从 JSON 里递归找形如 .m3u8 的字符串，兼容多种字段名。
    static func fetchVideoURL(attachmentId: Int) async throws -> URL? {
        guard isLoggedIn else { throw APIError.envelope("视频地址需要登录后才能获取") }
        guard let url = URL(string: "\(base)/api/video/\(attachmentId)") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue("\(base)/home", forHTTPHeaderField: "Referer")
        req.setValue("211112203214", forHTTPHeaderField: "mver")
        req.setValue(authUid ?? "null", forHTTPHeaderField: "x-user-id")
        req.setValue(authToken ?? "null", forHTTPHeaderField: "x-user-token")

        let (data, _) = try await URLSession.shared.data(for: req)
        let raw = String(data: data, encoding: .utf8) ?? ""
        guard let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw APIError.envelope("视频接口响应非 JSON：" + String(raw.prefix(100)))
        }
        if let ok = env["success"] as? Bool, ok == false {
            throw APIError.envelope((env["message"] as? String) ?? "视频接口失败")
        }
        var payload: Any = env
        if let s = env["data"] as? String, let plain = decodePayload(s),
           let obj = try? JSONSerialization.jsonObject(with: plain) {
            payload = obj
        } else if let d = env["data"] {
            payload = d
        }
        if let u = findM3U8(in: payload) { return u }
        // 没找到 m3u8 就把结构抛出来，便于定位
        let desc = String((try? JSONSerialization.data(withJSONObject: payload)).flatMap { String(data: $0, encoding: .utf8) }?.prefix(300) ?? "")
        throw APIError.envelope("视频接口没给出 m3u8，结构：" + desc)
    }

    /// 递归找 JSON 里第一个 .m3u8 地址
    private static func findM3U8(in any: Any, depth: Int = 0) -> URL? {
        if depth > 8 { return nil }
        if let s = any as? String {
            let clean = s.replacingOccurrences(of: "\\/", with: "/")
            if clean.contains(".m3u8"), let u = URL(string: clean) { return u }
            return nil
        }
        if let arr = any as? [Any] {
            for x in arr { if let u = findM3U8(in: x, depth: depth + 1) { return u } }
            return nil
        }
        if let d = any as? [String: Any] {
            // 优先看常见字段
            for k in ["url", "m3u8", "src", "videoUrl", "video_url", "playUrl", "play_url", "remoteUrl"] {
                if let v = d[k], let u = findM3U8(in: v, depth: depth + 1) { return u }
            }
            for (_, v) in d { if let u = findM3U8(in: v, depth: depth + 1) { return u } }
        }
        return nil
    }

    /// 作者主页（站点路由 /homepage/<userId>，见站点 JS 的 LAYOUT_PAGE_PREFIXES）
    static func homepageURL(userId: Int) -> URL? {
        URL(string: "\(base)/homepage/\(userId)")
    }

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
    /// 拉站点板块列表（137 个，取常用的前几个做顶部导航）
    static func fetchNodes() async throws -> [NodeInfo] {
        guard let url = URL(string: "\(base)/api/topic/nodes_by_ver/v2?ver=0") else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue("\(base)/home", forHTTPHeaderField: "Referer")
        req.setValue("211112203214", forHTTPHeaderField: "mver")
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let env = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let raw = env["data"] as? String,
              let plain = decodePayload(raw),
              let obj = try? JSONSerialization.jsonObject(with: plain) else {
            throw APIError.envelope("板块接口异常")
        }
        var out: [NodeInfo] = []
        func walk(_ any: Any) {
            if let arr = any as? [Any] { for x in arr { walk(x) }; return }
            guard let d = any as? [String: Any] else { return }
            if let id = JSON.int(d["nodeId"]), let name = JSON.string(d["name"]), !name.isEmpty {
                out.append(NodeInfo(id: id, name: name))
            }
            for (_, v) in d { if v is [Any] || v is [String: Any] { walk(v) } }
        }
        walk(obj)
        // 去重
        var seen = Set<Int>()
        return out.filter { seen.insert($0.id).inserted }
    }

    static func fetchTopics(page: Int, nodeId: Int = 0, keyword: String? = nil) async throws -> TopicPage {
        // 先让隐藏 WebView 打开过首页：一来拿站点 Cookie，二来保证网页通道随时可用
        await WebBridge.shared.prepare()
        let cookie = await WebBridge.shared.cookieHeader()
        var directError: Error?
        do {
            return try await fetchTopicsDirect(page: page, cookie: cookie, nodeId: nodeId, keyword: keyword)
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

