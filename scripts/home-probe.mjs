// home-probe.mjs —— 直接看原站 /home：Tab 有哪些、点了发什么请求、配色到底什么样
//
// 用户反馈「Tab 只有热门一个真的」「背景不像原站」，所以不再猜，直接抓：
//   1) 页面里所有 /api/ 请求（含参数）
//   2) 顶部导航/Tab 的 DOM 文本
//   3) 逐个点 Tab，记录触发的新请求
//   4) 计算样式：body / 卡片 / 文字颜色与字号

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out31';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();

  const apiCalls = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/api/') || u.includes('?')) {
      if (u.includes('/api/')) apiCalls.push({ url: u.replace(BASE, ''), method: r.method() });
    }
  });

  console.log('打开原站首页…');
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);

  // 1) 顶部导航 / Tab 结构
  const nav = await page.evaluate(() => {
    const out = { candidates: [], texts: [] };
    // 常见 Tab 容器
    const sels = ['.van-tabs', '[class*="tab"]', 'nav', 'header', '.header', '#app > .mobile > div:first-child'];
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].slice(0, 3);
      for (const el of els) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 400) out.candidates.push({ sel: s, cls: el.className, text: t.slice(0, 300) });
      }
    }
    // 页面上短文本（可能是 Tab 名）
    out.texts = [...document.querySelectorAll('div,span,a,li')]
      .map(e => (e.innerText || '').trim())
      .filter(t => t && t.length <= 6 && /[\u4e00-\u9fa5]/.test(t))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 60);
    return out;
  });

  console.log('\n=== 顶部候选容器 ===');
  for (const c of nav.candidates.slice(0, 6)) {
    console.log(`[${c.sel}] class="${c.cls}"`);
    console.log('   ' + c.text.slice(0, 200));
  }
  console.log('\n=== 短文本（可能是 Tab 名）===');
  console.log(nav.texts.join(' | '));

  // 2) 首屏 API
  const initial = [...new Map(apiCalls.map(a => [a.url, a])).values()];
  console.log(`\n=== 首屏 API（${initial.length}）===`);
  for (const a of initial) console.log(`  ${a.method} ${a.url}`);

  // 3) 逐个点 Tab
  const clicked = [];
  const tabWords = ['最新', '热门', '精华', '推荐', '关注', '全部', '视频', '图片'];
  for (const w of tabWords) {
    try {
      const before = apiCalls.length;
      const el = page.locator(`text="${w}"`).first();
      if (!(await el.count())) continue;
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1800);
      const added = apiCalls.slice(before).map(a => a.url).filter((v, i, s) => s.indexOf(v) === i);
      clicked.push({ tab: w, newCalls: added });
      console.log(`\n[点「${w}」] 新增请求 ${added.length}`);
      for (const u of added.slice(0, 4)) console.log('   ' + u);
    } catch (e) {
      // 忽略不可点的
    }
  }

  // 4) 计算样式
  const styles = await page.evaluate(() => {
    const cs = el => (el ? getComputedStyle(el) : null);
    const body = document.body;
    // 找一个"卡片"：有背景色、圆角、且包含文字的容器
    let card = null;
    for (const el of document.querySelectorAll('div')) {
      const s = getComputedStyle(el);
      const bg = s.backgroundColor;
      const r = parseFloat(s.borderRadius) || 0;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && r >= 4 && el.innerText && el.innerText.length > 20 && el.innerText.length < 300) {
        card = el; break;
      }
    }
    const pick = el => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        bg: s.backgroundColor,
        color: s.color,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        borderRadius: s.borderRadius,
        padding: s.padding,
      };
    };
    const title = document.querySelector('h1,h2,h3,[class*="title"]');
    return {
      body: pick(body),
      html: pick(document.documentElement),
      card: pick(card),
      cardText: card ? card.innerText.slice(0, 80).replace(/\s+/g, ' ') : null,
      title: pick(title),
      app: pick(document.querySelector('#app')),
    };
  });

  console.log('\n=== 计算样式 ===');
  console.log(JSON.stringify(styles, null, 2));

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'home.json'), JSON.stringify({ nav, initial, clicked, styles }, null, 2));
  await page.screenshot({ path: path.join(OUT, 'home.png'), fullPage: false }).catch(() => {});
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
