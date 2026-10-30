// verify_adblock.js —— 在 Windows 上验证 AdBlock.swift 里嵌的 JS 与规则 JSON（不需要 Mac / 不需要浏览器）
//
//   1) 按 Swift 多行字符串语义把 launchJS / siteJS / js 抽出来（顺带抓「Swift 会编译报错的反斜杠」）
//   2) 语法检查（new Function 解析）；WKContentRuleList 的 JSON 重建后 JSON.parse
//   3) 造一个最小 DOM（含 MutationObserver / setInterval / 选择器匹配）跑真实脚本：
//        · siteJS：.topbanmer / .addbox / .van-dialog.luodi* 要被清，普通登录弹窗不许动
//        · js：封 window.open、清广告 iframe
//        · launchJS（默认不注入，仍测）：几何判定能拆全屏浮层且不误伤
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SWIFT = path.join(ROOT, 'ios/Haijiao/Features/AdBlock.swift');
const src = fs.readFileSync(SWIFT, 'utf8');

let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  -> ' + extra : ''));
  if (!cond) fails++;
}

// ───────────────────────── 1. 抽 Swift 多行字符串 ─────────────────────────
function sliceBlock(startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('找不到 ' + startMarker);
  const bodyStart = i + startMarker.length;
  const end = src.indexOf('\n    """', bodyStart);
  if (end < 0) throw new Error(startMarker + ' 没有闭合的 """');
  return src.slice(bodyStart, end);
}

function unswift(raw, blocks) {
  let out = '';
  const bad = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[i + 1];
    if (n === '\\') { out += '\\'; i++; continue; }
    if (n === '"') { out += '"'; i++; continue; }
    if (n === 'n') { out += '\n'; i++; continue; }
    if (n === 't') { out += '\t'; i++; continue; }
    if (n === "'") { out += "'"; i++; continue; }
    if (n === '(') {
      let depth = 0, close = -1;
      for (let j = i + 1; j < raw.length; j++) {
        if (raw[j] === '(') depth++;
        else if (raw[j] === ')') { depth--; if (depth === 0) { close = j; break; } }
      }
      const expr = raw.slice(i + 2, close).trim();
      if (expr === 'jsArray(blockedHosts)') { out += JSON.stringify(blocks.hosts); i = close; continue; }
      bad.push('\\(...): ' + expr);
      i = close; continue;
    }
    bad.push('\\' + n);
    i++;
  }
  return { text: out, bad };
}

function literals(section, rawString) {
  const i = src.indexOf(section);
  if (i < 0) throw new Error('找不到 ' + section);
  const end = src.indexOf('\n    ]', i);
  const body = src.slice(i, end < 0 ? undefined : end);
  const out = [];
  if (rawString) {
    const re = /#"([\s\S]*?)"#/g; let m;
    while ((m = re.exec(body))) out.push(m[1]);
  } else {
    const re = /"([^"\\]*)"/g; let m;
    while ((m = re.exec(body))) out.push(m[1]);
  }
  return out;
}

const hosts = literals('static let blockedHosts', false);
const paths = literals('static let adPathRules', true);
const selectors = literals('static let splashSelectors', false);

const blocks = { hosts };
const launch = unswift(sliceBlock('static let launchJS = """'), blocks);
const site = unswift(sliceBlock('static let siteJS = """'), blocks);
const main = unswift(sliceBlock('static let js = """'), blocks);

ok('launchJS 无非法 Swift 转义', launch.bad.length === 0, launch.bad.slice(0, 4).join(' '));
ok('siteJS 无非法 Swift 转义', site.bad.length === 0, site.bad.slice(0, 4).join(' '));
ok('js 无非法 Swift 转义', main.bad.length === 0, main.bad.slice(0, 4).join(' '));
ok('launchJS 被抽出', launch.text.length > 3000, launch.text.length + ' 字符');
ok('siteJS 被抽出', site.text.length > 800, site.text.length + ' 字符');
ok('js 被抽出', main.text.length > 800, main.text.length + ' 字符');

function syntax(name, code) {
  try { new Function(code); ok(name + ' 语法', true); }
  catch (e) { ok(name + ' 语法', false, e.message); }
}
syntax('launchJS', launch.text);
syntax('siteJS', site.text);
syntax('documentEnd js', main.text);

