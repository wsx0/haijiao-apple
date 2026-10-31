// route-probe.mjs —— 验证作者主页路由 + 视频附件地址形态
//
// 两个待验证问题：
//   1) /homepage/<uid> 到底能不能渲染作者页？（用户反馈「进入网页但空白」）
//      同时试 /user/<uid>、/u/<uid>、/homepage/<uid>?tab=topic 等候选
//   2) 视频附件的 remoteUrl 现在长什么样（是否仍是 ?m3u8= 包装）

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out37';
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

async function apiGet(p) {
  const r = await fetch(BASE + p, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
               'Referer': BASE + '/home', 'mver': '211112203214',
               'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const t = await r.text();
  try { const e = JSON.parse(t); return e.data ? decodeLayers(e.data) : null; } catch { return null; }
}

async function main() {
  const out = {};

  // ── 1) 拿真实 uid 和一个视频帖 ──
  const list = await apiGet('/api/topic/hot/topics?page=1');
  const results = list?.results ?? [];
  const withUser = results.find(x => x.user?.id);
  const uid = withUser?.user?.id;
  const nickname = withUser?.user?.nickname;
  console.log(`样本作者: ${nickname}  id=${uid}`);

  // 视频附件形态
  const videoTopics = [];
  for (const t of results) {
    const v = (t.attachments || []).find(a => (a.category || '').toLowerCase().includes('video'));
    if (v) videoTopics.push({ topicId: t.topicId, url: v.remoteUrl, cover: v.coverUrl, len: v.video_time_length });
  }
  console.log(`\n=== 列表里的视频附件（${videoTopics.length}）===`);
  for (const v of videoTopics.slice(0, 3)) console.log(`  topic ${v.topicId}  ${v.len}s  ${v.url}`);
  out.videos = videoTopics;

  // 详情里的视频附件（可能和列表不同）
  const firstVideoTopic = videoTopics[0];
  if (firstVideoTopic) {
    const d = await apiGet(`/api/topic/${firstVideoTopic.topicId}`);
    const dv = (d?.attachments || []).find(a => (a.category || '').toLowerCase().includes('video'));
    console.log(`\n=== 详情里的视频附件（topic ${firstVideoTopic.topicId}）===`);
    console.log('  ' + JSON.stringify(dv));
    out.detailVideo = dv;
    out.detailSale = d?.sale;
  }

  if (!uid) { console.log('没拿到 uid'); return; }

  // ── 2) 逐个候选路由，看渲染结果 ──
  const routes = [
    `/homepage/${uid}`,
    `/user/${uid}`,
    `/u/${uid}`,
    `/homepage/${uid}?tab=topic`,
    `/forum/homepage/${uid}`,
  ];
  console.log('\n=== 作者页路由 ===');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  out.routes = [];
  for (const r of routes) {
    const calls = [];
    const h = req => { const u = req.url(); if (u.includes('/api/')) calls.push(u.replace(BASE, '')); };
    page.on('request', h);
    try {
      await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        len: (document.body.innerText || '').replace(/\s+/g, ' ').trim().length,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      }));
      const uniq = [...new Set(calls)];
      console.log(`\n[${r}]`);
      console.log(`  最终=${info.url.replace(BASE, '')} 文本长度=${info.len}`);
      console.log(`  文本: ${info.text}`);
      console.log(`  API: ${uniq.slice(0, 5).join(' | ')}`);
      out.routes.push({ route: r, ...info, api: uniq });
    } catch (e) {
      console.log(`\n[${r}] 失败: ${e.message.slice(0, 60)}`);
      out.routes.push({ route: r, error: e.message });
    }
    page.off('request', h);
  }

  await browser.close();

  // 判定哪个路由真的渲染了作者内容
  const good = out.routes.filter(r => r.len > 200 && !/首页|登录/.test(r.text || ''));
  console.log(`\n=== 看起来有效的路由: ${good.length} ===`);
  for (const g of good) console.log(`  ${g.route}  len=${g.len}  ${g.text.slice(0, 60)}`);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'route.json'), JSON.stringify(out, null, 2));
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
