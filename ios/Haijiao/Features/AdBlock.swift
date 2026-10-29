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
    
    /// 注入用的 JS。
    ///
    /// 性能红线（上一版就是踩了这个才闪退）：
    ///   · 只扫 `document.body.children`（第一层，通常 <20 个节点），**绝不** querySelectorAll 全站
    ///   · 不做「遍历所有元素 + getBoundingClientRect」——那是强制同步布局，主线程直接卡死
    ///   · 同一个节点只处理一次（打标记），避免反复计算
    ///   · 前 8 秒 300ms 一次，之后 2 秒一次
    static let js = """
    (function () {
      if (window.__hj_adblock) return;
      window.__hj_adblock = true;

      var HOSTS = \(jsArray(blockedHosts));
      var START = Date.now();
      var HIT = '__hj_hit';      // 已判定过的节点标记

      // 1) 封 window.open（弹窗广告主要来源）
      try { window.open = function () { return null; }; } catch (e) {}

      // 2) 封 alert 广告文案
      var _alert = window.alert;
      window.alert = function (msg) {
        var s = String(msg || '');
        if (/ad|广告|推广|下载|app|扫码|关注|加群|微信|qq|telegram|飞机/i.test(s)) return;
        return _alert && _alert.call(window, msg);
      };

      function text(el) {
        var t = el.textContent || '';
        return t.length > 200 ? t.slice(0, 200) : t;
      }

      function idc(el) {
        var c = el.className;
        if (c && c.baseVal !== undefined) c = c.baseVal;
        return ((el.id || '') + ' ' + (c || '')).toLowerCase();
      }

      // 3) 判定一个「body 直接子元素」是不是广告层
      function isAdLayer(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') return false;

        var cs = getComputedStyle(el);
        // 必须浮在上面
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;

        var z = parseInt(cs.zIndex || '0', 10);
        if (isNaN(z) || z < 10) return false;

        // 有输入框的放过（登录 / 评论 / 搜索）
        if (el.querySelector('input,textarea,select')) return false;
        // 有播放器的放过
        if (el.querySelector('video')) return false;

        var name = idc(el);
        // 名字里明确是广告 / 开屏 / 遮罩
        if (/(advert|adsense|adsbygoogle|adbanner|ad-banner|ad-box|ad-wrap|ad-container|guanggao|popunder|interstitial|splash|launch|openscreen|open-screen|start-?ad|boot-?ad|kaiping|startpage|welcome-?ad|guide-?ad|mask|overlay)/.test(name)) {
          return true;
        }

        // 结构特征：几乎铺满 + 含图片或纯文字层 + 有跳过/倒计时/关闭字样
        var r = el.getBoundingClientRect();
        var w = window.innerWidth, h = window.innerHeight;
        if (r.width < w * 0.8 || r.height < h * 0.8) return false;
        var t = text(el);
        var hasSkip = /(跳过|跳過|关闭|关闭广告|skip|close|\\d+\\s*s\\b)/i.test(t);
        var hasMedia = !!el.querySelector('img,picture,canvas,iframe');
        return hasSkip || hasMedia;
      }

      // 4) 在给定的广告层里找关闭按钮并点掉（只在这个子树里找，范围很小）
      function clickSkipInside(el) {
        var cand = el.querySelectorAll('div,span,a,button,i,em,p');
        var LIMIT = Math.min(cand.length, 60);   // 硬上限，绝不无限扫
        for (var i = 0; i < LIMIT; i++) {
          var n = cand[i];
          var t = (n.textContent || '').trim();
          if (!t || t.length > 10) continue;
          if (!/^(跳过|跳过广告|跳過|关闭|关闭广告|×|✕|x|X|skip|skip ad|close)$/.test(t)) continue;
          try { n.click(); } catch (e) {}
          return true;
        }
        return false;
      }

      // 5) 主清理：只看 body 的第一层
      function sweep() {
        if (!document.body) return;
        var kids = document.body.children;
        // 倒序遍历，删元素不会打乱未处理的索引
        for (var i = kids.length - 1; i >= 0; i--) {
          var el = kids[i];
          if (!el || el[HIT]) continue;
          try {
            if (isAdLayer(el)) {
              clickSkipInside(el);
              el.remove();
            } else {
              el[HIT] = 1;    // 判过了就不再算
            }
          } catch (e) {}
        }

        // 顺手清掉来自广告域的 iframe/script/img（一次 querySelectorAll，范围可控）
        try {
          var junk = document.querySelectorAll(
            'iframe[src*="doubleclick" i],iframe[src*="googlesyndication" i],' +
            'script[src*="popads" i],script[src*="propellerads" i],' +
            'img[src*="adsterra" i],img[src*="exoclick" i]'
          );
          for (var k = 0; k < junk.length; k++) { junk[k].remove(); }
        } catch (e) {}
      }

      // 6) 前 8 秒 300ms 一次（开屏弹窗都在这个窗口），之后降到 2 秒
      sweep();
      var fast = setInterval(function () {
        sweep();
        if (Date.now() - START > 8000) {
          clearInterval(fast);
          setInterval(sweep, 2000);
        }
      }, 300);

      // 7) DOM 变动触发（去抖 200ms，避免频繁回调）
      try {
        var pending = false;
        new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; sweep(); }, 200);
        }).observe(document.body || document.documentElement, { childList: true });
      } catch (e) {}
    })();
    """

    private static func jsArray(_ items: [String]) -> String {
        "[" + items.map { "\"\($0)\"" }.joined(separator: ",") + "]"
    }
}