// ───────────────────────── 2. 规则 JSON ─────────────────────────
(function checkJson() {
  ok('blockedHosts 非空', hosts.length >= 20, hosts.length + ' 条');
  ok('site 广告路径含 banner 接口', paths.some(p => p.includes('/api/banner/banner_list')));
  ok('site 广告路径含 banner 图片目录', paths.some(p => p.includes('hjstore/system/banner')));
  ok('选择器含实测三个容器', ['.topbanmer', '.addbox', '.luodiconfirm', '.luodisconfirm']
    .every(s => selectors.some(x => x.includes(s))), selectors.join(' '));
  ok('选择器里没有双引号（会破坏 JSON）', !selectors.some(s => s.includes('"')));

  const hostRules = hosts.map(h => `{"trigger":{"url-filter":".*","if-domain":["*${h}"]},"action":{"type":"block"}}`);
  const cssRule = `{"trigger":{"url-filter":".*"},"action":{"type":"css-display-none","selector":"${selectors.join(',')}"}}`;
  const json = '[' + hostRules.concat(paths, [cssRule]).join(',') + ']';
  let parsed = null, err = null;
  try { parsed = JSON.parse(json); } catch (e) { err = e.message; }
  ok('WKContentRuleList JSON 可解析', !!parsed, err || (parsed && parsed.length + ' 条规则'));
  if (parsed) {
    ok('css-display-none 规则存在', parsed.some(r => r.action && r.action.type === 'css-display-none'));
    ok('规则总量在 WebKit 上限内', parsed.length < 1500, parsed.length + '/1500');
  }
  ok('css 花括号平衡', (() => {
    const css = sliceBlock('static let css = """');
    let d = 0; for (const ch of css) { if (ch === '{') d++; else if (ch === '}') d--; }
    return d === 0;
  })());
})();

// ───────────────────────── 3. 最小 DOM ─────────────────────────
const W = 390, H = 844;
let OBS = [];            // 已注册的 MutationObserver
let NEXT_TIMER_ID = 1;

function clsOf(el) {
  const c = el.className;
  return String((c && c.baseVal === undefined ? c : '') || '');
}

function matchesSel(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  return String(sel).split(',').some(raw => {
    const s = raw.trim();
    if (!s) return false;
    // 属性选择器：[attr*=value i] / [attr^=value] / [attr=value]
    if (s.includes(':')) return false;   // :last-child 之类的伪类不在测试范围
    const attrs = [...s.matchAll(/\[([\w-]+)\s*([*^$]?=)\s*["']?([^"'\]]*?)["']?\s*(i?)\]/g)];
    let rest = s.replace(/\[[^\]]*\]/g, '');
    for (const m of attrs) {
      const name = m[1], op = m[2], val = m[3], flag = m[4];
      const raw2 = el.getAttribute(name);
      if (raw2 == null) return false;
      const hay = flag ? String(raw2).toLowerCase() : String(raw2);
      const needle = flag ? val.toLowerCase() : val;
      if (op === '*=' && !hay.includes(needle)) return false;
      if (op === '^=' && !hay.startsWith(needle)) return false;
      if (op === '=' && hay !== needle) return false;
    }
    if (!rest) return true;
    const idPart = /#([\w-]+)/.exec(rest);
    if (idPart && el.id !== idPart[1]) return false;
    const tagPart = /^([a-zA-Z][\w-]*)/.exec(rest);
    if (tagPart && el.tagName.toLowerCase() !== tagPart[1].toLowerCase()) return false;
    const classes = [...rest.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    const have = clsOf(el).split(/\s+/);
    return classes.every(c => have.includes(c));
  });
}

class Style {
  constructor(o) { this.position = 'static'; this.zIndex = 'auto'; this.display = 'block'; this.visibility = 'visible'; Object.assign(this, o || {}); }
}

