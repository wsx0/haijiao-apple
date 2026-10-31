// tabs-probe.mjs —— 摸清「最新 / 热门 / 精华」与搜索的接口形状
//
// 已知在用：/api/topic/hot/topics?page=1
// 要试：排序变体、搜索、板块列表

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out30';
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

async function probe(pathname) {
  try {
    const r = await fetch(BASE + pathname, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${BASE}/home`,
        'mver': '211112203214',
        'x-user-id': 'null',
        'x-user-token': 'null',
      },
    });
    const text = await r.text();
    let env;
    try { env = JSON.parse(text); } catch (e) {
      return { pathname, status: r.status, ok: false, note: '非 JSON: ' + text.slice(0, 60) };
    }
    const data = env.data ? decodeLayers(env.data) : null;
    const n = data && (data.results ? data.results.length : (Array.isArray(data) ? data.length : Object.keys(data).length));
    return {
      pathname,
      status: r.status,
      ok: !!data,
      code: env.errorCode,
      success: env.success,
      n,
      keys: data ? Object.keys(data).slice(0, 8) : [],
      sample: data && data.results && data.results[0] ? {
        id: data.results[0].topicId,
        title: String(data.results[0].title || '').slice(0, 18),
      } : null,
    };
  } catch (e) {
    return { pathname, status: -1, ok: false, note: e.message };
  }
}

async function main() {
  const paths = [
    // 已知
    '/api/topic/hot/topics?page=1',
    // 排序/类型变体
    '/api/topic/new/topics?page=1',
    '/api/topic/latest/topics?page=1',
    '/api/topic/essence/topics?page=1',
    '/api/topic/jinghua/topics?page=1',
    '/api/topic/topics?page=1',
    '/api/topic/topics?page=1&sort=new',
    '/api/topic/topics?page=1&type=new',
    '/api/topic/topics?page=1&order=new',
    '/api/topic/hot/topics?page=1&type=essence',
    '/api/topic/list?page=1',
    '/api/topic/list?page=1&type=new',
    // 板块/节点
    '/api/node/list',
    '/api/nodes',
    '/api/board/list',
    // 搜索
    '/api/topic/search?keyword=%E8%80%81%E5%A9%86&page=1',
    '/api/search?keyword=%E8%80%81%E5%A9%86&page=1',
    '/api/topic/search?wd=%E8%80%81%E5%A9%86&page=1',
    '/api/search/topic?keyword=%E8%80%81%E5%A9%86',
    '/api/topic/search?keyword=%E8%80%81%E5%A9%86&page=1&type=topic',
  ];

  const results = [];
  for (const p of paths) {
    const r = await probe(p);
    results.push(r);
    const flag = r.ok ? '✓' : '✗';
    console.log(`${flag} ${r.status} ${String(p).padEnd(52)} ${r.ok ? `n=${r.n} keys=${(r.keys || []).join(',')}` : (r.note || `code=${r.code}`)}`);
    if (r.sample) console.log(`     ${r.sample.id}  ${r.sample.title}`);
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'tabs.json'), JSON.stringify(results, null, 2));

  const worked = results.filter(r => r.ok);
  console.log(`\n可用接口 ${worked.length} 个：`);
  for (const w of worked) console.log('  ' + w.pathname);
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
