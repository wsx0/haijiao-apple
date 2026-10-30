//
//  TopicModels.swift
//  Haijiao
//
//  站点列表接口（/api/topic/hot/topics）解码后的数据结构。
//  全部字段 Optional —— 站点偶尔缺字段，缺了不该让整页崩。
//

import Foundation

struct TopicPage: Decodable {
    let page: PageInfo?
    let results: [Topic]?
}

struct PageInfo: Decodable {
    let page: Int?
    let limit: Int?
    let total: Int?
}

struct Topic: Decodable, Identifiable {
    let topicId: Int?
    let title: String?
    let liteContent: String?
    let createTime: String?
    let lastCommentTime: String?
    let viewCount: Int?
    let commentCount: Int?
    let likeCount: Int?
    let hasVideo: Bool?
    let hasPic: Bool?
    let user: TopicUser?
    let node: TopicNode?
    let tags: [TopicTag]?
    let attachments: [TopicAttachment]?

    var id: Int { topicId ?? 0 }

    /// 列表里要展示的图（视频取封面，图片取 remoteUrl）
    var displayImages: [URL] {
        guard let atts = attachments else { return [] }
        var out: [URL] = []
        for a in atts {
            let raw: String?
            if let r = a.remoteUrl, !r.isEmpty { raw = r }
            else { raw = a.coverUrl }
            if let u = TopicAPI.imageURL(raw) { out.append(u) }
            if out.count >= 3 { break }
        }
        return out
    }
}

struct TopicUser: Decodable {
    let id: Int?
    let nickname: String?
    let avatar: String?
}

struct TopicNode: Decodable {
    let nodeId: Int?
    let name: String?
}

struct TopicTag: Decodable {
    let tagId: Int?
    let tagName: String?
}

struct TopicAttachment: Decodable {
    let id: Int?
    let remoteUrl: String?
    let coverUrl: String?
    let category: String?
    let status: Int?
}
