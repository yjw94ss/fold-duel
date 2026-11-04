import { chromium } from '/Users/Apple/.npm-global/lib/node_modules/playwright/index.mjs';

const URL = 'http://127.0.0.1:8899/index.html';
// OPPO Find N5 内屏横屏 CSS 视口估算：2480x2248 / dpr3 ≈ 827 x 749
const VW = 827, VH = 749;
const SEG_TOP = 375, SEG_BOT = 374;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 按元素视觉包围盒中心做真实触摸点击（可验证旋转面板的坐标映射）
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
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; OPPO Find N5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
});

// 伪造 Viewport Segments（模拟折叠屏悬停态）
await ctx.addInitScript(({ segTop, segBot }) => {
  try {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'segments', {
      configurable: true,
      get: () => {
        // 折叠态（细长视口）只有一段连续屏；横屏大屏才被铰链分成上下两段
        if (window.innerWidth < 600) {
          return [{ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }];
        }
        return [
          { left: 0, top: 0, width: window.innerWidth, height: segTop },
          { left: 0, top: segTop, width: window.innerWidth, height: segBot }
        ];
      }
    });
  } catch (e) { window.__segMockFailed = String(e); }
}, { segTop: SEG_TOP, segBot: SEG_BOT });

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await sleep(400);

console.log('\n── 1. 加载与布局 ─────────────────────────');
{
  const segMockFailed = await page.evaluate(() => window.__segMockFailed || null);
  const s = await page.evaluate(() => window.__FD.sizes);
  ok(s.W === VW && s.H === VH, `视口 ${VW}×${VH}`, `${s.W}×${s.H}`);
  ok(s.MID === SEG_TOP, `铰链中线 = ${SEG_TOP}`, 'MID=' + s.MID);
  ok(s.seg === true, 'Viewport Segments 被识别', segMockFailed || ('seg=' + s.seg));
  ok(s.segTopH === SEG_TOP && s.segBotH === SEG_BOT, '上下段高度正确', `${s.segTopH}/${s.segBotH}`);

  const tf = await page.evaluate(() => getComputedStyle(document.getElementById('pTop')).transform);
  ok(tf.startsWith('matrix(-1'), '上半屏已旋转 180°', tf);

  const panels = await page.evaluate(() => {
    const t = document.getElementById('pTop').getBoundingClientRect();
    const b = document.getElementById('pBot').getBoundingClientRect();
    return { t: { y: t.y, h: t.height }, b: { y: b.y, h: b.height } };
  });
  ok(Math.abs(panels.t.y - 0) < 1, '上半屏贴合顶边', JSON.stringify(panels.t));
  ok(Math.abs(panels.b.y - SEG_TOP) < 1, '下半屏贴合铰链下沿', JSON.stringify(panels.b));
  ok(Math.abs(panels.t.h - SEG_TOP) < 1 && Math.abs(panels.b.h - SEG_BOT) < 1, '面板高度无重叠无缝隙');
}

console.log('\n── 2. 菜单 ───────────────────────────────');
{
  const cards = await page.evaluate(() => ({
    top: document.querySelectorAll('#pTop .card').length,
    bot: document.querySelectorAll('#pBot .card').length
  }));
  ok(cards.top === 6 && cards.bot === 6, '两侧各渲染 6 个游戏卡片', JSON.stringify(cards));

  const overlaps = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#pBot .card, #pBot .badge, #pBot .title, #pBot .kicker')];
    const rects = els.map(e => ({ n: e.className + '|' + e.textContent.trim().slice(0, 8), r: e.getBoundingClientRect() }));
    const out = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)
        out.push(rects[i].n + ' × ' + rects[j].n);
    }
    return out;
  });
  ok(overlaps.length === 0, '菜单元素无重叠', overlaps.join(' / '));

  const bounds = await page.evaluate(() => {
    const p = document.getElementById('pBot').getBoundingClientRect();
    return [...document.querySelectorAll('#pBot .card, #pBot .badge, #pBot .title')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5; })
      .map(e => e.textContent.trim().slice(0, 10));
  });
  ok(bounds.length === 0, '菜单内容未溢出面板', bounds.join(','));
}

