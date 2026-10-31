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
    /// 长边上限。列表格子 300 够用；详情页大图必须给大的，否则会糊。
    var maxSide: CGFloat = 300
    /// 列表格子要填满（fill）；详情页正文图要完整显示（fit），否则竖图会被裁成一条。
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?
    @State private var failed = false
    /// List 滚动会反复触发 onAppear，失败图会被无限重试（实测累计到 2660 次）。
    /// 用这个锁住，只加载一次。
    @State private var started = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                ZStack {
                    Color.gray.opacity(0.15)
                    if failed { Image(systemName: "photo").foregroundStyle(.secondary) }
                }
            }
        }
        .onAppear {
            // 不用 .task（生命周期绑视图，List 复用单元格时会取消它，下载被打断）。
            // 但也**不能**每次出现都重试：List 滚动会反复触发 onAppear，
            // 失败图会被无限重试（实测累计到 2660 次）。用 started 锁住只跑一次。
            guard !started else { return }
            started = true
            Task { await load() }
        }
    }

    @MainActor
    private func load() async {
        guard let url else { return }
        failed = false
        // 缓存按「URL + 尺寸」分开：缩略图和大图不能互相顶掉
        let key = url.absoluteString + "@" + String(Int(maxSide))
        if let cached = NativeImageCache.shared.get(key) {
            image = cached
            return
        }

        // fetchImage 内部已经在后台完成解码 + 下采样，这里直接落缓存
        if let thumb = await TopicAPI.fetchImage(url, maxSide: maxSide) {
            NativeImageCache.shared.set(key, thumb)
            image = thumb
            ImageStats.shared.recordOK()
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

    /// 还有没有下一页
    var hasMore: Bool { nextPage <= total }

    private var nextPage = 1
    private var total = 1000
    private var started = false

    func loadFirstIfNeeded() async {
        if started { return }
        started = true
        // 图片走自己的解码器（SiteImage），不再需要预热隐藏 WebView 去收集
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
        VStack(alignment: .leading, spacing: 9) {
            // 标题
            Text(topic.title?.isEmpty == false ? (topic.title ?? "") : (topic.liteContent ?? "（无标题）"))
                .font(.system(size: 16, weight: .semibold))
                .lineLimit(3)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)

            // 作者行：头像 + 昵称 + 付费/分类徽标
            HStack(spacing: 6) {
                if let head = TopicAPI.imageURL(topic.user?.avatar) {
                    RemoteImage(url: head, maxSide: 120)
                        .frame(width: 18, height: 18)
                        .clipShape(Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.subtext)
                }
                Text(topic.user?.nickname ?? "匿名")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.subtext)
                    .lineLimit(1)
                if let badge = badgeText {
                    Text(badge)
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Theme.chip, in: RoundedRectangle(cornerRadius: 3))
                        .foregroundStyle(Theme.accent)
                }
                Spacer(minLength: 0)
            }

            // 图片 / 摘要
            let imgs = topic.displayImages
            if !imgs.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(imgs.enumerated()), id: \.offset) { _, item in
                        RemoteImage(attID: item.id, url: item.url, maxSide: 600)
                            .frame(height: 108)
                            .frame(maxWidth: .infinity)
                            .clipped()
                            .cornerRadius(6)
                    }
                }
            } else if let lite = topic.liteContent, !lite.isEmpty {
                Text(lite)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.subtext)
                    .lineLimit(2)
            }

            // 统计 + 标签
            HStack(spacing: 10) {
                Label("\(topic.commentCount ?? 0)", systemImage: "bubble.left")
                Label("\(topic.viewCount ?? 0)", systemImage: "eye")
                if let n = topic.node?.name, !n.isEmpty {
                    Text(n)
                }
                Spacer(minLength: 0)
                if let first = topic.tags.first?.tagName, !first.isEmpty {
                    Text("#" + first)
                        .lineLimit(1)
                }
            }
            .font(.system(size: 11))
            .foregroundStyle(Theme.subtext)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Theme.stroke, lineWidth: 0.5)
        )
    }

    /// 角标（Topic 模型里没有 money_type，用 hasVideo + 标题关键词近似网页版角标）
    private var badgeText: String? {
        if topic.hasVideo == true { return "视频" }
        let t = topic.title ?? ""
        if t.contains("原创") { return "原创" }
        if t.contains("收费") { return "收费" }
        return nil
    }
}

// MARK: - 列表页

struct NativeHomeView: View {
    /// 点条目：交给内置 WebView 打开详情
    let onOpen: (URL?) -> Void
    /// 右上角切回网页版
    let onSwitchToWeb: () -> Void

    @StateObject private var store = TopicStore()
    @ObservedObject private var stats = ImageStats.shared
    @State private var showDiag = false

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
                    .buttonStyle(PressableRowStyle())
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
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.8)
                        Text("加载更多…")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.subtext)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .listRowSeparator(.hidden)
                } else if !store.topics.isEmpty, !store.hasMore {
                    Text("— 已经到底了 —")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.subtext.opacity(0.7))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 18)
                        .listRowSeparator(.hidden)
                }

                if let s = ImageStats.shared.summary {
                    Text(s)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.orange)
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
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 5, leading: 12, bottom: 5, trailing: 12))
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle(store.topics.isEmpty ? "海角" : "海角 · \(store.topics.count) 条")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    HStack(spacing: 14) {
                        Button {
                            showDiag = true
                        } label: {
                            Image(systemName: "stethoscope")
                        }
                        Button {
                            onSwitchToWeb()
                        } label: {
                            Image(systemName: "safari")
                        }
                    }
                }
            }
            .sheet(isPresented: $showDiag) {
                DiagnosticsView()
                    .preferredColorScheme(.dark)
            }
            .task { await store.loadFirstIfNeeded() }
            .refreshable { await store.reload() }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
    }
}

/// 卡片按下时轻微缩放 + 变暗，给出点击反馈（网页版点卡片有这个感觉）
struct PressableRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}