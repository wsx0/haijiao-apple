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

            LegacyWebView(url: Self.homeURL,
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

            // 诊断面板：启动后前 12 秒显示（不影响触摸），截图就能看出滚动几何到底卡在哪
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
            // 先编译规则；编译失败就是空数组，照样放行（退回 CSS/JS 两层）。
            ruleLists = await AdBlock.makeRuleLists()
            rulesReady = true
        }
        .task {
            // 12 秒后自动收起诊断面板
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            diagVisible = false
        }
        // 双击隐藏/显示底部导航栏 —— 由 WKWebView 上的 UITapGestureRecognizer 触发
        // （cancelsTouchesInView = false），不再用 SwiftUI 的整屏 onTapGesture：
        // 那个手势会先把点击吃掉再判定，导致进页面第一下点不动。
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