console.log('\n── 3. 气垫球 ─────────────────────────────');
{
  const hb = await tapEl(page, '#pTop .card[data-act="hockey"]');
  await sleep(250);
  let mode = await page.evaluate(() => window.__FD.APP.mode);
  ok(mode === 'hockey', '点击上半屏「气垫球」可进入游戏（旋转命中）', 'mode=' + mode + ' @y=' + hb.y.toFixed(0));

  await sleep(2300);
  let st = await page.evaluate(() => ({ phase: window.__FD.HK.phase, on: window.__FD.HK.on }));
  ok(st.on && st.phase === 'play', '开局倒计时后进入 play', JSON.stringify(st));

  // 双指同时拖动（上下各一个）
  const cdp = await ctx.newCDPSession(page);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  await T('touchStart', [{ x: 300, y: 620, id: 1 }, { x: 500, y: 120, id: 2 }]);
  await sleep(30);
  await T('touchMove',   [{ x: 420, y: 640, id: 1 }, { x: 620, y: 100, id: 2 }]);
  await sleep(120);
  await T('touchMove',   [{ x: 500, y: 655, id: 1 }, { x: 700, y: 80,  id: 2 }]);
  await sleep(200);
  const pads = await page.evaluate(() => window.__FD.HK.pads);
  await T('touchEnd', [{ x: 500, y: 655, id: 1 }, { x: 700, y: 80, id: 2 }]);

  ok(Math.abs(pads.bot.x - 500) < 45, '下半屏触摸控制己方球拍 x', 'bot.x=' + pads.bot.x.toFixed(1));
  ok(pads.bot.y > SEG_TOP, '己方球拍被限制在下半场', 'bot.y=' + pads.bot.y.toFixed(1));
  ok(Math.abs(pads.top.x - 700) < 45, '上半屏触摸控制对方球拍 x（无需坐标翻转）', 'top.x=' + pads.top.x.toFixed(1));
  ok(pads.top.y < SEG_TOP, '对方球拍被限制在上半场', 'top.y=' + pads.top.y.toFixed(1));

  // 物理稳定性
  let bad = null;
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const b = await page.evaluate(() => window.__FD.HK.ball);
    if (!b) { bad = 'ball null'; break; }
    if (![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) { bad = 'NaN ' + JSON.stringify(b); break; }
    if (b.x < -40 || b.x > VW + 40 || b.y < -40 || b.y > VH + 40) { bad = 'out of bounds ' + JSON.stringify(b); break; }
  }
  ok(!bad, '球体 4 秒内无 NaN / 无飞出界', bad || '');

  /* ---- 端到端球门判定：把球摆在门口，让它真的飞进去 ---- */
  await page.evaluate(() => window.__FD.HK._setBall(window.innerWidth / 2 + 100, window.__FD.sizes.MID - 35, 0, -700));
  await sleep(700);
  const sc1 = await page.evaluate(() => window.__FD.HK.score);
  ok(sc1.bot === 1, '球穿过球门线 → 己方得分（端到端）', JSON.stringify(sc1));

  await sleep(1000);
  // 门外侧不应得分而是反弹
  await page.evaluate(() => window.__FD.HK._setBall(90, window.__FD.sizes.MID - 35, 0, -700));
  await sleep(700);
  const sc2 = await page.evaluate(() => window.__FD.HK.score);
  ok(sc2.bot === 1, '球门外的边线只反弹、不计分', JSON.stringify(sc2));

  const hudTxt = await page.evaluate(() => document.querySelector('#pBot .hud .me').textContent);
  ok(hudTxt === String(sc2.bot), 'HUD 同步显示比分', hudTxt);
  const hudTop = await page.evaluate(() => document.querySelector('#pTop .hud .me').textContent);
  ok(hudTop === String(sc2.top), '上半屏 HUD 显示上半屏玩家的分数', hudTop);
  const hudTopOp = await page.evaluate(() => document.querySelector('#pTop .hud .op').textContent);
  ok(hudTopOp === String(sc2.bot), '上半屏「对手」列指向下半屏玩家', hudTopOp);

  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__FD.HK._forceScore('bot'); });
  await sleep(350);
  const result = await page.evaluate(() => window.__FD.APP.result);
  ok(result && result.winner === 'bot' && result.score.bot === 7, '比分到 7 触发结算', JSON.stringify(result));
  ok(await page.evaluate(() => window.__FD.HK.phase) === 'over', '结算后进入 over 状态');

  const resTxt = await page.evaluate(() => (document.querySelector('#pBot .title') || {}).textContent);
  ok(resTxt === '你赢了', '下半屏结算文案正确', resTxt);
  const resTxtTop = await page.evaluate(() => (document.querySelector('#pTop .title') || {}).textContent);
  ok(resTxtTop === '你赢了', '上半屏结算文案同样正立可读', resTxtTop);

  await tapEl(page, '#pBot [data-act="menu"]');
  await sleep(250);
  mode = await page.evaluate(() => window.__FD.APP.mode);
  ok(mode === 'menu', '结算页「再来一局」返回菜单', 'mode=' + mode);
  ok(await page.evaluate(() => window.__FD.HK.on) === false, '返回菜单时游戏循环已停止，无后台残留');
}

