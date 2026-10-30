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

    /// 列表里要展示的图。
    /// 注意：视频类附件的 `remoteUrl` 是**视频文件**地址，不是图片 —— 拿它当图片会加载失败，
    /// 视频必须优先 coverUrl；图片类才优先 remoteUrl。
    var displayImages: [URL] {
        guard let atts = attachments else { return [] }
        var out: [URL] = []
        for a in atts {
            let isVideo = (a.category ?? "").lowercased().contains("video")
            let raw: String?
            if isVideo {
                raw = (a.coverUrl?.isEmpty == false) ? a.coverUrl : a.remoteUrl
            } else {
                raw = (a.remoteUrl?.isEmpty == false) ? a.remoteUrl : a.coverUrl
            }
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
