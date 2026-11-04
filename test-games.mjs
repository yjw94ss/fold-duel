import { chromium } from '/Users/Apple/.npm-global/lib/node_modules/playwright/index.mjs';

const URL = 'http://127.0.0.1:8899/index.html';
const VW = 827, VH = 749, SEG_TOP = 375, SEG_BOT = 374;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tapEl(page, selector) {
  const box = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) throw new Error('no element: ' + selector);
  await page.touchscreen.tap(box.x, box.y);
  return box;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH }, deviceScaleFactor: 3, isMobile: true, hasTouch: true
});
await ctx.addInitScript(({ segTop, segBot }) => {
  try {
    Object.defineProperty(window.visualViewport, 'segments', {
      configurable: true,
      get: () => [
        { left: 0, top: 0, width: innerWidth, height: segTop },
        { left: 0, top: segTop, width: innerWidth, height: segBot }
      ]
    });
  } catch (e) {}
}, { segTop: SEG_TOP, segBot: SEG_BOT });

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await sleep(400);

const paintedPixels = () => page.evaluate(() => {
  const c = document.getElementById('cv');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 89) {
    if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
  }
  return n;
});

console.log('\n── 菜单（6 项）───────────────────────────');
{
  const cards = await page.evaluate(() => [...document.querySelectorAll('#pBot .card')].map(c => c.dataset.act));
  ok(cards.length === 6, '6 个游戏入口', cards.join(','));
  ok(['gomoku', 'reversi', 'blackjack'].every(a => cards.includes(a)), '三个新游戏均在菜单中');

  const overlap = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#pBot .card')];
    const rs = els.map(e => e.getBoundingClientRect());
    const out = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5)
        out.push(i + '×' + j);
    }
    return out;
  });
  ok(overlap.length === 0, '6 张卡片互不重叠', overlap.join(','));

  const overflow = await page.evaluate(() => {
    const p = document.getElementById('pBot').getBoundingClientRect();
    return [...document.querySelectorAll('#pBot .card')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.top < p.top - .5 || r.bottom > p.bottom + .5;
    }).length;
  });
  ok(overflow === 0, '卡片未溢出面板');
}

console.log('\n── 五子棋 ───────────────────────────────');
{
  await tapEl(page, '#pTop .card[data-act="gomoku"]');
  await sleep(300);
  const m = await page.evaluate(() => ({ mode: window.__FD.APP.mode, on: window.__FD.GM.on }));
  ok(m.mode === 'gomoku' && m.on, '点击上半屏进入五子棋', JSON.stringify(m));

  const geo = await page.evaluate(() => window.__FD.GM.geo);
  ok(geo && geo.cell > 20 && geo.size > 300, '棋盘几何有效', JSON.stringify(geo));

  const painted = await paintedPixels();
  ok(painted > 50, '棋盘已绘制到画布', 'pixels=' + painted);

  // 真实触摸落子：点 (2,2) 交叉点
  const px = geo.x0 + 2 * geo.cell, py = geo.y0 + 2 * geo.cell;
  await page.touchscreen.tap(px, py);
  await sleep(200);
  let st = await page.evaluate(() => ({ turn: window.__FD.GM.turn, over: window.__FD.GM.over }));
  ok(st.turn === 2, '下半屏落子成功并切换到对方回合', JSON.stringify(st));

  // 上半屏真实触摸落子（对手视角，坐标不做翻转）
  const px2 = geo.x0 + 3 * geo.cell, py2 = geo.y0 + 3 * geo.cell;
  await page.touchscreen.tap(px2, py2);
  await sleep(200);
  st = await page.evaluate(() => window.__FD.GM.turn);
  ok(st === 1, '上半屏点击也能落子并切回己方', 'turn=' + st);

  // 同一位置重复点击不应生效（仍是 bot 回合）
  await page.touchscreen.tap(px2, py2);
  await sleep(150);
  st = await page.evaluate(() => window.__FD.GM.turn);
  ok(st === 1, '已有棋子的位置不重复落子', 'turn=' + st);

  // 空白远处（棋盘外）点击不落子
  await page.touchscreen.tap(20, 700);
  await sleep(150);
  st = await page.evaluate(() => window.__FD.GM.turn);
  ok(st === 1, '棋盘外点击不落子', 'turn=' + st);

  // 重开一局，构造五连
  await page.evaluate(() => { window.__FD.GM.start(); });
  await sleep(150);
  const seq = [[0,0],[0,1],[1,0],[1,1],[2,0],[2,1],[3,0],[3,1],[4,0]];
  for (const p of seq) { await page.evaluate(q => window.__FD.GM._place(q[0], q[1]), p); await sleep(30); }
  await sleep(300);
  const res = await page.evaluate(() => ({ r: window.__FD.APP.result, over: window.__FD.GM.over }));
  ok(res.over === true, '五子连线后对局结束');
  ok(res.r && res.r.winner === 'bot', '先连成五子的一方获胜', JSON.stringify(res.r));

  await sleep(200);
  const resTxt = await page.evaluate(() => (document.querySelector('#pBot .title') || {}).textContent);
  ok(resTxt === '你赢了', '下半屏显示胜利', resTxt);
  const resTxtTop = await page.evaluate(() => (document.querySelector('#pTop .title') || {}).textContent);
  ok(resTxtTop === '你赢了', '上半屏同样正立显示');

  await tapEl(page, '#pBot [data-act="menu"]');
  await sleep(250);
  ok(await page.evaluate(() => window.__FD.APP.mode) === 'menu', '返回菜单');
  ok(await page.evaluate(() => window.__FD.GM.on) === false, '五子棋已停止');
}

