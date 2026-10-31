// img5-probe.mjs —— 同一张图的「密文」与「明文 base64」都抓全，用来反推变换
//
// 已确认：.txt 内容 30760 字符（去 #FEy），页面里 img.src 是 data:image/jpeg;base64,<约30760字符>。
// 长度几乎一致 → 这是等长变换（字符置换 or 逐位异或），不是分组加密。
// 抓到同一张图的两份全量数据，就能在本地把映射关系推出来。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out18';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const BLOCK = ['**/api/banner/banner_list*', '**/hjstore/system/banner/**', '**/www.google-analytics.com/**'];

const decodeLayers = payload => {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) {}
    if (!text.trim()) break;
    cur = text.trim();
  }
  return null;
};

async function main() {
  // 1) 列表 → attachment id 与 URL 的对应表
  const r = await fetch(`${BASE}/api/topic/hot/topics?page=1`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': `${BASE}/home`,
               'mver': '211112203214', 'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const env = await r.json();
  const list = decodeLayers(env.data);
  const map = {};
  for (const t of (list.results || [])) {
    for (const a of (t.attachments || [])) {
      const u = a.coverUrl || a.remoteUrl;
      if (a.id && u && /\.(jpe?g|png|gif)(\.txt)?$/i.test(u)) map[String(a.id)] = u;
    }
  }
  console.log('附件 id → url 数量:', Object.keys(map).length);

  // 2) 浏览器：等页面把某张图解码成 data URL
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, x => x.abort());
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(4000);

  const picks = await page.evaluate(() => {
    const out = [];
    for (const im of document.querySelectorAll('img')) {
      const s = im.src || '';
      if (s.startsWith('data:image') && s.length > 5000) {
        out.push({ id: im.getAttribute('data-id') || '', len: s.length, src: s });
        if (out.length >= 3) break;
      }
    }
    return out;
  });
  console.log(`页面上解出 ${picks.length} 张 data URL 图`);

  await fs.mkdir(OUT, { recursive: true });
  const saved = [];
  for (const p of picks) {
    const url = map[p.id];
    if (!url) { console.log(`  id=${p.id} 没在列表映射里，跳过`); continue; }
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    const cipher = await res.text();
    const name = `pair-${p.id}`;
    await fs.writeFile(path.join(OUT, name + '-plain.txt'), p.src);
    await fs.writeFile(path.join(OUT, name + '-cipher.txt'), cipher);
    const plainB64 = p.src.slice(p.src.indexOf(',') + 1);
    saved.push({ id: p.id, url, cipherLen: cipher.length, plainLen: p.src.length, plainB64Len: plainB64.length, name });
    console.log(`  id=${p.id} 密文=${cipher.length} 明文字符=${plainB64.length} 前 20 对比:`);
    console.log(`     cipher: ${JSON.stringify(cipher.slice(0, 24))}`);
    console.log(`     plain : ${JSON.stringify(plainB64.slice(0, 24))}`);
  }

  await fs.writeFile(path.join(OUT, 'pairs.json'), JSON.stringify({ saved }, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
