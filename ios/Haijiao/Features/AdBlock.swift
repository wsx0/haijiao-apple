//
//  AdBlock.swift
//  Haijiao
//
//  去广告 —— 规则全部来自对真实站点的实测（2026-10-30，CI 上 Playwright 渲染 + A/B/C 三组对比）：
//
//  站点实际有三个「挡屏物」，没有任何全屏开屏广告图：
//    1. 顶部博彩横幅      .topbanmer   ← POST /api/banner/banner_list + hjstore/system/banner/*.gif.txt
//    2. 底部 PWA 引导条   .addbox      ← “添加海角社区到主屏幕”
//    3. 开屏三连弹窗      .van-dialog.luodiconfirm（重要提示/我知道了）
//                          .van-dialog.luodisconfirm（域名保存/好）
//
//  四层：
//    1. WKContentRuleList —— 拦 banner 数据源与图片、统计域，并用 css-display-none 首帧就不画
//    2. 注入 CSS —— 同上的兜底（真 CSS 引擎，认大小写标志）
//    3. siteJS（documentStart）—— MutationObserver 盯新增节点 + 400ms 兜底，
//       只对上面几个精确选择器动手：不遍历全站、不做几何测量
//    4. js（documentEnd）—— 封 window.open、过滤广告 alert、清广告 iframe，轻量收尾
//
//  几何杀手（launchJS）保留但默认关闭：实测站点没有铺满视口的浮层，
//  而 elementsFromPoint 这类强制布局曾经把这个 App 拖死过。需要时把 splashKillerEnabled 改 true。
//

import Foundation
import WebKit

enum AdBlock {

    /// 几何开屏杀手总开关。实测站点没有全屏浮层，默认关掉（它要强制布局，历史上崩过一次）。
    static let splashKillerEnabled = false

    // MARK: - 第 1 层：网络层拦截

