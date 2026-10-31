// img8-probe.mjs —— 用调用栈定位解码函数（不再靠静态推测）
//
// 思路：img.src 被赋成 data:image/jpeg;base64 的那一刻，抛一个 Error 抓 stack。
// 栈里会写明「是哪个 chunk 的哪一行」把密文解成明文的 —— 那就是解码函数的位置。
// 同时把所有 chunk 存盘，方便本地按行列号定位并读算法。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out21';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  await ctx.addInitScript(() => {
    window.__hj_stacks = [];
    window.__hj_txt = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get() { return desc.get.call(this); },
      set(v) {
        try {
          if (typeof v === 'string' && v.indexOf('data:image') === 0 && v.length > 5000 &&
              window.__hj_stacks.length < 3 && /^\d+$/.test(this.getAttribute('data-id') || '')) {
            window.__hj_stacks.push({
              id: this.getAttribute('data-id'),
              len: v.length,
              stack: String(new Error('here').stack || '').slice(0, 4000),
            });
          }
        } catch (e) {}
        return desc.set.call(this, v);
      },
      configurable: true,
    });

    const push = (url, body) => {
      if (!body || body.length < 500) return;
      if (window.__hj_txt.length >= 12) return;
      window.__hj_txt.push({ url: String(url).slice(0, 300), len: body.length, body: body.slice(0, 3000) });
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const u = String(this.__u || '');
          if (/\.txt(\?|$)/.test(u) && (this.responseType === '' || this.responseType === 'text')) push(u, this.responseText);
        } catch (e) {}
      });
      return os.apply(this, arguments);
    };
  });

  const chunks = [];
  const page = await ctx.newPage();
  page.on('response', async r => {
    const u = r.url();
    if (!/\.js(\?|$)/.test(u)) return;
    try { chunks.push({ url: u, body: await r.text() }); } catch (e) {}
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(5000);

  const stacks = await page.evaluate(() => window.__hj_stacks || []);
  console.log(`抓到 ${stacks.length} 条赋值调用栈\n`);
  for (const s of stacks) {
    console.log(`=== img data-id=${s.id} len=${s.len} ===`);
    const lines = String(s.stack).split('\n').slice(0, 12);
    for (const l of lines) console.log('  ' + l.trim());
    console.log('');
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'stacks.json'), JSON.stringify(stacks, null, 2));
  // 存 chunk（只存含 stack 里提到的文件 + 所有 chunk 名）
  await fs.writeFile(path.join(OUT, 'chunks.json'), JSON.stringify(chunks.map(c => ({ url: c.url.replace(BASE, ''), len: c.body.length })), null, 2));
  for (const c of chunks) {
    const name = c.url.split('/').pop().split('?')[0];
    if (/home|app|index|post/i.test(name)) {
      await fs.writeFile(path.join(OUT, name), c.body);
    }
  }
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
