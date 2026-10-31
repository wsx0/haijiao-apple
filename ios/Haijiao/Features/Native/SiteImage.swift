//
//  SiteImage.swift
//  Haijiao
//
//  站点把图片文本包了一层「打乱字母表的 base64」：
//
//    表:  "ABCD*EFGHIJKLMNOPQRSTUVWX#YZabcdefghijklmnopqrstuvwxyz1234567890"
//          （标准 base64 的 64 个符号被重新排序，且用 * 和 # 代替 + 和 /）
//
//  .txt 的内容 = `#FEy` + 该表编码的数据；解码后是 `data:image/jpeg;base64,<真 base64>` 这段文本，
//  开头 3 字节是 `#FEy` 解出来的垃圾（所以看起来像有偏移）。
//
//  算法直接来自站点 app-*.js：
//      function A(){ var e="ABCD*EF…"; this.decode=function(t){ … } }
//  已在 CI 抓到的真实样本上验证：解出的 base64 → JPEG 头 ff d8 ff db ✓
//

import Foundation
import UIKit

enum SiteImage {

    private static let alphabet = Array("ABCD*EFGHIJKLMNOPQRSTUVWX#YZabcdefghijklmnopqrstuvwxyz1234567890".utf8)

    /// 字节 → 索引，避免每次 indexOf 线性扫 64 个字符
    private static let reverse: [UInt8: Int] = {
        var m: [UInt8: Int] = [:]
        for (i, b) in alphabet.enumerated() { m[b] = i }
        return m
    }()

    /// 解 .txt 原文 → 纯 base64（图片字节的 base64）
    static func decodeBase64Payload(_ raw: String) -> String? {
        // 与 JS 的 `t.replace(/[^A-Za-z0-9*\#]/g,"")` 等价
        let src = Array(raw.utf8).filter { b in
            (b >= 0x41 && b <= 0x5A) ||      // A-Z
            (b >= 0x61 && b <= 0x7A) ||      // a-z
            (b >= 0x30 && b <= 0x39) ||      // 0-9
            b == 0x2A || b == 0x23           // * 和 #
        }
        guard src.count >= 4 else { return nil }

        var out: [UInt8] = []
        out.reserveCapacity(src.count / 4 * 3)
        var i = 0
        while i + 3 < src.count {
            guard let s = reverse[src[i]],
                  let n = reverse[src[i + 1]],
                  let r = reverse[src[i + 2]],
                  let u = reverse[src[i + 3]] else {
                i += 4
                continue
            }
            out.append(UInt8(((s << 2) | (n >> 4)) & 0xFF))
            out.append(UInt8((((15 & n) << 4) | (r >> 2)) & 0xFF))
            out.append(UInt8((((3 & r) << 6) | u) & 0xFF))
            i += 4
        }
        guard let text = String(bytes: out, encoding: .isoLatin1) else { return nil }

        // 结果里形如  "\u{3}…data:image/jpeg;base64,xxxx" —— 取 base64 之后的部分
        if let r = text.range(of: "base64,") {
            return String(text[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    static func image(from raw: String) -> UIImage? {
        guard let b64 = decodeBase64Payload(raw),
              let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let img = UIImage(data: data) else { return nil }
        return img
    }
}
