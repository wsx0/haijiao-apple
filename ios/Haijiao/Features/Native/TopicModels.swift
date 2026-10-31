//
//  TopicModels.swift
//  Haijiao
//
//  站点列表数据结构。
//
//  为什么不用 JSONDecoder：站点字段类型不稳定（同一个字段偶尔是数字、偶尔是字符串、偶尔 null），
//  Codable 严格解码会因为一条记录里的一个字段让整页报「未能读取数据，因为它的格式不正确」。
//  这里改成从 JSONSerialization 的字典里手工取值，每个字段都容错。
//

import Foundation

struct TopicPage {
    let page: PageInfo?
    let results: [Topic]
}

struct PageInfo {
    let page: Int?
    let limit: Int?
    let total: Int?
}

struct TopicUser {
    let id: Int?
    let nickname: String?
    let avatar: String?
}

struct TopicNode {
    let nodeId: Int?
    let name: String?
}

struct TopicTag {
    let tagId: Int?
    let tagName: String?
}

/// 附件（列表里的缩略图、详情页里的图片/视频都靠它）
struct TopicAttachment {
    let id: Int?
    let remoteUrl: String?
    let coverUrl: String?
    let category: String?
    let status: Int?
}

struct Topic: Identifiable {
    let topicId: Int?
    let title: String?
    let liteContent: String?
    let createTime: String?
    let viewCount: Int?
    let commentCount: Int?
    let likeCount: Int?
    let hasVideo: Bool?
    let user: TopicUser?
    let node: TopicNode?
    let tags: [TopicTag]
    /// 已经挑好、可直接渲染的缩略图（带 attachment id —— 图片数据要按 id 从解码表里取）
    let displayImages: [(id: Int, url: URL)]

    var imageURLs: [URL] { displayImages.map { $0.url } }

    var id: Int { topicId ?? 0 }
}

extension Topic {
    init(dict d: [String: Any]) {
        topicId = JSON.int(d["topicId"])
        title = JSON.string(d["title"])
        liteContent = JSON.string(d["liteContent"])
        createTime = JSON.string(d["createTime"])
        viewCount = JSON.int(d["viewCount"])
        commentCount = JSON.int(d["commentCount"])
        likeCount = JSON.int(d["likeCount"])
        hasVideo = JSON.bool(d["hasVideo"])

        if let u = d["user"] as? [String: Any] {
            user = TopicUser(id: JSON.int(u["id"]),
                             nickname: JSON.string(u["nickname"]),
                             avatar: JSON.string(u["avatar"]))
        } else {
            user = nil
        }

        if let n = d["node"] as? [String: Any] {
            node = TopicNode(nodeId: JSON.int(n["nodeId"]), name: JSON.string(n["name"]))
        } else {
            node = nil
        }

        var parsedTags: [TopicTag] = []
        if let arr = d["tags"] as? [[String: Any]] {
            for item in arr {
                parsedTags.append(TopicTag(tagId: JSON.int(item["tagId"]),
                                           tagName: JSON.string(item["tagName"])))
            }
        }
        tags = parsedTags

        // 缩略图：视频类附件的 remoteUrl 是**视频文件**，必须取 coverUrl
        var imgs: [(Int, URL)] = []
        if let arr = d["attachments"] as? [[String: Any]] {
            for a in arr {
                let isVideo = (JSON.string(a["category"]) ?? "").lowercased().contains("video")
                let remote = JSON.string(a["remoteUrl"])
                let cover = JSON.string(a["coverUrl"])
                let raw: String?
                if isVideo {
                    raw = (cover?.isEmpty == false) ? cover : remote
                } else {
                    raw = (remote?.isEmpty == false) ? remote : cover
                }
                if let s = raw, s.hasPrefix("http"), let u = URL(string: s) {
                    imgs.append((JSON.int(a["id"]) ?? 0, u))
                }
                if imgs.count >= 3 { break }
            }
        }
        displayImages = imgs
    }
}

// MARK: - 宽松取值

enum JSON {
    static func int(_ v: Any?) -> Int? {
        if v == nil || v is NSNull { return nil }
        if let i = v as? Int { return i }
        if let n = v as? NSNumber { return n.intValue }
        if let d = v as? Double { return Int(d) }
        if let s = v as? String { return Int(s.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    static func string(_ v: Any?) -> String? {
        if v == nil || v is NSNull { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    static func bool(_ v: Any?) -> Bool? {
        if v == nil || v is NSNull { return nil }
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        if let s = v as? String { return (s == "1" || s.lowercased() == "true") }
        return nil
    }
}
