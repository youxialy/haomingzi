/* ============================================================
 * harness.js — 生成引擎逻辑自测（Node 环境）
 * 运行：node test/harness.js
 * 校验：连续 14 天日报 —— 模块轮换无连续重叠 / 字数达标 / 相邻相似度 / 周月报聚合
 * ============================================================ */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ctx = {
  window: {},
  console: console,
  localStorage: {
    _s: {},
    getItem: function (k) { return this._s[k] || null; },
    setItem: function (k, v) { this._s[k] = v; },
    removeItem: function (k) { delete this._s[k]; }
  }
};
vm.createContext(ctx);

['store.js', 'phrases.js', 'generator.js', 'composer.js'].forEach(function (f) {
  var code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
});
// 浏览器里 window.X 即全局 X；vm 沙箱需手动提升
['Store', 'Phrases', 'Generator', 'Composer'].forEach(function (k) {
  ctx[k] = ctx.window[k];
});
/* deviceId 由 store.js 加载时随机生成 → 每次运行种子都不同，生成类断言会偶发抖动。
 * 测试里固定它（生产逻辑不变），保证结果可复现。 */
if (ctx.Store.data && ctx.Store.data.settings) ctx.Store.data.settings.deviceId = 'test-fixed';

var Store = ctx.window.Store, Generator = ctx.window.Generator, Composer = ctx.window.Composer;

/* ---------- 构造配置：模拟一位电商客服实习生 ---------- */
var config = {
  jobType: 'service',
  modules: ctx.window.Phrases.jobTypes.service.modules.slice(),
  startDate: '2026-09-07',
  endDate: '2026-12-25',
  minWords: 300,
  company: '某电商公司',
  jobTitle: '电商客服'
};
var reports = {};
var stats = {};

var failures = [];
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); failures.push(msg); }
}

console.log('\n===== 测试 1：连续生成 14 天日报 =====');
var days = [];
for (var i = 0; i < 14; i++) {
  var d = new Date(2026, 8, 7 + i); // 2026-09-07 起
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  days.push(y + '-' + m + '-' + dd);
}

var texts = [];
days.forEach(function (ds, idx) {
  var extra = idx === 3 ? '参加了部门消防安全演练' : '';
  var r = Generator.generateDaily(ds, config, reports, stats, extra);
  if (!r) { failures.push('生成失败 ' + ds); return; }

  // 落库（模拟 editor.js 行为）
  reports[ds] = { date: ds, text: r.text, modules: r.modules, extra: r.extra, problem: r.problem, tpls: r.tpls || [], submitted: true };
  r.modules.forEach(function (m) {
    var s = stats[m] || { count: 0, lastDate: '' };
    s.count++; s.lastDate = ds;
    stats[m] = s;
  });
  texts.push(r.text);
});

check(days.every(function (d) { return reports[d]; }), '14 天全部生成成功');

// a. 字数达标
var wordOk = days.every(function (d) { return Generator.charCount(reports[d].text) >= 300; });
check(wordOk, '每天字数 ≥ 300（实际：' + days.map(function (d) { return Generator.charCount(reports[d].text); }).join('/') + '）');

/* b. 相邻两天模块重叠受限
 * 每天出 4 条、模块池 7 个：昨天用掉 4 个只剩 3 个，数学上不可能零重叠
 * —— 任意两个 4 元子集在 7 元全集里的交至少 1 个（|A∩B| ≥ |A|+|B|-|全集|）。
 * 真正要守住的是「别连着写同样的事」，所以按组合下界给出允许的最大重叠数；
 * 内容层面的防线是紧接着的「相邻两天相似度」断言。 */
var takeN = reports[days[0]].modules.length;
var overlapCap = Math.max(0, 2 * takeN - config.modules.length);
var worstOverlap = 0, worstAt = '';
for (var i2 = 1; i2 < days.length; i2++) {
  var prev = reports[days[i2 - 1]].modules, curr = reports[days[i2]].modules;
  var ov = curr.filter(function (m) { return prev.indexOf(m) >= 0; }).length;
  if (ov > worstOverlap) { worstOverlap = ov; worstAt = days[i2]; }
}
check(worstOverlap <= overlapCap,
  '相邻两天模块重叠 ≤ ' + overlapCap + ' 个（每天 ' + takeN + ' 条 / 池 ' + config.modules.length +
  ' 个；实测最大 ' + worstOverlap + (worstAt ? ' @ ' + worstAt : '') + '）');

