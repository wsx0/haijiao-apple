// video-probe.mjs —— 拆 HLS：m3u8 是否加密、有没有完整版、要不要鉴权
//
// 列表/详情里视频附件长这样：
//   remoteUrl: https://ts10.hj260302818.top/hjstore/video/20261023/<hash>/565690_i_preview.m3u8
//   coverUrl:  https://pic.../565690.jpeg.txt
// 名字里带 `_i_preview` —— 很可能只是**预览片段**，完整版是另一个地址。
// 这里把 m3u8 抓下来看：是 master 还是 media、有没有 #EXT-X-KEY 加密、分片多少个，
// 并试几种「把 preview 去掉」的猜测。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out22';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

// 注意：JSON 接口用的是**标准 base64**（三层），打乱表那套只用于图片（SiteImage）。
const decodeLayers = payload => {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) { cur = text.trim(); }
  }
  return null;
};

// 兜底样本：前几轮抓到的真实视频附件（万一系列接口拿不到）
const FALLBACK_VIDEO = {
  id: 14330811,
  remoteUrl: 'https://ts10.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/565690_i_preview.m3u8',
  category: 'video',
  status: 1,
  coverUrl: 'https://pic.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/565690.jpeg.txt',
  video_time_length: 782,
};

async function getJSON(pathname) {
  const r = await fetch(BASE + pathname, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
               'Referer': `${BASE}/home`, 'mver': '211112203214',
               'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const text = await r.text();
  const env = JSON.parse(text);
  return decodeLayers(env.data);
}

async function fetchText(url, referer) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': referer || `${BASE}/home`, 'Accept': '*/*' },
  });
  const t = await r.text();
  return { status: r.status, ct: r.headers.get('content-type'), len: t.length, body: t.slice(0, 4000) };
}

async function main() {
  // 1) 找一个视频帖（API 拿不到就用兜底样本）
  let topic = null, video = null;
  try {
    const list = await getJSON('/api/topic/hot/topics?page=1');
    for (const t of ((list && list.results) || [])) {
      const v = (t.attachments || []).find(a => (a.category || '').toLowerCase().includes('video') && a.remoteUrl);
      if (v) { topic = t; video = v; break; }
    }
  } catch (e) { console.log('列表接口失败:', e.message); }
  if (!video) {
    console.log('改用兜底样本（前几轮抓到的真实视频附件）');
    topic = { topicId: 0, title: '(fallback)' };
    video = FALLBACK_VIDEO;
  }
  console.log('帖子:', topic.topicId, String(topic.title).slice(0, 24));
  console.log('视频附件:', JSON.stringify(video));

  // 2) 详情接口里的附件可能更全
  let detailVideo = null;
  try {
    const d = await getJSON(`/api/topic/${topic.topicId}`);
    const v = (d.attachments || []).find(a => (a.category || '').toLowerCase().includes('video'));
    if (v) { detailVideo = v; console.log('详情里的视频附件:', JSON.stringify(v)); }
    console.log('sale:', JSON.stringify(d.sale || null), ' money_type:', d.money_type);
  } catch (e) { console.log('详情拿失败', e.message); }

  const m3u8 = (detailVideo && detailVideo.remoteUrl) || video.remoteUrl;
  console.log('\n目标 m3u8:', m3u8);

  const results = {};

  // 3) 直接抓 m3u8
  const direct = await fetchText(m3u8, `${BASE}/`);
  results.direct = direct;
  console.log(`\n[直接] ${direct.status} ct=${direct.ct} len=${direct.len}`);
  console.log(direct.body.split('\n').slice(0, 15).map(l => '  ' + l).join('\n'));

  // 4) 各种「去掉 preview」的猜测
  const cands = [
    m3u8.replace('_i_preview', ''),
    m3u8.replace('_preview', ''),
    m3u8.replace('_i_preview.m3u8', '.m3u8'),
    m3u8.replace('/565690_i_preview', '/565690'),
    m3u8.replace('_i_preview', '_i'),
  ];
  for (const c of [...new Set(cands)]) {
    if (c === m3u8) continue;
    const r = await fetchText(c, `${BASE}/`);
    console.log(`\n[猜测] ${c.replace('https://', '').slice(0, 90)}`);
    console.log(`   ${r.status} ct=${r.ct} len=${r.len}` + (r.status === 200 ? '  ← 有内容' : ''));
    if (r.status === 200) {
      results['guess:' + c] = r;
      console.log('   ' + r.body.split('\n').slice(0, 10).join('\n   '));
    }
  }

  // 5) 如果拿到 master，跟进第一个 variant
  const firstLine = (direct.body || '').split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (firstLine) {
    const u = new URL(firstLine.trim(), m3u8).toString();
    const sub = await fetchText(u, `${BASE}/`);
    console.log(`\n[子播放列表] ${u.slice(0, 100)}`);
    console.log(`   ${sub.status} len=${sub.len}`);
    console.log('   ' + sub.body.split('\n').slice(0, 12).join('\n   '));
    results.sub = sub;
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'video.json'), JSON.stringify({ topicId: topic.topicId, video, detailVideo, results }, null, 2));
  await fs.writeFile(path.join(OUT, 'm3u8-direct.txt'), direct.body);
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
