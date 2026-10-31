// img3-probe.mjs —— 网页里图片到底怎么显示的（DOM 一手证据）
//
// 已知 .txt 内容是 #FEy + base64，解码后仍不是图片 → 还有一层。
// 但网页里图片确实显示，所以 img 的 src 一定是可直接加载的地址（blob:/data:/其他）。
// 这里把图片元素的全部属性、以及创建它们的 JS 调用抓出来。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out16';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const BLOCK = [
  '**/api/banner/banner_list*', '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**', '**/www.googletagmanager.com/**',
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  // hook：谁创建了 objectURL、谁给 img 赋 src、谁调了 atob
  await ctx.addInitScript(() => {
    window.__hj_trace = [];
    const rec = (k, v) => { try { window.__hj_trace.push({ k, v: String(v).slice(0, 200) }); } catch (e) {} };

    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) {
      const u = origCreate(b);
      rec('createObjectURL', (b && b.type ? b.type + ' ' : '') + (b && b.size) + 'B -> ' + u);
      return u;
    };

    const origAtob = window.atob;
    window.atob = function (s) {
      const out = origAtob(s);
      if (window.__hj_trace.length < 400) rec('atob', 'in=' + String(s).slice(0, 40) + ' outlen=' + out.length);
      return out;
    };

    // 监听 img src 赋值
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get() { return desc.get.call(this); },
        set(v) { rec('img.src', v); return desc.set.call(this, v); },
        configurable: true,
      });
    } catch (e) {}
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(3500);

  const imgs = await page.evaluate(() => {
    return [...document.querySelectorAll('img')].slice(0, 8).map(i => {
      const attrs = {};
      for (const a of i.attributes) attrs[a.name] = String(a.value).slice(0, 160);
      return {
        src: String(i.src).slice(0, 160),
        currentSrc: String(i.currentSrc).slice(0, 160),
        complete: i.complete,
        natural: `${i.naturalWidth}x${i.naturalHeight}`,
        attrs,
        parentClass: String(i.parentElement && i.parentElement.className).slice(0, 60),
      };
    });
  });

  const trace = await page.evaluate(() => (window.__hj_trace || []).slice(0, 60));

  console.log('=== 首页 img 元素 ===');
  for (const im of imgs) {
    console.log(`  natural=${im.natural}  complete=${im.complete}  parent=.${im.parentClass}`);
    console.log(`    src=${im.src}`);
    if (im.currentSrc && im.currentSrc !== im.src) console.log(`    currentSrc=${im.currentSrc}`);
    const d = Object.entries(im.attrs).filter(([k]) => !['src', 'class', 'style', 'width', 'height', 'alt'].includes(k));
    if (d.length) console.log('    attrs=' + JSON.stringify(d).slice(0, 220));
  }

  console.log('\n=== 追踪（前 40 条）===');
  for (const t of trace.slice(0, 40)) console.log(`  [${t.k}] ${t.v}`);

  // 页面是否有虚拟滚动/懒加载组件处理图片
  const hints = await page.evaluate(() => {
    const out = {};
    out.hasVue = !!document.querySelector('#app').__vue_app__ || !!window.__VUE__;
    out.scriptCount = document.querySelectorAll('script[src]').length;
    out.imgCount = document.querySelectorAll('img').length;
    // 找带 data-url 的元素
    const du = [...document.querySelectorAll('[data-url]')].slice(0, 3).map(e => ({
      tag: e.tagName, cls: String(e.className).slice(0, 40), dataUrl: String(e.getAttribute('data-url')).slice(0, 120),
      src: String(e.getAttribute('src') || '').slice(0, 120),
    }));
    out.dataUrlEls = du;
    return out;
  });

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'img3.json'), JSON.stringify({ imgs, trace, hints }, null, 2));
  await page.screenshot({ path: path.join(OUT, 'home.png') });
  console.log('\n=== 其他 ===');
  console.log(JSON.stringify(hints, null, 1).slice(0, 800));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
