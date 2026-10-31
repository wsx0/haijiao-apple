//
//  ImageViewer.swift
//  Haijiao
//
//  详情页点图看大图：双指缩放、双击放大、拖拽移动、下滑关闭。
//  网页版有这个交互，之前点图没反应。
//

import SwiftUI

struct ImageViewer: View {
    let url: URL
    let title: String?

    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            RemoteImage(url: url, maxSide: 2400, contentMode: .fit)
                .scaleEffect(scale)
                .offset(offset)
                .gesture(
                    MagnificationGesture()
                        .onChanged { v in scale = max(1, min(5, lastScale * v)) }
                        .onEnded { _ in lastScale = scale; if scale <= 1 { resetPan() } }
                )
                .simultaneousGesture(
                    DragGesture()
                        .onChanged { v in
                            guard scale > 1 else { return }
                            offset = CGSize(width: lastOffset.width + v.translation.width,
                                            height: lastOffset.height + v.translation.height)
                        }
                        .onEnded { _ in lastOffset = offset }
                )
                .onTapGesture(count: 2) {
                    withAnimation(.easeOut(duration: 0.2)) {
                        if scale > 1 { scale = 1; lastScale = 1; resetPan() }
                        else { scale = 2.5; lastScale = 2.5 }
                    }
                }

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 28))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    if let t = title, !t.isEmpty {
                        Text(t)
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.6))
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                Spacer()
            }
        }
        .statusBarHidden(true)
    }

    private func resetPan() {
        withAnimation(.easeOut(duration: 0.2)) {
            offset = .zero
            lastOffset = .zero
        }
    }
}

/// 让 URL 能直接用于 `.fullScreenCover(item:)`
struct ImagePreview: Identifiable {
    let id: String
    let url: URL
    let title: String?

    init(url: URL, title: String? = nil) {
        self.id = url.absoluteString
        self.url = url
        self.title = title
    }
}