console.log('\n── 翻转棋 ───────────────────────────────');
{
  await tapEl(page, '#pBot .card[data-act="reversi"]');
  await sleep(300);
  ok(await page.evaluate(() => window.__FD.APP.mode) === 'reversi', '进入翻转棋');

  const c0 = await page.evaluate(() => window.__FD.RV.count);
  ok(c0.bot === 2 && c0.top === 2, '初始 4 子（2:2）', JSON.stringify(c0));

  // 初始合法落子应为 4 个
  const legalCount = await page.evaluate(() => window.__FD.RV.legalCount);
  ok(legalCount === 4, '初始合法点位 4 个', String(legalCount));

  const painted = await paintedPixels();
  ok(painted > 50, '棋盘已绘制', 'pixels=' + painted);

  // 落子 (2,3) 应翻转 (3,3)
  await page.evaluate(() => window.__FD.RV._place(2, 3));
  await sleep(250);
  const c1 = await page.evaluate(() => window.__FD.RV.count);
  ok(c1.bot === 4 && c1.top === 1, '落子后正确翻转（4:1）', JSON.stringify(c1));
  ok(await page.evaluate(() => window.__FD.RV.turn) === 2, '换手到对方');

  // 非法落子不应生效
  const before = await page.evaluate(() => window.__FD.RV.count);
  await page.evaluate(() => window.__FD.RV._place(0, 0));
  await sleep(200);
  const after = await page.evaluate(() => window.__FD.RV.count);
  ok(after.bot === before.bot && after.top === before.top, '非法位置点击无效', JSON.stringify(after));

  // 真实触摸落子（对方回合，点上半个合法点）
  const geo = await page.evaluate(() => window.__FD.RV.geo);
  const legalPts = await page.evaluate(() => window.__FD.RV.legal);
  // 取一个落在上半屏（y < 铰链中线）的合法点，验证对面那一侧的触摸同样可用
  const upper = legalPts.find(p => (geo.y0 + p[1] * geo.cell) < SEG_TOP);
  ok(!!upper, '对方回合在上半屏存在合法落子点', JSON.stringify(legalPts));
  if (upper) {
    await page.touchscreen.tap(geo.x0 + upper[0] * geo.cell, geo.y0 + upper[1] * geo.cell);
    await sleep(250);
    ok(await page.evaluate(() => window.__FD.RV.turn) === 1, '上半屏触摸可落子', 'turn=' + await page.evaluate(() => window.__FD.RV.turn));
  }

  await tapEl(page, '#pBot [data-act="menu"]');
  await sleep(200);
}

