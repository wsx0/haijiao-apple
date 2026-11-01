// webapp-probe.mjs —— 网页版可行性验证：CORS + 完整列表推导命中率
//
// 要回答两件事，决定网页版能不能纯静态跑起来：
//   1) haijiao.com 的 API 是否返回 Access-Control-Allow-Origin（浏览器能否直接 fetch）
//   2) 从试看列表推导完整列表，在真实帖子里命中率多高（值不值得做）

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out41';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

const decodeLayers = payload => {
  let cur = String(payload).trim();
  for (let i = 0; i < 10; i++) {
    try { return JSON.parse(Buffer.from(cur, 'base64').toString('utf8')); } catch (e) {}
    const t = Buffer.from(cur, 'base64').toString('utf8');
    if (!t || t === cur) break;
    cur = t.trim();
  }
  return null;
};

async function apiGet(p) {
  const r = await fetch(BASE + p, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
               'Referer': BASE + '/home', 'mver': '211112203214',
               'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const t = await r.text();
  const cors = {
    acao: r.headers.get('access-control-allow-origin'),
    acac: r.headers.get('access-control-allow-credentials'),
    acah: r.headers.get('access-control-allow-headers'),
  };
  let data = null;
  try { const e = JSON.parse(t); data = e.data ? decodeLayers(e.data) : null; } catch (e) {}
  return { status: r.status, cors, data };
}

// 预览列表 → 流 ID
function streamIdFromPlaylist(text) {
  const m = text.match(/^\s*([A-Za-z0-9_-]+)_i\d+\.ts\s*$/m);
  return m ? m[1] : null;
}

async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.ok ? Number(r.headers.get('content-length') || 0) : null;
  } catch (e) { return null; }
}

async function main() {
  const out = { cors: {}, attempts: [] };

  // ── 1) CORS ──
  console.log('=== CORS 探测 ===');
  for (const p of ['/api/topic/hot/topics?page=1', '/api/login/conf']) {
    const r = await apiGet(p);
    const ok = r.cors.acao || '(无)';
    console.log(`  ${p}`);
    console.log(`    status=${r.status} ACAO=${ok} ACAC=${r.cors.acac || '-'}`);
    out.cors[p] = r.cors;
  }

  // 图片域名也测一下（网页版要直接显示图片）
  try {
    const img = await fetch('https://pic.hj260302818.top/hjstore/images/20261023/e85129820d8b0d42cfad2f2a1d14aae9.jpg.txt',
      { method: 'HEAD' });
    console.log(`  图片域 ACAO=${img.headers.get('access-control-allow-origin') || '(无)'}`);
    out.cors.image = img.headers.get('access-control-allow-origin');
  } catch (e) { console.log('  图片域探测失败'); }

  // ── 2) 扫几个板块，收集视频帖，逐个试推导 ──
  console.log('\n=== 完整列表推导命中率 ===');
  const nodes = [888, 2020, 1001, 900, 972, 115];
  const videos = [];
  for (const n of nodes) {
    const r = await apiGet(`/api/topic/node/topics?nodeId=${n}&page=1&type=1`);
    for (const t of (r.data?.results || [])) {
      const v = (t.attachments || []).find(a => (a.category || '').toLowerCase().includes('video') && (a.remoteUrl || '').includes('_preview'));
      if (v) videos.push({ nodeId: n, topicId: t.topicId, url: v.remoteUrl, title: String(t.title || '').slice(0, 16) });
    }
    if (videos.length >= 12) break;
  }
  console.log(`收集到 ${videos.length} 个试看地址`);

  let hit = 0, random = 0, nostream = 0, gone = 0;
  for (const v of videos.slice(0, 12)) {
    let text = '';
    try {
      const r = await fetch(v.url, { cache: 'no-store' });
      text = await r.text();
    } catch (e) {
      out.attempts.push({ ...v, outcome: 'fetch-failed' });
      continue;
    }
    const segs = (text.match(/^[^\s#].*\.ts$/gm) || []).length;
    const stream = streamIdFromPlaylist(text);
    if (!stream) {
      const isRandom = /^\s*[0-9a-f]{32}\.ts\s*$/m.test(text);
      out.attempts.push({ ...v, outcome: isRandom ? 'random-segments' : 'no-stream-id', segs });
      if (isRandom) random++; else nostream++;
      console.log(`  ✗ ${v.topicId}  ${isRandom ? '随机分片' : '无流ID'}  (${segs} 段)`);
      continue;
    }
    const base = v.url.replace(/[^/]*$/, '');
    let found = null;
    for (const name of [`${stream}_i.m3u8`, `${stream}.m3u8`, `${stream}_full.m3u8`]) {
      const len = await head(base + name);
      if (len !== null) { found = { name, len }; break; }
    }
    if (found) {
      hit++;
      // 完整列表的分片数
      let fullSegs = 0;
      try {
        const t2 = await (await fetch(base + found.name, { cache: 'no-store' })).text();
        fullSegs = (t2.match(/^[^\s#].*\.ts$/gm) || []).length;
      } catch (e) {}
      console.log(`  ✓ ${v.topicId}  stream=${stream}  → ${found.name}  预览${segs}段/完整${fullSegs}段`);
      out.attempts.push({ ...v, outcome: 'hit', stream, file: found.name, previewSegs: segs, fullSegs });
    } else {
      gone++;
      console.log(`  ✗ ${v.topicId}  stream=${stream}  三个候选都 404`);
      out.attempts.push({ ...v, outcome: 'all-404', stream, segs });
    }
  }

  console.log(`\n=== 汇总（${videos.slice(0, 12).length} 个样本）===`);
  console.log(`  命中完整列表: ${hit}`);
  console.log(`  新格式(随机分片): ${random}`);
  console.log(`  无流ID: ${nostream}`);
  console.log(`  三个候选都404: ${gone}`);
  out.summary = { hit, random, nostream, gone, total: videos.slice(0, 12).length };

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'webapp.json'), JSON.stringify(out, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