class El {
  constructor(tag, o) {
    o = o || {};
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.id = o.id || '';
    this.className = o.cls || '';
    this.style = new Style(o.style);
    this._rect = o.rect || { left: 0, top: 0, width: 0, height: 0 };
    this._text = o.text || '';
    this._attrs = Object.assign({}, o.attrs || {});
    this._children = [];
    this.parentNode = null;
    this.clicks = 0;
    this.baseVal = undefined;
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const i = p._children.indexOf(this);
    for (let k = i + 1; k < p._children.length; k++) if (p._children[k].nodeType === 1) return p._children[k];
    return null;
  }
  get previousElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const i = p._children.indexOf(this);
    for (let k = i - 1; k >= 0; k--) if (p._children[k].nodeType === 1) return p._children[k];
    return null;
  }
  get children() { return this._children; }
  appendChild(c) {
    c.parentNode = this; this._children.push(c);
    OBS.forEach(o => { if (o.target !== this) return; try { o.cb([{ addedNodes: [c], target: this }]); } catch (e) {} });
    return c;
  }
  remove() {
    const p = this.parentNode; if (!p) return;
    const i = p._children.indexOf(this); if (i >= 0) p._children.splice(i, 1);
    this.parentNode = null;
  }
  get textContent() { let s = this._text; for (const c of this._children) s += c.textContent; return s; }
  getBoundingClientRect() {
    const r = this._rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height,
             right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  querySelectorAll(sel) {
    const out = [];
    (function walk(n) { for (const c of n._children) { if (matchesSel(c, sel)) out.push(c); walk(c); } })(this);
    return out;
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  click() { this.clicks++; }
}

function makeWorld() {
  const clock = { t: 1_000_000 };
  const hits = [];
  const listeners = [];
  const docListeners = [];
  const rafQ = [];
  const timers = [];
  OBS = []; NEXT_TIMER_ID = 1;

  const html = new El('html', { rect: { left: 0, top: 0, width: W, height: H } });
  html.clientWidth = W; html.clientHeight = H;
  const head = new El('head');
  const body = new El('body', { rect: { left: 0, top: 0, width: W, height: H } });
  html.appendChild(head); html.appendChild(body);

  const document = {
    nodeType: 9, documentElement: html, body, head,
    readyState: 'loading',
    visibilityState: 'visible',
    createElement: t => new El(t),
    addEventListener(evt, fn) { docListeners.push({ evt, fn }); },
    getElementById: id => (function find(n) {
      for (const c of n._children) { if (c.id === id) return c; const r = find(c); if (r) return r; }
      return null;
    })(html),
    querySelectorAll: sel => html.querySelectorAll(sel),
    querySelector: sel => html.querySelector(sel),
    elementsFromPoint(x, y) {
      const inDoc = el => { let n = el; while (n) { if (n === html) return true; n = n.parentNode; } return false; };
      const cands = hits.filter(h => inDoc(h.el))
        .filter(h => x >= h.el._rect.left && x <= h.el._rect.left + h.el._rect.width &&
                     y >= h.el._rect.top && y <= h.el._rect.top + h.el._rect.height)
        .sort((a, b) => b.z - a.z);
      const out = [];
      for (const c of cands) {
        out.push(c.el);
        let n = c.el.parentElement;
        while (n && n.tagName !== 'BODY' && n.tagName !== 'HTML') { out.push(n); n = n.parentElement; }
      }
      return out;
    },
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; OBS.push(this); }
    observe(target) { this.target = target; }
    disconnect() { OBS = OBS.filter(o => o !== this); }
  }

  const win = {
    innerWidth: W, innerHeight: H,
    addEventListener(evt, fn) { listeners.push({ evt, fn }); },
    requestAnimationFrame(cb) { rafQ.push(cb); return rafQ.length; },
  };

  const sandbox = {
    window: win, document, MutationObserver,
    getComputedStyle: el => el.style,
    Date: { now: () => clock.t },
    setTimeout: (fn, delay) => { const id = NEXT_TIMER_ID++; timers.push({ fn, at: clock.t + (delay || 0), id }); return id; },
    setInterval: (fn, delay) => { const id = NEXT_TIMER_ID++; timers.push({ fn, at: clock.t + (delay || 0), every: delay || 1, id }); return id; },
    clearInterval: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    console,
  };
  sandbox.window.document = document;
  sandbox.window.MutationObserver = MutationObserver;
  sandbox.window.setTimeout = sandbox.setTimeout;
  sandbox.window.setInterval = sandbox.setInterval;
  sandbox.window.clearTimeout = sandbox.clearTimeout;
  sandbox.window.clearInterval = sandbox.clearInterval;
  vm.createContext(sandbox);

  function addHit(el, z) { hits.push({ el, z: z || 0 }); }

  function frame(n) {
    for (let i = 0; i < n; i++) {
      clock.t += 30;
      let guard = 0;
      while (guard++ < 400) {
        const idx = timers.findIndex(t => t.at <= clock.t);
        if (idx < 0) break;
        const t = timers.splice(idx, 1)[0];
        try { t.fn(); } catch (e) { console.error('timer error:', e.message); }
        if (t.every) timers.push({ fn: t.fn, at: clock.t + t.every, every: t.every, id: t.id });
      }
      const q = rafQ.splice(0, rafQ.length);
      for (const cb of q) { try { cb(); } catch (e) {} }
    }
  }
  function touch() { for (const l of listeners) if (/touchstart|pointerdown/.test(l.evt)) l.fn({ type: l.evt }); }
  function fireDoc(evt) { for (const l of docListeners.slice()) if (l.evt === evt) l.fn({ type: evt }); }
  function fireWin(evt) { for (const l of listeners.slice()) if (l.evt === evt) l.fn({ type: evt }); }

  return { sandbox, document, body, head, html, addHit, frame, touch, fireDoc, fireWin, clock, hits, win, timers };
}

