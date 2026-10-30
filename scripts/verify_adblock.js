// verify_adblock.js —— 在 Windows 上验证 AdBlock.swift 里嵌的 JS 与规则 JSON
//   1) 按 Swift 多行字符串语义把 launchJS / js 抽出来（顺带抓「Swift 会编译报错的反斜杠」）
//   2) 语法检查（new Function 解析）
//   3) 用同样字面量重建 WKContentRuleList 的 JSON，JSON.parse 验证
//   4) 造一个最小 DOM，跑 launchJS，验证：杀开屏 / 不误伤登录框 / 不误伤协议页 /
//      用户触碰后停手 / 20 秒窗口过期 / 限次 12 层 / 点跳过按钮
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

// Swift 普通多行字符串的转义语义；遇到 Swift 不认的转义就报错（=Xcode 会编译失败）
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
      // Swift 插值 \( ... )：括号要配平，不能取第一个 ')'
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

// ── 从 Swift 里抽 blockedHosts / adPathRules / splashSelectors 字面量 ──
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
    const re = /"([^"\\]*)"|\\"(?:[^"\\]*)\\"/g; let m;
    while ((m = re.exec(body))) if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

const hosts = literals('static let blockedHosts', false);
const paths = literals('static let adPathRules', true);
const selectors = literals('static let splashSelectors', false);

// ───────────────────────── 2. 抽 JS + 语法检查 ─────────────────────────
const blocks = { hosts };
const launchRaw = sliceBlock('static let launchJS = """');
const jsRaw = sliceBlock('static let js = """');

const launch = unswift(launchRaw, blocks);
const main = unswift(jsRaw, blocks);
ok('launchJS 无非法 Swift 转义', launch.bad.length === 0, launch.bad.slice(0, 4).join(' '));
ok('js 无非法 Swift 转义', main.bad.length === 0, main.bad.slice(0, 4).join(' '));
ok('launchJS 被抽出', launch.text.length > 1500, launch.text.length + ' 字符');
ok('js 被抽出', main.text.length > 3000, main.text.length + ' 字符');

function syntax(name, code) {
  try { new Function(code); ok(name + ' 语法', true); }
  catch (e) { ok(name + ' 语法', false, e.message); }
}
syntax('launchJS', launch.text);
syntax('documentEnd js', main.text);

// ───────────────────────── 3. 规则 JSON ─────────────────────────
(function checkJson() {
  ok('blockedHosts 非空', hosts.length >= 20, hosts.length + ' 条');
  ok('adPathRules 非空', paths.length >= 5, paths.length + ' 条');
  ok('splashSelectors 非空', selectors.length >= 20, selectors.length + ' 条');
  ok('选择器里没有双引号（会破坏 JSON）', !selectors.some(s => s.includes('"')));

  const hostRules = hosts.map(h => `{"trigger":{"url-filter":".*","if-domain":["*${h}"]},"action":{"type":"block"}}`);
  const cssRule = `{"trigger":{"url-filter":".*"},"action":{"type":"css-display-none","selector":"${selectors.join(',')}"}}`;
  const json = '[' + hostRules.concat(paths, [cssRule]).join(',') + ']';
  let parsed = null, err = null;
  try { parsed = JSON.parse(json); } catch (e) { err = e.message; }
  ok('WKContentRuleList JSON 可解析', !!parsed, err || (parsed && parsed.length + ' 条规则'));
  if (parsed) {
    const css = parsed.filter(r => r.action && r.action.type === 'css-display-none');
    ok('css-display-none 规则存在', css.length === 1);
    ok('每条规则都有 trigger', parsed.every(r => r.trigger && r.trigger['url-filter']));
    ok('规则总数在 WebKit 上限内', parsed.length < 1500, parsed.length + '/1500');
  }
})();

ok('css 花括号平衡', (() => {
  const css = sliceBlock('static let css = """');
  let d = 0; for (const ch of css) { if (ch === '{') d++; else if (ch === '}') d--; }
  return d === 0;
})());

// ───────────────────────── 4. 最小 DOM ─────────────────────────
const W = 390, H = 844;

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
  get children() { return this._children; }
  appendChild(c) { c.parentNode = this; this._children.push(c); return c; }
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
    const tags = new Set(sel.split(',').map(s => s.trim().toLowerCase()));
    const out = [];
    (function walk(n) { for (const c of n._children) { if (tags.has(c.tagName.toLowerCase())) out.push(c); walk(c); } })(this);
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
  const rafQ = [];
  const timers = [];

  const html = new El('html', { rect: { left: 0, top: 0, width: W, height: H } });
  html.clientWidth = W; html.clientHeight = H;
  const head = new El('head');
  const body = new El('body', { rect: { left: 0, top: 0, width: W, height: H } });
  html.appendChild(head); html.appendChild(body);

  const document = {
    nodeType: 9, documentElement: html, body, head,
    readyState: 'loading',
    createElement: t => new El(t),
    getElementById: id => (function find(n) {
      for (const c of n._children) { if (c.id === id) return c; const r = find(c); if (r) return r; }
      return null;
    })(html),
    querySelectorAll: () => [],
    elementsFromPoint(x, y) {
      const cands = hits.filter(h => h.el.parentNode !== null)   // 已被摘掉的节点不再命中
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
    constructor(cb) { this.cb = cb; }
    observe() {} disconnect() {}
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
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    setInterval: () => 0, clearInterval: () => {}, clearTimeout: () => {},
    console,
  };
  sandbox.window.document = document;
  sandbox.window.MutationObserver = MutationObserver;
  sandbox.window.setTimeout = sandbox.setTimeout;
  vm.createContext(sandbox);

  function addHit(el, z) { hits.push({ el, z: z || 0 }); }
  function frame(n) {
    for (let i = 0; i < n; i++) {
      clock.t += 30;
      const q = rafQ.splice(0, rafQ.length);
      for (const cb of q) { try { cb(); } catch (e) { console.error('frame error:', e.message); } }
    }
  }
  function touch() { for (const l of listeners) if (/touchstart|pointerdown/.test(l.evt)) l.fn({ type: l.evt }); }

  return { sandbox, document, body, head, html, addHit, frame, touch, clock, hits, win };
}

function runLaunch() {
  const world = makeWorld();
  vm.runInContext(launch.text, world.sandbox, { filename: 'launchJS' });
  return world;
}

// 开屏层工厂：铺满视口、fixed、z 9999
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
    const skip = new El('span', {
      text: opts.skipText || '跳过',
      rect: { left: W - 70, top: 40, width: 50, height: 26 },
    });
    el.appendChild(skip);
    el._skip = skip;
  }
  world.body.appendChild(el);
  world.addHit(el, 9999);
  return el;
}

