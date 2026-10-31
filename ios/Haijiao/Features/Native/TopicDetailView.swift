//
//  TopicDetailView.swift
//  Haijiao
//
//  原生详情页。数据来自 GET /api/topic/<id>（三层 base64，字段同列表）。
//  正文是 HTML，这里**自己拆成块**渲染，不塞 WKWebView：
//    <p> 段落      → 原生 Text
//    <img src>     → RemoteImage（走同一套图片双通道）
//    [door]id[/door] → 相关帖子卡片（用 doors 数组里的数据）
//

import SwiftUI

// MARK: - 模型

struct TopicDetail {
    let topicId: Int?
    let title: String?
    let user: TopicUser?
    let node: TopicNode?
    let createTime: String?
    let viewCountStr: String?
    let commentCountStr: String?
    let contentHTML: String?
    let attachments: [TopicAttachment]
    let doors: [TopicDoor]
    let isPaid: Bool

    var images: [URL] {
        attachments.compactMap { a in
            let isVideo = (a.category ?? "").lowercased().contains("video")
            let raw = isVideo ? (a.coverUrl?.isEmpty == false ? a.coverUrl : a.remoteUrl)
                              : (a.remoteUrl?.isEmpty == false ? a.remoteUrl : a.coverUrl)
            return TopicAPI.imageURL(raw)
        }
    }
}

struct TopicDoor: Identifiable {
    let id: Int
    let title: String?
    let description: String?
    let imageURL: URL?
    let viewCount: Int?
    let commentCount: Int?
}

extension TopicDetail {
    init(dict d: [String: Any]) {
        topicId = JSON.int(d["topicId"])
        title = JSON.string(d["title"])
        createTime = JSON.string(d["createTime"])
        viewCountStr = JSON.string(d["viewCountStr"]) ?? JSON.int(d["viewCount"]).map(String.init)
        commentCountStr = JSON.string(d["commentCountStr"]) ?? JSON.int(d["commentCount"]).map(String.init)
        contentHTML = JSON.string(d["content"])

        if let u = d["user"] as? [String: Any] {
            user = TopicUser(id: JSON.int(u["id"]), nickname: JSON.string(u["nickname"]), avatar: JSON.string(u["avatar"]))
        } else { user = nil }
        if let n = d["node"] as? [String: Any] {
            node = TopicNode(nodeId: JSON.int(n["nodeId"]), name: JSON.string(n["name"]))
        } else { node = nil }

        var atts: [TopicAttachment] = []
        if let arr = d["attachments"] as? [[String: Any]] {
            for a in arr {
                atts.append(TopicAttachment(
                    id: JSON.int(a["id"]),
                    remoteUrl: JSON.string(a["remoteUrl"]),
                    coverUrl: JSON.string(a["coverUrl"]),
                    category: JSON.string(a["category"]),
                    status: JSON.int(a["status"])))
            }
        }
        attachments = atts

        var ds: [TopicDoor] = []
        if let arr = d["doors"] as? [[String: Any]] {
            for x in arr {
                guard let did = JSON.int(x["id"]) else { continue }
                ds.append(TopicDoor(
                    id: did,
                    title: JSON.string(x["title"]),
                    description: JSON.string(x["description"]),
                    imageURL: TopicAPI.imageURL(JSON.string(x["img_url"])),
                    viewCount: JSON.int(x["view_count"]),
                    commentCount: JSON.int(x["comment_count"])))
            }
        }
        doors = ds

        if let s = d["sale"] as? [String: Any] {
            let amount = JSON.int(s["amount"]) ?? 0
            let bought = JSON.bool(s["is_buy"]) ?? false
            isPaid = amount > 0 && !bought
        } else {
            isPaid = false
        }
    }
}

// MARK: - HTML → 块

enum HTMLBlocks {
    enum Kind {
        case text(String)
        case image(URL)
        case door(TopicDoor)
    }
    struct Block: Identifiable {
        let id = UUID()
        let kind: Kind
    }

