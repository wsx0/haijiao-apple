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
    /// 不持久化：每次启动都从原生列表开始。
    /// 网页版只作为「看详情 / 兜底」的临时入口 —— 存进 UserDefaults 会导致切一次之后
    /// 再也回不到默认路径（2.0.0~2.0.5 的修复就是这么没被验证到的）。
    @State private var mode: String = "native"
    @State private var webURL: URL = HJWeb.home
    /// 「看详情/作者页」这类临时跳转用 sheet，**不再切换整个 App 的模式**。
    /// 之前 onOpen 里直接 mode = "web"，导致点头像等操作会把 App 整个切到网页，
    /// 用户体感是「时不时就跳进网页端」。
    @State private var sheetTarget: WebTarget?

    var body: some View {
        ZStack {
            if mode == "native" {
                NativeHomeView(
                    onOpen: { url in
                        sheetTarget = WebTarget(url: url ?? HJWeb.home)
                    },
                    onSwitchToWeb: {
                        webURL = HJWeb.home
                        mode = "web"
                    }
                )
                .sheet(item: $sheetTarget) { t in
                    WebSheet(url: t.url) { sheetTarget = nil }
                }
            } else {
                WebHomeView(
                    initialURL: webURL,
                    onSwitchToNative: { mode = "native" }
                )
            }
        }
        // 原站是白底浅色主题，整个 App 强制浅色：
        // 否则用户系统是深色时，正文用的 .primary 会变成白字，压在白色背景上就"文字不见了"
        .preferredColorScheme(.light)
    }
}

/// sheet 用的可识别目标
struct WebTarget: Identifiable {
    let id = UUID()
    let url: URL
}

/// 简易网页 sheet：带标题栏和关闭按钮，不接管整个 App
struct WebSheet: View {
    let url: URL
    let onClose: () -> Void

    @State private var progress: Double = 0
    @State private var title = ""

    var body: some View {
        NavigationView {
            ZStack(alignment: .top) {
                HStackWeb(url: url, progress: $progress, title: $title)
                if progress < 1.0 {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .tint(Theme.accent)
                }
            }
            .navigationTitle(title.isEmpty ? "网页" : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("关闭") { onClose() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }
}

/// WebSheet 内部的 WKWebView 包装
private struct HStackWeb: UIViewRepresentable {
    let url: URL
    @Binding var progress: Double
    @Binding var title: String

    func makeUIView(context: Context) -> WKWebView {
        let w = WKWebView()
        w.navigationDelegate = context.coordinator
        w.allowsBackForwardNavigationGestures = true
        w.load(URLRequest(url: url))
        return w
    }

    func updateUIView(_ w: WKWebView, context: Context) {}

    func makeCoordinator() -> Coord { Coord(progress: $progress, title: $title) }

    final class Coord: NSObject, WKNavigationDelegate {
        let progress: Binding<Double>
        let title: Binding<String>
        private var obs: NSKeyValueObservation?

        init(progress: Binding<Double>, title: Binding<String>) {
            self.progress = progress
            self.title = title
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            progress.wrappedValue = 1
            title.wrappedValue = webView.title ?? ""
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            progress.wrappedValue = 0.1
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
    /// 网页侧的诊断文本：还在采集（方便以后排查），但不再画到屏幕上
    @State private var diag = ""
    /// 诊断文本（前 10 秒采集，直接画在界面上，截图即可定位「划不动」）

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