console.log('\n── 21 点 ────────────────────────────────');
{
  await tapEl(page, '#pBot .card[data-act="blackjack"]');
  await sleep(300);
  ok(await page.evaluate(() => window.__FD.APP.mode) === 'blackjack', '进入 21 点');

  const h0 = await page.evaluate(() => window.__FD.BJ.hands);
  ok(h0.bot.length === 2 && h0.top.length === 2, '双方各发 2 张', JSON.stringify({ b: h0.bot.length, t: h0.top.length }));

  const cardsDom = await page.evaluate(() => ({
    top: document.querySelectorAll('#pTop .pcard').length,
    bot: document.querySelectorAll('#pBot .pcard').length
  }));
  ok(cardsDom.top === 2 && cardsDom.bot === 2, '两侧各渲染 2 张牌面', JSON.stringify(cardsDom));

  // 点数计算（含 A 的软硬处理）
  const sc = await page.evaluate(() => {
    const f = window.__FD.BJ._score;
    return {
      a9: f([{ r: 'A', s: '♠' }, { r: '9', s: '♥' }]),
      aa: f([{ r: 'A', s: '♠' }, { r: 'A', s: '♥' }]),
      kq5: f([{ r: 'K', s: '♠' }, { r: 'Q', s: '♥' }, { r: '5', s: '♦' }]),
      ak: f([{ r: 'A', s: '♠' }, { r: 'K', s: '♥' }])
    };
  });
  ok(sc.a9 === 20, 'A+9 = 20', String(sc.a9));
  ok(sc.aa === 12, 'A+A = 12（自动降为 1）', String(sc.aa));
  ok(sc.kq5 === 25, 'K+Q+5 = 25（爆）', String(sc.kq5));
  ok(sc.ak === 21, 'A+K = 21', String(sc.ak));

  // 真实点「要牌」
  await tapEl(page, '#pBot [data-act="bj-hit"]');
  await sleep(300);
  const h1 = await page.evaluate(() => window.__FD.BJ.hands);
  ok(h1.bot.length === 3, '点击要牌后手牌 +1', String(h1.bot.length));

  const handDom = await page.evaluate(() => document.querySelectorAll('#pBot .pcard').length);
  ok(handDom === 3, '牌面 DOM 同步更新', String(handDom));

  // 连续要牌直到超过 21 点，验证爆牌状态与按钮消失
  await page.evaluate(() => window.__FD.BJ.start());
  await sleep(250);
  for (let i = 0; i < 12; i++) {
    const st = await page.evaluate(() => window.__FD.BJ.status.bot);
    if (st !== 'play') break;
    await page.evaluate(() => window.__FD.BJ.hit('bot'));
    await sleep(110);
  }
  const bustStatus = await page.evaluate(() => window.__FD.BJ.status.bot);
  ok(bustStatus === 'bust', '超过 21 点判定爆牌', bustStatus);
  ok(await page.evaluate(() => !document.querySelector('#pBot [data-act="bj-hit"]')), '爆牌后操作按钮已隐藏');
  ok(await page.evaluate(() => document.querySelector('#pBot .bj-note')?.textContent) === '爆牌', '爆牌文案正确');

  // 重开一局：双方各 2 张必不爆，用于验证停牌与结算流程
  await page.evaluate(() => window.__FD.BJ.start());
  await sleep(250);
  await tapEl(page, '#pBot [data-act="bj-stand"]');
  await sleep(250);
  ok(await page.evaluate(() => window.__FD.APP.result) === null, '仅一方停牌时不结算');
  await tapEl(page, '#pTop [data-act="bj-stand"]');
  await sleep(400);

  const r = await page.evaluate(() => window.__FD.APP.result);
  ok(r && ['bot', 'top', 'draw'].includes(r.winner), '双方停牌后结算', JSON.stringify(r));
  const t = await page.evaluate(() => (document.querySelector('#pBot .title') || {}).textContent);
  ok(['你赢了', '对手赢了', '平局'].includes(t), '结算文案有效', t);

  // 结算后再点要牌不应改变状态
  const handsBefore = await page.evaluate(() => window.__FD.BJ.hands.bot.length);
  await page.evaluate(() => window.__FD.BJ.hit('bot'));
  await sleep(150);
  ok(await page.evaluate(() => window.__FD.BJ.hands.bot.length) === handsBefore, '结算后不可继续要牌');

  await tapEl(page, '#pBot [data-act="menu"]');
  await sleep(200);
  ok(await page.evaluate(() => window.__FD.APP.mode) === 'menu', '返回菜单');
}

console.log('\n── 综合 ─────────────────────────────────');
{
  // 六个游戏轮转一遍，确保没有残留状态串味
  const acts = ['hockey', 'reflex', 'memory', 'gomoku', 'reversi', 'blackjack'];
  for (const a of acts) {
    await tapEl(page, `#pBot .card[data-act="${a}"]`);
    await sleep(300);
    const mode = await page.evaluate(() => window.__FD.APP.mode);
    if (mode !== a) { ok(false, '轮转进入 ' + a, mode); break; }
    await tapEl(page, '#pBot [data-act="menu"]');
    await sleep(250);
  }
  ok(await page.evaluate(() => window.__FD.APP.mode) === 'menu', '六个游戏轮转进出无异常');

  const ids = await page.evaluate(() => ({
    hk: window.__FD.HK.on, rf: window.__FD.RF.on, mm: window.__FD.MM.on,
    gm: window.__FD.GM.on, rv: window.__FD.RV.on, bj: window.__FD.BJ.on
  }));
  ok(Object.values(ids).every(v => v === false), '回到菜单后全部游戏已停止', JSON.stringify(ids));
}

console.log('\n── 报错 ─────────────────────────────────');
const inPage = await page.evaluate(() => window.__FD.errs);
ok(errors.length === 0, '浏览器零报错', errors.slice(0, 3).join(' | '));
ok(inPage.length === 0, '页面内部零报错', inPage.slice(0, 3).join(' | '));

await browser.close();
console.log('\n══════════════════════════════════════════');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  · ' + f)); }
console.log('══════════════════════════════════════════\n');
process.exit(fail ? 1 : 0);