function runLaunch() {
  const w = makeWorld();
  vm.runInContext(launch.text, w.sandbox, { filename: 'launchJS' });
  return w;
}
function runSite() {
  const w = makeWorld();
  vm.runInContext(site.text, w.sandbox, { filename: 'siteJS' });
  return w;
}
function runEnd() {
  const w = makeWorld();
  vm.runInContext(site.text, w.sandbox, { filename: 'siteJS' });
  vm.runInContext(main.text, w.sandbox, { filename: 'js' });
  return w;
}

// 开屏浮层工厂（launchJS 用例）
function splash(world, opts) {
  opts = opts || {};
  const el = new El('div', Object.assign({
    id: opts.id || '', cls: opts.cls || '',
    rect: { left: 0, top: 0, width: W, height: H },
    style: { position: 'fixed', zIndex: '9999' },
  }, opts.el || {}));
  const img = new El('img', { rect: { left: 0, top: 0, width: W, height: Math.round(H * 0.8) } });
  el.appendChild(img);
  if (opts.text !== false) {
    const skip = new El('span', { text: opts.skipText || '跳过', rect: { left: W - 70, top: 40, width: 50, height: 26 } });
    el.appendChild(skip);
    el._skip = skip;
  }
  world.body.appendChild(el);
  world.addHit(el, 9999);
  return el;
}

// ───────────────────────── 4. siteJS：站点精确清理 ─────────────────────────
(function S1() {
  const w = runSite();
  const bar = new El('div', { cls: 'topbanmer' });
  w.body.appendChild(bar);
  ok('S1 .topbanmer 插入即被摘掉', bar.parentNode === null, JSON.stringify(w.sandbox.window.__hj_strip_log));
})();

(function S2() {
  const w = runSite();
  const pwa = new El('div', { cls: 'addbox' });
  w.body.appendChild(pwa);
  ok('S2 .addbox 插入即被摘掉', pwa.parentNode === null);
})();

(function S3() {
  const w = runSite();
  const dlg = new El('div', { cls: 'van-dialog luodiconfirm', rect: { left: 29, top: 91, width: 333, height: 577 } });
  const btn = new El('button', { cls: 'van-dialog__confirm' });
  dlg.appendChild(btn);
  w.body.appendChild(dlg);
  w.frame(6);
  ok('S3 luodiconfirm 弹窗被点确认', btn.clicks >= 1, 'clicks=' + btn.clicks);
  ok('S3 luodiconfirm 弹窗随后被移除', dlg.parentNode === null, JSON.stringify(w.sandbox.window.__hj_strip_log));
})();

(function S4() {
  const w = runSite();
  const dlg = new El('div', { cls: 'van-dialog luodisconfirm' });
  const btn = new El('button', { cls: 'van-dialog__confirm' });
  dlg.appendChild(btn);
  w.body.appendChild(dlg);
  w.frame(6);
  ok('S4 luodisconfirm 弹窗被点确认并移除', btn.clicks >= 1 && dlg.parentNode === null);
})();

