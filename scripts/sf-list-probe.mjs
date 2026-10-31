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

  // Cloudflare 拦渲染但放静态请求：直接用 HTTP 拿 HTML
  const resp = await page.request.get(LIST, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  const html = await resp.text();
  console.log(`列表页 HTTP ${resp.status()}  ${html.length}B`);

  let list = [];
  // 列表页里每个脚本形如 <a href="/zh-CN/scripts/12345-name">显示名</a>
  const re = /<a[^>]+href="([^"]*\/scripts\/(\d+)(?:-[^"]*)?)"[^>]*>([\s\S]{0,200}?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].startsWith('http') ? m[1] : 'https://sleazyfork.org' + m[1];
    const name = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    list.push({ name, href, cells: [], id: m[2] });
  }
  console.log(`正则命中 ${list.length} 条`);

  if (list.length === 0) {
    // 退化：只拿 id
    const ids = [...new Set([...html.matchAll(/\/scripts\/(\d+)/g)].map(x => x[1]))];
    console.log(`退化拿到 ${ids.length} 个 id: ${ids.slice(0, 20).join(',')}`);
    for (const id of ids) {
      list.push({ id, name: `#${id}`, href: `https://sleazyfork.org/zh-CN/scripts/${id}`, cells: [] });
    }
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
        const hr = await p.request.get(s.href, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
        const h = await hr.text();
        const strip = x => x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const pick = (re) => { const mm = h.match(re); return mm ? strip(mm[1]).slice(0, 400) : ''; };
        const info = {
          title: pick(/<title>([\s\S]*?)<\/title>/),
          desc: pick(/<div[^>]*id="script-description"[^>]*>([\s\S]*?)<\/div>/),
          meta: {
            '版本': pick(/Version[\s\S]{0,200}?<dd[^>]*>([\s\S]{0,40}?)<\/dd>/i),
            '更新': pick(/Updated[\s\S]{0,200}?<dd[^>]*>([\s\S]{0,60}?)<\/dd>/i),
          },
          codeLink: (h.match(/href="([^"]*\/code[^"]*)"/) || [])[1] || '',
          httpStatus: hr.status(),
        };
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
