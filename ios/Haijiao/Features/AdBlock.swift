//
//  AdBlock.swift
//  Haijiao
//
//  四层去广告（重点是开屏）：
//    1. WKContentRuleList —— 网络层拦掉广告域名 + 广告路径 + css-display-none 直接不画开屏容器
//    2. 注入 CSS —— 兜住同域下发、拦不住的开屏 / 广告位
//    3. 启动期开屏杀手（documentStart）—— 不认 class 名，靠「谁盖在视口最上层」几何判定，
//       在站点自己的 JS 把广告画出来之前就拆掉
//    4. 常驻清理（documentEnd）—— 定时清理动态插入的弹窗 / 横幅 / iframe
//
//  站点是 Vue SPA，DOM 随时重建，所以清理必须定时跑，不能只在 load 时跑一次。
//

import Foundation
import WebKit

enum AdBlock {

    // MARK: - 第 1 层：网络层拦截

    /// 常见广告 / 弹窗 / 统计域。命中即 block，连请求都不发。
    static let blockedHosts: [String] = [
        // Google / 通用广告网络
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "googletagservices.com", "adservice.google.com", "pagead2.googlesyndication.com",
        "adnxs.com", "adroll.com", "rubiconproject.com", "pubmatic.com",
        "openx.net", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
        "smartadserver.com", "casalemedia.com", "33across.com",
        // 弹窗 / 联盟
        "popads.net", "popcash.net", "propellerads.com", "propellerads.net",
        "onclickads.net", "clickadu.com", "hilltopads.net", "adsterra.com",
        "exoclick.com", "exosrv.com", "juicyads.com", "trafficjunky.net",
        "trafficjunky.com", "adspyglass.com", "tsyndicate.com",
        "realsrv.com", "juicyads.net", "dttrk.com",
        // 国内广告 / 监测
        "admaster.com.cn", "miaozhen.com", "irs01.com", "tanx.com",
        "alimama.com", "gdt.qq.com", "e.qq.com",
        // 统计 / 追踪
        "google-analytics.com", "googletagmanager.com", "hm.baidu.com",
        "cnzz.com", "umeng.com", "cloudflareinsights.com",
    ]

    /// 同域下发的广告资源路径特征（开屏图 / 广告 API 大多长这样）。命中即 block。
    static let adPathRules: [String] = [
        #"{"trigger":{"url-filter":"/ads?/","resource-type":["image","script","raw","popup"]},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"/advert","resource-type":["image","script","raw","popup"]},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"/upload/ad","resource-type":["image","script","raw"]},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"^https?://[^/]+/gg/","resource-type":["image","script","raw"]},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"/kaiping","resource-type":["image","script","raw"]},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"/popunder"},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"/banner[0-9]*\\.(gif|png|jpe?g|webp)"},"action":{"type":"block"}}"#,
    ]

    /// 开屏容器的 css-display-none 选择器：命中就压根不画，比任何 JS 都快。
    /// 两个坑都踩过：
    ///   · 要拼进 JSON，属性值一律用单引号（双引号会破坏 JSON）
    ///   · WebKit 的 Content Blocker 选择器解析器只认 CSS 的一个子集，**不认 `i` 大小写标志**；
    ///     带上 ` i` 会让整份规则编译失败 —— 那连广告域名拦截都会一起丢掉。
    ///     所以这里只写小写形式；大写命名的开屏由注入的 CSS（真 CSS 引擎，认 `i`）兜住。
    static let splashSelectors: String = [
        "[class*='splash']", "[id*='splash']",
        "[class*='kaiping']", "[id*='kaiping']",
        "[class*='open-screen']", "[class*='openscreen']",
        "[class*='launch-ad']", "[class*='launchad']",
        "[class*='start-ad']", "[class*='boot-ad']",
        "[class*='welcome-ad']", "[class*='welcomead']",
        "[class*='startpage']", "[class*='interstitial']",
        "[class*='openapp']", "[class*='open-app']",
        "[class*='app-guide']", "[class*='download-bar']",
        "[class*='ad-mask']", "[class*='admask']",
        "[class*='gg-mask']", "[class*='ggmask']",
        "[class*='fullscreen-ad']", "[class*='ad-fullscreen']",
        "[class*='pop-ad']", "[class*='popad']",
        "[class*='advert']", "[class*='guanggao']",
    ].joined(separator: ",")

