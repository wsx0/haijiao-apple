//
//  ImageStats.swift
//  Haijiao
//
//  图片加载失败时把原因记下来，列表底部显示一行汇总。
//  目的：让「看不到图」从猜谜变成可读的文字（是 DNS、HTTP 码、还是解码失败）。
//

import Foundation

@MainActor
final class ImageStats: ObservableObject {
    static let shared = ImageStats()

    @Published private(set) var failures: [String: Int] = [:]
    @Published private(set) var success = 0

    func recordOK() {
        success += 1
    }

    func record(failure reason: String) {
        let key = String(reason.prefix(60))
        failures[key, default: 0] += 1
    }

    func reset() {
        failures = [:]
        success = 0
    }

    /// 一行汇总，没有失败时返回 nil
    var summary: String? {
        guard !failures.isEmpty else { return nil }
        let total = failures.values.reduce(0, +)
        let top = failures.sorted { $0.value > $1.value }.prefix(2)
            .map { "\($0.key)×\($0.value)" }
            .joined(separator: "；")
        return "图片失败 \(total) 张（成功 \(success)）：\(top)"
    }
}
