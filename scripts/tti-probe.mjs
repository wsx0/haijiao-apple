// tti-probe.mjs —— 「等一会才能划动」到底在等什么
//
// 桌面 Chromium 跑得太快，掩盖了问题。这里把 CPU 降到 1/4（大致相当于中端 iPhone 相对 CI runner），
// 然后同时测三件事：
//   1. longtask：主线程被谁占着（带 attribution，能指到具体脚本 URL）
//   2. 首次可滚动时间：每 150ms 试着 scrollTo，记录「什么时候才滚得动」
//   3. 是否存在内部虚拟滚动容器（better-scroll 那类 transform 位移，WKWebView 里表现就是划不动）
//
// 注入我们真实的 siteJS（从 Swift 抽），所以测的就是 App 里的行为。

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

async function probe(label, { throttle, inject }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }

  // 主线程长任务 + 归属
  await ctx.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const a = (e.attribution && e.attribution[0]) || {};
          window.__lt.push({
            start: Math.round(e.startTime),
            dur: Math.round(e.duration),
            name: a.name || a.containerName || '',
            type: a.containerType || '',
          });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  });

  if (inject) {
    await ctx.addInitScript(SITE_JS);
    // 每 150ms 试滚一次，记录首次滚得动的时刻（= 用户能划动的时间）
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

  const t0 = Date.now();
  try {
    await page.goto(HOME, { waitUntil: 'load', timeout: 90000 });
  } catch (e) { console.log(`  [${label}] goto:`, e.message); }
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(6000);

  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const lts = (window.__lt || []).slice();
    const total = lts.reduce((a, b) => a + b.dur, 0);
    const byName = {};
    for (const t of lts) {
      const k = (t.name || '(inline/unknown)').split('/').pop().slice(0, 46) || '(inline)';
      byName[k] = (byName[k] || 0) + t.dur;
    }
    // 内部虚拟滚动容器（better-scroll 特征：有 transform 位移且内容远高于自身）
    const virtualScrollers = [...document.querySelectorAll('#app div, #app section')]
      .map(el => ({ el, cs: getComputedStyle(el), r: el.getBoundingClientRect() }))
      .filter(x => /translate|matrix/.test(x.cs.transform) && x.el.scrollHeight > x.el.clientHeight + 100)
      .slice(0, 5)
      .map(x => ({
        cls: String(x.el.className).slice(0, 50),
        transform: x.cs.transform.slice(0, 40),
        clientH: x.el.clientHeight,
        scrollH: x.el.scrollHeight,
      }));
    return {
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
      clientHeight: (document.scrollingElement || document.documentElement).clientHeight,
      longTasks: lts.length,
      longTaskMs: total,
      longest: lts.slice().sort((a, b) => b.dur - a.dur).slice(0, 6),
      byName,
      firstScrollableAt: window.__firstScrollableAt,
      virtualScrollers,
      bodyClass: String(document.body.className),
      overlays: document.querySelectorAll('.van-overlay').length,
    };
  });

  await ctx.close();
  await browser.close();
  return { label, throttle: throttle || 1, inject, loadMs, ...m };
}

await fs.mkdir(OUT, { recursive: true });
const runs = [];
runs.push(await probe('A-1x',      { throttle: 0, inject: true }));   // 不节流
runs.push(await probe('B-4x',      { throttle: 4, inject: true }));   // 4x 节流（模拟手机）
runs.push(await probe('C-4x-nojs', { throttle: 4, inject: false }));  // 4x 节流，不注入我们脚本

await fs.writeFile(path.join(OUT, 'tti.json'), JSON.stringify(runs, null, 2));
for (const r of runs) {
  console.log(`\n===== ${r.label} (throttle=${r.throttle}x, siteJS=${r.inject}) =====`);
  console.log(`  DCL=${r.dcl}ms  load=${r.loadEvent}ms  goto=${r.loadMs}ms`);
  console.log(`  首次可滚 @ ${r.firstScrollableAt === null ? '始终滚不动(!)' : r.firstScrollableAt + 'ms'}`);
  console.log(`  文档 ${r.scrollHeight} / 视口 ${r.clientHeight}`);
  console.log(`  longtask: ${r.longTasks} 次 / ${r.longTaskMs}ms`);
  console.log(`  最长的几个: ${JSON.stringify(r.longest)}`);
  console.log(`  按脚本归属: ${JSON.stringify(r.byName)}`);
  console.log(`  内部虚拟滚动容器: ${JSON.stringify(r.virtualScrollers)}`);
  console.log(`  body=${JSON.stringify(r.bodyClass)} overlay=${r.overlays}`);
}
console.log('\ndone');