(function S5() {
  const w = runSite();
  const dlg = new El('div', { cls: 'van-dialog login' });
  const input = new El('input', { rect: { left: 40, top: 400, width: 300, height: 40 } });
  const btn = new El('button', { cls: 'van-dialog__confirm' });
  dlg.appendChild(input); dlg.appendChild(btn);
  w.body.appendChild(dlg);
  w.frame(20);
  ok('S5 站点登录弹窗不许动', dlg.parentNode === w.body && btn.clicks === 0, 'clicks=' + btn.clicks);
})();

(function S6() {
  const w = runSite();
  // banner 挂在 #app 内部（不是 body 直接子节点）：MutationObserver 看不到，靠 400ms 兜底
  const app = new El('div', { id: 'app' });
  w.body.appendChild(app);
  const inner = new El('div', { cls: 'topbanmer' });
  app.appendChild(inner);
  w.frame(25);
  ok('S6 无周期兜底时它靠 CSS 隐藏（DOM 保留）', inner.parentNode === app);
  w.sandbox.window.__hj_strip_now();
  ok('S6 手动 __hj_strip_now 仍能摘掉', inner.parentNode === null,
     JSON.stringify(w.sandbox.window.__hj_strip_log));
})();

(function S7() {
  const w = runSite();
  // vant 的 confirm 型 dialog：取消键在前、确认键在后 —— 绝不能点错
  const dlg = new El('div', { cls: 'van-dialog luodiconfirm' });
  const footer = new El('div', { cls: 'van-dialog__footer' });
  const cancel = new El('button', { cls: 'van-dialog__cancel', text: '取消' });
  const confirm = new El('button', { cls: 'van-dialog__confirm', text: '好' });
  footer.appendChild(cancel); footer.appendChild(confirm);
  dlg.appendChild(footer);
  w.body.appendChild(dlg);
  w.frame(6);
  ok('S7 只点确认键，不碰取消键', confirm.clicks >= 1 && cancel.clicks === 0,
     'confirm=' + confirm.clicks + ' cancel=' + cancel.clicks);
})();

(function S8() {
  // 模拟 documentStart：body 还没进 DOM，siteJS 先盯 documentElement；
  // DOMContentLoaded 之后必须重新挂到 body，否则只看得到 html 的直接子节点。
  const w = makeWorld();
  const bodyEl = w.body;
  w.document.body = null;
  bodyEl.remove();
  vm.runInContext(site.text, w.sandbox, { filename: 'siteJS' });

  const early = new El('div', { cls: 'topbanmer' });
  bodyEl.appendChild(early);
  ok('S8 DOMContentLoaded 之前，body 里的新增不会被误判', early.parentNode === bodyEl);

  w.html.appendChild(bodyEl);
  w.document.body = bodyEl;
  w.fireDoc('DOMContentLoaded');

  const late = new El('div', { cls: 'topbanmer' });
  bodyEl.appendChild(late);
  ok('S8 body 就位后，新增的 .topbanmer 立即被摘掉', late.parentNode === null,
     JSON.stringify(w.sandbox.window.__hj_strip_log));
})();
(function S9() {
  const w = runSite();
  // 站点打开弹窗时的真实形态：body 被加滚动锁、先插 overlay、再插 dialog
  w.body.className = 'van-overflow-hidden';
  const ov = new El('div', { cls: 'van-overlay' });
  w.body.appendChild(ov);
  const dlg = new El('div', { cls: 'van-dialog luodiconfirm' });
  const btn = new El('button', { cls: 'van-dialog__confirm' });
  dlg.appendChild(btn);
  w.body.appendChild(dlg);
  w.frame(14);
  ok('S9 弹窗清掉后 body 滚动锁被解除', w.body.className.indexOf('van-overflow-hidden') < 0,
     'class="' + w.body.className + '" log=' + JSON.stringify(w.sandbox.window.__hj_strip_log));
  ok('S9 残留遮罩被摘掉', ov.parentNode === null);
})();

