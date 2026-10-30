// scroll-probe.mjs —— 「划不动」诊断：直接注入 App 里真实的 siteJS，然后量化能不能滚
//
// 不做猜测，只回答四个问题：
//   1. body / html 上有没有 vant 的滚动锁（van-overflow-hidden）、内联 overflow 是什么
//   2. 页面里到底哪个容器在滚（body？还是内部某个 overflow-y:auto 的 div）
//   3. 注入 siteJS 之后，window.scrollTo 能不能生效
//   4. 手动清掉锁之后能不能滚（= 锁确实是原因）
//
// siteJS 从 ios/Haijiao/Features/AdBlock.swift 里抽出来，测的就是 App 里跑的那段脚本。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out5';
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

// ── 从 Swift 里抽 siteJS（与 App 同源）────────────────────────────────
const swift = await fs.readFile('ios/Haijiao/Features/AdBlock.swift', 'utf8');
function sliceBlock(marker) {
  const i = swift.indexOf(marker);
  if (i < 0) throw new Error('找不到 ' + marker);
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
console.log('siteJS 抽出', SITE_JS.length, '字符');

const probed = async page => page.evaluate(() => {
  const se = document.scrollingElement || document.documentElement;
  const y0 = window.scrollY, t0 = se.scrollTop;
  const mods = [...document.querySelectorAll('.van-dialog, .van-popup')].map(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { cls: String(el.className).slice(0, 60), display: cs.display, pos: cs.position,
             w: Math.round(r.width), h: Math.round(r.height) };
  });
  const scrollers = [...document.querySelectorAll('div,section,main')].map(el => {
    const cs = getComputedStyle(el);
    return { el, cs };
  }).filter(x => (x.cs.overflowY === 'auto' || x.cs.overflowY === 'scroll') &&
                 x.el.scrollHeight > x.el.clientHeight + 20)
    .slice(0, 6)
    .map(x => {
      const r = x.el.getBoundingClientRect();
      return { id: x.el.id, cls: String(x.el.className).slice(0, 50),
               clientH: x.el.clientHeight, scrollH: x.el.scrollHeight, top: Math.round(r.top) };
    });
  window.scrollTo(0, 600);
  const y1 = window.scrollY, t1 = se.scrollTop;
  return {
    bodyClass: String(document.body.className),
    bodyInlineOverflow: document.body.style.overflow + '/' + document.body.style.overflowY,
    bodyComputedOverflow: getComputedStyle(document.body).overflowY,
    htmlClass: String(document.documentElement.className),
    touchAction: getComputedStyle(document.body).touchAction,
    scrollElTag: se.tagName, scrollHeight: se.scrollHeight, clientHeight: se.clientHeight,
    scrollYBefore: y0, scrollYAfter: y1, scrollTopBefore: t0, scrollTopAfter: t1,
    canScroll: (y1 > y0) || (t1 > t0),
    modals: mods,
    scrollers,
    bannersGone: !document.querySelector('.topbanmer'),
    addboxGone: !document.querySelector('.addbox'),
  };
});

const unlockAndTest = async page => page.evaluate(() => {
  const b = document.body;
  b.className = String(b.className || '').split(/\s+/).filter(x => x && x !== 'van-overflow-hidden').join(' ');
  b.style.overflow = ''; b.style.overflowY = '';
  const h = document.documentElement;
  h.className = String(h.className || '').split(/\s+/).filter(x => x && x !== 'van-overflow-hidden').join(' ');
  const se = document.scrollingElement || document.documentElement;
  const y0 = window.scrollY;
  window.scrollTo(0, 600);
  return { afterUnlockScrollY: window.scrollY, canScroll: window.scrollY > y0 || se.scrollTop > 0 };
});

async function run(label, { inject }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());
  if (inject) await ctx.addInitScript(SITE_JS);

  const state = { label };
  try {
    await page.goto(HOME, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    state.at3s = await probed(page);
    state.afterManualUnlock = await unlockAndTest(page);
    await page.screenshot({ path: path.join(OUT, `${label}.png`) });
  } catch (e) {
    state.error = e.message;
  }
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `scroll-${label}.json`), JSON.stringify(state, null, 2));
  console.log(`\n[${label}]`, JSON.stringify({
    bodyClass: state.at3s && state.at3s.bodyClass,
    bodyOverflow: state.at3s && state.at3s.bodyComputedOverflow,
    inline: state.at3s && state.at3s.bodyInlineOverflow,
    canScroll: state.at3s && state.at3s.canScroll,
    modals: state.at3s && state.at3s.modals,
    scrollers: state.at3s && state.at3s.scrollers,
    bannersGone: state.at3s && state.at3s.bannersGone,
    afterUnlock: state.afterManualUnlock,
  }, null, 1));
  await browser.close();
  return state;
}

await fs.mkdir(OUT, { recursive: true });
console.log('=== 注入 siteJS（App 同源脚本）===');
await run('with-sitejs', { inject: true });
console.log('=== 不注入（对照）===');
await run('no-sitejs', { inject: false });
console.log('done');
