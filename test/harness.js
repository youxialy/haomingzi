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

// b. 相邻两天模块不重叠
var overlap = false;
for (var i2 = 1; i2 < days.length; i2++) {
  var prev = reports[days[i2 - 1]].modules, curr = reports[days[i2]].modules;
  if (curr.some(function (m) { return prev.indexOf(m) >= 0; })) { overlap = true; console.log('    重叠：' + days[i2] + ' → ' + curr.join(',')); }
}
check(!overlap, '相邻两天模块完全不重叠');

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
check(reports[days[3]].text.indexOf('消防安全演练') >= 0, '特殊事项已并入当日「今日完成」');

console.log('\n===== 测试 2：周报聚合（2026-09-07 ~ 09-13） =====');
var weekly = Composer.aggregate('weekly', '2026-09-07', '2026-09-13', config, reports);
check(!!weekly && weekly.count === 7, '7 篇日报全部聚合（count=' + (weekly && weekly.count) + '）');
var wkHead = weekly.text.split('\n')[0];
check(wkHead.indexOf('2026-09-07 ~ 2026-09-13') >= 0 && wkHead.indexOf('实习第1周') >= 0,
  '周报抬头含起止日期与批次号（版式为 6 套轮换，不再固定前缀）', wkHead);
check(weekly.text.indexOf('消防安全演练') >= 0, '特殊事项进入周报「其他专项工作」');
check(/下[周月]工作计划/.test(weekly.text), '包含下周期计划章节（章节编号随骨架变化）');

console.log('\n===== 测试 3：月报聚合（2026-09-01 ~ 09-30） =====');
var monthly = Composer.aggregate('monthly', '2026-09-01', '2026-09-30', config, reports);
check(!!monthly && monthly.count === 14, '14 篇日报全部聚合（count=' + (monthly && monthly.count) + '）');
var moHead = monthly.text.split('\n')[0];
check(moHead.indexOf('2026-09-01 ~ 2026-09-30') >= 0 && moHead.indexOf('（2026-09）') >= 0,
  '月报抬头含起止日期与月份', moHead);

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

console.log('\n===== 测试 7：自定义栏目（改名 + 关闭） =====');
var cfg7 = JSON.parse(JSON.stringify(config));
cfg7.sections = [
  { key: 'done', title: '今日工作内容', on: true },
  { key: 'gains', title: '收获', on: false },
  { key: 'problems', title: '问题与反思', on: true },
  { key: 'plans', title: '明日安排', on: false }
];
var r7 = Generator.buildDaily('2026-09-14', cfg7, {}, {}, 0, '');
check(r7.text.indexOf('一、今日工作内容') >= 0, '自定义标题生效且编号正确');
check(r7.text.indexOf('二、问题与反思') >= 0, '第二栏目为问题与反思');
check(r7.text.indexOf('收获与学习') < 0 && r7.text.indexOf('明日计划') < 0, '关闭的栏目不再出现');
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
// 提取正文内容句（去抬头/栏目行/序号），检查同一句不会在 4 天内再次出现
var dayIdx = {};
days.forEach(function (d, i) { dayIdx[d] = i; });
var seen = {}; // 句子 -> 出现过的日期下标数组
var worstDup = null;
days.forEach(function (d) {
  reports[d].text.split('\n').forEach(function (raw) {
    var s = raw.trim();
    if (s.length < 8 || s.charAt(0) === '【' || /^[一二三四五六七八九十]、/.test(s)) return;
    s = s.replace(/^\d+\.\s*/, '');
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
    var s = raw.trim();
    if (s.length < 8 || s.charAt(0) === '【' || /^[一二三四五六七八九十]、/.test(s)) return;
    ls.push(s.replace(/^\d+\.\s*/, ''));
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
var cfg10 = JSON.parse(JSON.stringify(config));
cfg10.dailyLoad = 6;
var nOk = true, nSamples = [];
for (var i5 = 0; i5 < 10; i5++) {
  var ds10 = '2026-10-' + String(i5 + 1).padStart(2, '0');
  var rr = Generator.buildDaily(ds10, cfg10, {}, {}, i5, '');
  // 提取「今日完成」栏目里的数字（去掉行首序号）
  var sec = rr.text.split('一、')[1] ? rr.text.split('一、')[1].split('二、')[0] : '';
  sec.split('\n').forEach(function (raw) {
    var s = raw.trim().replace(/^\d+\.\s*/, '');
    (s.match(/\d+/g) || []).forEach(function (x) {
      var v = parseInt(x, 10);
      if (v >= 2 && v <= 99) { nSamples.push(v); if (v < 3 || v > 10) nOk = false; }
    });
  });
}
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
