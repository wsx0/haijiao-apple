//
//  TopicListView.swift
//  Haijiao
//
//  原生列表：数据来自站点接口，滚动交给 UIKit 的 UICollectionView（SwiftUI List），
//  不再经过 WKWebView —— 这才是「一进页面就能划」的根本解法。
//

import SwiftUI
import UIKit

// MARK: - 图片（站点图片是 .txt 后缀，自带 content-type 不一定可信，所以按字节解码）

final class NativeImageCache {
    static let shared = NativeImageCache()
    private let cache = NSCache<NSString, UIImage>()
    private init() { cache.countLimit = 300 }
    func get(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func set(_ key: String, _ image: UIImage) { cache.setObject(image, forKey: key as NSString) }
}

struct RemoteImage: View {
    /// attachment id：优先用它去查「页面已解码」的图片表
    var attID: Int? = nil
    let url: URL?
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Color.gray.opacity(0.15)
                    if failed { Image(systemName: "photo").foregroundStyle(.secondary) }
                }
            }
        }
        .task(id: url?.absoluteString) { await load() }
    }

    @MainActor
    private func load() async {
        guard let url else { return }
        failed = false
        let key = url.absoluteString
        if let cached = NativeImageCache.shared.get(key) {
            image = cached
            return
        }
        // 最优路径：页面已经把这层编码解开了，按 attachment id 直接取
        if let b64 = WebBridge.shared.cachedImage(attID),
           let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
           let img = UIImage(data: data) {
            let thumb = await img.byPreparingThumbnail(ofSize: CGSize(width: 300, height: 300)) ?? img
            NativeImageCache.shared.set(key, thumb)
            image = thumb
            return
        }
        // 直连（带 Cookie/Referer）失败会内部回退到页面内 fetch，两条都不成才算失败
        if let full = await TopicAPI.fetchImage(url) {
            // 下采样到 300pt：列表格子只有 ~100pt，原图（gif/jpeg 常见 1000px+）白占内存
            let thumb = await full.byPreparingThumbnail(ofSize: CGSize(width: 300, height: 300)) ?? full
            NativeImageCache.shared.set(key, thumb)
            image = thumb
        } else {
            failed = true
        }
    }
}

// MARK: - 数据

@MainActor
final class TopicStore: ObservableObject {
    @Published private(set) var topics: [Topic] = []
    @Published private(set) var loading = false
    @Published private(set) var errorText: String?

    private var nextPage = 1
    private var total = 1000
    private var started = false

    func loadFirstIfNeeded() async {
        if started { return }
        started = true
        // 延迟 2 秒预热隐藏 WebView，并把页面已解码的图片收下来（站点把图片编码过，
        // 自己解不开；但页面自己会解成 data URL，收集比逆向省事且稳定）
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            _ = await WebBridge.shared.collectImages(scrolls: 5)
        }
        // 原来的注释保留说明
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await WebBridge.shared.prepare(timeout: 15)
        }
        await reload()
    }

    func reload() async {
        nextPage = 1
        total = 1000
        topics = []
        errorText = nil
        await loadMore()
    }

    func loadMore() async {
        if loading { return }
        if topics.count >= total { return }
        loading = true
        defer { loading = false }
        do {
            let fetched = try await TopicAPI.fetchTopics(page: nextPage)
            let raw = fetched.results
            // topicId 缺失的条目会让 Identifiable 的 id 全变 0 → List 身份冲突，直接丢掉
            let items = raw.filter { ($0.topicId ?? 0) > 0 }
            if raw.isEmpty {
                total = topics.count
            } else {
                topics.append(contentsOf: items)
                if let t = fetched.page?.total { total = t }
                nextPage += 1
            }
            errorText = nil
        } catch {
            let msg = "加载失败：\(error.localizedDescription)"
            errorText = msg
            // 同时落盘：Documents 已开文件共享，可用「文件」App 直接导出发给我
            do {
                let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let url = dir.appendingPathComponent("hj_last_error.txt")
                let stamp = ISO8601DateFormatter().string(from: Date())
                let body = "[\(stamp)] page=\(nextPage)\n\(msg)\n\n"
                if let handle = try? FileHandle(forWritingTo: url) {
                    handle.seekToEndOfFile()
                    handle.write(body.data(using: .utf8) ?? Data())
                    try? handle.close()
                } else {
                    try body.write(to: url, atomically: true, encoding: .utf8)
                }
            } catch { }
        }
    }
}

// MARK: - 行

struct TopicRow: View {
    let topic: Topic

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(topic.title?.isEmpty == false ? (topic.title ?? "") : (topic.liteContent ?? "（无标题）"))
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(3)
                .foregroundStyle(.primary)

            let imgs = topic.displayImages
            if !imgs.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(imgs.enumerated()), id: \.offset) { _, item in
                        RemoteImage(attID: item.id, url: item.url)
                            .frame(height: 104)
                            .frame(maxWidth: .infinity)
                            .clipped()
                            .cornerRadius(6)
                    }
                }
            }

            HStack(spacing: 12) {
                Text(topic.user?.nickname ?? "")
                    .lineLimit(1)
                Spacer(minLength: 8)
                Label("\(topic.commentCount ?? 0)", systemImage: "bubble.left")
                Label("\(topic.viewCount ?? 0)", systemImage: "eye")
                if let n = topic.node?.name, !n.isEmpty {
                    Text(n)
                }
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)

            if let first = topic.tags.first?.tagName, !first.isEmpty {
                Text(topic.tags.compactMap { $0.tagName }.prefix(3).joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - 列表页

struct NativeHomeView: View {
    /// 点条目：交给内置 WebView 打开详情
    let onOpen: (URL?) -> Void
    /// 右上角切回网页版
    let onSwitchToWeb: () -> Void

    @StateObject private var store = TopicStore()

    var body: some View {
        NavigationView {
            List {
                ForEach(store.topics) { t in
                    NavigationLink {
                        TopicDetailView(topicId: t.id, onOpenWeb: { id in
                            onOpen(TopicAPI.detailURL(topicId: id))
                        })
                    } label: {
                        TopicRow(topic: t)
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .onAppear {
                        if t.id == store.topics.last?.id {
                            Task { await store.loadMore() }
                        }
                    }
                }

                // 首屏还没有内容时的占位
                if store.topics.isEmpty, store.loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .padding(.vertical, 30)
                        .listRowSeparator(.hidden)
                }

                if store.loading, !store.topics.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowSeparator(.hidden)
                }

                if let e = store.errorText {
                    VStack(alignment: .leading, spacing: 8) {
                        // 完整显示、可长按复制：出错时这行文字本身就是诊断信息
                        Text(e)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        HStack(spacing: 14) {
                            Button("重试") { Task { await store.reload() } }
                            Button("用网页版打开") { onSwitchToWeb() }
                        }
                        .font(.system(size: 13))
                    }
                    .padding(.vertical, 6)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .navigationTitle(store.topics.isEmpty ? "海角" : "海角 · \(store.topics.count) 条")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        onSwitchToWeb()
                    } label: {
                        Image(systemName: "safari")
                    }
                }
            }
            .task { await store.loadFirstIfNeeded() }
            .refreshable { await store.reload() }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
    }
}
