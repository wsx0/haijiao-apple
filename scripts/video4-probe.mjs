// video4-probe.mjs —— 最后一轮：完整版文件到底存不存在
//
// 已知：
//   目录 .../105f7d1d12d6c3854b57940db853d59b/
//   里面确定有 565690_i_preview.m3u8（24 分片 / 30 秒）和 enc_14330811.key（16 字节）
//   全片 782 秒 —— 也就是预览只占 4%
// 要试：
//   1) 同目录下不带 preview 的几种文件名
//   2) 目录本身是否可列举（OSS 有时会返回 XML）
//   3) 常见的 CDN 参数（?v= / ?t= / ?sign=）能不能放出别的版本

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out25';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const DIR = 'https://ts10.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/';

async function head(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ct: r.headers.get('content-type'), len: buf.length, head: buf.toString('utf8').slice(0, 60).replace(/\n/g, ' ') };
  } catch (e) { return { error: e.message }; }
}

async function main() {
  const rows = [];
  const add = (name, url, r) => {
    rows.push({ name, url: url.replace('https://ts10.hj260302818.top', '…'), ...r });
    const s = r.error ? 'ERR' : r.status;
    console.log(`${name.padEnd(28)} ${String(s).padEnd(4)} ${String(r.ct || '').padEnd(28)} ${String(r.len || '').padStart(7)}  ${(r.head || '').slice(0, 50)}`);
  };

  console.log('=== 1) 同目录下的文件名变体 ===');
  const names = [
    '565690_i_preview.m3u8',
    '565690.m3u8',
    '565690_i.m3u8',
    '565690_full.m3u8',
    '565690_hd.m3u8',
    '565690_origin.m3u8',
    '565690_source.m3u8',
    '565690_0.m3u8',
    '565690_preview.m3u8',
    'index.m3u8',
    'playlist.m3u8',
    'master.m3u8',
  ];
  for (const n of names) add(n, DIR + n, await head(DIR + n));

  console.log('\n=== 2) 目录能否列举 ===');
  add('目录本身', DIR, await head(DIR));
  add('目录 ?list-type=2', DIR + '?list-type=2&max-keys=20', await head(DIR + '?list-type=2&max-keys=20'));
  add('目录 ?prefix=', DIR + '?prefix=565690', await head(DIR + '?prefix=565690'));

  console.log('\n=== 3) 已知存在的两个文件（对照）===');
  add('enc_14330811.key', DIR + 'enc_14330811.key', await head(DIR + 'enc_14330811.key'));
  add('565690.jpeg.txt(封面)', 'https://pic.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/565690.jpeg.txt', await head('https://pic.hj260302818.top/hjstore/video/20261023/105f7d1d12d6c3854b57940db853d59b/565690.jpeg.txt'));

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'video4.json'), JSON.stringify(rows, null, 2));

  const ok = rows.filter(r => r.status === 200 && !r.name.includes('preview') && !r.name.includes('.key') && !r.name.includes('jpeg'));
  console.log('\n结论：');
  if (ok.length) {
    console.log('  发现非预览的可用播放列表：');
    for (const r of ok) console.log(`    ${r.name}  ${r.len}B`);
  } else {
    console.log('  除 preview 外没有任何可用的 m3u8，目录也不可列举');
    console.log('  → 完整版由服务端在购买后下发，客户端无可用地址');
  }
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
