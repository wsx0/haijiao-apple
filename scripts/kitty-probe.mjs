// kitty-probe.mjs —— 抓 Kitty猫脚本的源码，看它凭什么能突破 30 秒预览
//
// 页面：https://www.kittymao.xyz/script/18   （海角社区 1.2.3，免费+口令）
// 更新日志透露：v1.1.3 修复「电脑端只能看30秒」、v1.1.2 修复「海角加密更改」、
// v1.0.5 加「跨域检测」→ 说明它在处理海角加密 + 请求非 haijiao 域名。
// 目标：找到 .user.js 地址，下载全文，定位它的关键逻辑。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out28';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE = 'https://www.kittymao.xyz/script/18';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const result = { page: PAGE, links: [], scriptUrl: '', code: '' };

  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // 1) 所有链接（找「安装」按钮）
  const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => ({
    text: (a.innerText || '').trim().slice(0, 20),
    href: a.href,
  })).filter(x => x.href && !x.href.startsWith('javascript')));
  result.links = links;
  console.log('=== 页面链接（含 安装/领取/user.js 的）===');
  for (const l of links) {
    if (/user\.js|install|安装|领取|download|script/i.test(l.href + l.text)) {
      console.log(`  [${l.text}] ${l.href}`);
    }
  }

  // 2) 猜几个脚本地址
  // 已经从页面 HTML 里挖到的真实地址
  const cands = [
    'https://file.kittymao.xyz/file/hj.user.js',
    ...links.filter(l => /\.user\.js/.test(l.href)).map(l => l.href),
    'https://www.kittymao.xyz/script/18.user.js',
    'https://www.kittymao.xyz/scripts/18.user.js',
    'https://www.kittymao.xyz/script/18/user.js',
    'https://www.kittymao.xyz/api/script/18',
    'https://www.kittymao.xyz/script/18.js',
  ];
  for (const c of [...new Set(cands)]) {
    try {
      const r = await page.request.get(c, { headers: { 'User-Agent': UA, Referer: PAGE } });
      const t = await r.text();
      const looksJs = /==UserScript==|function\s|const\s|let\s|var\s/.test(t);
      console.log(`  ${String(r.status()).padEnd(4)} ${String(t.length).padStart(8)}B  ${looksJs ? 'JS!' : '    '}  ${c}`);
      if (r.status() === 200 && looksJs && t.length > 2000 && !result.code) {
        result.scriptUrl = c;
        result.code = t;
      }
    } catch (e) {
      console.log(`  ERR ${c} (${e.message.slice(0, 40)})`);
    }
  }

  // 3) 页面上"安装"按钮点击后去哪
  if (!result.code) {
    try {
      const btn = page.locator('text=安装').first();
      if (await btn.count()) {
        const href = await btn.getAttribute('href').catch(() => null);
        console.log('\n安装按钮 href:', href);
        if (href) {
          const abs = href.startsWith('http') ? href : 'https://www.kittymao.xyz' + href;
          const r = await page.request.get(abs, { headers: { 'User-Agent': UA, Referer: PAGE } });
          const t = await r.text();
          console.log(`  ${r.status()} ${t.length}B ${abs}`);
          if (r.status() === 200 && t.length > 2000) { result.scriptUrl = abs; result.code = t; }
        }
      }
    } catch (e) { console.log('点安装失败', e.message); }
  }

  console.log('\n脚本地址:', result.scriptUrl || '(未找到)');
  console.log('源码长度:', result.code.length);

  if (result.code) {
    const keys = ['m3u8', 'preview', 'is_buy', 'decode', 'atob', 'api/', 'kittymao', 'proxy', 'token', '口令', 'hjstore'];
    console.log('\n=== 关键词 ===');
    for (const k of keys) {
      const c = (result.code.match(new RegExp(k.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi')) || []).length;
      if (c) console.log(`  ${k.padEnd(12)} ${c}`);
    }
    // 抓所有域名
    const hosts = {};
    for (const m of result.code.matchAll(/https?:\/\/([a-z0-9.\-]+)/gi)) hosts[m[1]] = (hosts[m[1]] || 0) + 1;
    console.log('\n=== 源码里的域名 ===');
    Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([h, n]) => console.log(`  ${h.padEnd(36)} ${n}`));
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'kitty.json'), JSON.stringify({ page: result.page, links: result.links, scriptUrl: result.scriptUrl, codeLen: result.code.length }, null, 2));
  if (result.code) await fs.writeFile(path.join(OUT, 'kitty.user.js'), result.code);
  await page.screenshot({ path: path.join(OUT, 'page.png') }).catch(() => {});
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
