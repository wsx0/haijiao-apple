// api-detail-probe.mjs —— 直接按 id 打详情接口，不再纠缠 URL 形式
//
// 线索：详情页会请求 /api/topic/<id>（参数缺失时拼成 undefined）。
// 那就用列表里拿到的 topicId 直接打这个接口，再顺手试探评论接口的几种常见形式。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out13';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Referer': `${BASE}/home`,
  'mver': '211112203214',
  'x-user-id': 'null',
  'x-user-token': 'null',
};

function decodeLayers(payload) {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) {}
    if (!text.trim()) break;
    cur = text.trim();
  }
  return null;
}

async function getJSON(pathname) {
  const r = await fetch(BASE + pathname, { headers: HEADERS });
  const text = await r.text();
  let env = null;
  try { env = JSON.parse(text); } catch (e) {}
  let data = null;
  if (env && typeof env.data === 'string') data = decodeLayers(env.data);
  return { status: r.status, len: text.length, env: env && { code: env.errorCode, ok: env.success, enc: env.isEncrypted }, data, raw: text.slice(0, 300) };
}

async function main() {
  // 1) 列表拿一个真实 topicId
  const list = await getJSON('/api/topic/hot/topics?page=1');
  const topic = list.data && list.data.results && list.data.results[0];
  if (!topic) { console.log('列表没拿到数据'); return; }
  const id = topic.topicId;
  console.log(`样本 topicId=${id}  title=${String(topic.title).slice(0, 20)}`);

  const results = {};

  // 2) 详情接口
  const detail = await getJSON(`/api/topic/${id}`);
  results.detail = { path: `/api/topic/${id}`, status: detail.status, len: detail.len, env: detail.env, raw: detail.raw, data: detail.data };
  console.log(`\n[详情] /api/topic/${id} -> ${detail.status} ${detail.len}B  env=${JSON.stringify(detail.env)}`);
  if (detail.data) {
    console.log('  顶层字段:', Object.keys(detail.data).join(', '));
    const d = detail.data;
    const node = d.topic || d.data || d;
    console.log('  topic 字段:', node && typeof node === 'object' ? Object.keys(node).join(', ').slice(0, 400) : String(node));
  } else {
    console.log('  raw:', detail.raw.slice(0, 200));
  }

  // 3) 评论接口候选
  const cands = [
    `/api/comment/list/${id}?page=1&limit=20`,
    `/api/comment/${id}?page=1&limit=20`,
    `/api/topic/${id}/comment?page=1&limit=20`,
    `/api/topic/${id}/comments?page=1&limit=20`,
    `/api/comment/list?topicId=${id}&page=1&limit=20`,
    `/api/reply/list?topicId=${id}&page=1&limit=20`,
  ];
  for (const p of cands) {
    const r = await getJSON(p);
    const ok = !!(r.data && Object.keys(r.data).length);
    console.log(`\n[评论候选] ${p} -> ${r.status} ${r.len}B data=${ok ? 'yes' : 'no'}`);
    if (ok) console.log('  字段:', Object.keys(r.data).join(', ').slice(0, 300));
    else console.log('  raw:', r.raw.slice(0, 140));
    results['comment:' + p] = { status: r.status, len: r.len, ok, data: ok ? r.data : null };
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'api-detail.json'), JSON.stringify(results, null, 2));
  if (results.detail.data) {
    await fs.writeFile(path.join(OUT, 'detail-sample.json'), JSON.stringify(results.detail.data, null, 2).slice(0, 200000));
  }
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
