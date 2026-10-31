// video2-probe.mjs —— 关键一问：AES key 能不能直接拿
//
// m3u8 里写着：
//   #EXT-X-KEY:METHOD=AES-128,URI="enc_14330811.key",IV=0x680a...
// 如果这个 .key 能直接 GET，AVPlayer 就能原生播放，不需要任何自定义加载。
// 如果需要鉴权，就得用 AVAssetResourceLoaderDelegate 拦截并补头。

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out23';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const M3U8 = 'https://ts10.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/565690_i_preview.m3u8';

const base = M3U8.slice(0, M3U8.lastIndexOf('/') + 1);

async function tryGet(url, headers, binary = false) {
  try {
    const r = await fetch(url, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      status: r.status,
      ct: r.headers.get('content-type'),
      len: buf.length,
      head: binary ? [...buf.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join(' ') : buf.toString('utf8').slice(0, 80),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const results = { base, checks: [] };
  const add = (name, r) => { results.checks.push({ name, ...r }); 
    console.log(`${name.padEnd(26)} ${r.error ? 'ERR ' + r.error : r.status + '  ' + String(r.ct).padEnd(22) + r.len + 'B  ' + (r.head || '').slice(0, 60)}`); };

  // 1) m3u8 本身
  console.log('=== m3u8 ===');
  add('m3u8 裸', await tryGet(M3U8, {}));
  add('m3u8 +UA', await tryGet(M3U8, { 'User-Agent': UA }));
  add('m3u8 +UA+Referer', await tryGet(M3U8, { 'User-Agent': UA, 'Referer': BASE + '/' }));

  // 2) 完整 m3u8 内容
  const full = await fetch(M3U8, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } }).then(r => r.text());
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'full-m3u8.txt'), full);
  const segs = full.split('\n').filter(l => l.endsWith('.ts'));
  const durs = [...full.matchAll(/#EXTINF:([\d.]+)/g)].map(m => parseFloat(m[1]));
  const total = durs.reduce((a, b) => a + b, 0);
  console.log(`\n分片 ${segs.length} 个，总时长 ${total.toFixed(1)}s`);
  const keyLine = full.split('\n').find(l => l.startsWith('#EXT-X-KEY'));
  console.log('加密行:', keyLine);
  const keyUri = keyLine && (keyLine.match(/URI="([^"]+)"/) || [])[1];
  console.log('key URI:', keyUri);

  // 3) key 的访问性（各种头）
  console.log('\n=== AES key ===');
  const keyUrl = base + keyUri;
  add('key 裸', await tryGet(keyUrl, {}, true));
  add('key +UA', await tryGet(keyUrl, { 'User-Agent': UA }, true));
  add('key +UA+Referer', await tryGet(keyUrl, { 'User-Agent': UA, 'Referer': BASE + '/' }, true));
  add('key +UA+Referer+m3u8', await tryGet(keyUrl, { 'User-Agent': UA, 'Referer': M3U8 }, true));
  add('key +Origin', await tryGet(keyUrl, { 'User-Agent': UA, 'Origin': BASE, 'Referer': BASE + '/' }, true));

  // 4) 一个分片
  console.log('\n=== 分片 ts ===');
  const tsUrl = base + segs[0];
  add('ts 裸', await tryGet(tsUrl, {}, true));
  add('ts +UA+Referer', await tryGet(tsUrl, { 'User-Agent': UA, 'Referer': BASE + '/' }, true));

  await fs.writeFile(path.join(OUT, 'video2.json'), JSON.stringify(results, null, 2));
  console.log('\n结论：');
  const keyCheck = results.checks.find(c => c.name === 'key +UA+Referer');
  if (keyCheck && keyCheck.status === 200) console.log('  key 可直接拿（16 字节）→ AVPlayer 原生播放即可，无需自定义加载器');
  else console.log('  key 需要鉴权 → 需要 AVAssetResourceLoaderDelegate 补头');
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
