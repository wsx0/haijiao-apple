// captcha-probe.mjs —— 登录到底要不要验证码？验证码从哪来？
//
// 用**假账号**试探，不涉及真实凭据：
//   - 不带 captcha 字段 → 看报错是「验证码」还是「用户名密码」
//   - 带假 captcha → 看报错变化
// 同时找验证码接口（captchaId 从哪来）。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out40';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

const H = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Referer': BASE + '/login',
  'Origin': BASE,
  'mver': '211112203214',
  'x-user-id': 'null',
  'x-user-token': 'null',
};

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 400) };
}

async function get(p, extra = {}) {
  const r = await fetch(BASE + p, { headers: { ...H, ...extra } });
  const t = await r.text();
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ct, len: t.length, body: ct.includes('json') ? t.slice(0, 300) : `[binary ${t.length}B]` };
}

async function main() {
  const out = {};

  console.log('=== A. 不带 captcha，假账号 ===');
  out.noCaptcha = await post('/api/login/signin', { username: 'probe_user_x1', password: 'probe_pwd_x1' });
  console.log(`HTTP ${out.noCaptcha.status}  ${out.noCaptcha.body}`);

  console.log('\n=== B. 带空 captcha 字段 ===');
  out.emptyCaptcha = await post('/api/login/signin', {
    username: 'probe_user_x1', password: 'probe_pwd_x1', captchaCode: '', captchaId: '',
  });
  console.log(`HTTP ${out.emptyCaptcha.status}  ${out.emptyCaptcha.body}`);

  console.log('\n=== C. 带假 captcha ===');
  out.fakeCaptcha = await post('/api/login/signin', {
    username: 'probe_user_x1', password: 'probe_pwd_x1', captchaCode: '0000', captchaId: 'fake-id-123',
  });
  console.log(`HTTP ${out.fakeCaptcha.status}  ${out.fakeCaptcha.body}`);

  console.log('\n=== D. 多试一个 remember 字段 ===');
  out.withRemember = await post('/api/login/signin', {
    username: 'probe_user_x1', password: 'probe_pwd_x1', remember: true,
  });
  console.log(`HTTP ${out.withRemember.status}  ${out.withRemember.body}`);

  console.log('\n=== E. 验证码接口候选 ===');
  const cands = [
    '/api/captcha',
    '/api/captcha/image',
    '/api/captcha/register',
    '/api/login/captcha',
    '/api/verify/code',
    '/api/common/captcha',
    '/api/login/conf',
  ];
  out.captchaEndpoints = [];
  for (const c of cands) {
    const r = await get(c);
    const looksOk = r.status === 200;
    console.log(`${looksOk ? '✓' : '✗'} ${c.padEnd(28)} ${r.status} ${r.ct} ${r.len}B  ${String(r.body).slice(0, 90)}`);
    if (looksOk) out.captchaEndpoints.push({ path: c, ...r });
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'captcha.json'), JSON.stringify(out, null, 2));

  // 判定
  const anyCaptchaMsg = [out.noCaptcha, out.emptyCaptcha, out.fakeCaptcha]
    .some(r => /验证码|captcha/i.test(r.body));
  console.log(`\n=== 结论 ===`);
  console.log(anyCaptchaMsg
    ? '登录需要验证码（响应里出现「验证码」/captcha）'
    : '响应里没提验证码 —— 可能非必需，或先校验账号密码');
  console.log('各次响应原文见 out40/captcha.json');
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
