// sf-list-probe.mjs —— 把 haijiao.com 的全部脚本拉下来，元数据汇总，方便筛
//
// 抓列表页的表格行：名称 / 版本 / 作者 / 安装量 / 评分 / 更新时间 / 描述，
// 同时抓每个详情页的一点点信息（描述全文、代码大小），用于判断「是不是纯客户端解锁」。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out27';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LIST = 'https://sleazyfork.org/zh-CN/scripts/by-site/haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1000 }, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();

  await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  const title = await page.evaluate(() => document.title);
  console.log('页面标题:', title);

  // 抓表格行
  const rows = await page.evaluate(() => {
    const out = [];
    // GreasyFork/SleazyFork 列表是 table#scripts-list 或 .script-list
    const table = document.querySelector('#scripts-list, table.listing, table');
    const trs = table ? [...table.querySelectorAll('tr')] : [];
    for (const tr of trs) {
      const link = tr.querySelector('a[href*="/scripts/"]');
      if (!link) continue;
      const tds = [...tr.querySelectorAll('td')];
      const txt = i => (tds[i] ? tds[i].innerText.replace(/\s+/g, ' ').trim() : '');
      out.push({
        name: link.innerText.trim(),
        href: link.href,
        cells: tds.map(td => td.innerText.replace(/\s+/g, ' ').trim()),
      });
    }
    return out;
  });

  console.log(`列表行数: ${rows.length}`);
  for (const r of rows.slice(0, 5)) console.log('  示例:', JSON.stringify(r).slice(0, 240));

  // 如果表格没抓到，退化为抓所有脚本链接
  let list = rows;
  if (list.length === 0) {
    list = await page.evaluate(() => [...document.querySelectorAll('a[href*="/scripts/"]')]
      .filter(a => /\/scripts\/\d+/.test(a.href))
      .map(a => ({ name: a.innerText.trim(), href: a.href, cells: [] })));
    console.log(`退化抓取: ${list.length} 个链接`);
  }

  // 去重（同一脚本在标题与安装列各出现一次）
  const seen = new Set();
  const scripts = [];
  for (const r of list) {
    const m = r.href.match(/\/scripts\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    scripts.push({ id, name: r.name, href: r.href, cells: r.cells });
  }
  console.log(`去重后脚本数: ${scripts.length}`);

  // 逐个详情页拿描述（并发 4）
  const detail = [];
  const queue = scripts.slice(0, 40);
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      const p = await ctx.newPage();
      try {
        await p.goto(s.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await p.waitForTimeout(1200);
        const info = await p.evaluate(() => {
          const g = sel => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
          const meta = {};
          for (const dt of document.querySelectorAll('dl dt')) {
            const k = dt.innerText.replace(/\s+/g, ' ').trim();
            const v = dt.nextElementSibling?.innerText.replace(/\s+/g, ' ').trim() || '';
            if (k) meta[k] = v.slice(0, 120);
          }
          return {
            title: document.title,
            desc: g('#script-description') || g('.script-description') || '',
            meta,
            codeLink: [...document.querySelectorAll('a[href*="code"]')].map(a => a.href)[0] || '',
          };
        });
        detail.push({ ...s, ...info });
        console.log(`  ✓ ${s.id} ${s.name.slice(0, 34)} | ${info.meta['版本'] || info.meta['Version'] || '?'} | ${(info.desc || '').slice(0, 50)}`);
      } catch (e) {
        detail.push({ ...s, error: e.message });
        console.log(`  ✗ ${s.id} ${s.name.slice(0, 30)} (${e.message.slice(0, 40)})`);
      }
      await p.close();
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'list.json'), JSON.stringify(detail, null, 2));
  console.log(`\n保存 ${detail.length} 条到 out27/list.json`);

  // 粗筛：只看描述里有「解锁/VIP/付费/完整/解析/下载/无限」的
  const KW = ['解锁', 'VIP', 'vip', '付费', '完整', '解析', '下载', '无限', '免费看', '金币', '钻石'];
  const cands = detail.filter(d => KW.some(k => (d.desc || '').includes(k) || (d.name || '').includes(k)));
  console.log(`\n=== 可能解锁付费的 ${cands.length} 个 ===`);
  for (const c of cands) {
    console.log(`\n[${c.id}] ${c.name}`);
    const ver = c.meta?.['版本'] || c.meta?.['Version'] || '';
    const upd = c.meta?.['每日安装'] || c.meta?.['Daily installs'] || '';
    console.log(`  版本=${ver}  更新=${c.meta?.['更新'] || c.meta?.['Updated'] || ''}  ${upd}`);
    console.log(`  链接=${c.href}`);
    console.log(`  描述=${(c.desc || '').slice(0, 220)}`);
  }

  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
