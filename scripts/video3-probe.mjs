// video3-probe.mjs —— 完整版视频到底怎么给
//
// 已知：视频 URL 带 `_i_preview`，去掉就 404；详情里有 sale{money_type,amount,is_buy}。
// 要回答三件事：
//   1) 免费视频帖的 m3u8 带不带 _i_preview？（带 → preview 只是低码率版；不带 → 它就是付费锁）
//   2) 详情/列表响应里有没有藏着完整版地址（别的字段）
//   3) 站点所有 API 路径 + JS 里跟 preview/购买有关的逻辑

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out24';
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

// 在浏览器上下文里 fetch（同源、带站点 cookie），比 Node 直连稳
async function getJSONViaPage(page, pathname) {
  const raw = await page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'accept': 'application/json, text/plain, */*' } });
    const t = await r.text();
    return { status: r.status, len: t.length, head: t.slice(0, 120), body: t };
  }, pathname);
  console.log(`  GET ${pathname} -> ${raw.status} ${raw.len}B`);
  if (raw.status !== 200) { console.log('    响应:', raw.head); return null; }
  let env;
  try { env = JSON.parse(raw.body); } catch (e) { console.log('    非 JSON:', raw.head); return null; }
  const data = decodeLayers(env.data);
  if (!data) console.log('    解码失败, data 前缀:', String(env.data).slice(0, 40));
  return data;
}

async function main() {
  const out = { freeVideos: [], paidVideos: [], apiPaths: [], jsHints: [] };

  // 浏览器先起来（后面还要抓 JS）
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const jsBodies = [];
  const page = await ctx.newPage();
  page.on('response', async r => {
    const u = r.url();
    if (!/\.js(\?|$)/.test(u)) return;
    try { jsBodies.push({ url: u.replace(BASE, ''), body: await r.text() }); } catch (e) {}
  });
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);

  // 1) 扫几页列表，分别收集「免费视频帖」与「付费视频帖」
  for (let pg = 1; pg <= 3; pg++) {
    const list = await getJSONViaPage(page, `/api/topic/hot/topics?page=${pg}`);
    for (const t of ((list && list.results) || [])) {
      const v = (t.attachments || []).find(a => (a.category || '').toLowerCase().includes('video') && a.remoteUrl);
      if (!v) continue;
      const rec = {
        topicId: t.topicId,
        title: String(t.title || '').slice(0, 20),
        money_type: t.money_type,
        isPaidBadge: String(t.title || '').includes('收费') || String(t.title || '').includes('购买'),
        url: v.remoteUrl,
        hasPreviewTag: String(v.remoteUrl).includes('_preview'),
        cover: v.coverUrl || '',
        video_time_length: v.video_time_length,
        attachmentKeys: Object.keys(v),
      };
      if (t.money_type === 0) out.freeVideos.push(rec);
      else out.paidVideos.push(rec);
    }
  }
  console.log(`免费视频帖 ${out.freeVideos.length} 条，付费/金币视频帖 ${out.paidVideos.length} 条`);
  const show = (arr, label) => {
    for (const r of arr.slice(0, 3)) {
      console.log(`  [${label}] money_type=${r.money_type} preview=${r.hasPreviewTag} len=${r.video_time_length}`);
      console.log(`     ${r.url}`);
      console.log(`     附件字段: ${r.attachmentKeys.join(',')}`);
    }
  };
  show(out.freeVideos, '免费');
  show(out.paidVideos, '付费');

  // 2) 详情：把附件与 sale 全量 dump（找隐藏的完整版地址）
  const sample = (out.freeVideos[0] || out.paidVideos[0]);
  if (sample) {
    try {
      const d = await getJSON(`/api/topic/${sample.topicId}`);
      out.detailSample = {
        topicId: sample.topicId,
        money_type: d.money_type,
        sale: d.sale,
        reward: d.reward,
        attachments: d.attachments,
        // 把所有可能是 URL 的字段都捞出来
        urlsInDetail: JSON.stringify(d).match(/https?:\/\/[^"'\\\s]+/g)?.slice(0, 30) || [],
      };
      console.log('\n详情附件:');
      console.log(JSON.stringify(d.attachments, null, 1).slice(0, 900));
      console.log('sale:', JSON.stringify(d.sale), ' money_type:', d.money_type);
      const allUrls = out.detailSample.urlsInDetail.filter(u => /\.m3u8|video/.test(u));
      console.log('详情里所有视频类 URL:', allUrls.join('\n  '));
    } catch (e) { console.log('详情失败', e.message); }
  }

  // 3) JS 已在上面抓过，直接分析

  const apis = new Set();
  const hints = [];
  for (const j of jsBodies) {
    for (const m of j.body.matchAll(/["'`](\/api\/[a-zA-Z0-9_\/\-\{\}\$\.]+)["'`]/g)) apis.add(m[1]);
    for (const kw of ['_i_preview', '_preview', 'm3u8', 'buyTopic', 'buy_topic', 'createOrder', 'unlock', 'is_buy', 'buy_index']) {
      const i = j.body.indexOf(kw);
      if (i >= 0) hints.push({ js: j.url, kw, ctx: j.body.slice(Math.max(0, i - 200), i + 260) });
    }
  }
  out.apiPaths = [...apis].sort();
  out.jsHints = hints.slice(0, 12).map(h => ({ js: h.js, kw: h.kw, ctx: h.ctx.replace(/\s+/g, ' ') }));

  console.log(`\n=== JS 里的 /api/ 路径（${out.apiPaths.length} 个，含 order/buy/video/pay 的）===`);
  console.log(out.apiPaths.filter(p => /order|buy|pay|video|sale|unlock|preview/i.test(p)).join('\n') || '(无)');

  console.log('\n=== preview / 购买相关片段 ===');
  for (const h of out.jsHints.slice(0, 6)) {
    console.log(`\n[${h.js}] ${h.kw}`);
    console.log('  ' + h.ctx.slice(0, 300));
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'video3.json'), JSON.stringify(out, null, 2));
  await fs.writeFile(path.join(OUT, 'all-apis.txt'), out.apiPaths.join('\n'));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