    /// 把正文 HTML 拆成「文本 / 图片 / 相关推荐」三种块。
    /// 只做必要的字符串处理：抠 body、把 img 和 door 换成占位符、按段落切、去标签解实体。
    static func parse(_ html: String, doors: [TopicDoor]) -> [Block] {
        var body = html
        if let r = body.range(of: "<body", options: .caseInsensitive) {
            if let end = body.range(of: ">", range: r.lowerBound..<body.endIndex) {
                body = String(body[end.upperBound...])
            }
        }
        if let r = body.range(of: "</body>", options: .caseInsensitive) {
            body = String(body[..<r.lowerBound])
        }

        let doorMap = Dictionary(uniqueKeysWithValues: doors.map { ($0.id, $0) })

        // 1) [door]123[/door] → 占位符
        var src = body
        src = replaceRegex(src, pattern: "\\[door\\](\\d+)\\[/door\\]") { groups in
            "\u{1}DOOR:\(groups[0])\u{1}"
        }
        // 2) <img ... src="..."> → 占位符
        src = replaceRegex(src, pattern: "<img[^>]*?src\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>") { groups in
            "\u{1}IMG:\(groups[0])\u{1}"
        }
        // 3) 段落分隔
        src = src.replacingOccurrences(of: "</p>", with: "\n\n", options: .caseInsensitive)
        src = src.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        // 4) 剩下的标签全部去掉
        src = replaceRegex(src, pattern: "<[^>]+>", groupsAre: 0) { _ in "" }

        var blocks: [Block] = []
        for chunk in src.components(separatedBy: "\u{1}") {
            let t = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            if t.hasPrefix("IMG:") {
                let raw = String(t.dropFirst(4))
                if let u = TopicAPI.imageURL(decodeEntities(raw)) {
                    blocks.append(Block(kind: .image(u)))
                }
            } else if t.hasPrefix("DOOR:") {
                if let did = Int(t.dropFirst(5)), let door = doorMap[did] {
                    blocks.append(Block(kind: .door(door)))
                }
            } else {
                let text = decodeEntities(t)
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    blocks.append(Block(kind: .text(text)))
                }
            }
        }
        return blocks
    }

    private static func replaceRegex(_ input: String, pattern: String, groupsAre n: Int = 0,
                                     _ transform: ([String]) -> String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return input }
        var out = input
        let ms = re.matches(in: input, range: NSRange(input.startIndex..., in: input))
        for m in ms.reversed() {
            guard let full = Range(m.range, in: input) else { continue }
            var groups: [String] = []
            if n > 0 {
                for i in 1...n {
                    if let r = Range(m.range(at: i), in: input) { groups.append(String(input[r])) }
                }
            }
            out.replaceSubrange(full, with: transform(groups))
        }
        return out
    }

    private static func replaceRegex(_ input: String, pattern: String, _ transform: ([String]) -> String) -> String {
        replaceRegex(input, pattern: pattern, groupsAre: 1, transform)
    }

    static func decodeEntities(_ s: String) -> String {
        var t = s
        let map = ["&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
                   "&#39;": "'", "&apos;": "'", "&ldquo;": "\u{201C}", "&rdquo;": "\u{201D}",
                   "&hellip;": "…", "&mdash;": "—"]
        for (k, v) in map { t = t.replacingOccurrences(of: k, with: v) }
        return t
    }
}

// MARK: - 页面

@MainActor
final class TopicDetailStore: ObservableObject {
    @Published private(set) var detail: TopicDetail?
    @Published private(set) var loading = false
    @Published private(set) var errorText: String?

    func load(topicId: Int) async {
        if loading || detail != nil { return }
        loading = true
        defer { loading = false }
        do {
            detail = try await TopicAPI.fetchDetail(topicId: topicId)
        } catch {
            errorText = error.localizedDescription
        }
    }
}

struct TopicDetailView: View {
    let topicId: Int
    let onOpenWeb: (Int) -> Void

    @StateObject private var store = TopicDetailStore()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let d = store.detail {
                    header(d)
                    if d.isPaid {
                        paidHint()
                    }
                    ForEach(HTMLBlocks.parse(d.contentHTML ?? "", doors: d.doors)) { block in
                        switch block.kind {
                        case .text(let t):
                            Text(t)
                                .font(.system(size: 16))
                                .lineSpacing(5)
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        case .image(let u):
                            RemoteImage(url: u)
                                .frame(maxWidth: .infinity)
                                .frame(height: 260)
                                .clipped()
                                .cornerRadius(8)
                        case .door(let door):
                            doorCard(door, onOpenWeb: onOpenWeb)
                        }
                    }
                    Button {
                        onOpenWeb(topicId)
                    } label: {
                        Label("用网页打开（可看视频/评论）", systemImage: "safari")
                            .font(.system(size: 14))
                    }
                    .padding(.top, 8)
                } else if store.loading {
                    HStack { Spacer(); ProgressView(); Spacer() }.padding(.top, 40)
                } else if let e = store.errorText {
                    Text(e).font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
        }
        .navigationTitle("详情")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load(topicId: topicId) }
    }

    private func header(_ d: TopicDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(d.title ?? "（无标题）")
                .font(.system(size: 20, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Text(d.user?.nickname ?? "")
                if let n = d.node?.name, !n.isEmpty { Text(n) }
                Spacer()
                if let v = d.viewCountStr { Label(v, systemImage: "eye") }
                if let c = d.commentCountStr { Label(c, systemImage: "bubble.left") }
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            if let t = d.createTime, !t.isEmpty {
                Text(t).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Divider()
        }
    }

    private func paidHint() -> some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill")
            Text("这是付费内容，完整正文需要在网页里购买后查看")
                .font(.system(size: 13))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.15))
        .cornerRadius(8)
    }

    private func doorCard(_ door: TopicDoor, onOpenWeb: @escaping (Int) -> Void) -> some View {
        Button {
            onOpenWeb(door.id)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                if let u = door.imageURL {
                    RemoteImage(url: u)
                        .frame(width: 84, height: 84)
                        .clipped()
                        .cornerRadius(6)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(door.title ?? "")
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(2)
                    if let t = door.description {
                        Text(t).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(Color.gray.opacity(0.12))
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }
}
