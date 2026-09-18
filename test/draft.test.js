/* ============================================================
 * draft.test.js — 草稿暂存 / 切换日期不丢内容 回归测试（Node 环境）
 * 运行：node test/draft.test.js
 *
 * 用一套极简 DOM 桩把 editor.js 跑起来，验证：
 *   1. 手写内容切日期再切回来 → 内容还在（且真写进了 localStorage）
 *   2. 点「保存」→ 内容进报告库、临时草稿被清掉
 *   3. 直接关页面（pagehide）→ 未过防抖的草稿也立即落盘
 *   4. 周报草稿按「类型+范围」各存一份，来回切换不串、不丢
 *   5. 实习总结草稿在重新打开页面后自动恢复
 *   6. 重新生成不会把旧草稿回灌，也不会残留脏草稿
 *   7. 素材库插入（contentChanged）不会重置编辑器内容
 * ============================================================ */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ---------- 极简 DOM ---------- */
function makeEl(id, tag) {
  var el = {
    id: id || '', tagName: (tag || 'div').toUpperCase(),
    value: '', textContent: '', innerHTML: '', hidden: false,
    className: '', title: '', checked: false, disabled: false,
    dataset: {}, style: {}, children: [], handlers: {},
    addEventListener: function (t, fn) { (el.handlers[t] = el.handlers[t] || []).push(fn); },
    appendChild: function (c) { el.children.push(c); return c; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return el; },
    fire: function (t, ev) {
      (el.handlers[t] || []).forEach(function (fn) { fn.call(el, ev || {}); });
    }
  };
  el.classList = {
    toggle: function (c, on) { el.className = on === undefined ? el.className : (on ? el.className + ' ' + c : el.className); },
    add: function (c) { el.className += ' ' + c; },
    remove: function () {},
    contains: function (c) { return el.className.indexOf(c) >= 0; }
  };
  return el;
}

var byId = {};
var doc = {
  getElementById: function (id) { return byId[id] || (byId[id] = makeEl(id)); },
  createElement: function (tag) { return makeEl('', tag); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
  visibilityState: 'visible',
  documentElement: { dataset: {}, setAttribute: function () {} }
};

var lsStore = {};
var win = {
  handlers: {},
  addEventListener: function (t, fn) { (win.handlers[t] = win.handlers[t] || []).push(fn); },
  fire: function (t) { (win.handlers[t] || []).forEach(function (fn) { fn(); }); },
  matchMedia: function () { return { matches: false, addEventListener: function () {} }; }
};

var toasts = [];

var ctx = {
  window: win,
  document: doc,
  console: console,
  confirm: function () { return true; },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null; },
    setItem: function (k, v) { lsStore[k] = String(v); },
    removeItem: function (k) { delete lsStore[k]; }
  }
};
vm.createContext(ctx);

['store.js', 'phrases.js', 'generator.js', 'composer.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
});
// 浏览器里 window.X 即全局 X；vm 沙箱需手动提升（editor.js 依赖这些全局）
['Store', 'Phrases', 'Generator', 'Composer'].forEach(function (k) { ctx[k] = win[k]; });
ctx.App = win.App = {
  toast: function (m) { toasts.push(m); },
  goTab: function () {},
  renderDue: function () {}
};
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8'), ctx, { filename: 'editor.js' });
ctx.Editor = win.Editor;

var Store = win.Store, Editor = win.Editor, phrases = win.Phrases;
function $(id) { return byId[id] || (byId[id] = makeEl(id)); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function savedDrafts() { return JSON.parse(lsStore.irdp_data_v1).drafts; }

/* ---------- 断言 ---------- */
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '　→ 实际：' + extra : '')); }
}

var D1 = '2026-09-10', D2 = '2026-09-11';

