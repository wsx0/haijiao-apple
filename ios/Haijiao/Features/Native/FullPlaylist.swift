//
//  FullPlaylist.swift
//  Haijiao
//
//  从「试看播放列表」推导 CDN 上的完整播放列表。
//
//  原理（来自开源脚本 zhaoruizhe81/haijiao-unlock 的实测结论）：
//    · /api/topic/<pid> 里 attachments[].remoteUrl 只给 xxxx_i_preview.m3u8（30 秒试看）
//    · 试看列表的分片名带出流 ID：2914240GjGiFvxI_i0.ts → 流 = 2914240GjGiFvxI
//    · 同目录下 <流ID>_i.m3u8 就是完整列表，且用的是同一把 AES-128 key 与 IV
//      —— 也就是说 CDN 这一层并不知道「付没付费」
//
//  限制：2026 起的新帖分片名是 32 位随机 hex（无公共前缀），推导不出来。
//        这类只能看试看片段，脚本作者也是这么写的。
//

import Foundation

enum FullPlaylist {

    /// 推导结果
    enum Outcome {
        case found(URL)          // 找到完整列表
        case randomSegments      // 新格式：分片随机 hex，推导不了
        case noStreamId          // 分片名解析不出流 ID
        case notPreview          // 传进来的不是试看地址
        case failed(String)      // 网络/其他错误
    }

    /// 从试看地址推导完整列表
    static func resolve(previewURL: URL, ua: String, referer: String) async -> Outcome {
        let s = previewURL.absoluteString
        guard s.contains("_preview.m3u8") else { return .notPreview }
        guard let text = await fetchText(previewURL, ua: ua, referer: referer) else {
            return .failed("拉试看列表失败")
        }

        guard let stream = streamIdFromPlaylist(text) else {
            // 区分「新格式随机分片」和「完全解析不出」
            let randomSeg = text.range(of: #"^\s*[0-9a-f]{32}\.ts\s*$"#,
                                       options: [.regularExpression, .anchored]) != nil
            return randomSeg ? .randomSegments : .noStreamId
        }

        let base = previewURL.deletingLastPathComponent()
        for name in ["\(stream)_i.m3u8", "\(stream).m3u8", "\(stream)_full.m3u8"] {
            let cand = base.appendingPathComponent(name)
            if await exists(cand, ua: ua, referer: referer) {
                return .found(cand)
            }
        }
        return .failed("流 \(stream) 的三个候选都 404")
    }

    /// 分片名形如 `<stream>_i0.ts`，取出 `<stream>`
    static func streamIdFromPlaylist(_ text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: #"^\s*([A-Za-z0-9_-]+)_i\d+\.ts\s*$"#,
                                                options: [.anchorsMatchLines]) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1 else { return nil }
        let s = ns.substring(with: m.range(at: 1))
        return s.isEmpty ? nil : s
    }

    // MARK: - 网络

    private static func fetchText(_ url: URL, ua: String, referer: String) async -> String? {
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue(referer, forHTTPHeaderField: "Referer")
        req.setValue("application/vnd.apple.mpegurl, */*", forHTTPHeaderField: "Accept")
        guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return nil }
        if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func exists(_ url: URL, ua: String, referer: String) async -> Bool {
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 12
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue(referer, forHTTPHeaderField: "Referer")
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        guard let h = resp as? HTTPURLResponse else { return false }
        return h.statusCode == 200
    }
}
