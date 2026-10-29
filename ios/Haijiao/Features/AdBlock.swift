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
    /* 开屏广告 —— 首帧就藏起来，不依赖 JS */
    [class*="splash" i], [id*="splash" i],
    [class*="launch-ad" i], [class*="launchad" i],
    [class*="open-screen" i], [class*="openscreen" i],
    [class*="start-ad" i], [class*="boot-ad" i],
    [class*="kaiping" i], [class*="startpage" i],
    [class*="welcome-ad" i], [class*="welcomead" i],
    [class*="guide-ad" i], [class*="guidead" i],
    /* 广告位 iframe */
    iframe[src*="doubleclick" i],
    iframe[src*="/ad" i][src*="?"],
    iframe[id*="ad" i],
    /* 推广条 / 引导下载 */
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
    
    /// 注入用的 JS：删节点 + 封弹窗 + 专治开屏广告。
    static let js = """
    (function () {
      if (window.__hj_adblock) return;
      window.__hj_adblock = true;

      var HOSTS = \(jsArray(blockedHosts));
      var START = Date.now();

      // 1) 封掉 window.open（弹窗广告主要来源）
      try { window.open = function () { return null; }; } catch (e) {}

      // 2) 封掉 alert/confirm 广告
      var _alert = window.alert;
      window.alert = function (msg) {
        var s = String(msg || '');
        if (/ad|广告|推广|下载|app|扫码|关注|加群|微信|qq|telegram|飞机/i.test(s)) return;
        return _alert && _alert.call(window, msg);
      };

      function classOf(el) {
        var c = el.className;
        if (c && c.baseVal !== undefined) c = c.baseVal;
        return ((el.id || '') + ' ' + (c || '')).toLowerCase();
      }

      // 3) 明确是广告的容器
      var AD_SEL = [
        '[class*="advert" i]', '[id*="advert" i]',
        'ins.adsbygoogle', '[class*="adsense" i]', '[id*="adsense" i]',
        '[class*="adbanner" i]', '[class*="ad-banner" i]',
        '[class*="ad-box" i]', '[id*="ad-box" i]',
        '[class*="ad-wrap" i]', '[id*="ad-wrap" i]',
        '[class*="ad-container" i]', '[id*="ad-container" i]',
        '[class*="popunder" i]', '[class*="interstitial" i]',
        '[class*="guanggao" i]', '[class*="promo-bar" i]',
        '[class*="download-bar" i]', '[class*="open-app" i]',
        '[class*="float-ad" i]', '[class*="floatad" i]',
        // ── 开屏广告专用 ──
        '[class*="splash" i]', '[id*="splash" i]',
        '[class*="launch-ad" i]', '[class*="launchad" i]',
        '[class*="open-screen" i]', '[class*="openscreen" i]',
        '[class*="start-ad" i]', '[class*="boot-ad" i]',
        '[class*="kaiping" i]', '[class*="startpage" i]',
        '[class*="welcome-ad" i]', '[class*="welcomead" i]',
        '[class*="guide-ad" i]', '[class*="guidead" i]'
      ].join(',');

      // 4) 跳过按钮关键词
      var SKIP_RE = /^(跳过|跳过广告|跳過|关闭广告|关闭|关闭该广告|不再提示|skip|skip ad|close|×|✕|x)$/i;

      function clickSkip() {
        var nodes = document.querySelectorAll('div,span,a,button,p,i,em');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var txt = (el.textContent || '').trim();
          if (!txt || txt.length > 14) continue;
          if (!SKIP_RE.test(txt)) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          try { el.click(); } catch (e) {}
          // 顺手把它所在的全屏父层也删掉
          var p = el;
          for (var k = 0; k < 6 && p; k++) {
            var pr = p.getBoundingClientRect();
            if (pr.width >= window.innerWidth * 0.8 && pr.height >= window.innerHeight * 0.8) {
              try { p.remove(); } catch (e) {}
              break;
            }
            p = p.parentElement;
          }
        }
      }

      // 5) 全屏遮罩层判定：铺满 + 高 z-index + 没有输入框
      //    不要求含广告字样 —— 开屏广告的 class 经常看不出是广告
      function looksLikeOverlay(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el === document.body || el === document.documentElement) return false;
        // 有输入框的可能是登录/评论框，放过
        if (el.querySelector('input,textarea,select')) return false;
        // 有视频/播放器的放过（可能是全屏播放）
        if (el.querySelector('video')) return false;

        var r = el.getBoundingClientRect();
        var w = window.innerWidth, h = window.innerHeight;
        if (r.width < w * 0.92 || r.height < h * 0.92) return false;

        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        var z = parseInt(cs.zIndex || '0', 10);
        if (z < 50) return false;

        var idc = classOf(el);
        // 明确是弹窗/遮罩的命名，直接判
        if (/(mask|overlay|modal|dialog|popup|splash|launch|start|welcome|guide)/.test(idc)) return true;

        // 否则：看它是不是「图片 + 倒计时/跳过」那种开屏结构
        var hasImg = !!el.querySelector('img,picture,canvas');
        var hasCountdown = /(跳过|\\d+\\s*s|倒计时)/.test(el.textContent || '');
        return hasImg && hasCountdown;
      }

      // 6) 清理
      function sweep() {
        // 明确广告位
        try {
          document.querySelectorAll(AD_SEL).forEach(function (el) { el.remove(); });
        } catch (e) {}

        // 广告域名资源
        try {
          document.querySelectorAll('iframe,script,img').forEach(function (el) {
            var src = (el.src || el.getAttribute('data-src') || '').toLowerCase();
            if (!src) return;
            for (var i = 0; i < HOSTS.length; i++) {
              if (src.indexOf(HOSTS[i]) >= 0) { el.remove(); return; }
            }
          });
        } catch (e) {}

        // 全屏遮罩
        try {
          var kids = document.body ? document.body.children : [];
          for (var i = 0; i < kids.length; i++) {
            if (looksLikeOverlay(kids[i])) {
              try { kids[i].remove(); } catch (e) {}
            }
          }
        } catch (e) {}

        // 跳过按钮
        clickSkip();
      }

      // 7) 前 6 秒高频扫（开屏广告就在这段时间），之后降到 1.5 秒
      sweep();
      var fast = setInterval(function () {
        sweep();
        if (Date.now() - START > 6000) {
          clearInterval(fast);
          setInterval(sweep, 1500);
        }
      }, 120);

      // 8) DOM 变动立刻扫
      try {
        var pending = false;
        new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; sweep(); }, 60);
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    })();
    """

    private static func jsArray(_ items: [String]) -> String {
        "[" + items.map { "\"\($0)\"" }.joined(separator: ",") + "]"
    }
}
