//
//  VideoPlayerView.swift
//  Haijiao
//
//  原生播放 HLS。站点视频是 AES-128 加密的 m3u8，但 **key 和分片都能匿名拿到**
//  （实测：m3u8 200 / enc_*.key 200 十六字节 / *.ts 200），
//  所以 AVPlayer 直接播即可，不需要 AVAssetResourceLoaderDelegate 补头。
//
//  注意：附件名带 `_i_preview` 的是**预览片段**（几十秒）；完整版在网页里购买后才有。
//

import AVKit
import SwiftUI

struct VideoPlayerView: View {
    let url: URL
    let title: String
    var isPreview: Bool = false

    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var failed = false
    /// 默认走 WebKit：真机上媒体 CDN 用原生栈拿不到，网页内核能拿到。
    /// 只有显式验证过原生可用（video.nativeOK）才用 AVPlayer。
    /// 诊断页已证明 m3u8/key/ts 全部 200，所以先走 AVPlayer；播不了再一键切 WebKit。
    @State private var useWebKit = false

    /// 防御：不管上层给的是什么形态，进播放器前再拆一次包装地址
    private var effectiveURL: URL { url.unwrappedStream }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if useWebKit {
                // 原生栈拿不到媒体 CDN 时，用 WebKit 播（它走自己的网络栈）
                WebVideoPlayer(url: effectiveURL)
                    .ignoresSafeArea()
            } else if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
                    .onAppear { player.play() }
            } else if failed {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 34))
                    Text("原生播放失败")
                        .font(.system(size: 14))
                    Text(effectiveURL.absoluteString)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.45))
                        .multilineTextAlignment(.center)
                        .lineLimit(4)
                        .padding(.horizontal, 24)
                    Text("换网页内核试试")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                    HStack(spacing: 12) {
                        Button("用网页内核播放") {
                            player?.pause()
                            player = nil
                            failed = false
                            useWebKit = true
                        }
                        .buttonStyle(.borderedProminent)
                        Button("关闭") { dismiss() }
                            .buttonStyle(.bordered)
                    }
                    .padding(.top, 6)
                }
                .foregroundStyle(.white.opacity(0.85))
            } else {
                ProgressView().tint(.white)
            }

            VStack {
                HStack {
                    Button {
                        player?.pause()
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 26))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    if isPreview {
                        Text("预览片段")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.orange.opacity(0.85), in: Capsule())
                            .foregroundStyle(.white)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                Spacer()
                if !title.isEmpty {
                    Text(title)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 10)
                }
            }
        }
        .onAppear { if !useWebKit { prepare() } }
        .onDisappear { player?.pause(); player = nil }
    }

    private func prepare() {
        // 让视频能出声（默认类别是 ambient，会被静音键掐掉）
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { }

        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        asset.loadValuesAsynchronously(forKeys: ["playable"]) { [asset] in
            var err: NSError?
            let status = asset.statusOfValue(forKey: "playable", error: &err)
            DispatchQueue.main.async {
                if status == .loaded {
                    player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
                } else {
                    failed = true
                }
            }
        }
    }
}

extension URL {
    /// 站点有时给的不是真 m3u8，而是包装链接：
    ///   https://hjai97.top?m3u8=https://sto.resmeres.top/haijiao/.../xxx.m3u8
    /// 真正的播放地址在 `m3u8` 查询参数里。不拆开的话 AVPlayer 直接报「格式不支持」。
    var unwrappedStream: URL {
        guard let comp = URLComponents(url: self, resolvingAgainstBaseURL: false),
              let raw = comp.queryItems?.first(where: { $0.name == "m3u8" || $0.name == "url" })?.value,
              !raw.isEmpty
        else { return self }
        // 参数值可能还是被编码过的一次
        let once = raw.removingPercentEncoding ?? raw
        return URL(string: once) ?? URL(string: raw) ?? self
    }
}

extension TopicDetail {
    /// 详情里的视频附件（取第一个）
    var videoAttachment: TopicAttachment? {
        attachments.first { ($0.category ?? "").lowercased().contains("video") && ($0.remoteUrl?.isEmpty == false) }
    }

    var videoURL: URL? {
        guard let s = videoAttachment?.remoteUrl, let u = URL(string: s) else { return nil }
        // 剥掉 ?m3u8= 包装，拿到真实地址
        return u.unwrappedStream
    }

    var videoIsPreview: Bool {
        let raw = videoAttachment?.remoteUrl ?? ""
        return raw.contains("_preview") || raw.contains("preview")
    }
}
