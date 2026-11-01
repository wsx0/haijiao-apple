// attachment-probe.mjs —— 视频地址到底从哪个接口来？
//
// 现象：列表/详情接口的 attachments[].remoteUrl 为空，但网页版未登录也能看 30 秒预览
// → 说明播放地址是从**另一个接口**单独取的。
// 线索：kitty 脚本 hook 了 `/api/attachment`。
//
// 做法：找有 video 附件的帖子 → 拿 attachment id → 试各种 attachment 接口

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out42';
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

async function get(p) {
  const r = await fetch(BASE + p, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
               'Referer': BASE + '/home', 'mver': '211112203214',
               'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const t = await r.text();
  let data = null;
  try { const e = JSON.parse(t); data = e.data ? dec(e.data) : null; } catch (e) {}
  return { status: r.status, data, raw: t.slice(0, 200) };
}

async function main() {
  const out = { posts: [], attempts: [] };

  // ── 1) 找带 video 附件的帖子（不管 remoteUrl 空不空）──
  const nodes = [888, 2020, 1001, 972, 900, 115, 205];
  const found = [];
  for (const n of nodes) {
    const r = await get(`/api/topic/node/topics?nodeId=${n}&page=1&type=1`);
    for (const t of (r.data?.results || [])) {
      const vids = (t.attachments || []).filter(a => (a.category || '').toLowerCase().includes('video'));
      for (const v of vids) {
        found.push({
          nodeId: n,
          topicId: t.topicId,
          attachmentId: v.id,
          remoteUrl: v.remoteUrl || '',
          coverUrl: v.coverUrl || '',
          segs: v.segments ?? v.segmentCount ?? null,
          keys: Object.keys(v),
        });
      }
    }
    if (found.length >= 6) break;
  }
  console.log(`=== 找到 ${found.length} 个 video 附件 ===`);
  for (const f of found.slice(0, 6)) {
    console.log(`  topic=${f.topicId} attachment=${f.attachmentId} remoteUrl="${f.remoteUrl}"`);
    console.log(`     字段: ${f.keys.join(',')}`);
  }
  out.posts = found.slice(0, 6);

  if (!found.length) { console.log('没找到 video 附件'); return; }

  const sample = found[0];
  const aid = sample.attachmentId;
  const pid = sample.topicId;

  // ── 2) 试各种 attachment / 视频地址接口 ──
  const cands = [
    `/api/attachment/${aid}`,
    `/api/attachment?id=${aid}`,
    `/api/attachment/info/${aid}`,
    `/api/attachment/video/${aid}`,
    `/api/topic/attachment/${aid}`,
    `/api/topic/${pid}/attachment/${aid}`,
    `/api/attachment/${aid}/url`,
    `/api/video/${aid}`,
    `/api/video/url?id=${aid}`,
    `/api/topic/video/${pid}`,
  ];
  console.log(`\n=== 探测接口（attachment=${aid} topic=${pid}）===`);
  for (const p of cands) {
    const r = await get(p);
    const ok = !!r.data;
    const keys = r.data ? Object.keys(r.data).slice(0, 8).join(',') : '';
    // 找任何像 m3u8 的字符串
    const txt = JSON.stringify(r.data || {});
    const m3u8 = (txt.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g) || [])[0] || '';
    console.log(`${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${p.padEnd(34)} ${ok ? `keys=${keys}` : r.raw.slice(0, 60)}`);
    if (m3u8) console.log(`     *** m3u8: ${m3u8}`);
    out.attempts.push({ path: p, status: r.status, keys: r.data ? Object.keys(r.data) : [], m3u8, raw: ok ? '' : r.raw });
  }

  // ── 3) 看详情接口里 video 附件的**完整字段**（可能有别的地址字段）──
  console.log(`\n=== 详情接口里 video 附件的原始 JSON ===`);
  const d = await get(`/api/topic/${pid}`);
  const dv = (d.data?.attachments || []).find(a => (a.category || '').toLowerCase().includes('video'));
  console.log(JSON.stringify(dv, null, 2));
  out.detailVideo = dv;
  // 详情里所有 m3u8
  const allM3u8 = (JSON.stringify(d.data || {}).match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g) || []);
  console.log(`\n详情里所有 m3u8（${allM3u8.length}）:`);
  allM3u8.slice(0, 5).forEach(u => console.log('  ' + u));
  out.detailM3u8 = allM3u8;

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'attachment.json'), JSON.stringify(out, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
