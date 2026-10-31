// img2-probe.mjs —— 拆 pic.*.top 的 .txt 图片到底怎么编码的
//
// 已知：所有头组合都 200，返回 30764 字节 text/plain，前 4 字节 = "#FEy"，<img> 加载失败、fetch 成功。
// 说明站点是 XHR 取文本 → 前端解码 → blob。这里把内容 dump 出来，试几种常见编码，
// 并从站点 JS 里找处理 img[data-url] 的解码函数。

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = 'out15';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

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

const magicOf = b => {
  const h = [...b.slice(0, 4)].map(x => x.toString(16).padStart(2, '0')).join('');
  if (h.startsWith('ffd8ff')) return 'JPEG';
  if (h.startsWith('89504e47')) return 'PNG';
  if (h.startsWith('47494638')) return 'GIF';
  if (h.startsWith('52494646')) return 'WEBP';
  if (h.startsWith('1f8b')) return 'GZIP';
  if (h.startsWith('789c') || h.startsWith('7801')) return 'ZLIB';
  return 'raw:' + h;
};

async function main() {
  // 取一张真实图
  const r = await fetch(`${BASE}/api/topic/hot/topics?page=1`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': `${BASE}/home`,
               'mver': '211112203214', 'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const env = await r.json();
  const list = decodeLayers(env.data);
  let imgUrl = null;
  for (const t of (list.results || [])) {
    for (const a of (t.attachments || [])) {
      const u = a.coverUrl || a.remoteUrl;
      if (u && /\.(jpe?g|png|gif)(\.txt)?$/i.test(u)) { imgUrl = u; break; }
    }
    if (imgUrl) break;
  }
  console.log('图片:', imgUrl);

  const res = await fetch(imgUrl, { headers: { 'User-Agent': UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`status=${res.status} len=${buf.length} ct=${res.headers.get('content-type')}`);
  console.log('前 4 字节 magic:', magicOf(buf));

  // a) 原始内容长什么样
  const head = buf.slice(0, 400);
  console.log('\n--- 原始前 400 字节（可打印）---');
  console.log(head.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  console.log('\n--- hex 前 64 字节 ---');
  console.log([...buf.slice(0, 64)].map(x => x.toString(16).padStart(2, '0')).join(' '));

  // b) 试几种解码
  const tries = [];
  const tryDecode = (name, fn) => {
    try {
      const out = fn();
      if (out && out.length) tries.push({ name, len: out.length, magic: magicOf(out), head: out.slice(0, 60).toString('latin1').replace(/[^\x20-\x7e]/g, '.') });
    } catch (e) {
      tries.push({ name, error: e.message });
    }
  };

  const text = buf.toString('latin1');
  // 去掉可能的前缀 "#FEy"
  const afterPrefix = buf.slice(4);
  tryDecode('原样 gzip', () => zlib.gunzipSync(buf));
  tryDecode('原样 inflate', () => zlib.inflateSync(buf));
  tryDecode('去掉4字节 gzip', () => zlib.gunzipSync(afterPrefix));
  tryDecode('去掉4字节 inflate', () => zlib.inflateSync(afterPrefix));
  tryDecode('整串 base64', () => Buffer.from(text.trim(), 'base64'));
  tryDecode('去前缀 base64', () => Buffer.from(afterPrefix.toString('latin1').trim(), 'base64'));
  tryDecode('去#FEy后 base64', () => Buffer.from(text.replace(/^#FEy/, '').trim(), 'base64'));
  // 有的站点格式：#FEy + base64(压缩)
  tryDecode('base64→inflate', () => zlib.inflateSync(Buffer.from(afterPrefix.toString('latin1').trim(), 'base64')));
  tryDecode('base64→gunzip', () => zlib.gunzipSync(Buffer.from(afterPrefix.toString('latin1').trim(), 'base64')));

  console.log('\n--- 解码尝试 ---');
  for (const t of tries) {
    if (t.error) console.log(`  ${t.name.padEnd(20)} 失败: ${t.error.slice(0, 60)}`);
    else console.log(`  ${t.name.padEnd(20)} ${t.len}B magic=${t.magic}  head=${JSON.stringify(t.head.slice(0, 40))}`);
  }

  // c) 站点 JS 里怎么解 img[data-url] 的
  const scripts = await fetch(`${BASE}/home`, { headers: { 'User-Agent': UA } }).then(x => x.text());
  const jsUrls = [...scripts.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]).slice(0, 20);
  const hints = [];
  for (const u of jsUrls) {
    const full = u.startsWith('http') ? u : BASE + (u.startsWith('/') ? u : '/' + u);
    try {
      const code = await fetch(full, { headers: { 'User-Agent': UA } }).then(x => x.text());
      for (const kw of ['data-url', 'dataUrl', 'FEy', 'atob(', 'createObjectURL', 'new Image', 'decodeURIComponent(atob']) {
        const i = code.indexOf(kw);
        if (i >= 0) hints.push({ js: full.replace(BASE, ''), kw, ctx: code.slice(Math.max(0, i - 120), i + 180).replace(/\s+/g, ' ') });
      }
    } catch (e) {}
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'img2.json'), JSON.stringify({ imgUrl, len: buf.length, magic: magicOf(buf), tries, hints }, null, 2));
  await fs.writeFile(path.join(OUT, 'raw-image.txt'), buf);

  console.log(`\n--- 站点 JS 里与图片解码相关的片段（前 6 条）---`);
  for (const h of hints.slice(0, 6)) {
    console.log(`\n[${h.js}] 关键词 ${h.kw}`);
    console.log('  ' + h.ctx.slice(0, 240));
  }
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