// c. 周期内模块覆盖（7 个模块，14 天应全部出现过）
var used = {};
days.forEach(function (d) { reports[d].modules.forEach(function (m) { used[m] = 1; }); });
check(Object.keys(used).length === config.modules.length, '14 天内 7 个模块全覆盖（覆盖 ' + Object.keys(used).length + '/' + config.modules.length + '）');

// d. 相邻相似度
var maxSim = 0, maxPair = '';
for (var i3 = 1; i3 < texts.length; i3++) {
  var s = Generator.similarity(texts[i3], texts[i3 - 1]);
  if (s > maxSim) { maxSim = s; maxPair = days[i3 - 1] + '↔' + days[i3]; }
}
check(maxSim < 0.6, '相邻两天相似度 < 0.60（最大 ' + maxSim.toFixed(3) + ' @ ' + maxPair + '）');

// e. 特殊事项进入正文
check(reports[days[3]].text.indexOf('消防安全演练') >= 0, '特殊事项已并入当日「主要工作」栏');

console.log('\n===== 测试 2：周报聚合（2026-09-07 ~ 09-13） =====');
var weekly = Composer.aggregate('weekly', '2026-09-07', '2026-09-13', config, reports);
check(!!weekly && weekly.count === 7, '7 篇日报全部聚合（count=' + (weekly && weekly.count) + '）');
// 两栏化后周报不再有抬头/下周期计划，改为校验两栏结构（与学习通表单字段一致）
var wkLines = weekly.text.split('\n').filter(function (s) { return s.trim(); });
check(wkLines[0] === '收获与感受', '周报首栏就是「收获与感受」', wkLines[0]);
check(weekly.text.indexOf('主要工作、遇到的问题及如何解决的') > weekly.text.indexOf('收获与感受'),
  '周报两栏顺序与学习通表单一致（收获在前）');
check(weekly.text.indexOf('2026-09-07') < 0 || weekly.text.indexOf('实习第') < 0,
  '周报正文不含抬头（起止日期/批次号已移除）');
check(weekly.text.indexOf('消防安全演练') >= 0, '特殊事项进入周报「其他专项工作」');
check(wkLines.indexOf('下周期工作计划') < 0 && wkLines.indexOf('下月工作计划') < 0,
  '周报不含下周期计划栏（两栏化时已移除）');

console.log('\n===== 测试 3：月报聚合（2026-09-01 ~ 09-30） =====');
var monthly = Composer.aggregate('monthly', '2026-09-01', '2026-09-30', config, reports);
check(!!monthly && monthly.count === 14, '14 篇日报全部聚合（count=' + (monthly && monthly.count) + '）');
var moLines = monthly.text.split('\n').filter(function (s) { return s.trim(); });
check(moLines[0] === '收获与感受', '月报首栏就是「收获与感受」', moLines[0]);
check(monthly.text.indexOf('主要工作、遇到的问题及如何解决的') > monthly.text.indexOf('收获与感受'),
  '月报两栏顺序与学习通表单一致（收获在前）');

console.log('\n===== 测试 4：实习总结 =====');
var summary = Composer.internshipSummary(config, reports);
check(!!summary && summary.count === 14, '总结汇总全部日报（count=' + (summary && summary.count) + '）');
var sumNeed = ['实习概况', '主要工作内容', '收获与成长', '不足与改进方向', '结语'];
check(sumNeed.every(function (t) { return summary.text.indexOf(t) > 0; }), '包含完整五章结构',
  '缺失：' + sumNeed.filter(function (t) { return summary.text.indexOf(t) < 0; }).join('、'));

console.log('\n===== 测试 5：备份往返（导出→重置→导入） =====');
var exported = Store.exportJSON();
var before = JSON.stringify(Store.data.reports);
Store.reset();
var importOk = false;
Store.importJSON(exported, function () { importOk = true; }, function () {});
check(importOk, '导入成功');
check(JSON.stringify(Store.data.reports) === before, '导入后数据与导出时完全一致');

console.log('\n===== 测试 6：少量模块边界（2 个模块） =====');
var smallCfg = { jobType: 'general', modules: ['整理资料', '参加晨会'], startDate: '2026-09-07', minWords: 200 };
var sReports = {}, sStats = {};
var smallOk = true;
for (var i4 = 0; i4 < 4; i4++) {
  var r2 = Generator.generateDaily(days[i4], smallCfg, sReports, sStats, '');
  if (!r2) { smallOk = false; break; }
  sReports[days[i4]] = { date: days[i4], text: r2.text, modules: r2.modules, extra: '', problem: r2.problem, tpls: r2.tpls || [] };
}
check(smallOk, '2 个模块时连续 4 天生成不崩溃');

