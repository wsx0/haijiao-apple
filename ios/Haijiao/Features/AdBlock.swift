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
    static func makeRuleLists() async -> [WKContentRuleList] {
        var lists: [WKContentRuleList] = []
        // WKContentRuleListStore.default() 返回 optional，先解开
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

    /// 与网络层 css-display-none 同一批选择器；这里带 ` i` 大小写标志，
    /// 因为这是真 CSS 引擎（Content Blocker 那份不认）。
    static let css = """
    /* 实测到的挡屏物 —— 首帧就藏 */
    .topbanmer, .addbox,
    .van-dialog.luodiconfirm, .van-dialog.luodisconfirm,
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
        setTimeout(function () { rm(dlg, 'dialog'); unlockBody(); }, 80);
      }

      // 只看「新增节点」，命中就处理
      function onNode(n) {
        try {
          if (!n || n.nodeType !== 1) return;
          var cls = clsOf(n);
          if (/\\b(topbanmer|addbox)\\b/.test(cls)) { rm(n, 'box'); return; }
          if (/luodiconfirm|luodisconfirm/.test(cls)) { clickConfirm(n); return; }
          if (/^van-overlay/.test(cls)) {
            var next = n.nextElementSibling;
            if (next && /luodiconfirm|luodisconfirm/.test(clsOf(next))) rm(n, 'overlay');
          }
        } catch (e) {}
      }

      // 站点用 vant 的滚动锁：弹窗一开就给 body 加 van-overflow-hidden。
      // 我们把弹窗节点删了，vant 自己的清理就被「外力移除」打断 —— 这个 class 会留在 body 上，
      // 结果整页滚不动、看着像「点不动屏幕」。没有弹窗时就强制解锁。
      function unlockBody() {
        try {
          var b = document.body;
          if (!b) return;
          if (document.querySelector('.van-dialog, .van-popup')) return;   // 真有弹窗就不动
          var cls = String(b.className || '');
          if (cls.indexOf('van-overflow-hidden') >= 0) {
            b.className = cls.split(/\\s+/).filter(function (x) {
              return x && x !== 'van-overflow-hidden';
            }).join(' ');
            if (LOG.length < 30) LOG.push('unlock:body');
          }
          if (b.style) {
            if (b.style.overflow) b.style.overflow = '';
            if (b.style.overflowY) b.style.overflowY = '';
          }
          var stray = document.querySelectorAll('.van-overlay');
          for (var i = 0; i < stray.length; i++) {
            var ov = stray[i];
            var next = ov.nextElementSibling;
            var orphan = !next || !/van-dialog|van-popup/.test(String(next.className || ''));
            if (orphan) { try { ov.remove(); } catch (e) {} }
          }
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
        unlockBody();
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
          if (++n >= 20) { try { clearInterval(t); } catch (e) {} }
        }, 350);
      }

      window.__hj_strip_now = sweepPrecise;
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    })();
    """

    // MARK: - 第 4 层：收尾清理（documentEnd）

    /// 轻量收尾：封 window.open（弹窗广告主要来源）、过滤广告 alert、
    /// 清掉广告域的 iframe/script，并每 1.5 秒用精确选择器再扫一次（SPA 换页会重插节点）。
    static let js = """
    (function () {
      if (window.__hj_adblock) return;
      window.__hj_adblock = true;

      var HOSTS = \(jsArray(blockedHosts));

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

      // 4) 每 2.5 秒兜底一次（精确选择器 + 广告节点），SPA 换页后也管用
      function tick() {
        dropAdNodes();
        if (window.__hj_strip_now) { try { window.__hj_strip_now(); } catch (e) {} }
      }
      tick();
      setInterval(tick, 2500);

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
