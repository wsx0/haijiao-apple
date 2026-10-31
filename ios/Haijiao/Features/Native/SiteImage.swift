//
//  SiteImage.swift
//  Haijiao
//
//  站点图片是「打乱字母表的 base64」：
//    密文 → 过滤出 [A-Za-z0-9*#] → 每 4 字符还原 3 字节 → 得到文本 "data:image/jpeg;base64,…" → 取 base64 → UIImage
//
//  ⚠️ 关键：整个过程**必须按原始字节做**，不能用 String 中转。
//  图片密文里含非 UTF-8 字节，一旦走 `String(data:encoding:.utf8)`：
//    · .utf8 失败 → 回退 .isoLatin1
//    · 再取 `raw.utf8` 时，0x80–0xFF 会被编码成 **2 个字节**（C2/C3 开头）
//    · 过滤后整段错位 → 解码必然失败
//  这正是「2660 张失败、69 张成功」的原因。
//

import UIKit

enum SiteImage {

    // MARK: - 打乱字母表

    private static let alphabet = Array("ABCD*EFGHIJKLMNOPQRSTUVWX#YZabcdefghijklmnopqrstuvwxyz1234567890".utf8)

    private static let reverse: [UInt8: Int] = {
        var m = [UInt8: Int]()
        for (i, c) in alphabet.enumerated() { m[c] = i }
        return m
    }()

    @inline(__always)
    private static func isAllowed(_ b: UInt8) -> Bool {
        (b >= 0x41 && b <= 0x5A) ||     // A-Z
        (b >= 0x61 && b <= 0x7A) ||     // a-z
        (b >= 0x30 && b <= 0x39) ||     // 0-9
        b == 0x2A || b == 0x23          // * #
    }

    // MARK: - 解码（字节入口，推荐）

    /// 从原始字节解出图片。**不经过 String**，避免编码破坏。
    static func image(from data: Data) -> UIImage? {
        guard let b64 = decodeBase64Payload(bytes: [UInt8](data)) else { return nil }
        guard let imgData = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: imgData)
    }

    /// 兼容入口：如果调用方手上确实是干净的 ASCII 文本，也可以走这里。
    static func image(from raw: String) -> UIImage? {
        image(from: Data(raw.utf8))
    }

    /// 解出真正的 base64 串
    static func decodeBase64Payload(bytes raw: [UInt8]) -> String? {
        // 1) 只保留字母表字符
        var src = [UInt8]()
        src.reserveCapacity(raw.count)
        for b in raw where isAllowed(b) { src.append(b) }

        guard src.count >= 4 else { return nil }

        // 2) 每 4 字符 → 3 字节
        var out = [UInt8]()
        out.reserveCapacity(src.count / 4 * 3)
        var i = 0
        while i + 3 < src.count {
            guard let a = reverse[src[i]],
                  let b = reverse[src[i + 1]],
                  let c = reverse[src[i + 2]],
                  let d = reverse[src[i + 3]] else {
                i += 4
                continue
            }
            out.append(UInt8((a << 2 | b >> 4) & 0xFF))
            out.append(UInt8(((b & 0x0F) << 4 | c >> 2) & 0xFF))
            out.append(UInt8(((c & 0x03) << 6 | d) & 0xFF))
            i += 4
        }

        // 3) 在字节里找 "base64,"（ASCII 字面量），取其后的内容
        let marker = Array("base64,".utf8)
        guard let start = find(marker, in: out) else { return nil }
        let body = out[(start + marker.count)...]

        // 4) 跳掉可能的空行，收集 base64 字符
        var b64 = [UInt8]()
        b64.reserveCapacity(body.count)
        for b in body {
            if b == 0x0A || b == 0x0D || b == 0x20 || b == 0x09 { continue }  // 换行/空白
            let ok = (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) ||
                     (b >= 0x30 && b <= 0x39) || b == 0x2B || b == 0x2F || b == 0x3D
            if ok { b64.append(b) }
        }
        guard b64.count >= 8 else { return nil }

        // 5) 补齐到 4 的倍数（末尾可能被截断）
        while b64.count % 4 != 0 { b64.append(0x3D) }   // '='
        return String(bytes: b64, encoding: .ascii)
    }

    private static func find(_ needle: [UInt8], in haystack: [UInt8]) -> Int? {
        guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
        let last = haystack.count - needle.count
        var i = 0
        while i <= last {
            if haystack[i] == needle[0] {
                var j = 1
                while j < needle.count, haystack[i + j] == needle[j] { j += 1 }
                if j == needle.count { return i }
            }
            i += 1
        }
        return nil
    }
}
