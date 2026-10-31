// kitty-verify.mjs —— 用真实口令验证 kitty 接口，确认 /hj/movieInfo 到底返回什么
//
// 输入：口令（从环境变量读，避免写死在仓库里）
// 动作：
//   1) /api/hj/getPermission 校验口令
//   2) 用一个真实视频附件（topicId + attachmentId）调 /api/hj/movieInfo
//   3) 把响应全文 dump 出来（口令脱敏）

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = 'out29';
const HOST = 'https://www.kittymao.xyz/api';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 之前抓到的真实样本：topic 2296441 的视频附件 id=14330811
const TOPIC_ID = 2296441;
const ATTACHMENT_ID = 14330811;

const passcode = (process.env.KITTY_CODE || '').trim();
const mask = s => (s ? s.slice(0, 2) + '***' + s.slice(-2) : '(空)');

async function req(url, init) {
  const r = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      'Origin': 'https://haijiao.com',
      'Referer': 'https://haijiao.com/post/details',
      ...(init?.headers || {}),
    },
  });
  const text = await r.text();
  return { status: r.status, ct: r.headers.get('content-type'), text };
}

async function main() {
  const out = { passcode: mask(passcode), topicId: TOPIC_ID, attachmentId: ATTACHMENT_ID, checks: [] };
  const log = (name, r) => {
    console.log(`\n=== ${name} ===`);
    console.log(`HTTP ${r.status}  ${r.ct}  ${r.text.length}B`);
    console.log(r.text.slice(0, 1200));
    out.checks.push({ name, status: r.status, ct: r.ct, len: r.text.length, body: r.text.slice(0, 4000) });
  };

  if (!passcode) { console.log('没有口令（KITTY_CODE 未设置）'); return; }

  // 1) 口令校验（脚本里是 checkPasscodePath: "/hj/getPermission"）
  log('GET /hj/getPermission', await req(`${HOST}/hj/getPermission?kthjau=${encodeURIComponent(passcode)}`));
  log('POST /hj/getPermission', await req(`${HOST}/hj/getPermission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kthjau: passcode }),
  }));

  // 2) movieInfo（body 按脚本里的结构）
  const body = { id: ATTACHMENT_ID, line: '', resource_id: TOPIC_ID, resource_type: 'topic' };
  log('POST /hj/movieInfo', await req(
    `${HOST}/hj/movieInfo?kthjau=${encodeURIComponent(passcode)}&isPhone=true&t=${Date.now()}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

  // 3) 如果上面失败，试几种变体
  const variants = [
    ['POST movieInfo 不带 t', `${HOST}/hj/movieInfo?kthjau=${encodeURIComponent(passcode)}&isPhone=true`, body],
    ['POST movieInfo isPhone=false', `${HOST}/hj/movieInfo?kthjau=${encodeURIComponent(passcode)}&isPhone=false&t=${Date.now()}`, body],
    ['GET movieInfo', `${HOST}/hj/movieInfo?kthjau=${encodeURIComponent(passcode)}&isPhone=true&t=${Date.now()}&id=${ATTACHMENT_ID}&resource_id=${TOPIC_ID}&resource_type=topic`, null],
  ];
  for (const [name, url, b] of variants) {
    const r = await req(url, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined);
    if (r.status === 200 && !r.text.includes('"code"') === false) {
      log(name, r);
    } else {
      console.log(`\n[${name}] HTTP ${r.status} ${r.text.slice(0, 120)}`);
      out.checks.push({ name, status: r.status, len: r.text.length, body: r.text.slice(0, 800) });
    }
  }

  // 4) 从所有响应里捞媒体地址
  const urls = new Set();
  for (const c of out.checks) {
    for (const m of (c.body || '').matchAll(/https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*/g)) urls.add(m[0]);
  }
  console.log('\n\n=== 捞到的媒体地址 ===');
  if (urls.size) for (const u of urls) console.log('  ' + u);
  else console.log('  (无)');
  out.mediaUrls = [...urls];

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'kitty-verify.json'), JSON.stringify(out, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
