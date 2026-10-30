// fetch-site3.mjs —— C 组：网页端「彻底去广告」终验
//
// 依据前两轮实测（A 原样 / B 拦接口）拿到的精确结构：
//   · 博彩横幅容器   .topbanmer（内含 .my-swipe.van-swipe + .crossbutton 自带关闭）
//   · 底部 PWA 引导条 .addbox（"添加海角社区到主屏幕" + 添加 + van-icon-cross）
//   · 开屏弹窗        .van-dialog.luodiconfirm（重要提示）+ .van-dialog.luodisconfirm（域名保存）
//
// C 组做四件事，目标 8 秒后截图完全干净：
//   1. 拦 POST /api/banner/banner_list 与 hjstore/system/banner/*（数据源）
//   2. 拦第三方统计（ga / gtag / cloudflare beacon）
//   3. 注入 CSS 直接不画 .topbanmer / .addbox / 两种 luodi 弹窗
//   4. 注入 JS：MutationObserver 盯着 body 直接子节点，出现就点掉/移除（双保险）

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out3';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const URL_HOME = 'https://haijiao.com/home';

const BLOCK = [
  '**/api/banner/banner_list*',
  '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**',
  '**/www.googletagmanager.com/**',
  '**/static.cloudflareinsights.com/**',
];

const CSS = `
  .topbanmer { display: none !important; }
  .addbox { display: none !important; }
  .van-dialog.luodiconfirm, .van-dialog.luodisconfirm { display: none !important; }
  .van-overlay { display: none !important; }
`;

// 注入脚本：只在「新增节点」上做最小动作，不遍历、不测量、不强制布局
const KILLER = `
(function () {
  if (window.__hj_webstrip) return;
  window.__hj_webstrip = true;
  var LOG = window.__hj_webstrip_log = [];

  function strip(node) {
    try {
      if (!node || node.nodeType !== 1) return;
      var cls = (node.className && node.className.baseVal === undefined ? node.className : '') || '';
      cls = String(cls);
      if (/topbanmer|addbox/.test(cls)) { node.remove(); LOG.push('rm:' + cls.slice(0, 40)); return; }
      if (/luodiconfirm|luodisconfirm/.test(cls)) {
        var btn = node.querySelector('.van-dialog__confirm, button');
        if (btn) { try { btn.click(); } catch (e) {} }
        setTimeout(function () { try { node.remove(); } catch (e) {} }, 60);
        LOG.push('dialog:' + cls.slice(0, 40));
      }
    } catch (e) {}
  }

  function scan() {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) strip(kids[i]);
    var app = document.getElementById('app');
    if (app) { for (var j = 0; j < app.children.length; j++) strip(app.children[j]); }
    // 精确命中（数量极少，纯选择器，不做几何）
    var hit = document.querySelectorAll('.topbanmer, .addbox');
    for (var k = 0; k < hit.length; k++) { try { hit[k].remove(); } catch (e) {} }
    var dlg = document.querySelectorAll('.van-dialog.luodiconfirm, .van-dialog.luodisconfirm');
    for (var m = 0; m < dlg.length; m++) {
      var b = dlg[m].querySelector('.van-dialog__confirm, button');
      if (b) { try { b.click(); } catch (e) {} }
    }
  }

  function start() {
    try {
      new MutationObserver(function () { scan(); })
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    scan();
    var n = 0;
    var t = setInterval(function () {
      scan();
      if (++n > 40) clearInterval(t);      // 最多 16 秒兜底
    }, 400);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  window.__hj_webstrip_now = scan;
})();
`;

async function run(label) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await ctx.addInitScript(CSS === '' ? () => {} : (css) => {
    const add = () => {
      const s = document.createElement('style');
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
  }, CSS);
  await ctx.addInitScript(KILLER);

  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  const state = { label, marks: {} };
  page.on('pageerror', e => console.log(`  [${label}] pageerror:`, e.message));

  let last = 0;
  try {
    await page.goto(URL_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    for (const t of [600, 1600, 4200, 8000, 12000]) {
      await page.waitForTimeout(t - last); last = t;
      await page.screenshot({ path: path.join(OUT, `${label}-${t}ms.png`) });
      const snap = await page.evaluate(() => {
        const W = innerWidth, H = innerHeight;
        const vis = el => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
        };
        const count = sel => [...document.querySelectorAll(sel)].filter(vis).length;
        return {
          topbanmer: count('.topbanmer'),
          addbox: count('.addbox'),
          luodiDialog: count('.van-dialog.luodiconfirm, .van-dialog.luodisconfirm'),
          anyDialog: count('.van-dialog'),
          overlay: count('.van-overlay'),
          bannerImgs: document.querySelectorAll('img[data-id^="banner_"]').length,
          htmlLen: document.documentElement.outerHTML.length,
          killed: (window.__hj_webstrip_log || []).slice(0, 12),
          vw: W, vh: H,
        };
      });
      state.marks[t] = snap;
      console.log(`  [${label}] ${t}ms`, JSON.stringify(snap));
    }
    state.final = state.marks[12000];
  } catch (e) {
    state.error = e.message;
    console.log(`  [${label}] error:`, e.message);
  }
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `report-${label}.json`), JSON.stringify(state, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
console.log('=== C：网页端彻底去广告 ===');
await run('C');
console.log('done');
