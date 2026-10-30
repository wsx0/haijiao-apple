// perf-probe.mjs —— 首屏性能量化：A 原样 vs B 套上我们的去广告规则，同一台 CI 机器跑
//
// 量的是：响应/解析/load 时刻、FCP、请求数与传输字节、longtask（主线程长任务）次数与总时长、DOM 节点数。
// 目的：证明「去广告到底是让页面变快还是变慢」，以及瓶颈到底在站点自身还是我们的脚本。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out4';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HOME = 'https://haijiao.com/home';

const BLOCK = [
  '**/api/banner/banner_list*',
  '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**',
  '**/www.googletagmanager.com/**',
  '**/static.cloudflareinsights.com/**',
];

const CSS = `
  .topbanmer, .addbox,
  .van-dialog.luodiconfirm, .van-dialog.luodisconfirm { display: none !important; }
`;

// 与 App 里 siteJS 等价的精简版（用于测量脚本本身的开销）
const SITE_JS = `
(function () {
  if (window.__hj_strip) return;
  window.__hj_strip = true;
  function clsOf(el) { var c = el.className; return String((c && c.baseVal === undefined ? c : '') || ''); }
  function rm(el) { try { el.remove(); } catch (e) {} }
  function unlockBody() {
    try {
      var b = document.body; if (!b) return;
      if (document.querySelector('.van-dialog, .van-popup')) return;
      var cls = String(b.className || '');
      if (cls.indexOf('van-overflow-hidden') >= 0) {
        b.className = cls.split(/\\s+/).filter(function (x) { return x && x !== 'van-overflow-hidden'; }).join(' ');
      }
    } catch (e) {}
  }
  function clickConfirm(dlg) {
    var btn = null;
    try { btn = dlg.querySelector('.van-dialog__confirm'); } catch (e) {}
    if (btn) { try { btn.click(); } catch (e) {} }
    setTimeout(function () { rm(dlg); unlockBody(); }, 80);
  }
  function onNode(n) {
    try {
      if (!n || n.nodeType !== 1) return;
      var cls = clsOf(n);
      if (/\\b(topbanmer|addbox)\\b/.test(cls)) return rm(n);
      if (/luodiconfirm|luodisconfirm/.test(cls)) return clickConfirm(n);
    } catch (e) {}
  }
  function sweep() {
    try { document.querySelectorAll('.topbanmer, .addbox').forEach(rm); } catch (e) {}
    try { document.querySelectorAll('.van-dialog.luodiconfirm, .van-dialog.luodisconfirm').forEach(clickConfirm); } catch (e) {}
    unlockBody();
  }
  function start() {
    try {
      var mo = new MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          var a = recs[i].addedNodes;
          for (var k = 0; k < a.length; k++) onNode(a[k]);
        }
      });
      mo.observe(document.body || document.documentElement, { childList: true });
      setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 20000);
    } catch (e) {}
    sweep();
    var n = 0;
    var t = setInterval(function () { sweep(); if (++n >= 10) clearInterval(t); }, 600);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
`;

const END_JS = `
(function () {
  if (window.__hj_adblock) return;
  window.__hj_adblock = true;
  try { window.open = function () { return null; }; } catch (e) {}
  function tick() {
    try {
      document.querySelectorAll('iframe[src*="doubleclick" i],iframe[src*="googlesyndication" i]').forEach(function (n) { n.remove(); });
    } catch (e) {}
    if (window.__hj_strip) { /* siteJS 自己带兜底 */ }
  }
  setTimeout(function () { tick(); setInterval(tick, 2500); }, 600);
})();
`;

async function probe(label, strip) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.__lt = [];
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) { window.__lt.push(Math.round(e.duration)); });
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  });

  const page = await ctx.newPage();
  if (strip) {
    for (const p of BLOCK) await page.route(p, r => r.abort());
    await ctx.addInitScript(css => {
      const add = () => {
        const s = document.createElement('style');
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
      };
      if (document.documentElement) add();
      else document.addEventListener('DOMContentLoaded', add, { once: true });
    }, CSS);
    await ctx.addInitScript(SITE_JS);
    await ctx.addInitScript(END_JS);
  }

  const t0 = Date.now();
  let gotoErr = null;
  try {
    await page.goto(HOME, { waitUntil: 'load', timeout: 60000 });
  } catch (e) { gotoErr = e.message; }
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paints = {};
    performance.getEntriesByType('paint').forEach(p => { paints[p.name] = Math.round(p.startTime); });
    const res = performance.getEntriesByType('resource');
    const byType = {}; let bytes = 0;
    res.forEach(r => { byType[r.initiatorType] = (byType[r.initiatorType] || 0) + 1; bytes += (r.transferSize || 0); });
    const lts = window.__lt || [];
    return {
      responseEnd: Math.round(nav.responseEnd || 0),
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      fcp: paints['first-contentful-paint'] || null,
      requests: res.length,
      transferKB: Math.round(bytes / 1024),
      byType,
      longTasks: lts.length,
      longTaskMs: lts.reduce((a, b) => a + b, 0),
      domNodes: document.getElementsByTagName('*').length,
      hasBanner: !!document.querySelector('.topbanmer'),
      hasAddbox: !!document.querySelector('.addbox'),
      bodyLocked: String(document.body.className || '').indexOf('van-overflow-hidden') >= 0,
    };
  });

  await ctx.close();
  await browser.close();
  return { label, strip, loadMs, gotoErr, ...m };
}

await fs.mkdir(OUT, { recursive: true });
const A = await probe('A-original', false);
const B = await probe('B-stripped', true);
const out = { A, B };
await fs.writeFile(path.join(OUT, 'perf.json'), JSON.stringify(out, null, 2));

const rows = [
  ['load 等待(ms)', A.loadMs, B.loadMs],
  ['响应结束(ms)', A.responseEnd, B.responseEnd],
  ['DOMContentLoaded(ms)', A.dcl, B.dcl],
  ['load 事件(ms)', A.loadEvent, B.loadEvent],
  ['FCP(ms)', A.fcp, B.fcp],
  ['请求数', A.requests, B.requests],
  ['传输(KB)', A.transferKB, B.transferKB],
  ['longtask 次数', A.longTasks, B.longTasks],
  ['longtask 总时长(ms)', A.longTaskMs, B.longTaskMs],
  ['DOM 节点', A.domNodes, B.domNodes],
  ['横幅还在', A.hasBanner, B.hasBanner],
  ['PWA 条还在', A.hasAddbox, B.hasAddbox],
  ['body 被锁', A.bodyLocked, B.bodyLocked],
];
console.log('\n指标'.padEnd(24) + 'A 原样'.padStart(12) + 'B 去广告'.padStart(12));
for (const [k, a, b] of rows) console.log(String(k).padEnd(24) + String(a).padStart(12) + String(b).padStart(12));
console.log('\nA byType:', JSON.stringify(A.byType));
console.log('B byType:', JSON.stringify(B.byType));