(function S10() {
  const w = runSite();
  // 站点正常的登录弹窗：带 input，不属于我们清理范围 —— body 锁必须保留，遮罩也不许动
  w.body.className = 'van-overflow-hidden';
  const ov = new El('div', { cls: 'van-overlay' });
  w.body.appendChild(ov);
  const dlg = new El('div', { cls: 'van-dialog login', rect: { left: 29, top: 200, width: 333, height: 400 } });
  dlg.appendChild(new El('input', { rect: { left: 40, top: 400, width: 300, height: 40 } }));
  w.body.appendChild(dlg);
  w.frame(14);
  ok('S10 真弹窗时不解锁、不拆遮罩',
     w.body.className.indexOf('van-overflow-hidden') >= 0 && ov.parentNode === w.body,
     'class="' + w.body.className + '"');
})();
(function S11() {
  const w = runSite();
  // 站点常驻一个 display:none 的 .van-popup（抽屉类），body 被锁 —— 必须仍能解锁
  const popup = new El('div', { cls: 'van-popup', style: { display: 'none' } });
  w.body.appendChild(popup);
  w.body.className = 'van-overflow-hidden';
  w.frame(25);
  ok('S11 隐藏的 .van-popup 不该阻止解锁', w.body.className.indexOf('van-overflow-hidden') < 0,
     'class="' + w.body.className + '" log=' + JSON.stringify(w.sandbox.window.__hj_strip_log));
})();

(function S12() {
  const w = runSite();
  // 真·可见弹窗（有尺寸）：锁必须保留，否则背景滚起来会跟模态打架
  const popup = new El('div', { cls: 'van-popup', rect: { left: 0, top: 600, width: 390, height: 244 } });
  w.body.appendChild(popup);
  w.body.className = 'van-overflow-hidden';
  w.frame(25);
  ok('S12 可见弹窗时保留滚动锁', w.body.className.indexOf('van-overflow-hidden') >= 0,
     'class="' + w.body.className + '"');
})();
(function S13() {
  const w = runSite();
  // 弹窗被删之后残留的全屏遮罩：会一直吃触摸，必须摘掉
  const ov = new El('div', { cls: 'van-overlay', rect: { left: 0, top: 0, width: W, height: H } });
  w.body.appendChild(ov);
  w.frame(14);                     // 420ms，覆盖一个 300ms 兜底
  ok('S13 孤儿遮罩被摘掉', ov.parentNode === null,
     JSON.stringify(w.sandbox.window.__hj_strip_log));
})();

(function S14() {
  const w = runSite();
  // 正常的模态：遮罩 + 相邻的可见弹窗，遮罩必须留着（不然点穿背景）
  const ov = new El('div', { cls: 'van-overlay', rect: { left: 0, top: 0, width: W, height: H } });
  w.body.appendChild(ov);
  const dlg = new El('div', { cls: 'van-popup login', rect: { left: 0, top: 600, width: W, height: 244 } });
  w.body.appendChild(dlg);
  w.frame(14);
  ok('S14 有相邻可见弹窗时遮罩保留', ov.parentNode === w.body,
     'ov=' + (ov.parentNode ? 'kept' : 'removed'));
})();
(function S15() {
  const w = runSite();
  // 遮罩与「可见弹窗」不相邻（中间夹了 wrapper）：按兄弟判的老逻辑会误删遮罩 → 背景点穿。
  // 新逻辑是全局判定，遮罩必须保留。
  const ov = new El('div', { cls: 'van-overlay', rect: { left: 0, top: 0, width: W, height: H } });
  w.body.appendChild(ov);
  const wrap = new El('div', { cls: 'dialog-wrapper' });
  const dlg = new El('div', { cls: 'van-dialog login', rect: { left: 29, top: 200, width: 333, height: 400 } });
  wrap.appendChild(dlg);
  w.body.appendChild(wrap);
  w.frame(14);
  ok('S15 弹窗不在相邻位置时遮罩也保留', ov.parentNode === w.body,
     'ov=' + (ov.parentNode ? 'kept' : 'removed') + ' log=' + JSON.stringify(w.sandbox.window.__hj_strip_log));
})();
(function S16() {
  const w = runSite();
  // 客服悬浮面板那种小尺寸 .van-popup（高 60px）：不该算模态，否则锁永远解不开
  const tiny = new El('div', { cls: 'van-popup service-panel', rect: { left: 300, top: 700, width: 80, height: 60 } });
  w.body.appendChild(tiny);
  w.body.className = 'van-overflow-hidden';
  const ov = new El('div', { cls: 'van-overlay', rect: { left: 0, top: 0, width: W, height: H } });
  w.body.appendChild(ov);
  w.frame(14);
  ok('S16 小面板不阻止解锁', w.body.className.indexOf('van-overflow-hidden') < 0,
     'class="' + w.body.className + '"');
})();
(function S17() {
  const w = runSite();
  ok('S17 首屏 spacer 注入', !!w.document.getElementById('__hj_spacer'));
  w.fireWin('load');
  w.frame(140);                       // 4.2s
  ok('S17 load 后 4 秒撤掉 spacer', !w.document.getElementById('__hj_spacer'));
  const d = w.sandbox.window.__hj_diag();
  ok('S17 __hj_diag 可用', !!d && typeof d.innerHeight === 'number' && ('spacer' in d), JSON.stringify(d).slice(0, 110));
})();
// ───────────────────────── 5. documentEnd：收尾清理 ─────────────────────────
(function E1() {
  const w = runEnd();
  ok('E1 window.open 被封', w.sandbox.window.open('https://x.test') === null);
})();

