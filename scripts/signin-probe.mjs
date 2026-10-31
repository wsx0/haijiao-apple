// signin-probe.mjs —— 精准挖 /api/login/signin 的请求字段与响应处理
//
// 已知：登录页是 /login，接口 /api/login/signin，后续请求带 x-user-id / x-user-token。
// 需要：请求体字段名、响应里 token 存在哪、怎么带到后续请求。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out39';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  // 1) 抓 auth 相关 JS 全文（app / auth / login chunk）
  const candidates = [
    '/static/js20261008/auth-f071b347307dd4e9ad9c.js',
    '/static/js20261008/app-f071b347307dd4e9ad9c.js',
    '/static/js20261008/login-f071b347307dd4e9ad9c.js',
    '/static/js20261008/home~login-f071b347307dd4e9ad9c.js',
  ];
  const bodies = [];
  for (const c of candidates) {
    try {
      const r = await fetch(BASE + c, { headers: { 'User-Agent': UA, 'Referer': BASE + '/login' } });
      if (r.ok) {
        const t = await r.text();
        bodies.push({ url: c, body: t });
        console.log(`✓ ${c}  ${t.length}B`);
      } else {
        console.log(`✗ ${c}  ${r.status}`);
      }
    } catch (e) { console.log(`✗ ${c}  ${e.message.slice(0, 40)}`); }
  }

  const out = { hits: [] };
  const seen = new Set();
  const push = (js, kw, ctx) => {
    const k = ctx.slice(0, 80);
    if (seen.has(k)) return;
    seen.add(k);
    out.hits.push({ js, kw, ctx: ctx.replace(/\s+/g, ' ') });
  };

  for (const b of bodies) {
    for (const kw of ['signin', 'MyPost("/user', 'MyPost("/login', 'x-user-token', 'x-user-id', 'setToken', 'localStorage.token']) {
      let i = b.body.indexOf(kw), n = 0;
      while (i >= 0 && n < 3) {
        push(b.url, kw, b.body.slice(Math.max(0, i - 400), i + 500));
        i = b.body.indexOf(kw, i + kw.length); n++;
      }
    }
  }

  console.log(`\n=== 命中 ${out.hits.length} 段 ===`);
  for (const h of out.hits.slice(0, 14)) {
    console.log(`\n[${h.js}] ${h.kw}`);
    console.log('  ' + h.ctx.slice(0, 620));
  }

  // 2) 试探：直接打 /api/login/signin，看它要求什么（故意空 body）
  console.log('\n=== 直接探测 /api/login/signin（空 body）===');
  try {
    const r = await fetch(BASE + '/api/login/signin', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Referer': BASE + '/login' },
      body: '{}',
    });
    const t = await r.text();
    console.log(`HTTP ${r.status}  ${t.slice(0, 300)}`);
    out.emptySignin = { status: r.status, body: t.slice(0, 500) };
  } catch (e) { console.log('失败', e.message); }

  // 3) 探测 /api/user/current（未登录应报错，用来确认鉴权头）
  console.log('\n=== 探测 /api/user/current（无登录态）===');
  try {
    const r = await fetch(BASE + '/api/user/current', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': BASE + '/home',
                 'x-user-id': 'null', 'x-user-token': 'null' },
    });
    const t = await r.text();
    console.log(`HTTP ${r.status}  ${t.slice(0, 300)}`);
    out.current = { status: r.status, body: t.slice(0, 500) };
  } catch (e) { console.log('失败', e.message); }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'signin.json'), JSON.stringify(out, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