console.log('\n── 4. 反应对决 ───────────────────────────');
{
  await tapEl(page, '#pBot .card[data-act="reflex"]');
  await sleep(200);
  let m = await page.evaluate(() => ({ mode: window.__FD.APP.mode, st: window.__FD.RF.state }));
  ok(m.mode === 'reflex' && m.st === 'countdown', '进入反应对决并开始倒计时', JSON.stringify(m));

  await page.touchscreen.tap(VW / 2, SEG_TOP + SEG_BOT / 2);
  await sleep(200);
  let sc = await page.evaluate(() => window.__FD.RF.score);
  ok(sc.top === 1 && sc.bot === 0, '下半屏抢跑 → 上半屏得分', JSON.stringify(sc));

  await sleep(1600);
  let st = await page.evaluate(() => window.__FD.RF.state);
  ok(st === 'countdown', '回合结束后自动重开', st);

  let guard = 0;
  while (guard++ < 120) {
    st = await page.evaluate(() => window.__FD.RF.state);
    if (st === 'go') break;
    await sleep(100);
  }
  ok(st === 'go', '倒计时与随机等待后出现 GO', st);

  await page.touchscreen.tap(VW / 2, SEG_TOP / 2);
  await sleep(250);
  sc = await page.evaluate(() => window.__FD.RF.score);
  ok(sc.top === 2, 'GO 后上半屏点击得分', JSON.stringify(sc));

  const rfTxt = await page.evaluate(() => document.querySelector('#pTop .rf .score').textContent.replace(/\s+/g, ''));
  ok(/你\d+·对手\d+/.test(rfTxt), '计分文案格式正确', rfTxt);

  // 打满一局：必须等每次进入 go 状态才计分，否则会被判为抢跑
  let rounds = 0, rres = null;
  while (rounds++ < 12) {
    let waited = 0, s2 = '';
    while (waited < 7000) {
      s2 = await page.evaluate(() => window.__FD.RF.state);
      if (s2 === 'go') break;
      await sleep(100); waited += 100;
    }
    if (s2 !== 'go') break;
    await page.evaluate(() => window.__FD.RF.hit('top'));
    await sleep(250);
    rres = await page.evaluate(() => window.__FD.APP.result);
    if (rres) break;
    await sleep(1500);
  }
  ok(rres && rres.winner === 'top' && rres.score.top === 5, '先到 5 分判胜', JSON.stringify(rres));

  await tapEl(page, '#pBot [data-act="menu"]');
  await sleep(250);
  m = await page.evaluate(() => window.__FD.APP.mode);
  ok(m === 'menu', '返回按钮回到菜单', m);
}

