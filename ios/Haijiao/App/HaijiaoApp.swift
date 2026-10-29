//
//  HaijiaoApp.swift
//  Haijiao
//
//  海角社区（haijiao.com）iOS 封装。
//  站点是纯 Vue SPA，视频用 DPlayer + hls.js，iOS 上会回落到原生 HLS 播放。
//  所以这里用 WKWebView 直接承载，不需要逆向 API。
//

import SwiftUI

@main
struct HaijiaoApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}
