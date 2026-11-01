// video-api-probe.mjs —— /api/video/<id> 到底要什么、返回什么
//
// 上一步发现：/api/video/14372317 和 /api/video/url?id= 都返回 200（不是 404），
// 但解不出 data。要看原始响应和参数要求。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out43';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

const dec = payload => {
  let cur = String(payload).trim();
  for (let i = 0; i < 10; i++) {
    try { return JSON.parse(Buffer.from(cur, 'base64').toString('utf8')); } catch (e) {}
    const t = Buffer.from(cur, 'base64').toString('utf8');
    if (!t || t === cur) break;
    cur = t.trim();
  }
  return null;
};

async function hit(p, method = 'GET', body = null) {
  const opt = {
    method,
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
               'Referer': BASE + '/home', 'Origin': BASE, 'mver': '211112203214',
               'x-user-id': 'null', 'x-user-token': 'null' },
  };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  let env = null, data = null;
  try { env = JSON.parse(t); if (env.data) data = dec(env.data); } catch (e) {}
  return {
    status: r.status,
    raw: t.slice(0, 400),
    code: env?.errorCode,
    success: env?.success,
    message: env?.message,
    isEncrypted: env?.isEncrypted,
    dataKeys: data ? (Array.isArray(data) ? `array(${data.length})` : Object.keys(data).join(',')) : null,
    data: data,
  };
}

async function main() {
  const out = {};
  const aid = 14372317;   // 上一步拿到的 video 附件 id
  const pid = 2302283;    // 对应 topic id

  console.log('=== /api/video/<id> 原始响应 ===');
  const a = await hit(`/api/video/${aid}`);
  console.log(JSON.stringify({ status: a.status, code: a.code, success: a.success, message: a.message, isEncrypted: a.isEncrypted, dataKeys: a.dataKeys }, null, 1));
  console.log('raw: ' + a.raw);
  out.videoById = a;

  console.log('\n=== /api/video/url?id= ===');
  const b = await hit(`/api/video/url?id=${aid}`);
  console.log(JSON.stringify({ status: b.status, code: b.code, success: b.success, message: b.message, dataKeys: b.dataKeys }, null, 1));
  console.log('raw: ' + b.raw);
  out.videoUrlById = b;

  // 试更多形态
  const cands = [
    [`/api/video/${aid}?topicId=${pid}`, 'GET', null],
    [`/api/video/info/${aid}`, 'GET', null],
    [`/api/video/play/${aid}`, 'GET', null],
    [`/api/video/url/${aid}`, 'GET', null],
    [`/api/video/detail/${aid}`, 'GET', null],
    [`/api/topic/video`, 'POST', { id: aid }],
    [`/api/video`, 'POST', { id: aid }],
    [`/api/video/play`, 'POST', { attachmentId: aid, topicId: pid }],
  ];
  console.log('\n=== 其他形态 ===');
  for (const [p, m, body] of cands) {
    const r = await hit(p, m, body);
    const info = r.dataKeys ? `DATA keys=${r.dataKeys}` : `code=${r.code} msg=${String(r.message).slice(0, 40)}`;
    console.log(`${r.status === 200 ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${m} ${p.padEnd(42)} ${info}`);
    if (r.data && JSON.stringify(r.data).match(/m3u8/)) {
      console.log('    *** 含 m3u8: ' + String(JSON.stringify(r.data)).slice(0, 300));
    }
    out[p] = r;
  }

  // 如果 /api/video/<id> 有 data，打印结构
  if (a.data) {
    console.log('\n=== /api/video/<id> 的 data 结构 ===');
    console.log(JSON.stringify(a.data, null, 2).slice(0, 1200));
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'videoapi.json'), JSON.stringify(out, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
