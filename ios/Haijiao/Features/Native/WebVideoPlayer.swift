//
//  WebVideoPlayer.swift
//  Haijiao
//
//  用 WKWebView + <video> 播 HLS。
//
//  为什么需要它：真机网络下 `haijiao.com` 的 API 通，但媒体 CDN（`ts10.*`、`pic.*`）
//  原生 URLSession 拿不到，而网页版能正常播放 —— 差异在网络栈。
//  AVPlayer 走的是原生栈，所以只能黑屏；WebKit 走它自己的栈，能拿到分片。
//
//  HLS 的 AES-128 解密也交给 WebKit 原生处理，不需要手动拼 ts。
//

import SwiftUI
import WebKit

struct WebVideoPlayer: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // 允许自动播放（否则 iOS 会要求用户先点一下）
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = .black
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.backgroundColor = .black
        load(wv)
        return wv
    }

    func updateUIView(_ wv: WKWebView, context: Context) { }

    private func load(_ wv: WKWebView) {
        // baseURL 用播放列表本身，相对路径的 .ts / .key 才能正确解析
        let html = """
        <!DOCTYPE html>
        <html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
        <style>
          html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden}
          #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
          video{width:100%;height:100%;background:#000;object-fit:contain}
        </style>
        </head><body>
        <div id="wrap">
          <video id="v" src="\(url.absoluteString)" controls playsinline webkit-playsinline autoplay preload="auto"></video>
        </div>
        <script>
          var v = document.getElementById('v');
          v.addEventListener('error', function(){
            document.body.insertAdjacentHTML('beforeend',
              '<div style="position:absolute;bottom:60px;left:0;right:0;text-align:center;color:#f66;font:13px -apple-system">' +
              '播放失败 code=' + (v.error ? v.error.code : '?') + '</div>');
          });
          v.play().catch(function(e){ /* 自动播放被拦时用户点一下即可 */ });
        </script>
        </body></html>
        """
        wv.loadHTMLString(html, baseURL: url)
    }
}
