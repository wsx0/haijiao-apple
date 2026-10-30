//
//  RootView.swift
//  Haijiao
//
//  极简外壳：全屏 WebView + 顶部进度条 + 底部浮动导航（返回 / 前进 / 刷新 / 主页）。
//  不做任何业务改版 —— 站点长什么样就是什么样。
//

import SwiftUI
import WebKit

struct RootView: View {
    private static let homeURL = HJWeb.home

    @State private var progress: Double = 0
    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var title = ""
    @State private var reloadToken = 0
    @State private var showBar = true
    @State private var lastTap: Date = .distantPast
    /// 广告拦截规则（网络层 + 开屏 css-display-none）。
    /// 编译是异步的，所以这里先给空数组、照常建 WebView；
    /// 规则编译完后由 `LegacyWebView.updateUIViewController` 补挂进 userContentController 并 reload 一次。
    @State private var ruleLists: [WKContentRuleList] = []

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()

            LegacyWebView(url: Self.homeURL,
                          progress: $progress,
                          canGoBack: $canGoBack,
                          canGoForward: $canGoForward,
                          title: $title,
                          reloadToken: reloadToken,
                          ruleLists: ruleLists)
                .ignoresSafeArea(edges: .bottom)

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
                    HStack(spacing: 26) {
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
                        barButton(showBar ? "eye.slash" : "eye", enabled: true) {
                            withAnimation { showBar = false }
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 18)
                }
                .transition(.opacity)
            }
        }
        .statusBarHidden(false)
        .task {
            // 编译规则（异步）。失败就返回空数组，退回纯 CSS/JS 两层，不影响启动。
            ruleLists = await AdBlock.makeRuleLists()
        }
        .onTapGesture {
            // 双击（间隔内连点两次）切换导航栏
            let now = Date()
            if now.timeIntervalSince(lastTap) < 0.35 {
                withAnimation { showBar.toggle() }
            }
            lastTap = now
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
