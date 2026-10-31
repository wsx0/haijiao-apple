// nodes-probe.mjs —— 抓板块列表（原站 Tab 的真正来源）
//
// 首屏实测请求：GET /api/topic/nodes_by_ver/v2?ver=0
// 这个接口返回站点的板块（热帖/视频/论坛/推荐/最新/精华…），
// 「最新」「精华」是板块而不是排序参数 —— 这解释了为什么 type=essence 无效。
// 另外把每个板块的 id 和名称列出来，供原生端做顶部导航。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out32';
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

async function get(pathname) {
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
  try { env = JSON.parse(text); } catch { return { status: r.status, raw: text.slice(0, 200) }; }
  return { status: r.status, env, data: env.data ? decodeLayers(env.data) : null };
}

function walkNodes(node, out, depth = 0) {
  if (!node) return;
  if (Array.isArray(node)) { for (const n of node) walkNodes(n, out, depth); return; }
  if (typeof node !== 'object') return;
  const id = node.nodeId ?? node.id;
  const name = node.name ?? node.nodeName ?? node.title;
  if (id != null && name) {
    out.push({
      id: Number(id),
      name: String(name).slice(0, 20),
      depth,
      hot: node.isHot ?? node.hot ?? null,
      parentId: node.parentId ?? node.pid ?? null,
    });
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') walkNodes(v, out, depth + 1);
  }
}

async function main() {
  const result = {};
  for (const p of ['/api/topic/nodes_by_ver/v2?ver=0', '/api/topic/nodes_by_ver/v2', '/api/node/list', '/api/topic/nodes']) {
    const r = await get(p);
    if (r.data) {
      const nodes = [];
      walkNodes(r.data, nodes);
      // 去重
      const seen = new Set();
      const uniq = nodes.filter(n => { const k = n.id + ':' + n.name; if (seen.has(k)) return false; seen.add(k); return true; });
      console.log(`\n=== ${p} ===`);
      console.log(`节点 ${uniq.length} 个：`);
      for (const n of uniq.slice(0, 60)) {
        console.log(`  ${String(n.id).padStart(6)}  ${'  '.repeat(Math.min(n.depth, 3))}${n.name}${n.hot ? '  [hot]' : ''}`);
      }
      result[p] = { status: r.status, nodes: uniq, rawKeys: Object.keys(r.data) };
      break;
    } else {
      console.log(`✗ ${p}  ${r.status}  ${(r.raw || '').slice(0, 80)}`);
    }
  }

  // 用拿到的第一个板块 id 试列表接口
  const anyNodes = Object.values(result)[0]?.nodes || [];
  if (anyNodes.length) {
    const nid = anyNodes.find(n => n.name === '最新')?.id || anyNodes[0].id;
    const tries = [
      `/api/topic/hot/topics?page=1&nodeId=${nid}`,
      `/api/topic/hot/topics?page=1&node_id=${nid}`,
      `/api/topic/node/${nid}/topics?page=1`,
      `/api/topic/nodes/${nid}/topics?page=1`,
      `/api/topic/topics?page=1&nodeId=${nid}`,
    ];
    console.log(`\n=== 试板块 ${nid} 的帖子列表 ===`);
    for (const t of tries) {
      const r = await get(t);
      const n = r.data?.results?.length ?? (Array.isArray(r.data) ? r.data.length : 0);
      const first = r.data?.results?.[0];
      console.log(`${n > 0 ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${t.padEnd(46)} n=${n} ${first ? first.topicId : ''}`);
      if (n > 0) {
        result['nodeFeed'] = { path: t, nodeId: nid };
        break;
      }
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'nodes.json'), JSON.stringify(result, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
