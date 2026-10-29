//
//  AdBlock.swift
//  Haijiao
//
//  三层去广告：
//    1. WKContentRuleList —— 在网络层直接拦掉广告域名（最干净，元素根本不加载）
//    2. 注入 CSS —— 兜住那些同域下发、拦不住的广告位
//    3. 注入 JS —— 定期清理动态插入的广告节点，并封掉 window.open 弹窗
//
//  站点是 Vue SPA，DOM 随时重建，所以 JS 清理必须定时跑，不能只在 load 时跑一次。
//

import Foundation
import WebKit

enum AdBlock {

    // MARK: - 第 1 层：网络层拦截

    /// 常见广告 / 弹窗 / 统计域。命中即 block，连请求都不发。
    static let blockedHosts: [String] = [
        // Google / 通用广告网络
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "adservice.google.com", "pagead2.googlesyndication.com",
        "adnxs.com", "adroll.com", "rubiconproject.com", "pubmatic.com",
        "openx.net", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
        "smartadserver.com", "casalemedia.com", "33across.com",
        // 弹窗 / 联盟
        "popads.net", "popcash.net", "propellerads.com", "propellerads.net",
        "onclickads.net", "clickadu.com", "hilltopads.net", "adsterra.com",
        "exoclick.com", "exosrv.com", "juicyads.com", "trafficjunky.net",
        "trafficjunky.com", "adspyglass.com", "tsyndicate.com",
        "realsrv.com", "juicyads.net", "dttrk.com",
        // 统计 / 追踪
        "google-analytics.com", "googletagmanager.com", "hm.baidu.com",
        "cnzz.com", "umeng.com", "cloudflareinsights.com",
    ]

    /// 编译成 WKContentRuleList。失败就返回 nil，不影响主流程。
    static func makeRuleList() async -> WKContentRuleList? {
        let parts = blockedHosts.map { host in
            """
            {"trigger":{"url-filter":".*","if-domain":["*\(host)"]},"action":{"type":"block"}}
            """
        }
        // 广告 URL 常见路径特征（同域下发的情况也拦一层）
        let pathRules = """
        {"trigger":{"url-filter":"/ads?[/_.-]","resource-type":["image","script","raw","popup"]},"action":{"type":"block"}},
        {"trigger":{"url-filter":"/advert","resource-type":["image","script","raw","popup"]},"action":{"type":"block"}},
        {"trigger":{"url-filter":"/popunder"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"/banner[0-9]*\\\\.(gif|png|jpg|jpeg|webp)"},"action":{"type":"block"}}
        """
        let json = "[" + parts.joined(separator: ",") + "," + pathRules + "]"
        return try? await WKContentRuleListStore.default()
            .compileContentRuleList(forIdentifier: "haijiao-adblock", encodedContentRuleList: json)
    }

    // MARK: - 第 2 层：CSS

    /// 常见的广告容器 class/id 命名。宁可多藏，也不误伤 —— 所以只匹配明确的广告词。
    static let css = """
    /* 广告容器 */
    [class*="advert" i], [id*="advert" i],
    [class*="adsbygoogle" i], ins.adsbygoogle,
    [class*="ad-banner" i], [class*="adbanner" i],
    [class*="ad-box" i], [id*="ad-box" i],
    [class*="ad-wrap" i], [id*="ad-wrap" i],
    [class*="ad-container" i], [id*="ad-container" i],
    [class*="adsense" i], [id*="adsense" i],
    [class*="gg-box" i], [class*="guanggao" i],
    [class*="float-ad" i], [class*="floatad" i],
    [class*="pop-ad" i], [class*="popad" i],
    [class*="popup-ad" i], [class*="modal-ad" i],
    [class*="interstitial" i],
    /* 广告位 iframe */
    iframe[src*="doubleclick" i],
    iframe[src*="/ad" i][src*="?"],
    iframe[id*="ad" i],
    /* 推广条 */
    [class*="promo-bar" i], [class*="download-bar" i],
    [class*="app-guide" i], [class*="open-app" i],
    /* 遮罩类弹窗（只在明显是广告位时隐藏，避免误伤登录框） */
    div[class*="mask" i][class*="ad" i] {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        width: 0 !important;
    }
    """
    
    /// 注入用的 JS：把上面的规则再以「删节点」的方式强化一遍，并封杀弹窗。
    static let js = """
    (function () {
      if (window.__hj_adblock) return;
      window.__hj_adblock = true;

      var HOSTS = \(jsArray(blockedHosts));

      // 1) 封掉 window.open（弹窗广告主要来源）
      try { window.open = function () { return null; }; } catch (e) {}

      // 2) 封掉 alert/confirm 广告（站点正常功能用的是自定义弹窗，不吃这两个）
      var _alert = window.alert;
      window.alert = function (msg) {
        var s = String(msg || '');
        if (/ad|广告|推广|下载|app|扫码|关注|加群|微信|qq|telegram|飞机/i.test(s)) return;
        return _alert && _alert.call(window, msg);
      };

      // 3) 判定一个元素是不是广告
      function looksLikeAd(el) {
        if (!el || el.nodeType !== 1) return false;
        var idc = ((el.id || '') + ' ' + (el.className && el.className.baseVal !== undefined
            ? el.className.baseVal : (el.className || ''))).toLowerCase();
        if (!idc) return false;
        return /(advert|adsense|adsbygoogle|adbanner|ad-banner|ad-box|ad-wrap|ad-container|guanggao|popunder|interstitial|promo-bar|download-bar|open-app)/.test(idc);
      }

      // 4) 清除第三方广告脚本与 iframe
      function sweep() {
        // 广告位
        try {
          document.querySelectorAll(
            '[class*="advert" i],[id*="advert" i],ins.adsbygoogle,' +
            '[class*="adsense" i],[class*="adbanner" i],[class*="ad-banner" i],' +
            '[class*="ad-box" i],[class*="ad-wrap" i],[class*="ad-container" i],' +
            '[class*="popunder" i],[class*="interstitial" i],' +
            '[class*="promo-bar" i],[class*="download-bar" i],[class*="open-app" i]'
          ).forEach(function (el) { el.remove(); });
        } catch (e) {}

        // 来自广告域的资源
        try {
          document.querySelectorAll('iframe,script,img').forEach(function (el) {
            var src = (el.src || el.getAttribute('data-src') || '').toLowerCase();
            if (!src) return;
            for (var i = 0; i < HOSTS.length; i++) {
              if (src.indexOf(HOSTS[i]) >= 0) { el.remove(); return; }
            }
          });
        } catch (e) {}

        // 全屏遮罩型广告层：只删「铺满全屏 + 高 z-index + 内含广告字样」
        try {
          var w = window.innerWidth, h = window.innerHeight;
          document.querySelectorAll('div').forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (r.width < w * 0.85 || r.height < h * 0.85) return;
            var z = parseInt(getComputedStyle(el).zIndex || '0', 10);
            if (z < 100) return;
            if (looksLikeAd(el)) el.remove();
          });
        } catch (e) {}
      }

      // 5) 首屏立刻扫一次，之后定时扫（Vue 会不断重建 DOM）
      sweep();
      setInterval(sweep, 1200);

      // 6) DOM 变动也触发，降低广告闪现时间
      try {
        var pending = false;
        new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; sweep(); }, 300);
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    })();
    """

    private static func jsArray(_ items: [String]) -> String {
        "[" + items.map { "\"\($0)\"" }.joined(separator: ",") + "]"
    }
}
