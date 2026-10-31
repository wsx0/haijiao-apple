// img7-probe.mjs —— 只抓「帖子图」的密文/明文配对（上一版抓到的是广告 banner）
//
// 关键修正：
//   1) img 的 data-id 必须是纯数字（attachment id）；banner_xxx 这种是广告位
//   2) 密文完整保存（不 slice），否则长度对不上没法配对
//   3) 同时输出密文 URL，便于用 URL 里的 hash 与 attachment 绑定

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out20';
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
      if (window.__hj_txt.length >= 30) return;
      window.__hj_txt.push({ url: String(url).slice(0, 300), len: body.length, body });
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return origOpen.apply(this, arguments); };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const u = String(this.__u || '');
          if (!/\.txt(\?|$)/.test(u)) return;
          if (this.responseType === '' || this.responseType === 'text') push(u, this.responseText);
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
    const of = window.fetch;
    window.fetch = function (input) {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      return of.apply(this, arguments).then(res => {
        if (/\.txt(\?|$)/.test(String(u))) res.clone().text().then(t => push(u, t)).catch(() => {});
        return res;
      });
    };
  });

  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  await page.evaluate(() => window.scrollBy(0, 700));
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.scrollBy(0, 700));
  await page.waitForTimeout(4000);

  // 只取纯数字 data-id 的 img（帖子图）
  const posts = await page.evaluate(() => {
    const out = [];
    for (const im of document.querySelectorAll('img[data-id]')) {
      const id = im.getAttribute('data-id') || '';
      if (!/^\d+$/.test(id)) continue;
      const s = im.src || '';
      if (s.indexOf('data:image') !== 0) continue;
      const k = s.indexOf(',');
      out.push({ id, len: s.length - k - 1, b64: s.slice(k + 1) });
    }
    return out;
  });
  console.log(`帖子图（数字 id）共 ${posts.length} 张`);
  for (const p of posts.slice(0, 6)) console.log(`  id=${p.id} b64len=${p.len}`);

  const txts = await page.evaluate(() => (window.__hj_txt || []).map(t => ({ url: t.url, len: t.len })));
  console.log(`\n.txt 响应 ${txts.length} 个：`);
  for (const t of txts.slice(0, 10)) console.log(`  len=${t.len}  ${t.url}`);

  await fs.mkdir(OUT, { recursive: true });
  // 保存前两张帖子图的明文
  const plainFiles = [];
  for (let i = 0; i < Math.min(posts.length, 3); i++) {
    const name = `plain-${i}-${posts[i].id}.txt`;
    await fs.writeFile(path.join(OUT, name), posts[i].b64);
    plainFiles.push({ id: posts[i].id, file: name, len: posts[i].len });
  }
  // 保存所有密文（完整）
  const cipherFiles = [];
  for (let i = 0; i < txts.length; i++) {
    const body = await page.evaluate(i => (window.__hj_txt || [])[i] && window.__hj_txt[i].body, i);
    if (!body) continue;
    const name = `cipher-${i}.txt`;
    await fs.writeFile(path.join(OUT, name), body);
    cipherFiles.push({ i, file: name, len: txts[i].len, url: txts[i].url });
  }
  await fs.writeFile(path.join(OUT, 'pairs.json'), JSON.stringify({ plain: plainFiles, ciphers: cipherFiles }, null, 2));

  console.log(`\n保存：明文 ${plainFiles.length} 张，密文 ${cipherFiles.length} 个`);
  for (const p of plainFiles) console.log(`  ${p.file} b64len=${p.len}`);
  for (const c of cipherFiles.slice(0, 8)) console.log(`  ${c.file} len=${c.len}`);
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