(function E2() {
  const w = runEnd();
  const frame1 = new El('iframe', { attrs: { src: 'https://ad.doubleclick.net/x' } });
  w.body.appendChild(frame1);
  w.frame(16);
  ok('E2 广告 iframe 被清掉', frame1.parentNode === null);
})();

(function E3() {
  const w = runEnd();
  const bar = new El('div', { cls: 'topbanmer' });
  w.body.appendChild(bar);
  w.frame(2);
  ok('E3 siteJS 与 js 叠加也不重复报错', bar.parentNode === null);
})();

// ───────────────────────── 6. launchJS：几何杀手（默认不注入，仍测）─────────────────────────
(function T1() {
  const w = runLaunch();
  const ad = splash(w, { id: 'app-splash', cls: 'splash-wrap' });
  w.frame(10);
  ok('T1 全屏浮层被移除', ad.parentNode === null, 'hits=' + JSON.stringify(w.sandbox.window.__hj_splash_kills));
  ok('T1 不点广告本体（只整层移除）', ad._skip.clicks === 0, 'clicks=' + ad._skip.clicks);
})();

(function T2() {
  const w = runLaunch();
  const ad = splash(w, { cls: 'gg-2' });
  w.frame(10);
  ok('T2 匿名 class 靠几何也能拆', ad.parentNode === null);
})();

(function T3() {
  const w = runLaunch();
  const modal = splash(w, { id: 'login-modal', cls: 'login-box' });
  modal.appendChild(new El('input', { rect: { left: 40, top: 400, width: 300, height: 40 } }));
  w.frame(12);
  ok('T3 登录弹窗保留', modal.parentNode === w.body);
})();

(function T4() {
  const w = runLaunch();
  const page = new El('div', {
    id: 'agreement', cls: 'doc-layer',
    rect: { left: 0, top: 0, width: W, height: H },
    style: { position: 'fixed', zIndex: '999' }, text: '用'.repeat(600),
  });
  w.body.appendChild(page); w.addHit(page, 999);
  w.frame(12);
  ok('T4 长文协议页保留', page.parentNode === w.body);
})();

(function T5() {
  const w = runLaunch();
  const player = splash(w, { id: 'player', cls: 'dplayer-full', text: false });
  player.appendChild(new El('video', { rect: { left: 0, top: 100, width: W, height: 220 } }));
  w.frame(12);
  ok('T5 播放器层保留', player.parentNode === w.body);
})();

(function T6() {
  const w = runLaunch();
  w.frame(4); w.touch();
  const ad = splash(w, { id: 'late-splash' });
  w.frame(8);
  ok('T6 触碰后不再拆层', ad.parentNode === w.body);
})();

(function T7() {
  const w = runLaunch();
  w.clock.t += 25000;
  const ad = splash(w, { id: 'expired-splash' });
  w.frame(10);
  ok('T7 超窗口不再拆层', ad.parentNode === w.body);
})();

(function T8() {
  const w = runLaunch();
  const layers = [];
  for (let i = 0; i < 15; i++) {
    layers.push(splash(w, { id: 'ad-' + i, cls: 'splash-' + i }));
    w.frame(12);
  }
  const killed = w.sandbox.window.__hj_splash_kills.length;
  const left = layers.filter(l => l.parentNode !== null).length;
  ok('T8 最多拆 10 层', killed === 10, 'killed=' + killed + ' left=' + left);
})();

console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
