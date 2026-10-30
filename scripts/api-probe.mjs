// api-probe.mjs —— 原生改造第 0 步：把站点 API 的真实契约抓下来
//
// 回答四个问题（决定原生列表能不能裸调）：
//   1. 请求长什么样：method / path / query / POST body
//   2. 有没有签名风控：自定义 header（sign / timestamp / token / device / nonce…）
//   3. 响应结构：字段名、图片 URL 字段、分页游标
//   4. 登录态怎么带：Cookie 名 / Authorization
//
// 动作：打开首页 → 滚几次触发分页 → 点第一条帖子进详情 → 全程拦截 /api/*
// 产出：out7/api.json（全部请求+响应）、out7/bodies/<n>-<slug>.json（响应体单独存）

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out7';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HOME = 'https://haijiao.com/home';
const BLOCK = [
  '**/api/banner/banner_list*',
  '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**',
  '**/www.googletagmanager.com/**',
  '**/static.cloudflareinsights.com/**',
];

const slug = u => {
  try {
    const x = new URL(u);
    return (x.pathname + (x.search || '')).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  } catch (e) { return 'x'; }
};

// 只看这几个跟「列表/详情」有关的接口，别把统计也塞进来
const KEEP = /\/api\/(topic|post|thread|detail|comment|list|index|home|user\/info|login\/conf)/i;

const caps = [];
let idx = 0;

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  page.on('request', r => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    if (BLOCK.some(b => u.includes('banner_list'))) return;
    const rec = {
      phase: 'req', tag: '', method: r.method(), url: u,
      headers: r.headers(), postData: (r.postData() || '').slice(0, 4000),
    };
    r._rec = rec;
    caps.push(rec);
  });

  page.on('response', async r => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    const rec = { phase: 'res', tag: '', url: u, status: r.status(), headers: r.headers(), body: '' };
    try {
      const t = await r.text();
      rec.body = t.slice(0, 30000);
      if (KEEP.test(u) && t.length > 5) {
        const i = ++idx;
        const name = `${String(i).padStart(2, '0')}-${slug(u)}.json`;
        await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });
        await fs.writeFile(path.join(OUT, 'bodies', name), t);
        rec.savedAs = name;
      }
    } catch (e) {}
    caps.push(rec);
  });

  const mark = t => { for (const c of caps) if (!c.tag) c.tag = t; };

  await page.goto(HOME, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3500);
  mark('home-initial');

  // 滚几次，触发分页
  for (let i = 1; i <= 3; i++) {
    try {
      await page.evaluate(y => window.scrollBy(0, y), 2400);
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1500);
      mark('home-scroll-' + i);
    } catch (e) {}
  }

  // 点第一条帖子进详情
  let opened = null;
  const sels = ['#app a[href*="/post"]', '#app a[href*="/topic"]', '#app a[href*="/detail"]',
                '#app .van-cell', '#app .indexbox a', '#app .list-item a'];
  for (const s of sels) {
    try {
      const el = await page.$(s);
      if (el) { await el.click({ timeout: 5000 }); opened = s; break; }
    } catch (e) {}
  }
  if (!opened) {
    // 兜底：直接点第一个带 href 的链接
    try {
      await page.evaluate(() => {
        const a = [...document.querySelectorAll('#app a[href]')].find(x => /post|topic|detail|\/\d+/.test(x.getAttribute('href') || ''));
        if (a) a.click();
      });
      opened = 'js-click';
    } catch (e) {}
  }
  await page.waitForTimeout(4000);
  mark('detail');
  const detailUrl = page.url();

  const cookies = (await ctx.cookies()).map(c => `${c.name}=${c.value}`.slice(0, 300));
  const storage = await page.evaluate(() => {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length && i < 40; i++) {
        const k = localStorage.key(i);
        out[k] = String(localStorage.getItem(k) || '').slice(0, 200);
      }
    } catch (e) {}
    return out;
  });

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'api.json'), JSON.stringify({
    detailUrl, opened, cookies, localStorageKeys: storage, caps,
  }, null, 2));

  // 控制台摘要：让人一眼看出有没有签名
  const reqs = caps.filter(c => c.phase === 'req');
  console.log(`\n捕获请求 ${reqs.length} 条，响应 ${caps.length - reqs.length} 条`);
  const customHeaders = new Set();
  for (const r of reqs) {
    for (const k of Object.keys(r.headers || {})) {
      if (/sign|token|auth|nonce|timestamp|ts|device|signature|key|ver/i.test(k)) customHeaders.add(k + ': ' + String(r.headers[k]).slice(0, 40));
    }
  }
  console.log('可疑签名/身份头:');
  for (const h of customHeaders) console.log('  ' + h);
  console.log('\n调用序:');
  for (const r of reqs) {
    console.log(`  [${r.tag}] ${r.method} ${r.url.replace('https://haijiao.com', '').slice(0, 110)}` +
                (r.postData ? ' body=' + r.postData.slice(0, 80).replace(/\s+/g, ' ') : ''));
  }
  console.log('\n响应体样本:');
  for (const c of caps.filter(x => x.phase === 'res' && x.savedAs)) {
    console.log(`  [${c.tag}] ${c.status} ${c.url.replace('https://haijiao.com', '').slice(0, 90)} -> ${c.savedAs}`);
  }

  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
