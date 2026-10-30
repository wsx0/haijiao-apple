// fetch-site.mjs —— 在 CI（海外 runner）上抓 haijiao.com 的真实页面结构
//
// 目的：搞清楚「开屏广告」到底是什么 —— 是 DOM 浮层、独立路由、还是 iframe/图片墙。
// 产出（out/ 目录，随 artifact 回传）：
//   meta.json      URL / 状态码 / 最终地址 / cookie / 标题
//   dom.html       渲染后的整页 HTML
//   overlays.json  「铺满视口的浮层」清单：选择器路径、class/id、rect、outerHTML 片段
//   requests.json  页面发出的全部请求（含 xhr/fetch/image，用来找广告域名与接口）
//   shot-*.png     0.6s / 2s / 5s 三张截图（开屏通常在这个窗口）
//   js/*.js        首页引用的全部 script bundle（静态分析用）
//
// 即使浏览器被 Cloudflare 拦，静态抓取那部分也会照跑，至少有 bundle 可分析。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HOME = ['https://haijiao.com/home', 'https://haijiao.com/'];

const write = async (p, data) => {
  const fp = path.join(OUT, p);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, data);
  console.log('wrote', fp, (data.length ?? data.byteLength ?? 0), 'bytes');
};

// ── 1. 静态抓取：首页 HTML + 所有 script bundle ───────────────────────────
async function staticFetch() {
  const report = {};
  for (const u of HOME) {
    try {
      const r = await fetch(u, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      });
      const body = await r.text();
      report[u] = { status: r.status, finalUrl: r.url, len: body.length, ct: r.headers.get('content-type') };
      const name = u.includes('/home') ? 'home' : 'root';
      await write(`static/${name}.html`, body);

      const srcs = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]);
      const css = [...body.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/g)].map(m => m[1]);
      await write(`static/${name}-scripts.json`, JSON.stringify({ srcs, css }, null, 2));

      for (const s of srcs.slice(0, 40)) {
        const abs = s.startsWith('http') ? s : new URL(s, u).href;
        if (!abs.includes('haijiao.com')) continue;
        try {
          const jr = await fetch(abs, { headers: { 'user-agent': UA } });
          const js = await jr.text();
          const fn = abs.split('/').pop().split('?')[0];
          await write(`js/${fn}`, js);
          console.log('  bundle', fn, jr.status, js.length);
        } catch (e) { console.log('  bundle fail', abs, e.message); }
      }
    } catch (e) {
      report[u] = { error: e.message };
    }
  }
  await write('static/report.json', JSON.stringify(report, null, 2));
}

// ── 2. 浏览器渲染：抓开屏浮层的真实结构 ──────────────────────────────────
async function browserDump(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  // 抹掉 headless 痕迹
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();
  const requests = [];
  page.on('request', r => requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
  page.on('response', async r => {
    try {
      const req = requests.find(x => x.url === r.url() && x.status === undefined);
      if (req) req.status = r.status();
    } catch (e) {}
  });
  page.on('pageerror', e => console.log('  pageerror:', e.message));

  const meta = { url };
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    meta.status = resp ? resp.status() : null;

    // 开屏广告一般 0.3–1.5 秒内出现：分三段截图 + 取样
    const shots = [[600, 'shot-600ms'], [1600, 'shot-1.6s'], [4200, 'shot-4.2s']];
    let last = 0;
    for (const [t, name] of shots) {
      await page.waitForTimeout(t - last);
      last = t;
      try { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }); }
      catch (e) { console.log('  shot fail', name, e.message); }
      const snap = await page.evaluate(() => {
        const W = innerWidth, H = innerHeight;
        const pathOf = el => {
          const parts = [];
          let n = el, d = 0;
          while (n && n.nodeType === 1 && d < 5) {
            let s = n.tagName.toLowerCase();
            if (n.id) s += '#' + n.id;
            const c = (n.className && n.className.baseVal === undefined ? n.className : '') || '';
            if (c) s += '.' + String(c).trim().split(/\s+/).slice(0, 3).join('.');
            parts.unshift(s);
            n = n.parentElement; d++;
          }
          return parts.join('>');
        };
        const out = [];
        const all = document.querySelectorAll('div,section,iframe,img,a,video,picture,canvas');
        for (const el of all) {
          if (el.tagName === 'IMG' && el.closest('div')) continue; // 只要容器
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.05) continue;
          const cover = r.width >= W * 0.7 && r.height >= H * 0.5;
          const floating = cs.position === 'fixed' || cs.position === 'absolute';
          if (!(cover && floating)) continue;
          out.push({
            path: pathOf(el),
            tag: el.tagName,
            id: el.id || '',
            cls: String((el.className && el.className.baseVal === undefined ? el.className : '') || ''),
            pos: cs.position,
            z: cs.zIndex,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
            html: el.outerHTML.slice(0, 1500),
          });
        }
        return { href: location.href, title: document.title, vw: W, vh: H, overlays: out };
      });
      meta[name] = { href: snap.href, title: snap.title, overlayCount: snap.overlays.length };
      await write(`overlays-${name}.json`, JSON.stringify(snap, null, 2));
    }

    await write('dom.html', await page.content());
    meta.finalUrl = page.url();
    meta.cookies = (await ctx.cookies()).map(c => `${c.name}=${c.value}`.slice(0, 200));
  } catch (e) {
    meta.error = e.message;
    console.log('  browser error:', e.message);
  }
  await write('requests.json', JSON.stringify(requests, null, 2));
  await write('meta.json', JSON.stringify(meta, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
console.log('=== 静态抓取 ===');
await staticFetch();
console.log('=== 浏览器渲染 ===');
await browserDump(HOME[0]);
console.log('done');