console.log('\n── 5. 记忆翻牌 ───────────────────────────');
{
  await tapEl(page, '#pBot .card[data-act="memory"]');
  await sleep(250);
  let m = await page.evaluate(() => ({ mode: window.__FD.APP.mode, tiles: document.querySelectorAll('#pBot .tile').length }));
  ok(m.mode === 'memory' && m.tiles === 12, '每侧渲染 12 张牌', JSON.stringify(m));

  const same = await page.evaluate(() => {
    const a = [...document.querySelectorAll('#pTop .tile')].map(e => e.textContent).join('');
    const b = [...document.querySelectorAll('#pBot .tile')].map(e => e.textContent).join('');
    return a === b;
  });
  ok(same === false, '上下两侧牌局独立随机', 'same=' + same);

  await tapEl(page, '#pBot .tile[data-i="0"]');
  await sleep(180);
  ok(await page.evaluate(() => document.querySelector('#pBot .tile[data-i="0"]').classList.contains('open')), '下半屏点击可翻牌');

  await tapEl(page, '#pTop .tile[data-i="0"]');
  await sleep(180);
  ok(await page.evaluate(() => document.querySelector('#pTop .tile[data-i="0"]').classList.contains('open')), '上半屏点击可翻牌（旋转面板命中正确）');
  ok(await page.evaluate(() => document.querySelector('#pBot .tile[data-i="1"]').classList.contains('open')) === false, '两侧牌局互不干扰');

  const partner = await page.evaluate(() => {
    const t = [...document.querySelectorAll('#pBot .tile')].map(e => e.textContent);
    for (let i = 1; i < t.length; i++) if (t[i] === t[0]) return i;
    return -1;
  });
  ok(partner > 0, '存在与首张配对的两张牌', 'partner=' + partner);
  await tapEl(page, `#pBot .tile[data-i="${partner}"]`);
  await sleep(600);
  const d = await page.evaluate(() => window.__FD.MM.done);
  ok(d.bot === 1, '配对成功计数 +1', JSON.stringify(d));
  ok(await page.evaluate(() => document.querySelectorAll('#pBot .tile.done').length) === 2, '配对的两张标记为已完成');
  const hudMem = await page.evaluate(() => document.querySelector('#pBot .mem-hud').textContent.replace(/\s+/g, ''));
  ok(/配对1\/6/.test(hudMem), '配对进度实时更新', hudMem);

  const nonPair = await page.evaluate(() => {
    const t = [...document.querySelectorAll('#pBot .tile')].map(e => e.textContent);
    const isDone = i => document.querySelector(`#pBot .tile[data-i="${i}"]`).classList.contains('done');
    for (let i = 0; i < t.length; i++) {
      if (isDone(i)) continue;
      for (let j = i + 1; j < t.length; j++) {
        if (isDone(j)) continue;
        if (t[i] !== t[j]) return [i, j];
      }
    }
    return null;
  });
  if (nonPair) {
    await tapEl(page, `#pBot .tile[data-i="${nonPair[0]}"]`);
    await sleep(150);
    await tapEl(page, `#pBot .tile[data-i="${nonPair[1]}"]`);
    await sleep(1200);
    const stillOpen = await page.evaluate(i => document.querySelector(`#pBot .tile[data-i="${i}"]`).classList.contains('open'), nonPair[0]);
    ok(stillOpen === false, '不匹配的两张自动翻回', 'open=' + stillOpen);
  } else {
    ok(false, '找到一组不匹配的牌用于测试', 'no pair found');
  }

  await tapEl(page, '#pBot [data-act="menu"]');
  await sleep(200);
}

console.log('\n── 6. 性能与形态切换 ─────────────────────');
{
  await tapEl(page, '#pBot .card[data-act="hockey"]');
  await sleep(2200);
  const fps = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    (function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); })();
  }));
  ok(fps > 45, `帧率 ${fps.toFixed(1)} fps`, fps.toFixed(1));

  await page.setViewportSize({ width: 749, height: 827 });
  await sleep(450);
  ok(await page.evaluate(() => document.getElementById('rotate').classList.contains('show')) === true, '竖屏时显示横屏引导');

  await page.setViewportSize({ width: VW, height: VH });
  await sleep(450);
  const back = await page.evaluate(() => ({ mid: window.__FD.sizes.MID, ball: window.__FD.HK.ball }));
  ok(Math.abs(back.mid - SEG_TOP) < 2, '旋转回横屏后布局恢复', String(back.mid));
  ok(!!back.ball && Number.isFinite(back.ball.x), '旋转后球体状态有效', JSON.stringify(back.ball));

  await page.setViewportSize({ width: 414, height: 951 });
  await sleep(450);
  const fold = await page.evaluate(() => window.__FD.sizes);
  ok(Math.abs(fold.MID - 475) < 2, '折叠态细长视口重新平分', JSON.stringify(fold));
}

console.log('\n── 7. 错误日志 ───────────────────────────');
const inPage = await page.evaluate(() => window.__FD.errs);
ok(errors.length === 0, '浏览器层面零报错', errors.slice(0, 3).join(' | '));
ok(inPage.length === 0, '页面内部零报错', inPage.slice(0, 3).join(' | '));

await browser.close();

console.log('\n══════════════════════════════════════════');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  · ' + f)); }
console.log('══════════════════════════════════════════\n');
process.exit(fail ? 1 : 0);
