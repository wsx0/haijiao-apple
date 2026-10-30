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
        let key = url.absoluteString
        if let cached = NativeImageCache.shared.get(key) {
            image = cached
            return
        }
        do {
            var req = URLRequest(url: url)
            req.timeoutInterval = 20
            req.setValue(TopicAPI.ua, forHTTPHeaderField: "User-Agent")
            req.setValue("\(TopicAPI.base)/", forHTTPHeaderField: "Referer")
            let (data, _) = try await URLSession.shared.data(for: req)
            guard let full = UIImage(data: data) else {
                failed = true
                return
            }
            // 下采样到 300pt：列表格子只有 ~100pt，原图（gif/jpeg 常见 1000px+）白占内存
            let thumb = await full.byPreparingThumbnail(ofSize: CGSize(width: 300, height: 300)) ?? full
            NativeImageCache.shared.set(key, thumb)
            image = thumb
        } catch {
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
            let raw = fetched.results ?? []
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
            errorText = "加载失败：\(error.localizedDescription)"
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
                    ForEach(Array(imgs.enumerated()), id: \.offset) { _, u in
                        RemoteImage(url: u)
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

            if let tags = topic.tags, let first = tags.first?.tagName, !first.isEmpty {
                Text(tags.compactMap { $0.tagName }.prefix(3).joined(separator: " · "))
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
                    Button {
                        onOpen(TopicAPI.detailURL(topicId: t.id))
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
                    VStack(alignment: .leading, spacing: 6) {
                        Text(e).font(.system(size: 12)).foregroundStyle(.red)
                        Button("重试") { Task { await store.reload() } }
                            .font(.system(size: 13))
                    }
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .navigationTitle("海角")
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