console.log('\n===== 测试 7：栏目开关（两栏化后标题固定为表单字段名） =====');
var cfg7 = JSON.parse(JSON.stringify(config));
cfg7.sections = [
  { key: 'done', title: '今日工作内容', on: true },
  { key: 'gains', title: '收获', on: false },
  { key: 'problems', title: '问题与反思', on: true },
  { key: 'plans', title: '明日安排', on: false }
];
var r7 = Generator.buildDaily('2026-09-14', cfg7, {}, {}, 0, '');
/* 两栏化后正文固定两栏，标题必须是学习通表单的字段名（不能改、不带编号）。
 * config.sections 的 title 不再影响输出 —— 这里验的是「标题锁定为表单字段名」。 */
function secHeadOf(text, title) {
  var hit = '';
  text.split('\n').forEach(function (l) { if (!hit && l.indexOf(title) >= 0) hit = l.trim(); });
  return hit;
}
var head7a = secHeadOf(r7.text, '收获与感受');
var head7b = secHeadOf(r7.text, '主要工作、遇到的问题及如何解决的');
check(head7a === '收获与感受', '首栏标题锁定为表单字段名「收获与感受」（' + head7a + '）');
check(head7b === '主要工作、遇到的问题及如何解决的', '次栏标题锁定为表单字段名「主要工作、遇到的问题及如何解决的」（' + head7b + '）');
check(r7.text.indexOf('今日工作内容') < 0 && r7.text.indexOf('问题与反思') < 0,
  'config.sections 里的自定义标题不再进入正文（两栏化后标题不可改）');
check(r7.text.indexOf('收获与学习') < 0 && r7.text.indexOf('明日计划') < 0 && r7.text.indexOf('明日安排') < 0,
  '关闭的栏目不再出现');
// 关闭 problems 栏 → 问题字段为空 → 周报聚合走「平稳顺利」兜底
var cfg7b = JSON.parse(JSON.stringify(config));
cfg7b.sections = [
  { key: 'done', title: '今日完成', on: true },
  { key: 'gains', title: '收获与学习', on: true },
  { key: 'problems', title: '遇到的问题与解决', on: false },
  { key: 'plans', title: '明日计划', on: true }
];
var r7b = Generator.buildDaily('2026-09-14', cfg7b, {}, {}, 0, '');
check(r7b.problem === null && r7b.text.indexOf('遇到的问题与解决') < 0, '关闭问题栏后不产出问题内容');
var rep7b = { date: '2026-09-14', text: r7b.text, modules: r7b.modules, extra: '', problem: r7b.problem };
var rep7bmap = {}; rep7bmap['2026-09-14'] = rep7b;
var wk7b = Composer.aggregate('weekly', '2026-09-14', '2026-09-14', cfg7b, rep7bmap);
check(wk7b && wk7b.text.indexOf('本周工作整体平稳顺利') >= 0, '无问题时周报使用兜底表述');

console.log('\n===== 测试 8：换一版（不同盐值输出不同版本） =====');
var base8 = Generator.generateDaily('2026-09-14', config, {}, {}, '');
var variant8 = Generator.generateDaily('2026-09-14', config, {}, {}, '', { saltBase: 4321 });
check(base8 && variant8 && base8.text !== variant8.text, '同一天不同盐值产出不同版本');
check(Generator.charCount(variant8.text) >= 300, '换一版后字数仍达标');

console.log('\n===== 测试 9：跨天句子防重复 =====');
/* 正文内容句提取：排除抬头、两栏固定标题、编号行。
 * ⚠️ 两栏化后标题是固定字符串（「收获与感受」/「主要工作、遇到的问题及如何解决的」），
 *    必须显式排除 —— 否则第二栏标题（18 字）会被当成正文句子参与重复统计，恒报失败。 */
