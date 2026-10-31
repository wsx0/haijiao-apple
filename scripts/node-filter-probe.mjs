// node-filter-probe.mjs —— nodeId 到底生不生效？直接比对返回的帖子集合
//
// 上次的错误：只看了 `n>0` 就认定 `nodeId` 生效（`type=essence` 也是这样骗过我的）。
// 这次拿不同 nodeId 的返回做集合比对：如果 topicId 完全重合，说明参数被忽略。
// 同时试几种传参方式（query/下划线/POST body/路径）。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out33';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

const decodeLayers = payload => {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) { cur = text.trim(); }
  }
  return null;
};

const H = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Referer': `${BASE}/home`,
  'mver': '211112203214',
  'x-user-id': 'null',
  'x-user-token': 'null',
};

async function get(pathname) {
  const r = await fetch(BASE + pathname, { headers: H });
  const t = await r.text();
  try {
    const env = JSON.parse(t);
    return env.data ? decodeLayers(env.data) : null;
  } catch { return null; }
}

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try {
    const env = JSON.parse(t);
    return env.data ? decodeLayers(env.data) : null;
  } catch { return null; }
}

const ids = d => (d && d.results ? d.results.map(x => x.topicId) : []);

function overlap(a, b) {
  if (!a.length || !b.length) return -1;
  const sa = new Set(a), sb = new Set(b);
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit++;
  return hit / Math.max(sa.size, sb.size);
}

async function main() {
  const out = { tests: [] };
  const NODES = [900, 2020, 1001, 115];

  console.log('=== A. query nodeId ===');
  const base = ids(await get('/api/topic/hot/topics?page=1'));
  console.log(`无 nodeId: ${base.length} 条, 前3=${base.slice(0, 3).join(',')}`);
  for (const n of NODES) {
    const got = ids(await get(`/api/topic/hot/topics?page=1&nodeId=${n}`));
    const ov = overlap(base, got);
    console.log(`nodeId=${n}: ${got.length} 条, 前3=${got.slice(0, 3).join(',')}  重合率=${ov < 0 ? 'n/a' : (ov * 100).toFixed(0) + '%'}`);
    out.tests.push({ kind: 'query nodeId', n, first: got.slice(0, 3), overlap: ov });
  }

  console.log('\n=== B. query node_id / node / nid ===');
  for (const key of ['node_id', 'node', 'nid', 'nidList']) {
    const got = ids(await get(`/api/topic/hot/topics?page=1&${key}=900`));
    const ov = overlap(base, got);
    console.log(`${key}=900: ${got.length} 条, 前3=${got.slice(0, 3).join(',')}  重合率=${ov < 0 ? 'n/a' : (ov * 100).toFixed(0) + '%'}`);
    out.tests.push({ kind: key, first: got.slice(0, 3), overlap: ov });
  }

  console.log('\n=== C. POST body ===');
  for (const key of ['nodeId', 'node_id']) {
    const got = ids(await post('/api/topic/hot/topics', { page: 1, [key]: 900 }));
    const ov = overlap(base, got);
    console.log(`POST {${key}:900}: ${got.length} 条, 前3=${got.slice(0, 3).join(',')}  重合率=${ov < 0 ? 'n/a' : (ov * 100).toFixed(0) + '%'}`);
    out.tests.push({ kind: 'POST ' + key, first: got.slice(0, 3), overlap: ov });
  }

  console.log('\n=== D. 其他可能路径 ===');
  const paths = [
    '/api/topic/node/900/topics?page=1',
    '/api/topic/nodes/900/topics?page=1',
    '/api/node/900/topics?page=1',
    '/api/topic/noded/topics?page=1&nodeId=900',
    '/api/topic/900/topics?page=1',
    '/api/topic/list?page=1&nodeId=900',
  ];
  for (const p of paths) {
    const got = ids(await get(p));
    if (got.length) {
      const ov = overlap(base, got);
      console.log(`✓ ${p}  ${got.length} 条 前3=${got.slice(0, 3).join(',')} 重合=${ov < 0 ? 'n/a' : (ov * 100).toFixed(0)}%`);
      out.tests.push({ kind: p, first: got.slice(0, 3), overlap: ov });
    } else {
      console.log(`✗ ${p}`);
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'nodefilter.json'), JSON.stringify(out, null, 2));

  const effective = out.tests.filter(t => t.overlap >= 0 && t.overlap < 0.9 && t.first.length);
  console.log(`\n=== 可能真的生效的（重合率<90%）: ${effective.length} ===`);
  for (const e of effective) console.log(`  ${e.kind}  nodeId=${e.n ?? ''}  重合=${(e.overlap * 100).toFixed(0)}%  首条=${e.first[0]}`);
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