// ── T1 开屏被拆 + 跳过按钮被点 ──
(function T1() {
  const w = runLaunch();
  const ad = splash(w, { id: 'app-splash', cls: 'splash-wrap' });
  w.frame(3);
  ok('T1 开屏层被移除', ad.parentNode === null, 'hits=' + JSON.stringify(w.sandbox.window.__hj_splash_kills));
  ok('T1 记录到 1 次拆除', w.sandbox.window.__hj_splash_kills.length === 1);
  ok('T1 跳过按钮被点过', ad._skip.clicks >= 1, 'clicks=' + ad._skip.clicks);
})();

// ── T2 无 class 名的开屏（只靠几何）也被拆 ──
(function T2() {
  const w = runLaunch();
  const ad = splash(w, { id: '', cls: 'gg-2', text: true });
  w.frame(3);
  ok('T2 匿名 class 的开屏被移除', ad.parentNode === null, JSON.stringify(w.sandbox.window.__hj_splash_kills));
})();

// ── T3 登录弹窗不误伤 ──
(function T3() {
  const w = runLaunch();
  const modal = splash(w, { id: 'login-modal', cls: 'login-box', text: true });
  const input = new El('input', { rect: { left: 40, top: 400, width: 300, height: 40 } });
  modal.appendChild(input);
  w.frame(3);
  ok('T3 登录弹窗保留', modal.parentNode === w.body, 'hits=' + JSON.stringify(w.sandbox.window.__hj_splash_kills));
})();

// ── T4 纯文字长协议页不误伤 ──
(function T4() {
  const w = runLaunch();
  const page = new El('div', {
    id: 'agreement', cls: 'doc-layer',
    rect: { left: 0, top: 0, width: W, height: H },
    style: { position: 'fixed', zIndex: '999' },
    text: '用'.repeat(600),
  });
  w.body.appendChild(page); w.addHit(page, 999);
  w.frame(3);
  ok('T4 长文协议页保留', page.parentNode === w.body);
})();

// ── T5 播放器页不误伤 ──
(function T5() {
  const w = runLaunch();
  const player = splash(w, { id: 'player', cls: 'dplayer-full', text: false });
  player.appendChild(new El('video', { rect: { left: 0, top: 100, width: W, height: 220 } }));
  w.frame(3);
  ok('T5 播放器层保留', player.parentNode === w.body);
})();

// ── T6 用户碰屏幕后停手 ──
(function T6() {
  const w = runLaunch();
  w.frame(2);
  w.touch();
  const ad = splash(w, { id: 'late-splash' });
  w.frame(4);
  ok('T6 触碰后不再拆层', ad.parentNode === w.body);
})();

// ── T7 20 秒窗口过期后停手 ──
(function T7() {
  const w = runLaunch();
  w.clock.t += 25000;
  const ad = splash(w, { id: 'expired-splash' });
  w.frame(3);
  ok('T7 超窗口不再拆层', ad.parentNode === w.body);
})();

// ── T8 限次 12 层 ──
(function T8() {
  const w = runLaunch();
  const layers = [];
  for (let i = 0; i < 15; i++) {
    layers.push(splash(w, { id: 'ad-' + i, cls: 'splash-' + i }));
    w.frame(6);
  }
  const killed = w.sandbox.window.__hj_splash_kills.length;
  const left = layers.filter(l => l.parentNode !== null).length;
  ok('T8 最多拆 12 层', killed === 12, 'killed=' + killed + ' left=' + left + ' ' + JSON.stringify(w.sandbox.window.__hj_splash_kills.slice(0, 4)));
  ok('T8 第 13 层起保留', left === 3, 'left=' + left);
})();

// ── T9 __hj_scan 手动重扫 ──
(function T9() {
  const w = runLaunch();
  w.frame(2);
  w.touch();                     // 停手
  const ad = splash(w, { id: 'after-touch' });
  w.frame(2);
  const before = ad.parentNode !== null;
  w.sandbox.window.__hj_scan();
  ok('T9 触碰后 __hj_scan 仍可手动拆', before && ad.parentNode === null);
})();

console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