var HARNESS_FIELDS = ['收获与感受', '主要工作、遇到的问题及如何解决的'];
function isContentLine(raw) {
  var s = raw.trim();
  if (s.length < 8) return false;
  if (s.charAt(0) === '【') return false;
  if (HARNESS_FIELDS.indexOf(s) >= 0) return false;         // 两栏固定标题
  if (/^[一二三四五六七八九十]、/.test(s)) return false;
  return true;
}
var dayIdx = {};
days.forEach(function (d, i) { dayIdx[d] = i; });
var seen = {}; // 句子 -> 出现过的日期下标数组
var worstDup = null;
days.forEach(function (d) {
  reports[d].text.split('\n').forEach(function (raw) {
    if (!isContentLine(raw)) return;
    var s = raw.trim().replace(/^[\d（(]+[.、）)]\s*/, '');
    if (!seen[s]) seen[s] = [];
    seen[s].forEach(function (prev) {
      var gap = dayIdx[d] - prev;
      if (gap <= 3 && (!worstDup || gap < worstDup.gap)) worstDup = { gap: gap, line: s };
    });
    seen[s].push(dayIdx[d]);
  });
});
check(!worstDup, '同一句话不会在 3 天内重复出现' + (worstDup ? '——间隔 ' + worstDup.gap + ' 天重复：「' + worstDup.line.slice(0, 30) + '…」' : ''));
var todayRec = Generator.buildDaily('2026-09-21', config, reports, stats, 0, '');
check(Array.isArray(todayRec.tpls) && todayRec.tpls.length > 0, '生成结果携带句式使用记录（tpls，共 ' + (todayRec.tpls ? todayRec.tpls.length : 0) + ' 条）');

// 同一篇内部：任意两句内容句相似度不得过高（防「只换模块名不换句式」）
var worstPair = null;
days.forEach(function (d) {
  var ls = [];
  reports[d].text.split('\n').forEach(function (raw) {
    if (!isContentLine(raw)) return;
    ls.push(raw.trim().replace(/^[\d（(]+[.、）)]\s*/, ''));
  });
  for (var a = 0; a < ls.length; a++) {
    for (var b = a + 1; b < ls.length; b++) {
      var sim2 = Generator.similarity(ls[a], ls[b]);
      if (sim2 >= 0.85 && (!worstPair || sim2 > worstPair.sim)) {
        worstPair = { sim: sim2, a: ls[a].slice(0, 18), b: ls[b].slice(0, 18), d: d };
      }
    }
  }
});
check(!worstPair, '同一篇内不存在句式雷同的两句话' + (worstPair ? '——' + worstPair.d + ' 相似度 ' + worstPair.sim.toFixed(2) + '：「' + worstPair.a + '…」vs「' + worstPair.b + '…」' : ''));

console.log('\n===== 测试 10：日均事务量（数字围绕基准波动） =====');
/* ⚠️ 「件数」只在设置项 numStyle='count'（写具体件数）时才写进正文；默认档是「不写件数」。
 *    这个测试原先没开档位，正文里一个数字都没有 → 样本恒为 0（空测）。这里显式打开。
 *    ⚠️ 口径是**按模块**（每项工作约处理几件），不是全天总量，所以断言区间是 3~10。 */
var prevNumStyle = ctx.Store.data.settings.numStyle;
ctx.Store.data.settings.numStyle = 'count';
var cfg10 = JSON.parse(JSON.stringify(config));
cfg10.dailyLoad = 6;
var nOk = true, nSamples = [];
for (var i5 = 0; i5 < 10; i5++) {
  var ds10 = '2026-10-' + String(i5 + 1).padStart(2, '0');
  var rr = Generator.buildDaily(ds10, cfg10, {}, {}, i5, '');
  // 两栏化后「主要工作」栏的标题是表单字段名，用它切栏取事务量数字（去掉行首序号）
  var s10 = rr.text.split('主要工作、遇到的问题及如何解决的')[1] || '';
  s10.split('\n').forEach(function (raw) {
    var s = raw.trim().replace(/^[\d（(]+[.、）)]\s*/, '');
    (s.match(/\d+/g) || []).forEach(function (x) {
      var v = parseInt(x, 10);
      if (v >= 2 && v <= 99) { nSamples.push(v); if (v < 3 || v > 10) nOk = false; }
    });
  });
}
ctx.Store.data.settings.numStyle = prevNumStyle;   // 还原，免得影响后续
check(nOk && nSamples.length > 0, 'dailyLoad=6 时事务量全部在 3~10 内（样本 ' + nSamples.length + ' 个：' + nSamples.slice(0, 12).join(',') + '）');

console.log('\n------------------------------------------');
if (failures.length) {
  console.log('❌ 失败 ' + failures.length + ' 项：');
  failures.forEach(function (f) { console.log('   - ' + f); });
  process.exit(1);
} else {
  console.log('✅ 全部通过');
}

/* ---------- 附：打印一篇样例供人工检查 ---------- */
console.log('\n===== 附：样例日报（' + days[3] + '，含特殊事项） =====');
console.log(reports[days[3]].text);
console.log('\n===== 附：样例周报 =====');
console.log(weekly.text);
