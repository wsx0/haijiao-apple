//
//  RootView.swift
//  Haijiao
//
//  两种首页：
//    · native —— 原生列表，直接打站点接口（默认）。列表滚动由 UICollectionView 负责，
//                不再经过 WKWebView，所以「进页面要等一会才能划」的问题从根上不存在。
//    · web    —— 原来的 WKWebView 套壳（去广告、视频全屏都在），点条目看详情走它。
//  右上角 safari 图标 / 底部 list 图标可以互相切换。
//

import SwiftUI
import WebKit

struct RootView: View {
    @AppStorage("hj.mode2") private var mode: String = "native"
    @State private var webURL: URL = HJWeb.home

    var body: some View {
        ZStack {
            if mode == "native" {
                NativeHomeView(
                    onOpen: { url in
                        webURL = url ?? HJWeb.home
                        mode = "web"
                    },
                    onSwitchToWeb: {
                        webURL = HJWeb.home
                        mode = "web"
                    }
                )
            } else {
                WebHomeView(
                    initialURL: webURL,
                    onSwitchToNative: { mode = "native" }
                )
            }
        }
    }
}

// MARK: - 网页版

struct WebHomeView: View {
    /// 打开时用的地址（来自原生列表点进来的详情，或首页）
    let initialURL: URL
    /// 切回原生列表
    let onSwitchToNative: () -> Void

    @State private var progress: Double = 0
    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var title = ""
    @State private var reloadToken = 0
    @State private var showBar = true
    /// 广告拦截规则（网络层 + 开屏 css-display-none）。编译是异步的。
    @State private var ruleLists: [WKContentRuleList] = []
    /// 规则编译是否已结束（成功或失败都算结束）
    @State private var rulesReady = false
    /// 诊断文本（前 10 秒采集，直接画在界面上，截图即可定位「划不动」）
    @State private var diag = ""
    @State private var diagVisible = true

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()

            LegacyWebView(url: initialURL,
                          progress: $progress,
                          canGoBack: $canGoBack,
                          canGoForward: $canGoForward,
                          title: $title,
                          reloadToken: reloadToken,
                          ruleLists: ruleLists,
                          rulesReady: rulesReady,
                          onDoubleTap: { withAnimation { showBar.toggle() } },
                          diag: $diag)
                .ignoresSafeArea(edges: .bottom)

            // 诊断面板：启动后前 20 秒显示（不影响触摸）
            if diagVisible, !diag.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Text(diag)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(Color.green)
                        .padding(4)
                        .background(Color.black.opacity(0.7))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 40)
                .padding(.horizontal, 4)
                .allowsHitTesting(false)
            }

            // 顶部进度条
            if progress > 0, progress < 1 {
                GeometryReader { geo in
                    Rectangle()
                        .fill(Color(red: 0.88, green: 0.14, blue: 0.37))
                        .frame(width: geo.size.width * progress, height: 2)
                }
                .frame(height: 2)
                .ignoresSafeArea(edges: .top)
                .animation(.easeOut(duration: 0.2), value: progress)
            }

            // 底部浮动导航
            if showBar {
                VStack {
                    Spacer()
                    HStack(spacing: 22) {
                        barButton("chevron.left", enabled: canGoBack) {
                            NotificationCenter.default.post(name: .hjGoBack, object: nil)
                        }
                        barButton("chevron.right", enabled: canGoForward) {
                            NotificationCenter.default.post(name: .hjGoForward, object: nil)
                        }
                        barButton("arrow.clockwise", enabled: true) {
                            reloadToken += 1
                        }
                        barButton("house.fill", enabled: true) {
                            NotificationCenter.default.post(name: .hjHome, object: nil)
                        }
                        // 回原生列表
                        barButton("list.bullet", enabled: true) {
                            onSwitchToNative()
                        }
                        barButton("eye.slash", enabled: true) {
                            withAnimation { showBar = false }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 18)
                }
                .transition(.opacity)
            }
        }
        .statusBarHidden(false)
        .task {
            ruleLists = await AdBlock.makeRuleLists()
            rulesReady = true
        }
        .task {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            diagVisible = false
        }
        .persistentSystemOverlays(.hidden)
    }

    @ViewBuilder
    private func barButton(_ icon: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(enabled ? .white : .white.opacity(0.28))
                .frame(width: 34, height: 34)
        }
        .disabled(!enabled)
    }
}

extension Notification.Name {
    static let hjGoBack    = Notification.Name("hj.goBack")
    static let hjGoForward = Notification.Name("hj.goForward")
    static let hjHome      = Notification.Name("hj.home")
}
