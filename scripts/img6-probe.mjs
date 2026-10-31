// img6-probe.mjs —— 抓「同一张图」的密文与明文，用来反推那层等长变换
//
// 已知：.txt 内容是 #FEy + 30760 字符（等长变换），页面 img.src 是 data:image/jpeg;base64,…
// 只差一对完整样本。这里在页面里同时 hook XHR / fetch（抓密文）并读 img.src（抓明文），
// 用长度做配对，输出一份可直接离线反推的样本。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out19';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__hj_txt = [];
    const push = (url, body) => {
      if (!body || body.length < 500) return;
      window.__hj_txt.push({ url: String(url).slice(0, 200), len: body.length, body: body.slice(0, 42000) });
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return origOpen.apply(this, arguments); };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const u = String(this.__u || '');
          if (!/\.(jpg|jpeg|png|gif)\.txt|\.txt/.test(u)) return;
          const rt = this.responseType;
          if (rt === '' || rt === 'text') push(u, this.responseText);
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      return origFetch.apply(this, arguments).then(res => {
        try {
          if (/\.txt/.test(String(u))) res.clone().text().then(t => push(u, t)).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
  });

  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(5000);

  // 明文字典：img[data-id] → src
  const plain = await page.evaluate(() => {
    const out = [];
    for (const im of document.querySelectorAll('img[data-id]')) {
      const s = im.src || '';
      if (s.indexOf('data:image') === 0) {
        out.push({ id: im.getAttribute('data-id'), len: s.length, b64len: s.length - s.indexOf(',') - 1, head: s.slice(0, 80) });
      }
    }
    return out;
  });

  // 密文字典（分段取，避免单次 evaluate 过大）
  const count = await page.evaluate(() => (window.__hj_txt || []).length);
  const ciphers = [];
  for (let i = 0; i < Math.min(count, 6); i++) {
    const rec = await page.evaluate(i => {
      const t = (window.__hj_txt || [])[i];
      return t ? { url: t.url, len: t.len, body: t.body } : null;
    }, i);
    if (rec) ciphers.push(rec);
  }

  console.log(`明文 img: ${plain.length} 个`);
  for (const p of plain.slice(0, 5)) console.log(`  id=${p.id} len=${p.len} b64=${p.b64len} head=${p.head}`);
  console.log(`\n密文 .txt: ${count} 个`);
  for (const c of ciphers) console.log(`  len=${c.len} url=${c.url}`);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'plain.json'), JSON.stringify(plain, null, 2));
  await fs.writeFile(path.join(OUT, 'ciphers.json'), JSON.stringify(ciphers.map(c => ({ url: c.url, len: c.len })), null, 2));
  for (let i = 0; i < ciphers.length; i++) {
    await fs.writeFile(path.join(OUT, `cipher-${i}.txt`), ciphers[i].body);
  }

  // 明文需要完整长度：单独取前两张的完整 src
  const fullPlain = [];
  for (let i = 0; i < Math.min(plain.length, 3); i++) {
    const s = await page.evaluate(i => {
      const imgs = [...document.querySelectorAll('img[data-id]')].filter(x => (x.src || '').indexOf('data:image') === 0);
      const im = imgs[i];
      if (!im) return null;
      const src = im.src;
      const k = src.indexOf(',');
      return { id: im.getAttribute('data-id'), b64: src.slice(k + 1) };
    }, i);
    if (s) {
      const name = `plain-${i}-${s.id}.txt`;
      await fs.writeFile(path.join(OUT, name), s.b64);
      fullPlain.push({ id: s.id, file: name, len: s.b64.length });
      console.log(`  明文存盘 ${name} len=${s.b64.length}`);
    }
  }

  await fs.writeFile(path.join(OUT, 'pairs.json'), JSON.stringify({ plain: fullPlain, ciphers: ciphers.map((c, i) => ({ i, len: c.len, file: `cipher-${i}.txt` })) }, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
