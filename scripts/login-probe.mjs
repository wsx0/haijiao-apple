// login-probe.mjs —— 挖登录接口：App 内要支持登录，必须先知道怎么登
//
// 需要确定：
//   1) 登录接口路径 + 请求体字段（用户名/密码字段名）
//   2) 返回什么（token / cookie / user 信息）
//   3) 后续请求怎么带登录态（header 还是 cookie）
//   4) 登录后详情接口的 video remoteUrl 是否有值（这是关键验证）

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out38';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  const jsBodies = [];
  page.on('response', async r => {
    const u = r.url();
    if (/\.js(\?|$)/.test(u)) { try { jsBodies.push({ url: u.replace(BASE, ''), body: await r.text() }); } catch (e) {} }
  });

  // 打开登录页，让登录相关的 chunk 加载出来
  console.log('打开 /login …');
  try { await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('  ', e.message.slice(0, 50)); }
  await page.waitForTimeout(6000);

  const out = { apiPaths: [], hits: [] };
  const apis = new Set();

  for (const s of jsBodies) {
    const b = s.body;
    for (const m of b.matchAll(/["'`](\/api\/[a-zA-Z0-9_\/\-\{\}\$\.]{3,50})["'`]/g)) apis.add(m[1]);
    for (const m of b.matchAll(/["'`](\/(?:login|user|auth|passport)[a-zA-Z0-9_\/\-]{0,40})["'`]/g)) apis.add(m[1]);

    for (const kw of ['/login', 'doLogin', 'loginBy', 'password', 'passwd']) {
      let i = b.indexOf(kw), n = 0;
      while (i >= 0 && n < 2) {
        const c = b.slice(Math.max(0, i - 260), i + 340).replace(/\s+/g, ' ');
        if (/MyPost|MyGet|api|axios|request|username|password/i.test(c)) out.hits.push({ js: s.url, kw, ctx: c });
        i = b.indexOf(kw, i + kw.length); n++;
      }
    }
  }

  out.apiPaths = [...apis].sort();
  console.log(`\n=== JS 里的接口路径（${out.apiPaths.length}）===`);
  for (const p of out.apiPaths) console.log('  ' + p);

  console.log(`\n=== 登录相关片段（${out.hits.length}）===`);
  const seen = new Set();
  for (const h of out.hits) {
    const k = h.ctx.slice(0, 70);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`\n[${h.js}] ${h.kw}`);
    console.log('  ' + h.ctx.slice(0, 420));
  }

  // 看看登录页有哪些输入框
  const form = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map(i => ({
      type: i.type, name: i.name, placeholder: i.placeholder, id: i.id,
    }));
    const btns = [...document.querySelectorAll('button, .van-button, [class*="btn"]')]
      .map(b => (b.innerText || '').trim()).filter(t => t && t.length < 12).slice(0, 10);
    return { inputs, btns, title: document.title };
  });
  console.log('\n=== 登录页表单 ===');
  console.log('  标题:', form.title);
  console.log('  输入框:', JSON.stringify(form.inputs));
  console.log('  按钮:', JSON.stringify(form.btns));
  out.form = form;

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'login.json'), JSON.stringify(out, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