    /// 编译成 WKContentRuleList（**拆成两份**）。
    ///
    /// 为什么拆：规则列表里只要有一条解析不了，整份编译就失败、返回 nil。
    /// 把「网络拦截」和「css-display-none」分开编译，CSS 选择器万一被 WebKit 挑刺，
    /// 也丢不掉域名/路径拦截。编译失败的那份直接跳过，不影响主流程。
    static func makeRuleLists() async -> [WKContentRuleList] {
        var lists: [WKContentRuleList] = []
        // WKContentRuleListStore.default() 返回的是 optional，先解开
        guard let store = WKContentRuleListStore.default() else { return lists }

        let hostRules = blockedHosts.map { host in
            #"{"trigger":{"url-filter":".*","if-domain":["*\#(host)"]},"action":{"type":"block"}}"#
        }
        let netJSON = "[" + (hostRules + adPathRules).joined(separator: ",") + "]"
        if let net = try? await store.compileContentRuleList(
            forIdentifier: "haijiao-adblock-net", encodedContentRuleList: netJSON) {
            lists.append(net)
        }

        let cssJSON = #"{"trigger":{"url-filter":".*"},"action":{"type":"css-display-none","selector":"\#(splashSelectors)"}}"#
        if let css = try? await store.compileContentRuleList(
            forIdentifier: "haijiao-adblock-css", encodedContentRuleList: "[" + cssJSON + "]") {
            lists.append(css)
        }
        return lists
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
    [class*="kaiping" i], [id*="kaiping" i],
    [class*="startpage" i],
    [class*="welcome-ad" i], [class*="welcomead" i],
    [class*="guide-ad" i], [class*="guidead" i],
    [class*="openapp" i], [class*="open-app" i],
    [class*="app-guide" i], [class*="download-bar" i],
    [class*="ad-mask" i], [class*="admask" i],
    [class*="gg-mask" i], [class*="ggmask" i],
    [class*="fullscreen-ad" i], [class*="ad-fullscreen" i],
    /* 广告位 iframe */
    iframe[src*="doubleclick" i],
    iframe[src*="/ad" i][src*="?"],
    iframe[id*="ad" i],
    /* 推广条 / 引导下载 */
    [class*="promo-bar" i], [class*="download-bar" i],
    /* 遮罩类弹窗（只在明显是广告位时隐藏，避免误伤登录框） */
    div[class*="mask" i][class*="ad" i] {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        width: 0 !important;
    }
    """

    // MARK: - 第 3 层：启动期开屏杀手（documentStart）

    /// 注入时机 .atDocumentStart —— 跑在站点脚本之前。
    ///
    /// 不靠 class 名（站点改个名就失效），改用「几何 + 层级」判定：
    ///   用 document.elementsFromPoint 在视口几个点取样，拿到盖在最上层的元素，
    ///   再往上找那一层「铺满视口并且是 fixed/absolute/高 z-index」的容器。
    ///   命中且不属于登录/表单/播放器 → 先点跳过按钮，再整层移除。
    ///
    /// 只在启动窗口（20 秒）内、用户还没操作过的时候动手，
    /// 并且限次（12 层），避免误伤正常的全屏浮层或和站点互相拉锯。
    static let launchJS = """
    (function () {
      if (window.__hj_splash) return;
      window.__hj_splash = true;

      var T0 = Date.now();
      var WINDOW_MS = 20000;     // 启动期强杀窗口
      var MAX_HITS = 12;         // 单次启动最多拆 12 层
      var MIN_GAP = 80;          // 两次扫描最小间隔（ms），防止打爆主线程
      var hits = window.__hj_splash_kills = [];
      var touched = false;
      var lastRun = 0;
      var done = false;

      // 用户一动，就说明开屏已经过去 / 他正在操作，立刻停手
      ['touchstart', 'pointerdown', 'mousedown', 'keydown', 'wheel', 'scroll'].forEach(function (n) {
        try { window.addEventListener(n, function () { touched = true; },
              { capture: true, passive: true }); } catch (e) {}
      });

      function vw() {
        return window.innerWidth ||
               (document.documentElement && document.documentElement.clientWidth) || 0;
      }
      function vh() {
        return window.innerHeight ||
               (document.documentElement && document.documentElement.clientHeight) || 0;
      }
      function nameOf(el) {
        var c = el.className;
        if (c && c.baseVal !== undefined) c = c.baseVal;
        return String((el.id || '') + ' ' + (c || '')).toLowerCase();
      }

      // 明显不是广告的层：登录 / 支付 / 播放器 / 编辑器 / 上传
      var PROTECT = /(login|sign-?in|regist|passwd|password|captcha|verify|pay|order|cashier|player|video|upload|editor|search|comment)/;

      function protectedLayer(el) {
        if (!el || el.nodeType !== 1) return true;
        if (el.id === 'app' || el.id === 'root') return true;
        if (PROTECT.test(nameOf(el))) return true;
        try {
          if (el.querySelector('input,textarea,select,video')) return true;
        } catch (e) {}
        var media = null;
        try { media = el.querySelector('img,picture,canvas,iframe'); } catch (e) {}
        var txt = (el.textContent || '').length;
        // 没图没播放器、又是长篇文字：那是内容页 / 协议页，不是开屏
        if (!media && txt > 400) return true;
        return false;
      }

      function covers(el) {
        var r = el.getBoundingClientRect();
        var W = vw(), H = vh();
        if (W < 20 || H < 20) return false;
        if (r.width >= W * 0.86 && r.height >= H * 0.60) return true;
        return r.width >= W * 0.95 && r.height >= H * 0.45;
      }

      // 从一个被点中的元素往上找「铺满视口的那一层」
      function layerOf(el) {
        var n = el, depth = 0;
        while (n && n.nodeType === 1 && depth < 9) {
          if (n === document.body || n === document.documentElement) break;
          if (covers(n)) {
            var cs = null;
            try { cs = getComputedStyle(n); } catch (e) {}
            var floating = cs && (cs.position === 'fixed' || cs.position === 'absolute');
            var z = cs ? parseInt(cs.zIndex || '0', 10) : 0;
            if (isNaN(z)) z = 0;
            if (floating || z >= 5) {
              return protectedLayer(n) ? null : n;
            }
          }
          n = n.parentElement;
          depth++;
        }
        return null;
      }

      var PTS = [
        [0.5, 0.5], [0.5, 0.12], [0.88, 0.06],
        [0.5, 0.88], [0.12, 0.5], [0.5, 0.03]
      ];

      function findOverlay() {
        if (!document.elementsFromPoint) return null;
        var W = vw(), H = vh();
        for (var i = 0; i < PTS.length; i++) {
          var x = Math.round(W * PTS[i][0]);
          var y = Math.round(H * PTS[i][1]);
          var stack = null;
          try { stack = document.elementsFromPoint(x, y); } catch (e) {}
          if (!stack || !stack.length) continue;
          for (var j = 0; j < stack.length && j < 5; j++) {
            var el = stack[j];
            if (!el || el.nodeType !== 1) continue;
            if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;
            var layer = layerOf(el);
            if (layer) return layer;
          }
        }
        return null;
      }

      var SKIP_TEXT = /^(跳过|跳過|跳过广告|跳過廣告|关闭|關閉|关闭广告|×|✕|✖|x|X|skip|skip ?ad|close|\\d+\\s*s?|\\d+\\s*秒)$/;
      var DISMISS_TEXT = /^(我知道了|知道了|好的|好|确定|确认|同意|继续|我知道|已阅读|同意并继续)$/;

      // 在广告层里点掉「跳过 / 关闭 / 我知道了」，右上角优先
      function clickIn(root) {
        var list = null;
        try { list = root.querySelectorAll('div,span,a,button,i,em,p,label,img'); } catch (e) {}
        if (!list || !list.length) return false;
        var W = vw(), H = vh();
        var N = Math.min(list.length, 100);
        var best = null, bestScore = -1;
        for (var i = 0; i < N; i++) {
          var n = list[i];
          var t = (n.textContent || '').trim();
          var hit = t.length > 0 && t.length <= 8 && (SKIP_TEXT.test(t) || DISMISS_TEXT.test(t));
          if (!hit && n.tagName === 'IMG') {
            var src = n.getAttribute('src') || '';
            if (/close|guanbi|skip|cross|cha-|xx/i.test(src)) hit = true;
          }
          if (!hit) continue;
          var r = n.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          var score = (r.left / W) + (1 - r.top / H);
          if (score > bestScore) { bestScore = score; best = n; }
        }
        if (!best) return false;
        try { best.click(); } catch (e) {}
        return true;
      }

      function kill(layer) {
        var label = nameOf(layer).slice(0, 60) || layer.tagName;
        clickIn(layer);
        var gone = false;
        try { layer.remove(); } catch (e) {}
        gone = !layer.parentNode;
        if (!gone) { try { layer.style.display = 'none'; } catch (e2) {} }
        try { layer.setAttribute('data-hj-killed', '1'); } catch (e3) {}
        if (hits.length < 40) hits.push(label);
        return true;
      }

      function scan() {
        if (done) return true;
        if (touched) { done = true; return true; }
        if (hits.length >= MAX_HITS) { done = true; return true; }
        if (Date.now() - T0 > WINDOW_MS) { done = true; return true; }
        var now = Date.now();
        if (now - lastRun < MIN_GAP) return false;
        lastRun = now;
        var layer = null;
        try { layer = findOverlay(); } catch (e) {}
        if (layer) kill(layer);
        return false;
      }

      function step() {
        if (done) return;
        if (window.requestAnimationFrame) window.requestAnimationFrame(loop);
        else setTimeout(loop, 60);
      }
      function loop() {
        if (scan()) return;
        step();
      }

      // DOM 一出现就抓：MutationObserver 只是「叫醒」，真正的判定在 scan 里限频
      try {
        var mo = new MutationObserver(function () { scan(); });
        mo.observe(document, { childList: true, subtree: true });
        setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, WINDOW_MS + 2000);
      } catch (e) {}

      // 手动再扫一轮（调试用：控制台里执行 __hj_scan()）
      window.__hj_scan = function () {
        touched = false; done = false; T0 = Date.now();
        var layer = findOverlay();
        return layer ? kill(layer) : false;
      };

      if (document.body) scan();
      step();
    })();
    """

    // MARK: - 第 4 层：常驻清理（documentEnd）

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
      // 已判定过的节点 → 判定时间戳。
      // 注意不能永久标记：SPA 会复用同一个 DOM 节点，第一次扫时它还是普通容器，
      // 打上永久标记之后就再也不会被检查 —— 广告换进来也认不出来了。
      // 因此标记 4 秒后失效，允许重新判定。
      var SEEN = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
      var SEEN_LIFE = 4000;

      function seen(el) {
        if (!SEEN) return false;
        var t = SEEN.get(el);
        if (!t) return false;
        if (Date.now() - t > SEEN_LIFE) { SEEN['delete'](el); return false; }
        return true;
      }
      function markSeen(el) {
        if (!SEEN) return;
        SEEN.set(el, Date.now());
      }

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
        var tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' ||
            tag === 'META' || tag === 'NOSCRIPT') return false;
        // #app 是根容器，绝不能删
        if (el.id === 'app') return false;

        var cs = getComputedStyle(el);
        // 必须浮在上面
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity || '1') < 0.05) return false;

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

      // 5) 主清理
      //
      //    关键：Vue 的弹窗渲染在 #app 内部，不是 body 的直接子节点 ——
      //    只扫 body.children 会完全扫不到。但也不能 querySelectorAll('*')。
      //    折中：用 CSS 特征先筛出少量候选（只有浮层才带 position:fixed 的内联样式
      //    或 popup/modal/mask 这类 class），再对这几个候选做几何判定。
      var CAND_SEL = [
        'div[style*="position: fixed"]',
        'div[style*="position:fixed"]',
        'div[class*="popup" i]', 'div[class*="modal" i]',
        'div[class*="mask" i]', 'div[class*="overlay" i]',
        'div[class*="dialog" i]', 'div[class*="layer" i]',
        'div[class*="splash" i]', 'div[class*="launch" i]',
        'div[class*="guide" i]', 'div[class*="advert" i]',
        'div[class*="banner" i]', 'div[class*="notice" i]',
        'div[id*="popup" i]', 'div[id*="modal" i]',
        'div[id*="mask" i]', 'div[id*="ad" i]',
        'div[id*="banner" i]',
        'a[href*="javascript:void"]'
      ].join(',');

      // 5.0 关掉站点自己的提示弹窗（不删，只点掉按钮，免得破坏正常功能）
      //     海角开屏会依次弹 3 个「warning 警告」，每个都有「我知道了」/「好」
      var DISMISS_RE = /^(我知道了|知道了|好的|好|确定|确认|关闭|同意|继续|我知道了。)$/;

      function autoDismiss() {
        // 只在浮层候选里找按钮，范围很小
        var zones = document.querySelectorAll(
          'div[class*="popup" i],div[class*="modal" i],div[class*="mask" i],' +
          'div[class*="dialog" i],div[class*="notice" i],div[class*="warn" i]'
        );
        var LIMIT = Math.min(zones.length, 20);
        for (var i = 0; i < LIMIT; i++) {
          var z = zones[i];
          if (!z || !z.parentNode) continue;
          var btns = z.querySelectorAll('button,a,div,span');
          var N = Math.min(btns.length, 40);
          for (var j = 0; j < N; j++) {
            var b = btns[j];
            var t = (b.textContent || '').trim();
            if (!t || t.length > 8) continue;
            if (!DISMISS_RE.test(t)) continue;
            // 排除登录按钮
            if (/登录|注册|登陆/.test(t)) continue;
            try { b.click(); } catch (e) {}
            return true;
          }
        }
        return false;
      }

      function sweep() {
        if (!document.body) return;

        // 5.1 body 的直接子元素（原生浮层常挂这里）
        var i, el;
        var kids = document.body.children;
        for (i = kids.length - 1; i >= 0; i--) {
          el = kids[i];
          if (!el || seen(el)) continue;
          try {
            if (isAdLayer(el)) { clickSkipInside(el); el.remove(); }
            else { markSeen(el); }
          } catch (e) {}
        }

        // 5.2 #app 的直接子元素（Vue 把弹窗挂在根组件里）
        var app = document.getElementById('app');
        if (app) {
          var ak = app.children;
          for (i = ak.length - 1; i >= 0; i--) {
            el = ak[i];
            if (!el || seen(el)) continue;
            try {
              if (isAdLayer(el)) { clickSkipInside(el); el.remove(); }
              else { markSeen(el); }
            } catch (e) {}
          }
        }

        // 5.3 特征候选（数量很少，通常个位数）
        try {
          var cands = document.querySelectorAll(CAND_SEL);
          var LIMIT = Math.min(cands.length, 40);   // 硬上限
          for (i = 0; i < LIMIT; i++) {
            el = cands[i];
            if (!el || seen(el) || !el.parentNode) continue;
            try {
              if (isAdLayer(el)) { clickSkipInside(el); el.remove(); }
            } catch (e) {}
          }
        } catch (e) {}

        // 5.4 顶部横幅广告条
        //     特征：贴着顶部、横向铺满、高度矮（<220px）、含图片或指向外部 / 无文字
        try {
          var tops = document.querySelectorAll('a,div');
          var TN = Math.min(tops.length, 800);
          for (i = 0; i < TN; i++) {
            el = tops[i];
            if (!el || seen(el) || !el.parentNode) continue;
            var r = el.getBoundingClientRect();
            if (r.top > 240 || r.height > 220 || r.height < 40) continue;
            if (r.width < window.innerWidth * 0.85) continue;
            // 里面有 img 且整块是链接（点一下跳外站）—— 基本就是横幅广告
            var href = el.getAttribute && (el.getAttribute('href') || '');
            var hasImg = !!el.querySelector('img');
            var txtLen = (el.textContent || '').trim().length;
            var looksBanner = hasImg && (href.indexOf('javascript') === 0 || href === '' || href === '#');
            if (looksBanner && txtLen < 30) {
              try { el.remove(); } catch (e) {}
            } else {
              markSeen(el);
            }
          }
        } catch (e) {}

        // 5.5 广告域资源
        try {
          var junk = document.querySelectorAll(
            'iframe[src*="doubleclick" i],iframe[src*="googlesyndication" i],' +
            'script[src*="popads" i],script[src*="propellerads" i],' +
            'img[src*="adsterra" i],img[src*="exoclick" i]'
          );
          for (var k = 0; k < junk.length; k++) { junk[k].remove(); }
        } catch (e) {}

        // 5.6 最后：把站点的 warning 提示点掉
        autoDismiss();
      }

      // 6) 前 8 秒 300ms 一次（开屏弹窗都在这个窗口），之后降到 2 秒
      sweep();
      var fast = setInterval(function () {
        sweep();
        if (Date.now() - START > 20000) {
          clearInterval(fast);
          setInterval(sweep, 1500);
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
