// fetch-site2.mjs —— 「网页端先去广告」实验：同一站点，A 原样 / B 去广告，对比截图
//
// 去广告三件事（全部作用在网页层面，App 里搬同一套）：
//   1. 拦 POST /api/banner/banner_list（博彩横幅的数据源）与 hjstore/system/banner/* 图片
//   2. 自动点掉 .van-dialog.luodiconfirm 的「我知道了」（站点开屏会连弹三次）
//   3. 关掉底部「添加海角社区到主屏幕」PWA 引导条
//
// 产出：out2/A-*.png、B-*.png、report-A.json、report-B.json、banner-A.json（接口响应体）

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out2';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const URL_HOME = 'https://haijiao.com/home';
const BLOCK = ['**/api/banner/banner_list*', '**/hjstore/system/banner/**'];

const CHAIN_FN = `(el) => {
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1) {
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const c = (n.className && n.className.baseVal === undefined ? n.className : '') || '';
    if (c) s += '.' + String(c).trim().split(/\\s+/).slice(0, 3).join('.');
    parts.unshift(s);
    n = n.parentElement;
  }
  return parts.join(' > ');
}`;

async function probe(page) {
  return page.evaluate(({ chainSrc }) => {
    const chain = eval(chainSrc);
    const W = innerWidth, H = innerHeight;
    const clean = el => String((el.className && el.className.baseVal === undefined ? el.className : '') || '');
    const info = el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        chain: chain(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, z: cs.zIndex, pos: cs.position,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
        html: el.outerHTML.slice(0, 400),
      };
    };

    // 1) 站内轮播（banner 就挂在 van-swipe 里）
    const swipes = [...document.querySelectorAll('.van-swipe')].map(info);

    // 2) 开屏提示弹窗
    const dialogs = [...document.querySelectorAll('.van-dialog')].map(info);

    // 3) 底部 PWA 引导条（按文本找最小容器）
    const pwa = [];
    for (const el of document.querySelectorAll('div')) {
      if ((el.textContent || '').includes('添加海角社区到主屏幕') && el.querySelector('button')) {
        pwa.push(info(el));
      }
    }

    // 4) 遮罩
    const overlays = [...document.querySelectorAll('.van-overlay')].map(info);

    // 5) body 直接子元素（看整体层级）
    const bodyKids = [...document.body.children].map(el => chain(el).slice(-80));

    // 6) 视口里还剩多少「图片 + 广告嫌疑」
    const imgs = [...document.querySelectorAll('img[data-id^="banner_"]')]
      .map(el => ({ chain: chain(el).slice(-90), src: (el.getAttribute('src') || '').slice(0, 40), dataUrl: (el.getAttribute('data-url') || '').slice(-60) }));

    return { vw: W, vh: H, swipes, dialogs, pwa: pwa.slice(0, 3), overlays, bodyKids, imgs, html: document.documentElement.outerHTML.length };
  }, { chainSrc: CHAIN_FN });
}

async function run(label, { strip }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const page = await ctx.newPage();
  const reqs = [];
  const bannerBodies = [];

  if (strip) {
    for (const p of BLOCK) await page.route(p, r => r.abort());
    await ctx.addInitScript(() => {
      setInterval(() => {
        try {
          document.querySelectorAll('.van-dialog.luodiconfirm .van-dialog__confirm, .van-dialog.luodiconfirm button')
            .forEach(b => b.click());
          // PWA 引导条：只点带 cross 图标的关闭钮
          document.querySelectorAll('i.van-icon-cross').forEach(i => i.click());
        } catch (e) {}
      }, 300);
    });
  }

  page.on('request', r => reqs.push(`${r.resourceType()} ${r.url().slice(0, 160)}`));
  page.on('response', async r => {
    if (r.url().includes('/api/banner/banner_list')) {
      try { bannerBodies.push({ status: r.status(), body: (await r.text()).slice(0, 4000) }); } catch (e) {}
    }
  });
  page.on('pageerror', e => console.log(`  [${label}] pageerror:`, e.message));

  const marks = [600, 1600, 4200, 8000];
  const shots = [];
  let last = 0;
  const report = { label, marks: {} };
  try {
    await page.goto(URL_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    for (const t of marks) {
      await page.waitForTimeout(t - last); last = t;
      await page.screenshot({ path: path.join(OUT, `${label}-${t}ms.png`) });
      const snap = await probe(page);
      report.marks[t] = {
        swipes: snap.swipes.length, dialogs: snap.dialogs.length,
        overlays: snap.overlays.filter(o => o.display !== 'none').length,
        pwa: snap.pwa.length, bannerImgs: snap.imgs.length,
        htmlLen: snap.html,
        pwaChain: snap.pwa[0] ? snap.pwa[0].chain : '',
        dialogText: snap.dialogs[0] ? snap.dialogs[0].text.slice(0, 40) : '',
      };
      shots.push(snap);
    }
    report.final = shots[shots.length - 1];
    report.all = shots;
  } catch (e) {
    report.error = e.message;
    console.log(`  [${label}] error:`, e.message);
  }
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `report-${label}.json`), JSON.stringify(report, null, 2));
  if (bannerBodies.length) {
    await fs.writeFile(path.join(OUT, 'banner-response.json'), JSON.stringify(bannerBodies, null, 2));
  }
  console.log(`[${label}] 完成：`, JSON.stringify(report.marks[8000] || report.error));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
console.log('=== A：原样 ===');
await run('A', { strip: false });
console.log('=== B：去广告 ===');
await run('B', { strip: true });
console.log('done');
