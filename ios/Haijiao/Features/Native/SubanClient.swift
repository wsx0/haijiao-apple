//
//  SubanClient.swift
//  Haijiao
//
//  suban.vip 的解析接口客户端（从它的 Userscript 1.7.8 逆出来的协议）：
//
//    POST https://api.suban.vip/api/business/decode
//    headers:
//      X-Client: LITE
//      X-Ts:  <毫秒时间戳>
//      X-Nc:  <8 字节随机 hex>
//      X-Sig: sha256Hex(X-Ts + X-Nc + urlPath + rawKey)
//      Content-Type: text/plain
//      Authorization: Bearer <token>   （没登录就不带）
//    body: base64( iv[12] + AES-GCM(JSON) )
//
//    rawKey = sha256Hex( (token ?? "anon") + "sb_lt_x7k2m9p4q8r1w5v3n6j0f" + "suban.vip" )
//    urlPath = "/api/business/decode"（不含域名）
//
//  注意：这是第三方商业服务，"试用额度用完"后会要求订阅。
//

import CryptoKit
import Foundation

enum SubanError: LocalizedError {
    case crypto
    case http(Int, String)
    case quota
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .crypto: return "本地加密出错"
        case .http(let c, let body): return "HTTP \(c)：\(body)"
        case .quota: return "suban 试用额度已用完，需要订阅"
        case .badResponse(let s): return "响应异常：\(s)"
        }
    }
}

enum SubanClient {

    static let base = "https://api.suban.vip"
    static let salt = "sb_lt_x7k2m9p4q8r1w5v3n6j0f"
    static let anchor = "suban.vip"

    // MARK: - 基础密码学

    private static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// 32 字节会话密钥（hex 字符串，与 JS 一致）
    static func rawKey(token: String?) -> String {
        sha256Hex((token ?? "anon") + salt + anchor)
    }

    private static func hexToData(_ hex: String) -> Data {
        var d = Data()
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            if let b = UInt8(hex[i..<j], radix: 16) { d.append(b) }
            i = j
        }
        return d
    }

    private static func randomHex(_ bytes: Int) -> String {
        var buf = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &buf)
        return buf.map { String(format: "%02x", $0) }.joined()
    }

    /// base64( iv[12] + AES-GCM ciphertext + tag )
    static func seal(_ plaintext: String, keyHex: String) throws -> String {
        let key = SymmetricKey(data: hexToData(keyHex))
        let nonce = AES.GCM.Nonce()
        let box = try AES.GCM.seal(Data(plaintext.utf8), using: key, nonce: nonce)
        var out = Data(nonce)
        out.append(box.ciphertext)
        out.append(box.tag)
        return out.base64EncodedString()
    }

    static func open(_ base64: String, keyHex: String) throws -> String {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), data.count > 12 + 16 else {
            throw SubanError.crypto
        }
        let key = SymmetricKey(data: hexToData(keyHex))
        let nonceData = data.prefix(12)
        let rest = data.dropFirst(12)
        let cipher = rest.dropLast(16)
        let tag = rest.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonceData),
                                        ciphertext: cipher,
                                        tag: tag)
        let plain = try AES.GCM.open(box, using: key)
        guard let s = String(data: plain, encoding: .utf8) else { throw SubanError.crypto }
        return s
    }

    // MARK: - 业务接口

    /// 解析一个附件，返回可播放的 m3u8 地址
    static func decodeStream(topicId: Int, attachmentId: Int, token: String?) async throws -> URL {
        let payload: [String: Any] = [
            "topicId": topicId,
            "attachmentId": attachmentId,
            "resourceKey": "topic:\(topicId):attachment:\(attachmentId)",
        ]
        let json = try JSONSerialization.data(withJSONObject: payload)
        let text = String(data: json, encoding: .utf8) ?? "{}"
        let body = try await post("/api/business/decode", plaintext: text, token: token)

        // 响应形如 { "data": { "url": "https://….m3u8" } }，也可能直接给 m3u8 文本
        if let d = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            if let data = obj["data"] as? [String: Any], let s = data["url"] as? String, let u = URL(string: s) {
                return u
            }
            if let s = obj["url"] as? String, let u = URL(string: s) { return u }
        }
        if body.hasPrefix("#EXTM3U") {
            // 直接把播放列表写进临时文件，交给 AVPlayer
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("suban-\(topicId)-\(attachmentId).m3u8")
            try body.write(to: url, atomically: true, encoding: .utf8)
            return url
        }
        throw SubanError.badResponse(String(body.prefix(120)))
    }

    private static func post(_ path: String, plaintext: String, token: String?) async throws -> String {
        let key = rawKey(token: token)
        let enc = try seal(plaintext, keyHex: key)
        let ts = String(Int(Date().timeIntervalSince1970 * 1000))
        let nc = randomHex(8)
        let sig = sha256Hex(ts + nc + path + key)

        guard let url = URL(string: base + path) else { throw SubanError.badResponse("URL 拼接失败") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 25
        req.httpBody = enc.data(using: .utf8)
        req.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        req.setValue("no-cache", forHTTPHeaderField: "Pragma")
        req.setValue("LITE", forHTTPHeaderField: "X-Client")
        req.setValue(ts, forHTTPHeaderField: "X-Ts")
        req.setValue(nc, forHTTPHeaderField: "X-Nc")
        req.setValue(sig, forHTTPHeaderField: "X-Sig")
        req.setValue("https://haijiao.com/", forHTTPHeaderField: "Origin")
        if let t = token, !t.isEmpty, t != "anon" {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }

        let (data, resp) = try await URLSession.shared.data(for: req)
        let raw = String(data: data, encoding: .utf8) ?? ""
        guard let http = resp as? HTTPURLResponse else { throw SubanError.badResponse("无响应") }

        if http.statusCode == 401 { throw SubanError.http(401, "token 无效") }
        if http.statusCode >= 400 { throw SubanError.http(http.statusCode, String(raw.prefix(150))) }
        // 400 里可能夹带额度提示
        if raw.contains("额度") || raw.contains("订阅") || raw.contains("quota") { throw SubanError.quota }

        // 响应通常是同样密钥加密的 base64；解不开就当明文
        if let plain = try? open(raw, keyHex: key) { return plain }
        return raw
    }
}
