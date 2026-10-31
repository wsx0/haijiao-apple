// img4-probe.mjs —— 找到把 #FEy 密文解成 JPEG 的那段 JS
//
// 线索：网页里 img.src 是 data:image/jpeg;base64,/9j/... （明文），且设置了 loading.gif 占位。
// 说明有组件负责「拿密文 → 解码 → 塞 data URL」。atob 追踪里没有它，所以是自研解码。
// 做法：拿页面所有 js，找含 loading.165748e6 / data-v-0080c5ec 的 chunk，把它里面
// 与 base64 / 字节操作 / 子串相关的代码整段 dump 出来。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out17';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  const jsSeen = [];
  page.on('response', async r => {
    const u = r.url();
    if (!/\.js(\?|$)/.test(u)) return;
    try {
      const t = await r.text();
      jsSeen.push({ url: u, len: t.length, body: t });
    } catch (e) {}
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.scrollBy(0, 1200));
  await page.waitForTimeout(4000);

  console.log(`捕获 ${jsSeen.length} 个 js 文件`);
  for (const j of jsSeen) console.log(`  ${String(j.len).padStart(7)} ${j.url.replace(BASE, '')}`);

  // 找关键 chunk
  const keys = ['loading.165748e6', '0080c5ec', 'data:image/jpeg', 'image/jpeg;base64'];
  const hits = [];
  for (const j of jsSeen) {
    for (const k of keys) {
      const i = j.body.indexOf(k);
      if (i >= 0) {
        hits.push({ js: j.url.replace(BASE, ''), key: k, at: i,
                    ctx: j.body.slice(Math.max(0, i - 700), i + 900) });
      }
    }
  }

  // 找自研 base64 表（典型特征：一串 A-Za-z0-9+/ 的字面量）或字节操作循环
  const decoderHints = [];
  for (const j of jsSeen) {
    for (const pat of ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                       'charCodeAt(', 'fromCharCode(', 'Uint8Array(', 'substring(4)', 'slice(4)',
                       'substr(4)', '>>2', '& 0x3f', '&63']) {
      let idx = j.body.indexOf(pat);
      let cnt = 0;
      while (idx >= 0 && cnt < 2) {
        decoderHints.push({ js: j.url.replace(BASE, ''), pat, ctx: j.body.slice(Math.max(0, idx - 300), idx + 500) });
        idx = j.body.indexOf(pat, idx + 1);
        cnt++;
      }
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'img4.json'), JSON.stringify({
    files: jsSeen.map(j => ({ url: j.url.replace(BASE, ''), len: j.len })),
    hits: hits.map(h => ({ js: h.js, key: h.key, at: h.at, ctx: h.ctx })),
    decoderHints: decoderHints.slice(0, 40).map(h => ({ js: h.js, pat: h.pat, ctx: h.ctx })),
  }, null, 2));

  // 关键 chunk 整份存盘，供下一步分析
  for (const j of jsSeen) {
    if (keys.some(k => j.body.includes(k)) || /post-detail|index|home/i.test(j.url)) {
      const name = j.url.split('/').pop().split('?')[0];
      await fs.writeFile(path.join(OUT, name), j.body);
    }
  }

  console.log(`\n命中 ${hits.length} 处：`);
  for (const h of hits.slice(0, 6)) {
    console.log(`\n[${h.js}] 关键词 ${h.key} @${h.at}`);
    console.log(h.ctx.replace(/\s+/g, ' ').slice(0, 600));
  }

  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
