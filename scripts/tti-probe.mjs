// tti-probe.mjs —— 「等一会才能划动」到底在等什么
//
// 桌面 Chromium 跑太快，掩盖问题。这里把 CPU 降到 1/4（大致相当于中端 iPhone 相对 CI runner），测：
//   1. longtask：主线程被占多久（带 attribution）
//   2. 首次可滚动时间：每 150ms 试着 scrollTo，记录「什么时候才滚得动」
//   3. 是否存在内部虚拟滚动容器（better-scroll 那类 transform 位移）
//   4. D 组：额外拦掉首页用不到的三个大库（webuploader / vendor-editor / dash.all），
//      看首屏可交互时间能压多少、功能有没有坏（视频封面数量、页面报错）
//
// 注入我们真实的 siteJS（从 Swift 抽），测的就是 App 里的行为。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out6';
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
const HEAVY = ['**/webuploader.min.js', '**/vendor-editor-*.js', '**/dash.all.min.js'];

const swift = await fs.readFile('ios/Haijiao/Features/AdBlock.swift', 'utf8');
function sliceBlock(marker) {
  const i = swift.indexOf(marker);
  const s = i + marker.length;
  const e = swift.indexOf('\n    """', s);
  return swift.slice(s, e);
}
function unswift(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[i + 1];
    if (n === '\\') { out += '\\'; i++; continue; }
    if (n === '"') { out += '"'; i++; continue; }
    out += c;
  }
  return out;
}
const SITE_JS = unswift(sliceBlock('static let siteJS = """'));

async function probe(label, opts) {
  const throttle = opts.throttle || 0;
  const inject = !!opts.inject;
  const heavy = opts.heavy || [];
  const blockHeavy = heavy.length > 0;

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());
  for (const p of heavy) await page.route(p, r => r.abort());

  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }

  await ctx.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const a = (e.attribution && e.attribution[0]) || {};
          window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration),
                             name: a.name || a.containerName || '', type: a.containerType || '' });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  });

  if (inject) {
    await ctx.addInitScript(SITE_JS);
    await ctx.addInitScript(() => {
      window.__firstScrollableAt = null;
      const tick = () => {
        if (window.__firstScrollableAt === null) {
          const se = document.scrollingElement || document.documentElement;
          if (se && se.scrollHeight > se.clientHeight + 50) {
            const before = window.scrollY;
            window.scrollTo(0, 200);
            if (window.scrollY > before) {
              window.__firstScrollableAt = Math.round(performance.now());
              window.scrollTo(0, 0);
              return;
            }
          }
        }
        setTimeout(tick, 150);
      };
      document.addEventListener('DOMContentLoaded', tick, { once: true });
    });
  }

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message.slice(0, 100)));

  const t0 = Date.now();
  try { await page.goto(HOME, { waitUntil: 'load', timeout: 90000 }); }
  catch (e) { console.log('  [' + label + '] goto:', e.message); }
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(6000);

  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const lts = (window.__lt || []).slice();
    const byName = {};
    for (const t of lts) {
      const k = (t.name || 'inline').split('/').pop().slice(0, 40);
      byName[k] = (byName[k] || 0) + t.dur;
    }
    const res = performance.getEntriesByType('resource');
    const scripts = res.filter(x => x.initiatorType === 'script');
    const virtualScrollers = [...document.querySelectorAll('#app div, #app section')]
      .map(el => ({ el, cs: getComputedStyle(el) }))
      .filter(x => /translate|matrix/.test(x.cs.transform) && x.el.scrollHeight > x.el.clientHeight + 100)
      .slice(0, 5)
      .map(x => ({ cls: String(x.el.className).slice(0, 44), clientH: x.el.clientHeight, scrollH: x.el.scrollHeight }));
    return {
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
      clientHeight: (document.scrollingElement || document.documentElement).clientHeight,
      longTasks: lts.length,
      longTaskMs: lts.reduce((a, b) => a + b.dur, 0),
      longest: lts.slice().sort((a, b) => b.dur - a.dur).slice(0, 5),
      byName,
      firstScrollableAt: window.__firstScrollableAt,
      virtualScrollers,
      bodyClass: String(document.body.className),
      overlays: document.querySelectorAll('.van-overlay').length,
      scriptCount: scripts.length,
      scriptKB: Math.round(scripts.reduce((a, b) => a + (b.transferSize || 0), 0) / 1024),
      videoCovers: document.querySelectorAll('img[data-url*="video"], img[src*="video"]').length,
      bannerGone: !document.querySelector('.topbanmer'),
    };
  });

  await fs.mkdir(OUT, { recursive: true });
  try { await page.screenshot({ path: path.join(OUT, label + '.png') }); } catch (e) {}
  await ctx.close();
  await browser.close();
  return { label, throttle, inject, blockHeavy, loadMs, pageErrors, ...m };
}

await fs.mkdir(OUT, { recursive: true });
const runs = [];
runs.push(await probe('A-1x', { throttle: 0, inject: true }));
runs.push(await probe('B-4x', { throttle: 4, inject: true }));
runs.push(await probe('C-4x-nojs', { throttle: 4, inject: false }));
runs.push(await probe('D-4x-dash-only', { throttle: 4, inject: true, heavy: ['**/dash.all.min.js'] }));
runs.push(await probe('E-4x-uploader-only', { throttle: 4, inject: true, heavy: ['**/webuploader.min.js'] }));

await fs.writeFile(path.join(OUT, 'tti.json'), JSON.stringify(runs, null, 2));
for (const r of runs) {
  console.log('\n===== ' + r.label + '  throttle=' + r.throttle + 'x  siteJS=' + r.inject + '  heavyBlocked=' + r.blockHeavy + ' =====');
  console.log('  DCL=' + r.dcl + 'ms  load=' + r.loadEvent + 'ms  goto=' + r.loadMs + 'ms');
  console.log('  首次可滚 @ ' + (r.firstScrollableAt === null ? '始终滚不动(!)' : r.firstScrollableAt + 'ms'));
  console.log('  文档 ' + r.scrollHeight + ' / 视口 ' + r.clientHeight);
  console.log('  longtask: ' + r.longTasks + ' 次 / ' + r.longTaskMs + 'ms');
  console.log('  最长: ' + r.longest.map(t => t.dur + 'ms@' + t.start).join(', '));
  console.log('  脚本: ' + r.scriptCount + ' 个 / ' + r.scriptKB + 'KB');
  console.log('  视频封面=' + r.videoCovers + '  bannerGone=' + r.bannerGone + '  overlay=' + r.overlays);
  console.log('  页面报错: ' + JSON.stringify((r.pageErrors || []).slice(0, 3)));
  console.log('  虚拟滚动容器: ' + JSON.stringify(r.virtualScrollers));
}
console.log('\ndone');
