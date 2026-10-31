//
//  DiagnosticsView.swift
//  Haijiao
//
//  网络诊断：把「哪一步断」变成可截图的文字。
//
//  背景：真机上列表能出（API 通），但图片/视频都不行，而网页版正常。
//  仅凭推断连修 5 版都没解决，所以改成直接测：
//    · API     haijiao.com
//    · 图片    pic.*  （原生 URLSession）
//    · 图片    pic.*  （WebKit 页面内 fetch）
//    · m3u8    ts10.*
//    · AES key ts10.*
//    · ts 分片 ts10.*
//    · WebView haijiao.com/home 是否加载成功
//

import SwiftUI

// 诊断用的真实样本地址（都来自之前 CI 抓到的真实数据）
private let diagSampleImage = URL(string: "https://pic.hj260302818.top/hjstore/images/20261023/e85129820d8b0d42cfad2f2a1d14aae9.jpg.txt")!
private let diagSampleM3U8 = URL(string: "https://ts10.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/565690_i_preview.m3u8")!
private let diagSampleKey = URL(string: "https://ts10.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/enc_14330811.key")!

@MainActor
final class DiagModel: ObservableObject {
    struct Row: Identifiable {
        let id = UUID()
        let name: String
        var result: String = "…"
        var ok: Bool? = nil
        var ms: Int = 0
    }

    @Published var rows: [Row] = [
        .init(name: "① API haijiao.com"),
        .init(name: "② 图片 原生 URLSession"),
        .init(name: "③ 图片 WebKit 页面内"),
        .init(name: "④ m3u8 ts10.*"),
        .init(name: "⑤ AES key"),
        .init(name: "⑥ ts 分片"),
        .init(name: "⑦ 隐藏 WebView 就绪"),
        .init(name: "⑧ 图片解码结果"),
    ]



    func runAll() async {
        // ① API
        await test(0) {
            try await self.probe(TopicAPI.base + "/api/topic/hot/topics?page=1", headers: [
                "User-Agent": TopicAPI.ua, "Referer": TopicAPI.base + "/home",
            ], expectText: true)
        }
        // ② 图片：原生
        await test(1) { try await self.probe(diagSampleImage.absoluteString, headers: [
            "User-Agent": TopicAPI.ua, "Referer": TopicAPI.base + "/home",
        ], expectText: true) }
        // ③ 图片：WebKit
        await test(2) {
            let t = try await WebBridge.shared.fetchRaw(path: diagSampleImage.absoluteString)
            return t.isEmpty ? (false, "空响应", 0) : (true, "\(t.count) 字符", 0)
        }
        // ④ m3u8
        await test(3) { try await self.probe(diagSampleM3U8.absoluteString, headers: [
            "User-Agent": TopicAPI.ua, "Referer": TopicAPI.base + "/",
        ], expectText: true) }
        // ⑤ key
        await test(4) { try await self.probe(diagSampleKey.absoluteString, headers: [
            "User-Agent": TopicAPI.ua, "Referer": TopicAPI.base + "/",
        ], expectText: false) }
        // ⑥ ts 分片：从 m3u8 里取第一个片段名
        await test(5) {
            let text = try await WebBridge.shared.fetchRaw(path: diagSampleM3U8.absoluteString)
            let seg = text.split(separator: "\n").map(String.init).first { $0.hasSuffix(".ts") }
            guard let seg, !seg.isEmpty else { return (false, "m3u8 里没解析出分片", 0) }
            let base = diagSampleM3U8.absoluteString.replacingOccurrences(of: "565690_i_preview.m3u8", with: "")
            return try await self.probe(base + seg, headers: ["User-Agent": TopicAPI.ua], expectText: false)
        }
        // ⑦ WebView 是否就绪
        await test(6) {
            await WebBridge.shared.prepare(timeout: 15)
            let ok = WebBridge.shared.isReady
            return (ok, ok ? "已加载 haijiao.com" : "加载失败/超时", 0)
        }
        // ⑧ 解码：拿到文本后走真正的解码器，看能不能出图
        await test(7) {
            let raw = try await WebBridge.shared.fetchRaw(path: diagSampleImage.absoluteString)
            let start = Date()
            guard let img = SiteImage.image(from: raw) else {
                let head = String(raw.prefix(24)).replacingOccurrences(of: "\n", with: " ")
                return (false, "解码失败 head=\(head)", raw.count)
            }
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            return (true, "解码成功 \(Int(img.size.width))×\(Int(img.size.height)) \(ms)ms", raw.count)
        }
    }

    private func test(_ idx: Int, _ body: @escaping () async throws -> (Bool, String, Int)) async {
        let start = Date()
        do {
            let (ok, msg, bytes) = try await body()
            rows[idx].ok = ok
            rows[idx].result = bytes > 0 ? "\(msg)  \(bytes) B" : msg
        } catch {
            rows[idx].ok = false
            rows[idx].result = error.localizedDescription
        }
        rows[idx].ms = Int(Date().timeIntervalSince(start) * 1000)
    }

    private func probe(_ url: String, headers: [String: String], expectText: Bool) async throws -> (Bool, String, Int) {
        guard let u = URL(string: url) else { return (false, "URL 非法", 0) }
        var req = URLRequest(url: u)
        req.timeoutInterval = 15
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code != 200 {
            let head = String(data: data.prefix(60), encoding: .utf8) ?? ""
            return (false, "HTTP \(code) \(head)", data.count)
        }
        if expectText {
            let s = String(data: data, encoding: .utf8) ?? ""
            let head = String(s.prefix(28)).replacingOccurrences(of: "\n", with: " ")
            return (true, "HTTP 200 head=\(head)", data.count)
        }
        return (true, "HTTP 200", data.count)
    }
}

struct DiagnosticsView: View {
    @StateObject private var model = DiagModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                Section {
                    ForEach($model.rows) { $row in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(row.name).font(.system(size: 13, weight: .semibold))
                                Spacer()
                                if let ok = row.ok {
                                    Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                                        .foregroundStyle(ok ? .green : .red)
                                } else {
                                    ProgressView().scaleEffect(0.6)
                                }
                            }
                            Text(row.result)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                            if row.ms > 0 {
                                Text("\(row.ms) ms").font(.system(size: 10)).foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } footer: {
                    Text("全部绿 = 网络没问题，问题在播放/解码；某一项红 = 那一步断在这里。截图发我即可。")
                        .font(.system(size: 11))
                }

                Section {
                    Button("重新测一遍") {
                        Task { await model.runAll() }
                    }
                }
            }
            .navigationTitle("网络诊断")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .task { await model.runAll() }
        }
    }
}
