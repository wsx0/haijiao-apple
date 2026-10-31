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
    /// 注意：成功计数**不能**是 @Published。
    /// 每张图加载成功都触发它 → 观察它的列表每次都整体重绘 →
    /// 120 张图就是 120 次全列表重绘，表现正是「图只出来一部分、还卡」。
    private(set) var success = 0

    func recordOK() {
        success += 1          // 只累加，不通知 SwiftUI
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