    /// 广告 / 统计域。命中即 block，连请求都不发。
    static let blockedHosts: [String] = [
        // 通用广告网络
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

    /// 站点自己的广告路径（实测：banner 数据接口 + banner 图片目录）。命中即 block。
    static let adPathRules: [String] = [
        #"{"trigger":{"url-filter":"/api/banner/banner_list"},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"hjstore/system/banner/"},"action":{"type":"block"}}"#,
        #"{"trigger":{"url-filter":"/popunder"},"action":{"type":"block"}}"#,
    ]

    /// 实测到的三个挡屏物的容器。css-display-none = 首帧就不画，比任何 JS 都早。
    /// 只用简单类选择器（WebKit 的 Content Blocker 选择器解析器只认 CSS 子集）。
    static let splashSelectors: String = [
        ".topbanmer",
        ".addbox",
        ".van-dialog.luodiconfirm",
        ".van-dialog.luodisconfirm",
    ].joined(separator: ",")

    /// 编译成 WKContentRuleList（**拆成两份**）。
    ///
    /// 规则列表里只要有一条解析不了，整份编译就失败、返回 nil。拆开以后，
    /// CSS 选择器万一被 WebKit 挑刺，也丢不掉「banner 数据源 + 统计域」的拦截。
    /// 规则文本的稳定摘要（FNV-1a）。内容变了 identifier 才变，缓存才有意义。
    private static func digest(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    /// `lookUpContentRuleList` / `removeContentRuleList` 在 Xcode 15.4 的 SDK 里只有 completion 版，
    /// 这里包成 async，避免用不存在的重载（1.0.8 第一次构建就栽在这）。
    private static func cachedList(_ store: WKContentRuleListStore, _ id: String) async -> WKContentRuleList? {
        await withCheckedContinuation { (cont: CheckedContinuation<WKContentRuleList?, Never>) in
            store.lookUpContentRuleList(forIdentifier: id) { list, _ in
                cont.resume(returning: list)
            }
        }
    }

    private static func dropList(_ store: WKContentRuleListStore, _ id: String) {
        store.removeContentRuleList(forIdentifier: id) { _ in }
    }

    static func makeRuleLists() async -> [WKContentRuleList] {
        var lists: [WKContentRuleList] = []
        // WKContentRuleListStore.default() 返回 optional，先解开
        guard let store = WKContentRuleListStore.default() else { return lists }

        let hostRules = blockedHosts.map { host in
            #"{"trigger":{"url-filter":".*","if-domain":["*\#(host)"]},"action":{"type":"block"}}"#
        }
        let netJSON = "[" + (hostRules + adPathRules).joined(separator: ",") + "]"
        let netID = "hj-net-" + digest(netJSON)

        // 先查编译缓存：WebKit 编译过的规则会落盘，命中就零编译直接加载。
        // 二次启动时这一步把「解析 + 编译 53 条规则」整个省掉，规则能赶在首屏请求前就位。
        if let cachedNet = await cachedList(store, netID) {
            lists.append(cachedNet)
        } else if let net = try? await store.compileContentRuleList(
            forIdentifier: netID, encodedContentRuleList: netJSON) {
            lists.append(net)
        }

        let cssJSON = #"{"trigger":{"url-filter":".*"},"action":{"type":"css-display-none","selector":"\#(splashSelectors)"}}"#
        let cssID = "hj-css-" + digest(cssJSON)
        if let cachedCss = await cachedList(store, cssID) {
            lists.append(cachedCss)
        } else if let css = try? await store.compileContentRuleList(
            forIdentifier: cssID, encodedContentRuleList: "[" + cssJSON + "]") {
            lists.append(css)
        }

        // 清掉旧 identifier 留下的缓存，免得越积越多
        dropList(store, "haijiao-adblock-net")
        dropList(store, "haijiao-adblock-css")
        return lists
    }

    // MARK: - 第 2 层：CSS

    /// 与网络层 css-display-none 同一批选择器；这里带 ` i` 大小写标志，
    /// 因为这是真 CSS 引擎（Content Blocker 那份不认）。
    static let css = """
    /* 实测到的挡屏物 —— 首帧就藏 */
    .topbanmer, .addbox,
    .van-dialog.luodiconfirm, .van-dialog.luodisconfirm,
    /* 滚动硬兜底：vant 的 .van-overflow-hidden{overflow:hidden!important} 一旦残留，
       WKWebView 的 contentSize 就被限死，整页划不动。这条特异性更高，直接把 Y 方向放开，
       不等 JS 去解锁（JS 那条路还有"弹窗还在时不动手"的时序问题）。 */
    body.van-overflow-hidden { overflow-y: auto !important; }
    /* 同域下发的广告位（站点换名字时的兜底） */
    [class*="advert" i], [id*="advert" i],
    [class*="adsbygoogle" i], ins.adsbygoogle,
    [class*="ad-banner" i], [class*="adbanner" i],
    [class*="ad-box" i], [class*="ad-wrap" i], [class*="ad-container" i],
    [class*="interstitial" i], [class*="guanggao" i],
    /* 广告 iframe */
    iframe[src*="doubleclick" i], iframe[src*="googlesyndication" i] {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        width: 0 !important;
    }
    """

    // MARK: - 第 3 层：站点清理（documentStart）

    /// 注入时机 .atDocumentStart。
    ///
    /// 只做实测有效的三件事，且**只对新增节点动手**（不遍历全站、不测量几何）：
    ///   · .topbanmer / .addbox 出现即摘掉
    ///   · .van-dialog.luodiconfirm / .luodisconfirm 出现即点确认再摘掉
    ///   · 配套的 .van-overlay 一起摘
    ///
    /// 开销护栏：MutationObserver 只看 body 的直接子节点（不开 subtree），
    /// 20 秒后自动断开；另外前 16 秒每 400ms 用精确选择器兜底扫一次（40 次上限）。
    static let siteJS = """
    (function () {
      if (window.__hj_strip) return;
      window.__hj_strip = true;

      var LOG = window.__hj_strip_log = [];
      var PRECISE = '.topbanmer, .addbox';
      var DIALOG = '.van-dialog.luodiconfirm, .van-dialog.luodisconfirm';

      function clsOf(el) {
        var c = el.className;
        if (c && c.baseVal !== undefined) c = c.baseVal;
        return String(c || '');
      }

      function rm(el, why) {
        if (!el || !el.parentNode) return;
        var label = why + ':' + clsOf(el).slice(0, 40);
        try { el.remove(); } catch (e) {}
        if (LOG.length < 30) LOG.push(label);
      }

      function clickConfirm(dlg) {
        var btn = null;
        // 只点「确认」，绝不点「取消」：
        // vant 的 dialog footer 里取消键通常排在前面，用 'button' 兜底会先命中取消键。
        try { btn = dlg.querySelector('.van-dialog__confirm'); } catch (e) {}
        if (!btn) { try { btn = dlg.querySelector('.van-dialog__footer button:last-child'); } catch (e) {} }
        if (!btn) { try { btn = dlg.querySelector('button'); } catch (e) {} }
        if (btn) { try { btn.click(); } catch (e) {} }
        // 只摘自己的节点并解锁；遮罩留给 300ms 的 sweep 统一判（这里清会误伤链式弹窗的下一层遮罩）
        setTimeout(function () { rm(dlg, 'dialog'); var m = hasVisibleModal(); unlockBody(m); }, 80);
      }

      // 只看「新增节点」，命中就处理
      function onNode(n) {
        try {
          if (!n || n.nodeType !== 1) return;
          var cls = clsOf(n);
          if (/\\b(topbanmer|addbox)\\b/.test(cls)) { rm(n, 'box'); return; }
          if (/luodiconfirm|luodisconfirm/.test(cls)) { clickConfirm(n); return; }
          // 任何遮罩 / 弹窗类节点出现，120ms 后复查一次（这时链式弹窗/兄弟节点都插完了）
          if (/^van-overlay/.test(cls) || /van-(dialog|popup|action-sheet)/.test(cls)) {
            setTimeout(function () {
              var m = hasVisibleModal();
              sweepOverlays(m);
              unlockBody(m);
            }, 120);
          }
        } catch (e) {}
      }

      // 站点用 vant 的滚动锁：弹窗一开就给 body（有时连 html）加 van-overflow-hidden。
      // 我们把弹窗节点删了，vant 自己的清理就被「外力移除」打断 —— 这个 class 会留下，
      // 整页就滚不动（用户看到的是「往下划不动」）。
      //
      // 判据必须看「有没有**可见**的弹窗」：站点常驻一个 display:none 的 .van-popup（抽屉/筛选面板），
      // 只用 querySelector 判断存在性的话，永远都会以为「有弹窗」，锁就永远解不开 —— 1.0.7/1.0.8 就是栽在这。
      function hasVisibleModal() {
        try {
          var vh = window.innerHeight || 800;
          var mods = document.querySelectorAll('.van-dialog, .van-popup, .van-action-sheet');
          for (var i = 0; i < mods.length; i++) {
            var el = mods[i], cs = null;
            try { cs = getComputedStyle(el); } catch (e) {}
            if (!cs) continue;
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            if (parseFloat(cs.opacity || '1') < 0.05) continue;
            var r = el.getBoundingClientRect();
            if (r.width <= 8 || r.height <= 8) continue;
            // dialog / action-sheet 天生就是模态；.van-popup 还可能是「客服悬浮面板」「筛选下拉」
            // 这种小东西 —— 把它算成模态的话，页面的锁就永远解不开，又回到「划不动」。
            var isDialog = /van-dialog|van-action-sheet/.test(String(el.className || '')) ||
                           el.getAttribute('role') === 'dialog';
            if (!isDialog && r.height < vh * 0.15) continue;
            return true;
          }
        } catch (e) {}
        return false;
      }

      // 孤儿遮罩：vant 的 .van-overlay 是全屏、pointer-events 默认 auto。
      // 弹窗被我们删掉后，遮罩继续盖着吃触摸 —— 表现就是「等一会才能划动」。
      //
      // 判定用「全局」而不是「相邻兄弟」：vant 的 overlay 和 dialog 在不同版本里
      // 未必紧挨着（可能被 wrapper 隔开），按兄弟判会误删正常模态的遮罩 —— 那会让背景点穿。
      // 规则只有一条：**有可见弹窗容器就全部保留，没有就全部清掉**。
      function sweepOverlays(modalVisible) {
        try {
          var modal = (typeof modalVisible === 'boolean') ? modalVisible : hasVisibleModal();
          if (modal) return;
          var ovs = document.querySelectorAll('.van-overlay, .van-mask');
          for (var i = 0; i < ovs.length; i++) {
            var ov = ovs[i];
            if (!ov.parentNode) continue;
            var cs = null;
            try { cs = getComputedStyle(ov); } catch (e) {}
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
            try { ov.style.pointerEvents = 'none'; } catch (e) {}
            try { ov.remove(); } catch (e) {}
            if (LOG.length < 30) LOG.push('overlay');
          }
        } catch (e) {}
      }

      function stripLock(el, tag) {
        if (!el) return false;
        var cls = String(el.className || '');
        if (cls.indexOf('van-overflow-hidden') < 0) return false;
        el.className = cls.split(/\\s+/).filter(function (x) {
          return x && x !== 'van-overflow-hidden';
        }).join(' ');
        if (LOG.length < 30) LOG.push('unlock:' + tag);
        return true;
      }

      function unlockBody(modalVisible) {
        try {
          var b = document.body, h = document.documentElement;
          // 平时零开销：只有真的被锁才往下走
          var locked = String((b && b.className) || '').indexOf('van-overflow-hidden') >= 0 ||
                       String((h && h.className) || '').indexOf('van-overflow-hidden') >= 0 ||
                       !!(b && b.style && (b.style.overflow === 'hidden' || b.style.overflowY === 'hidden'));
          if (!locked) return;
          var modal = (typeof modalVisible === 'boolean') ? modalVisible : hasVisibleModal();
          if (modal) return;                    // 真弹窗在，锁是合理的
          stripLock(b, 'body');
          stripLock(h, 'html');
          if (b && b.style) {
            if (b.style.overflow) b.style.overflow = '';
            if (b.style.overflowY) b.style.overflowY = '';
          }
          // 遮罩的清理统一交给 sweepOverlays()：这里再清一次会和它口径不一致（按兄弟判会误删正常模态遮罩）
        } catch (e) {}
      }

      // 精确选择器兜底（只查 4 个选择器，不扫全站）
      function sweepPrecise() {
        try {
          var boxes = document.querySelectorAll(PRECISE);
          for (var i = 0; i < boxes.length; i++) rm(boxes[i], 'box');
        } catch (e) {}
        try {
          var dlg = document.querySelectorAll(DIALOG);
          for (var j = 0; j < dlg.length; j++) clickConfirm(dlg[j]);
        } catch (e) {}
        // 先点掉弹窗，再判定一次「现在还有没有可见弹窗」，两处清理共用同一个结论
        var modal = hasVisibleModal();
        sweepOverlays(modal);
        unlockBody(modal);
      }

      var mo = null;

      function attachObserver() {
        try {
          if (mo) { try { mo.disconnect(); } catch (e) {} }
          mo = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
              var added = records[i].addedNodes;
              for (var k = 0; k < added.length; k++) onNode(added[k]);
            }
          });
          // documentStart 时 body 还没建出来：先盯 documentElement，等 DOMContentLoaded 换成 body。
          // 只盯「直接子节点」的 childList，不开 subtree —— 站点首屏 DOM 变动极其频繁。
          mo.observe(document.body || document.documentElement, { childList: true });
        } catch (e) {}
      }

      function start() {
        attachObserver();
        if (!document.body) {
          document.addEventListener('DOMContentLoaded', function () {
            attachObserver();      // body 到手了，重新挂到 body 上，否则只看得到 html 的直接子节点
            sweepPrecise();
          }, { once: true });
        }
        setTimeout(function () { if (mo) { try { mo.disconnect(); } catch (e) {} } }, 20000);

        sweepPrecise();
        var n = 0;
        var t = setInterval(function () {
          sweepPrecise();
          if (++n >= 15) { try { clearInterval(t); } catch (e) {} }
        }, 300);
      }

      window.__hj_strip_now = sweepPrecise;
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    })();
    """

    // MARK: - 第 4 层：收尾清理（documentEnd）

    /// 轻量收尾：封 window.open（弹窗广告主要来源）、过滤广告 alert、
    /// 清掉广告域的 iframe/script，并按递减节奏用精确选择器再扫（SPA 换页会重插节点）。
    static let js = """
    (function () {
      if (window.__hj_adblock) return;
      window.__hj_adblock = true;

      // 1) 封 window.open
      try { window.open = function () { return null; }; } catch (e) {}

      // 2) 过滤广告文案 alert（站点偶尔用 alert 弹推广）
      var _alert = window.alert;
      window.alert = function (msg) {
        var s = String(msg || '');
        if (/广告|推广|下载|扫码|关注|加群|加微信|telegram|飞机/i.test(s)) return;
        return _alert && _alert.call(window, msg);
      };

      // 3) 广告域 iframe / script
      function dropAdNodes() {
        try {
          var sel = 'iframe[src*="doubleclick" i],iframe[src*="googlesyndication" i],' +
                    'script[src*="popads" i],script[src*="propellerads" i],' +
                    'img[src*="adsterra" i],img[src*="exoclick" i]';
          var junk = document.querySelectorAll(sel);
          for (var i = 0; i < junk.length; i++) { try { junk[i].remove(); } catch (e) {} }
        } catch (e) {}
      }

      // 4) 每 1.2 秒兜底一次（精确选择器 + 广告节点），SPA 换页后也管用
      function tick() {
        dropAdNodes();
        if (window.__hj_strip_now) { try { window.__hj_strip_now(); } catch (e) {} }
      }
      // 延后 600ms 启动：documentEnd 正好是站点渲染首屏的时刻，别在这时候抢主线程。
      // 节奏：前 16 轮 1.2 秒一次（首屏 + 换页最需要），之后降到 5 秒一次 —— 永久高频没有意义，
      // 每次都要在全文档上跑属性选择器，纯烧 WebContent 主线程。
      var rounds = 0;
      function loop() {
        tick();
        var gap = (rounds++ < 16) ? 1200 : 5000;
        setTimeout(loop, gap);
      }
      setTimeout(loop, 600);

      // 5) body 直接子节点变动就清一次（去抖 300ms；不开 subtree，避免站点首屏把回调打爆）
      try {
        var pending = false;
        new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; tick(); }, 300);
        }).observe(document.body || document.documentElement, { childList: true });
      } catch (e) {}
    })();
    """

    // MARK: - 可选：几何开屏杀手（默认不注入）

    /// 只在站点以后真的加了「铺满视口的开屏浮层」时才需要。
    /// 判定靠 document.elementsFromPoint + 覆盖面积，会触发强制布局 —— 谨慎开。
    static let launchJS = """
    (function () {
      if (window.__hj_splash) return;
      window.__hj_splash = true;

      var T0 = Date.now();
      var WINDOW_MS = 12000;
      var MAX_HITS = 10;
      var MIN_GAP = 90;
      var hits = window.__hj_splash_kills = [];
      var touched = false;
      var done = false;
      var lastRun = 0;
      var timer = null;

      try {
        ['touchstart', 'pointerdown', 'mousedown', 'keydown', 'wheel'].forEach(function (n) {
          window.addEventListener(n, function () { touched = true; },
            { capture: true, passive: true });
        });
      } catch (e) {}

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

      function layerOf(el) {
        var n = el, depth = 0;
        while (n && n.nodeType === 1 && depth < 6) {
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

      var PTS = [[0.5, 0.5], [0.86, 0.08], [0.5, 0.06]];

      function findOverlay() {
        if (!document.elementsFromPoint) return null;
        var W = vw(), H = vh();
        for (var i = 0; i < PTS.length; i++) {
          var x = Math.round(W * PTS[i][0]);
          var y = Math.round(H * PTS[i][1]);
          var stack = null;
          try { stack = document.elementsFromPoint(x, y); } catch (e) {}
          if (!stack || !stack.length) continue;
          for (var j = 0; j < stack.length && j < 3; j++) {
            var el = stack[j];
            if (!el || el.nodeType !== 1) continue;
            if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;
            var layer = layerOf(el);
            if (layer) return layer;
          }
        }
        return null;
      }

      function kill(layer) {
        var tag = null;
        try { tag = layer.getAttribute && layer.getAttribute('data-hj-killed'); } catch (e) {}
        if (tag === '1') return false;
        var label = nameOf(layer).slice(0, 60) || layer.tagName;
        try { layer.remove(); } catch (e) {}
        if (layer.parentNode) { try { layer.style.display = 'none'; } catch (e2) {} }
        try { layer.setAttribute('data-hj-killed', '1'); } catch (e3) {}
        if (hits.length < 40) hits.push(label);
        return true;
      }

      function stop() {
        done = true;
        if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
      }

      function scan() {
        try {
          if (done) return;
          if (touched) { stop(); return; }
          if (hits.length >= MAX_HITS) { stop(); return; }
          if (Date.now() - T0 > WINDOW_MS) { stop(); return; }
          var now = Date.now();
          if (now - lastRun < MIN_GAP) return;
          lastRun = now;
          var vs = document.visibilityState;
          if (vs && vs !== 'visible') return;
          var layer = findOverlay();
          if (!layer) return;
          if (layer.isConnected === false) return;
          kill(layer);
        } catch (e) { stop(); }
      }

      function schedule() {
        if (done) return;
        var gap = (Date.now() - T0) < 2500 ? 100 : 350;
        timer = setTimeout(function () {
          timer = null;
          scan();
          schedule();
        }, gap);
      }

      window.__hj_scan = function () {
        touched = false; done = false; T0 = Date.now();
        var layer = null;
        try { layer = findOverlay(); } catch (e) {}
        return layer ? kill(layer) : false;
      };

      scan();
      schedule();
    })();
    """

    private static func jsArray(_ items: [String]) -> String {
        "[" + items.map { "\"\($0)\"" }.joined(separator: ",") + "]"
    }
}
