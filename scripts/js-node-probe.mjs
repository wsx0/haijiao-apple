// js-node-probe.mjs —— 从站点 JS 里挖「按板块取帖子」的真实接口
//
// 已知：/api/topic/hot/topics 忽略 type / nodeId / node_id / node / nid（全部返回同一批）
// 所以板块过滤一定走别的路径或参数。直接搜 JS 源码里的调用点。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out34';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  const scripts = [];
  page.on('response', async r => {
    const u = r.url();
    if (/\.js(\?|$)/.test(u)) {
      try { scripts.push({ url: u.replace(BASE, ''), body: await r.text() }); } catch (e) {}
    }
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  console.log(`抓到 ${scripts.length} 个 JS，总 ${scripts.reduce((a, s) => a + s.body.length, 0)} 字符`);

  const hits = [];
  const apiPaths = new Set();

  for (const s of scripts) {
    const b = s.body;
    // 1) 所有 /api/topic/ 路径
    for (const m of b.matchAll(/["'`](\/api\/topic\/[a-zA-Z0-9_\/\-\{\}\$\.]*)["'`]/g)) apiPaths.add(m[1]);
    for (const m of b.matchAll(/["'`](\/api\/[a-zA-Z0-9_\/\-]{3,40})["'`]/g)) apiPaths.add(m[1]);

    // 2) nodes_by_ver 的调用上下文
    let i = b.indexOf('nodes_by_ver');
    let n = 0;
    while (i >= 0 && n < 2) {
      hits.push({ js: s.url, kw: 'nodes_by_ver', ctx: b.slice(Math.max(0, i - 400), i + 400).replace(/\s+/g, ' ') });
      i = b.indexOf('nodes_by_ver', i + 5); n++;
    }

    // 3) nodeId 出现处（最多 4 个）
    i = b.indexOf('nodeId');
    n = 0;
    while (i >= 0 && n < 4) {
      const ctx = b.slice(Math.max(0, i - 220), i + 260).replace(/\s+/g, ' ');
      // 只留看起来像请求的
      if (/api|request|get|post|param|query/i.test(ctx)) hits.push({ js: s.url, kw: 'nodeId', ctx });
      i = b.indexOf('nodeId', i + 6); n++;
    }
  }

  console.log(`\n=== /api/ 路径（${apiPaths.size}）===`);
  const topicApis = [...apiPaths].filter(p => p.includes('topic') || p.includes('node') || p.includes('list')).sort();
  for (const p of topicApis) console.log('  ' + p);
  console.log('  其他：' + [...apiPaths].filter(p => !topicApis.includes(p)).slice(0, 12).join(' '));

  console.log(`\n=== 调用点（${hits.length}）===`);
  for (const h of hits.slice(0, 10)) {
    console.log(`\n[${h.js}] ${h.kw}`);
    console.log('  ' + h.ctx.slice(0, 460));
  }

  // 4) 再试：点板块元素，记录新请求
  const before = [];
  page.on('request', r => before.push(r.url()));
  await page.waitForTimeout(500);
  const navTexts = ['热门', '短视频专区', '海角视频', '讨论杂谈', '海角自拍'];
  const seen = new Set();
  for (const t of navTexts) {
    const cnt = [...before].length;
    try {
      const el = page.locator(`text="${t}"`).first();
      if (await el.count()) {
        await el.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(1500);
        const added = before.slice(cnt).filter(u => u.includes('/api/'));
        const uniq = added.filter(u => !seen.has(u));
        uniq.forEach(u => seen.add(u));
        if (uniq.length) {
          console.log(`\n[点「${t}」] 新 API 请求：`);
          uniq.slice(0, 5).forEach(u => console.log('   ' + u.replace(BASE, '')));
        }
      }
    } catch (e) {}
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'jsnode.json'), JSON.stringify({ apiPaths: [...apiPaths], hits }, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