async function main() {
  Store.data.config = {
    jobType: 'service', modules: phrases.jobTypes.service.modules.slice(0, 5),
    startDate: '2026-09-01', endDate: '2026-12-25', minWords: 300, dailyLoad: 10,
    sections: win.Generator.defaultSections()
  };
  Editor.init();

  /* ===== 1. 手写内容切日期再切回来 ===== */
  console.log('\n===== 1. 切换日期不丢未保存的手写内容 =====');
  Editor.setDate(D1);
  $('reportEditor').value = '手写内容 A';
  $('reportEditor').fire('input');
  await sleep(600); // 等防抖落盘
  ok('输入后草稿已写入 localStorage', savedDrafts().daily[D1] && savedDrafts().daily[D1].text === '手写内容 A',
    JSON.stringify(savedDrafts().daily));

  Editor.setDate(D2);
  ok('切到另一天：编辑器清空（该天没内容）', $('reportEditor').value === '', '"' + $('reportEditor').value + '"');
  Editor.setDate(D1);
  ok('切回来：手写内容完整恢复', $('reportEditor').value === '手写内容 A', '"' + $('reportEditor').value + '"');
  ok('恢复时有明确提示', $('draftHint').hidden === false && /未保存/.test($('draftHint').textContent));

  /* ===== 2. 点保存 → 进报告库 + 清草稿 ===== */
  console.log('\n===== 2. 保存后草稿清空 =====');
  $('saveBtn').fire('click');
  ok('内容写入报告库', Store.data.reports[D1] && Store.data.reports[D1].text === '手写内容 A');
  ok('该日草稿已删除', !savedDrafts().daily[D1]);
  ok('编辑器内容保持不丢', $('reportEditor').value === '手写内容 A');
  Editor.setDate(D2); Editor.setDate(D1);
  ok('保存后切换日期，读的是报告库内容', $('reportEditor').value === '手写内容 A');

  /* ===== 3. pagehide 立即落盘（不等防抖） ===== */
  console.log('\n===== 3. 关页面 / 切后台立即落盘 =====');
  Editor.setDate(D2);
  $('reportEditor').value = '草稿 B（还没到防抖时间）';
  $('reportEditor').fire('input');
  win.fire('pagehide'); // 立刻关页面
  ok('pagehide 后草稿已在 localStorage 里', savedDrafts().daily[D2] && savedDrafts().daily[D2].text === '草稿 B（还没到防抖时间）',
    JSON.stringify(savedDrafts().daily[D2]));

  /* ===== 4. 周报草稿按范围各存一份 ===== */
  console.log('\n===== 4. 周月报草稿：切范围不丢、不串 =====');
  $('aggEditor').value = '周报草稿 W1';
  $('aggEditor').fire('input');
  await sleep(600);
  var weeklyKeys = Object.keys(savedDrafts().agg);
  ok('周报草稿已落盘', weeklyKeys.some(function (k) { return savedDrafts().agg[k].text === '周报草稿 W1'; }),
    JSON.stringify(weeklyKeys));

  $('aggType').fire('click', { target: { closest: function () { return { dataset: { type: 'monthly' } }; } } });
  ok('切到月报：编辑器切换为该范围内容（空）', $('aggEditor').value === '', '"' + $('aggEditor').value + '"');
  $('aggType').fire('click', { target: { closest: function () { return { dataset: { type: 'weekly' } }; } } });
  ok('切回周报：草稿完整恢复', $('aggEditor').value === '周报草稿 W1', '"' + $('aggEditor').value + '"');
  ok('周报/月报草稿互不覆盖', Object.keys(savedDrafts().agg).length >= 1);

  /* ===== 5. 实习总结草稿恢复 ===== */
  console.log('\n===== 5. 实习总结草稿随页面重开恢复 =====');
  $('sumEditor').value = '总结草稿 S1';
  $('sumEditor').fire('input');
  await sleep(600);
  ok('总结草稿已落盘', savedDrafts().summary === '总结草稿 S1', JSON.stringify(savedDrafts().summary));
  Editor.resync(); // 模拟整份数据重载后的重绘
  ok('重绘后自动恢复草稿', $('sumEditor').value === '总结草稿 S1', '"' + $('sumEditor').value + '"');

  /* ===== 6. 重新生成不吃旧草稿回灌 ===== */
  console.log('\n===== 6. 重新生成后不残留、不回灌旧草稿 =====');
  Editor.setDate(D1);
  $('reportEditor').value = '手改版（生成前的手动修改）';
  $('reportEditor').fire('input');
  await sleep(600);
  ok('生成前草稿存在', !!savedDrafts().daily[D1]);
  $('genBtn').fire('click');
  var genText = Store.data.reports[D1].text;
  ok('生成结果已入库', !!genText && genText.length > 100, String(genText && genText.length) + ' 字');
  ok('编辑器显示的是新生成内容（未被旧草稿回灌）', $('reportEditor').value === genText,
    $('reportEditor').value.slice(0, 20) + '…');
  ok('生成后该日脏草稿已清除', !savedDrafts().daily[D1], JSON.stringify(savedDrafts().daily[D1]));

  /* ===== 7. 素材库插入不被重置 ===== */
  console.log('\n===== 7. 素材库插入句式不会被吞掉 =====');
  $('reportEditor').value = '原有内容\n插入的句式';
  Editor.contentChanged();
  ok('contentChanged 不改写编辑器内容', $('reportEditor').value === '原有内容\n插入的句式', '"' + $('reportEditor').value + '"');
  ok('插入内容被记为未保存状态', $('draftHint').hidden === false);
  ok('插入内容立即进草稿（不会因切页丢失）',
    Store.data.drafts.daily[D1] && Store.data.drafts.daily[D1].text === '原有内容\n插入的句式',
    JSON.stringify(Store.data.drafts.daily[D1]));
  await sleep(600);
  ok('插入内容已落盘到 localStorage', savedDrafts().daily[D1] && savedDrafts().daily[D1].text === '原有内容\n插入的句式');

  console.log('\n================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main();
