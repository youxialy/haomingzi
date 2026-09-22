/* ============================================================
 * repetition.test.js — 内容重复度 P0 验收回归
 * 运行：node test/repetition.test.js
 *
 * 把 P0 的验收标准固化下来：以后谁把池子改小、把台账窗口改回去、
 * 或者把骨架删掉，这里会直接红掉。
 *
 * 指标口径与《实习日报一点通_P0实施计划与验收标准》一致：
 *   M1 整篇相似度 ≥0.5 的篇对占比 < 10%
 *   M2 模板复用间隔中位数 > 20 天，且 6 天内复用 0 次
 *   M3 结构组合 ≥5 种，最长连续相同结构 = 1 天
 *   M4 空信息句（不含岗位实体的内容句）字数占比 均值 < 15%
 *   M5 句式池最小循环周期 ≥ 20 天
 *   M6 同栏目整段重复 ≤ 3 次
 *   M7 模板病句（通用动词 + 模块首词撞车）命中 0
 *   M8 聚合稿：连续 6 周骨架互不相同；周报两两均值 < 0.65；问题段不逐字照搬日报
 * ============================================================ */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   → ' + extra : '')); }
}
function section(t) { console.log('\n===== ' + t + ' ====='); }

var JS = path.join(__dirname, '..', 'js');
var ctx = {
  window: {}, console: console,
  localStorage: { _s: {}, getItem: function (k) { return this._s[k] || null; }, setItem: function (k, v) { this._s[k] = v; }, removeItem: function (k) { delete this._s[k]; } }
};
vm.createContext(ctx);
['store.js', 'phrases.js', 'generator.js', 'composer.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
});
ctx.Store = ctx.window.Store;
// generator.js 里引用的是裸 Store / Phrases（浏览器里由 window 提供），vm 里要显式挂上
['Store', 'Phrases', 'Generator', 'Composer'].forEach(function (k) { ctx[k] = ctx.window[k]; });
/* deviceId 是 store.js 加载时用 Math.random 生成的 —— 每次运行种子都不同，
 * 生成类断言会随机抖动（实测 M8「周报不得逐字照搬日报问题句」约 25% 概率误报）。
 * 生产逻辑保持不变，测试里显式固定它，保证可复现。 */
if (ctx.Store.data && ctx.Store.data.settings) ctx.Store.data.settings.deviceId = 'test-fixed';
var Phrases = ctx.window.Phrases, Generator = ctx.window.Generator, Composer = ctx.window.Composer;
var Store = ctx.window.Store;   // M18 用 Store.parse 算「距上次做该模块」的天数

/* ---------------- 工具 ---------------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function addDays(b, n) { return new Date(b.getTime() + n * 864e5); }
function bigrams(t) { var s = [], x = (t || '').replace(/\s/g, ''); for (var i = 0; i < x.length - 1; i++) s.push(x.substr(i, 2)); return s; }
function sim(a, b) {
  var A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return 0;
  var setB = {}; B.forEach(function (g) { setB[g] = 1; });
  var inter = 0; A.forEach(function (g) { if (setB[g]) inter++; });
  return inter / Math.min(A.length, B.length);
}
function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
function pct(x) { return (x * 100).toFixed(1) + '%'; }

var HDR_RE = /^(【|实习日报|日报|实习周报|实习月报|\d{4}-\d{2}-\d{2}\s+星期)/;
var NUM_RE = /^(【[一二三四五六七八九十]】|（[一二三四五六七八九十]）|[一二三四五六七八九十][、.）)]|\d+[、.]|\(?\d+\)|[①②③④⑤⑥⑦⑧⑨⑩])/;
var MARK_RE = /^([・·•◆●○\-–—]|\d+[.、)）]|（\d+）|\(\d+\)|[①②③④⑤⑥⑦⑧⑨⑩])\s*/;
function isHeader(s) { return HDR_RE.test(s); }
function isSection(s) {
  if (isHeader(s)) return false;
  if (!NUM_RE.test(s)) return false;
  return s.replace(/\s/g, '').length <= 16 && !/[。！？；]/.test(s);
}
function fp(text) {   // 结构指纹
  var ls = (text || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  var secs = [], marks = {};
  ls.forEach(function (s) {
    if (isSection(s)) { var m = s.match(NUM_RE); secs.push(m ? m[1] : '?'); return; }
    if (isHeader(s) || s.length < 8) return;
    var mm = s.match(MARK_RE);
    marks[mm ? mm[1] : 'none'] = 1;
  });
  var head = ls.length ? ls[0].replace(/【[^】]*】/g, '【】').replace(/\d{4}-\d{2}-\d{2}/g, '<D>')
    .replace(/星期[日一二三四五六]/g, '<W>').replace(/第\d+天/g, '<N>').replace(/（[^）]*）/g, '（<X>）') : '';
  return head + ' || ' + secs.join('') + ' || ' + Object.keys(marks).sort().join(',');
}

/* ---------------- 语料 ---------------- */
var DAYS = 60;
function buildCorpus(jobType, days, minWords) {
  var jt = Phrases.jobTypes[jobType];
  var config = {
    jobType: jobType, modules: jt.modules.slice(), startDate: '2026-09-07', endDate: '2026-12-31',
    minWords: minWords || 300, dailyLoad: 10, company: '某某公司', jobTitle: jt.name
  };
  var reports = {}, stats = {}, order = [], base = new Date(2026, 8, 7);
  for (var i = 0; i < days; i++) {
    var ds = fmt(addDays(base, i));
    var r = Generator.generateDaily(ds, config, reports, stats, '');
    reports[ds] = {
      date: ds, text: r.text, modules: r.modules, extra: r.extra,
      problem: r.problem, tpls: r.tpls || [], skeleton: r.skeleton
    };
    r.modules.forEach(function (m) { var s = stats[m] || { count: 0 }; s.count++; stats[m] = s; });
    order.push(ds);
  }
  return { config: config, reports: reports, order: order, stats: stats, base: base };
}

/* 模板复用间隔统计（共用给 M2 / M10）：返回 {median, within6, minGap, reuses} */
function reuseStats(c) {
  var byKey = {}, gaps = [], within6 = 0, minGap = Infinity;
  c.order.forEach(function (d, di) {
    (c.reports[d].tpls || []).forEach(function (t) {
      if (String(t).charAt(0) === '@') return;   // 骨架标记不计入句式台账
      (byKey[t] = byKey[t] || []).push(di);
    });
  });
  Object.keys(byKey).forEach(function (k) {
    var a = byKey[k];
    for (var i = 1; i < a.length; i++) {
      var g = a[i] - a[i - 1];
      gaps.push(g);
      if (g <= 6) within6++;
      if (g < minGap) minGap = g;
    }
  });
  return { median: median(gaps), within6: within6, minGap: minGap, reuses: gaps.length };
}

/* 整篇相似度 ≥0.5 的篇对占比与最大值 */
function overRate(list) {
  var over = 0, tot = 0, mx = 0;
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      var s = sim(list[i], list[j]); tot++;
      if (s > mx) mx = s;
      if (s >= 0.5) over++;
    }
  }
  return { rate: over / tot, max: mx };
}

console.log('P0 内容重复度验收（' + DAYS + ' 天语料，service 岗位）');
var corpus = buildCorpus('service', DAYS);
var texts = corpus.order.map(function (d) { return corpus.reports[d].text; });

/* ============================================================
 * M1 整篇相似度
 * ============================================================ */
section('M1 整篇两两相似度');
(function () {
  var over = 0, tot = 0, mx = 0, sum = 0;
  for (var i = 0; i < texts.length; i++) {
    for (var j = i + 1; j < texts.length; j++) {
      var s = sim(texts[i], texts[j]); tot++; sum += s; if (s > mx) mx = s;
      if (s >= 0.5) over++;
    }
  }
  var rate = over / tot;
  ok(rate < 0.10, '相似度 ≥0.5 的篇对占比 ' + pct(rate) + ' < 10%', over + '/' + tot);
  ok(mx < 0.75, '最大篇对相似度 ' + mx.toFixed(3) + ' < 0.75', '均值 ' + (sum / tot).toFixed(3));
})();

/* ============================================================
 * M2 模板复用间隔（全周期台账）
 * ============================================================ */
section('M2 模板复用间隔（LZ 台账：最久未用优先）');
(function () {
  var byKey = {}, skelGaps = [];
  corpus.order.forEach(function (d, di) {
    (corpus.reports[d].tpls || []).forEach(function (t) {
      if (t.charAt(0) === '@') { skelGaps.push([t, di]); return; }
      (byKey[t] = byKey[t] || []).push(di);
    });
  });
  var gaps = [], within6 = 0, minGap = Infinity;
  Object.keys(byKey).forEach(function (k) {
    var a = byKey[k];
    for (var i = 1; i < a.length; i++) {
      var g = a[i] - a[i - 1]; gaps.push(g);
      if (g <= 6) within6++;
      if (g < minGap) minGap = g;
    }
  });
  var md = median(gaps);
  ok(md > 20, '模板复用间隔中位数 ' + md + ' 天 > 20 天', '总复用 ' + gaps.length + ' 次');
  ok(within6 === 0, '6 天内复用 0 次', '实际 ' + within6 + ' 次，最短间隔 ' + (minGap === Infinity ? '-' : minGap) + ' 天');
  ok(skelGaps.length > 0, 'tpls 里记录了版式骨架标记（@skN），可被台账读取');
})();

/* ============================================================
 * M3 结构多样性
 * ============================================================ */
section('M3 结构（抬头 / 章节编号 / 条目符号）多样性');
(function () {
  var ids = corpus.order.map(function (d) { return fp(corpus.reports[d].text); });
  var kinds = {}; ids.forEach(function (k) { kinds[k] = (kinds[k] || 0) + 1; });
  var maxRun = 1, cur = 1;
  for (var i = 1; i < ids.length; i++) { if (ids[i] === ids[i - 1]) { cur++; if (cur > maxRun) maxRun = cur; } else cur = 1; }
  var n = Object.keys(kinds).length;
  var top = Math.max.apply(null, Object.keys(kinds).map(function (k) { return kinds[k]; })) / ids.length;
  ok(n >= 5, '出现 ' + n + ' 种结构组合（≥5）', '最高频占 ' + pct(top));
  ok(maxRun === 1, '最长连续相同结构 1 天（相邻两篇结构必不同）', '实际 ' + maxRun + ' 天');
  ok(top <= 0.40, '单一结构最高频占 ' + pct(top) + ' ≤40%');
  // 骨架可反推（旧数据兼容）
  var allDetected = true, badId = '';
  corpus.order.forEach(function (d) {
    var got = Generator.detectSkeleton(corpus.reports[d].text);
    if (!got || got.id !== corpus.reports[d].skeleton) { allDetected = false; badId = corpus.reports[d].skeleton + '->' + (got && got.id); }
  });
  ok(allDetected, '6 套骨架都能从正文反推出来（旧数据兼容路径可用）', badId);
})();

/* ============================================================
 * M4 空信息句占比
 * ============================================================ */
section('M4 空信息句（不含岗位实体与岗位语域词、换岗位也一模一样）字数占比');
(function () {
  var mods = corpus.config.modules.slice();
  /* 岗位语域词（模板里 {lex} 的取值）也要一起掩掉再判 —— 这类句子虽然不含模块名，
   * 但换个岗位就会换成完全不同的词（客服用「客户投诉记录」、护服用「病人生命体征」），
   * 换岗位并不相同，不属于「空信息句」。 */
  var lexAll = [];
  Object.keys(Phrases.jobLex || {}).forEach(function (k) { lexAll = lexAll.concat(Phrases.jobLex[k]); });
  var maskWords = mods.concat(lexAll).sort(function (a, b) { return b.length - a.length; });
  var rates = [];
  corpus.order.forEach(function (d) {
    var tot = 0, empty = 0;
    corpus.reports[d].text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (s) {
      if (isHeader(s) || isSection(s) || s.length < 8) return;
      var body = s.replace(MARK_RE, '');
      tot += body.replace(/\s/g, '').length;
      var masked = s;
      maskWords.forEach(function (m) { masked = masked.split(m).join('«»'); });
      if (masked.indexOf('«»') < 0) empty += body.replace(/\s/g, '').length;
    });
    if (tot) rates.push(empty / tot);
  });
  var av = mean(rates), mx = Math.max.apply(null, rates);
  var sorted = rates.slice().sort(function (a, b) { return a - b; });
  var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  ok(av < 0.15, '空信息句字数占比均值 ' + pct(av) + ' < 15%', '最高一篇 ' + pct(mx) + '，P95 ' + pct(p95));
  ok(p95 < 0.20, 'P95 ' + pct(p95) + ' < 20%');
})();

/* ============================================================
 * M5 句式池容量
 * ============================================================ */
section('M5 句式池容量（条数 ÷ 日均调用次数 ≥ 20 天）');
(function () {
  var rate = {
    openers: 1, openersMon: 0.6 / 7, openersFri: 0.6 / 7, done: 3, doneActivity: 1.5,
    gains: 1, gainsTail: 0.6, problems: 0.65, solutions: 0.65, noProblem: 0.35,
    plans: 2, plansActivity: 0.7, planTail: 0.5, fillers: 1
  };
  var worst = null;
  Object.keys(rate).forEach(function (k) {
    var size = (Phrases[k] || []).length;
    var cycle = size / rate[k];
    if (!worst || cycle < worst.cycle) worst = { name: k, size: size, cycle: cycle };
  });
  ok(worst.cycle >= 20, '最小循环周期 ' + worst.cycle.toFixed(1) + ' 天（' + worst.name + '，' + worst.size + ' 条）≥ 20 天');
  // 模块绑定池必须 100% 含 {module}，否则换岗位就是同一句话
  var bound = ['done', 'doneActivity', 'gains', 'problems', 'solutions', 'plans', 'plansActivity'];
  var noMod = [];
  bound.forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) { if (t.indexOf('{module}') < 0) noMod.push(k + ':' + t.slice(0, 12)); });
  });
  ok(noMod.length === 0, '模块绑定池（done/doneActivity/gains/problems/solutions/plans/plansActivity）100% 含 {module}',
    noMod.length ? noMod.slice(0, 3).join(' / ') : '');
  ok((Phrases.skeletons || []).length >= 5, '版式骨架 ' + (Phrases.skeletons || []).length + ' 套 ≥ 5');
  ok((Composer.aggSkeletons || []).length >= 5, '聚合稿骨架 ' + (Composer.aggSkeletons || []).length + ' 套 ≥ 5');
  // problemKinds 必须与 problems 逐条同序对齐：长度不等时 composer（problemSummaryOf）
  // 会静默退回「逐字照搬日报 problem 原文」，周报 vs 日报的文本比对必然命中。
  ok(Phrases.problemKinds && Phrases.problemKinds.length === Phrases.problems.length,
    'problemKinds 与 problems 逐条同序对齐（' + ((Phrases.problemKinds || []).length) + ' vs ' + Phrases.problems.length + '）');
  // 池内去重：池里若混入重复条，实际可用容量被虚增，台账也会重复记账
  var dupPools = [];
  Object.keys(rate).concat(['noteLead', 'noteAct', 'noteEnd', 'problemKinds']).forEach(function (k) {
    var a = Phrases[k] || [], seen = {}, d = 0;
    a.forEach(function (t) { if (seen[t]) d++; seen[t] = 1; });
    if (d) dupPools.push(k + '(' + d + ')');
  });
  ok(dupPools.length === 0, '各句式池内无重复条', dupPools.join(' '));
})();

/* ============================================================
 * M6 同栏目整段重复
 * ============================================================ */
section('M6 同栏目整段重复（同一栏目、整段逐字相同）');
(function () {
  var blocks = {};
  corpus.order.forEach(function (d, di) {
    var ls = corpus.reports[d].text.split('\n').map(function (s) { return s.trim(); });
    var cur = null, buf = [];
    function flush() { if (cur && buf.length) { var k = cur + '\u0001' + buf.join('\n'); (blocks[k] = blocks[k] || []).push(di); } }
    ls.forEach(function (s) {
      if (isSection(s)) { flush(); cur = s; buf = []; }
      else if (cur && s) buf.push(s);
    });
    flush();
  });
  var worst = 0, within7 = 0;
  Object.keys(blocks).forEach(function (k) {
    var a = blocks[k];
    if (a.length > worst) worst = a.length;
    for (var i = 1; i < a.length; i++) if (a[i] - a[i - 1] <= 7) within7++;
  });
  ok(worst <= 3, '同一整段最多出现 ' + worst + ' 次 ≤ 3', '（旧版最多 11 次）');
  ok(within7 === 0, '7 天内整段重复 0 次', '实际 ' + within7 + ' 次');
})();

/* ============================================================
 * M7 模板病句
 * ============================================================ */
section('M7 模板病句（「按时进行参加晨会」这类通用动词 + 模块首词撞车）');
(function () {
  var pools = ['done', 'doneActivity', 'gains', 'gainsTail', 'problems', 'solutions',
    'noProblem', 'plans', 'plansActivity', 'planTail', 'fillers', 'openers', 'openersMon', 'openersFri',
    /* 补漏：这三个池以前不在巡检范围内，「补充记录」的句式一直没被这条断言覆盖。
     * 补上后立刻查出一条旧规则的误报（见 badJoin 里对「首二字相同」的动词限定）。 */
    'noteLead', 'noteAct', 'noteEnd'];
  var allMods = [];
  Object.keys(Phrases.jobTypes).forEach(function (j) {
    allMods = allMods.concat(Phrases.jobTypes[j].modules);
  });
  // 判定口径必须与生成器一致：用 badJoin(模板, 模块) 判「模板内部」+「占位符接缝」，
  // 不能对填充后的整行做 BAD_PAIR——模块名自身就可能含两个动词
  // （「工位5S整理维护」「会员信息登记维护」），整行判断会把这类模块的全部句式都误杀。
  var hitsPool = [], hitsRun = 0;
  pools.forEach(function (p) {
    (Phrases[p] || []).forEach(function (t) {
      allMods.forEach(function (m) {
        if (Generator.badJoin(t, m)) hitsPool.push(p + ':' + t.split('{module}').join(m).slice(0, 22));
      });
    });
  });
  ok(hitsPool.length === 0, '句式池 × 全部岗位模块：病句组合 0 处',
    hitsPool.length ? hitsPool.slice(0, 3).join(' / ') : '共检查 ' + allMods.length + ' 个模块');
  // 成品稿只能反向验证：命中片段若「完整落在某个模块名内部」，那是模块自带的动词
  // （「工位5S整理维护」），不算病句；只有跨出模块边界的才算
  // ——「按时进行参加晨会」这种接缝病句，片段必然有一半在模块外，仍会被抓到。
  var modsByLen = allMods.slice().sort(function (a, b) { return b.length - a.length; });
  function badInLine(line) {
    var out = [], re = new RegExp(Generator.BAD_PAIR.source, 'g'), m;
    while ((m = re.exec(line))) {
      var i = m.index, j = i + m[0].length, inMod = false;
      for (var k = 0; k < modsByLen.length && !inMod; k++) {
        var mod = modsByLen[k], p = -1;
        while ((p = line.indexOf(mod, p + 1)) >= 0) {
          if (i >= p && j <= p + mod.length) { inMod = true; break; }
        }
      }
      if (!inMod) out.push(m[0]);
    }
    return out;
  }
  var leaks = [];
  corpus.order.forEach(function (d) {
    (corpus.reports[d].text || '').split('\n').forEach(function (line) {
      badInLine(line).forEach(function (p) {
        hitsRun++;
        if (leaks.length < 3) leaks.push(p + '@' + line.slice(0, 24));
      });
    });
  });
  ok(hitsRun === 0, DAYS + ' 篇实际输出中病句 0 处',
    hitsRun ? leaks.join(' / ') : '（旧版 120 篇命中 296 处）');
})();

/* ============================================================
 * M8 聚合稿（周报 / 月报）
 * ============================================================ */
section('M8 聚合稿：骨架轮换 + 周报之间不雷同 + 问题段不照搬日报');
(function () {
  var base = corpus.base;
  var weeks = [], skeletons = [];
  for (var w = 0; w < 8; w++) {
    var from = fmt(addDays(base, w * 7)), to = fmt(addDays(base, w * 7 + 6));
    var ag = Composer.aggregate('weekly', from, to, corpus.config, corpus.reports);
    if (ag) { weeks.push({ from: from, to: to, text: ag.text }); skeletons.push(ag.skeleton); }
  }
  var uniqRun = true;
  for (var i = 1; i < skeletons.length; i++) if (skeletons[i] === skeletons[i - 1]) uniqRun = false;
  ok(uniqRun, '相邻两周的聚合版式必然不同（序列：' + skeletons.join(' ') + '）');
  ok(new Set(skeletons).size >= 5, '8 周里用到 ' + new Set(skeletons).size + ' 套不同版式（≥5）');

  var pairs = [];
  for (var a = 0; a < weeks.length; a++) for (var b = a + 1; b < weeks.length; b++) pairs.push(sim(weeks[a].text, weeks[b].text));
  var av = mean(pairs);
  ok(av < 0.65, '周报两两相似度均值 ' + av.toFixed(3) + ' < 0.65', '（旧版 0.70 左右）');

  // 问题段不得逐字照搬日报句子
  var copied = 0, checked = 0;
  weeks.forEach(function (x) {
    Object.keys(corpus.reports).forEach(function (d) {
      if (d < x.from || d > x.to) return;
      var p = corpus.reports[d].problem;
      if (!p) return;
      checked++;
      if (x.text.indexOf(p) >= 0) copied++;
    });
  });
  ok(copied === 0, '周报里没有逐字照搬日报的问题句', '检查 ' + checked + ' 条');

  // 活动型模块不得被套上「累计处理 / 经手 / 承接」这类事务动词
  var bad = '';
  Object.keys(Phrases.jobTypes).forEach(function (j) {
    var jt = Phrases.jobTypes[j];
    var cfg = { jobType: j, modules: jt.modules.slice(), startDate: '2026-09-07', company: 'X', jobTitle: jt.name };
    var txt = Composer.aggregate('weekly', '2026-09-07', '2026-09-13', cfg, corpus.reports);
    if (!txt) return;
    txt.text.split('\n').forEach(function (line) {
      if (/(参加|学习|复盘|晨间)[^：\n]{0,20}：\s*(累计处理|累计办结|经手|承接|共推进)/.test(line)) bad = line;
    });
  });
  ok(!bad, '活动型模块不会被套用事务型动词', bad);

  var mo = Composer.aggregate('monthly', '2026-09-01', '2026-09-30', corpus.config, corpus.reports);
  ok(!!mo && /月报/.test(mo.text.split('\n')[0]), '月报抬头含「月报」', mo ? mo.text.split('\n')[0] : '');
  var moMax = 0;
  weeks.forEach(function (x) { if (/2026-09/.test(x.from)) { var s = sim(x.text, mo.text); if (s > moMax) moMax = s; } });
  if (moMax > 0) ok(moMax < 0.70, '周报 ↔ 同月月报 最大相似度 ' + moMax.toFixed(3) + ' < 0.70', '（旧版 0.759）');
})();

/* ============================================================
 * M9 跨岗位隔离（随机流必须依赖配置，不能只依赖日期）
 *
 * 背景：旧实现 rngFor(dateStr, salt) 与配置完全无关 → 同一天生成任何两个岗位
 * 拿到同一条随机序列，正文里「不含模块名」的句子（开头语 / 今日无异常 /
 * 计划收尾 / 补充说明）逐字相同。实测 28 个岗位两两平均 3 行逐字相同，
 * 掩名相似度 0.724，最大 0.990 —— 同一个班各自交日报会被查重命中。
 * ============================================================ */
section('M9 跨岗位隔离');
(function () {
  var jobs = Object.keys(Phrases.jobTypes);
  var out = {};
  jobs.forEach(function (jt) {
    var j = Phrases.jobTypes[jt];
    var cfg = {
      jobType: jt, modules: j.modules.slice(), startDate: '2026-09-07',
      minWords: 300, dailyLoad: 10, company: '某某公司', jobTitle: j.name
    };
    var rep = {}, st = {}, last = '';
    for (var i = 0; i < 5; i++) {
      var d = fmt(addDays(corpus.base, i)), r = Generator.generateDaily(d, cfg, rep, st, '');
      rep[d] = { date: d, text: r.text, modules: r.modules, tpls: r.tpls || [] };
      last = d;
      r.modules.forEach(function (m) { var s = st[m] || { count: 0 }; s.count++; st[m] = s; });
    }
    out[jt] = rep[last].text;
  });

  // 正文行（去掉抬头/栏目标题/条目符号）
  function bodyLines(t) {
    return Generator.contentLines(t);
  }
  var sameCnt = [], nLines = bodyLines(out[jobs[0]]).length;
  for (var i = 0; i < jobs.length; i++) {
    for (var j = i + 1; j < jobs.length; j++) {
      var A = bodyLines(out[jobs[i]]), B = bodyLines(out[jobs[j]]), c = 0;
      A.forEach(function (s) { if (B.indexOf(s) >= 0) c++; });
      sameCnt.push(c);
    }
  }
  var sameMean = mean(sameCnt), sameMax = Math.max.apply(null, sameCnt);
  ok(sameMean / nLines < 0.05,
    '同一天跨岗位逐字相同行占比 ' + pct(sameMean / nLines) + ' < 5%',
    '平均 ' + sameMean.toFixed(2) + ' 行 / 共 ' + nLines + ' 行，最多 ' + sameMax + ' 行（旧版 3.00 行 / 33.3%）');

  // 掩名后跨岗位相似度：把每个岗位的模块名统一替换成 «M»，公司名替换为 «C»
  function mask(t) {
    var s = t;
    jobs.forEach(function (jt) {
      Phrases.jobTypes[jt].modules.forEach(function (m) { s = s.split(m).join('«M»'); });
    });
    return s.split('某某公司').join('«C»').replace(/\d+/g, '#');
  }
  var vals = [], mx = 0;
  for (var p = 0; p < jobs.length; p++) {
    for (var q = p + 1; q < jobs.length; q++) {
      var s = sim(mask(out[jobs[p]]), mask(out[jobs[q]]));
      vals.push(s); if (s > mx) mx = s;
    }
  }
  var m = mean(vals);
  ok(m < 0.55, '跨岗位掩名相似度均值 ' + m.toFixed(3) + ' < 0.55', '最大 ' + mx.toFixed(3) + '（旧版 均值 0.724 / 最大 0.990）');
  ok(mx < 0.80, '跨岗位掩名相似度最大 ' + mx.toFixed(3) + ' < 0.80', '（旧版 0.990）');

  // 骨架抬头不因岗位而「全都撞在同一天同一套」
  var skels = {};
  jobs.forEach(function (jt) {
    var first = out[jt].split('\n')[0];
    var d = Generator.detectSkeleton(first);
    var id = d ? d.id : '?';
    skels[id] = (skels[id] || 0) + 1;
  });
  var kinds = Object.keys(skels).length;
  ok(kinds >= 3, '同一天不同岗位至少用到 ' + kinds + ' 套不同骨架（≥3）', JSON.stringify(skels));
})();

/* ============================================================
 * M10 参数矩阵：字数下限
 * 旧版只有「120 天 / 300 字 / 单岗位」这一格是绿的，M1~M9 全都跑在这一格上，
 * 于是「字数不足时追加 filler」那条支路（绕过台账）一直没被测到：
 *   400 字 → 6 天内复用 75 次；600 字 → 905 次、M1 30.3%；800 字 → 1755 次、M1 89.7%。
 * 现在改成组合式补充记录并接回台账，这里把 300 / 500 / 800 三格固化下来。
 * ============================================================ */
section('M10 字数下限参数矩阵（300 / 500 / 800 字）');
(function () {
  var CASES = [
    { mw: 300, maxOver: 0.08, within6: 0 },
    { mw: 500, maxOver: 0.08, within6: 0 },
    // 800 字是极值：要 30 天不复用就得再备 ~500 条补充片段，不值当。
    // 这里只锁「整篇相似度」这条用户真正会踩的线；模板层允许复用但必须仍有节制。
    { mw: 800, maxOver: 0.15, within6: null }
  ];
  CASES.forEach(function (cs) {
    var c = buildCorpus('service', 45, cs.mw);
    var list = c.order.map(function (d) { return c.reports[d].text; });
    var or = overRate(list);
    var rs = reuseStats(c);
    var short = 0, bad = 0;
    c.order.forEach(function (d) {
      if (Generator.charCount(c.reports[d].text) < cs.mw) short++;
      var t = c.reports[d].text;
      var re = new RegExp(Generator.BAD_PAIR.source, 'g');
      while ((re.exec(t))) bad++;
    });
    console.log('  · ' + cs.mw + ' 字：平均 ' + Math.round(mean(c.order.map(function (d) { return Generator.charCount(c.reports[d].text); }))) +
      ' 字，复用间隔中位 ' + rs.median + ' 天，6 天内复用 ' + rs.within6 + ' 次，≥0.5 篇对 ' + pct(or.rate));
    ok(or.rate < cs.maxOver, cs.mw + ' 字：≥0.5 篇对占比 ' + pct(or.rate) + ' < ' + pct(cs.maxOver),
      '最大篇对 ' + or.max.toFixed(3));
    if (cs.within6 !== null) {
      ok(rs.within6 <= cs.within6, cs.mw + ' 字：6 天内模板复用 ' + rs.within6 + ' 次 ≤ ' + cs.within6,
        '最短间隔 ' + (rs.minGap === Infinity ? '-' : rs.minGap) + ' 天');
    } else {
      ok(rs.minGap >= 3, cs.mw + ' 字：最短复用间隔 ' + (rs.minGap === Infinity ? '-' : rs.minGap) + ' 天 ≥3',
        '6 天内复用 ' + rs.within6 + ' 次（旧版 1755 次）');
    }
    ok(short === 0, cs.mw + ' 字：45 篇全部达到字数下限', '不足 ' + short + ' 篇');
    ok(bad === 0, cs.mw + ' 字：正文病句 0 处', '命中 ' + bad + ' 处');
  });
})();

/* ============================================================
 * M11 聚合稿跨配置隔离
 * P1 只把配置指纹混进了日报种子，composer 一直是「同起止日期 → 同一条随机序列」：
 * 同岗位不同公司的周报掩名相似度 0.927、实习总结 0.994 —— 一个班各自交周报必然互相命中。
 * ============================================================ */
section('M11 聚合稿跨配置隔离（同区间、不同配置）');
(function () {
  function pack(jobType, company, days) {
    var jt = Phrases.jobTypes[jobType];
    var config = {
      jobType: jobType, modules: jt.modules.slice(), startDate: '2026-09-07', endDate: '2026-12-31',
      minWords: 300, dailyLoad: 10, company: company, jobTitle: jt.name
    };
    var reports = {}, stats = {}, base = new Date(2026, 8, 7);
    for (var i = 0; i < days; i++) {
      var ds = fmt(addDays(base, i));
      var r = Generator.generateDaily(ds, config, reports, stats, '');
      reports[ds] = { date: ds, text: r.text, modules: r.modules, extra: '', problem: r.problem, tpls: r.tpls || [] };
      r.modules.forEach(function (m) { var s = stats[m] || { count: 0 }; s.count++; stats[m] = s; });
    }
    return { config: config, reports: reports };
  }
  var A = pack('service', '甲公司', 28);
  var B = pack('service', '乙公司', 28);
  var C = pack('nurse', '甲公司', 28);
  var FROM = '2026-09-07', TO = '2026-09-27';

  var allMods = [];
  Object.keys(Phrases.jobTypes).forEach(function (k) {
    Phrases.jobTypes[k].modules.forEach(function (m) { allMods.push(m); });
  });
  allMods.sort(function (a, b) { return b.length - a.length; });
  function mask(t) {
    var s = t;
    allMods.forEach(function (m) { s = s.split(m).join('«M»'); });
    return s.replace(/[甲乙]公司/g, '«C»').replace(/\d+/g, '#');
  }

  var wa = Composer.aggregate('weekly', FROM, TO, A.config, A.reports);
  var wb = Composer.aggregate('weekly', FROM, TO, B.config, B.reports);
  var wc = Composer.aggregate('weekly', FROM, TO, C.config, C.reports);
  var sa = Composer.internshipSummary(A.config, A.reports);
  var sb = Composer.internshipSummary(B.config, B.reports);
  var sc = Composer.internshipSummary(C.config, C.reports);

  var wAB = sim(mask(wa.text), mask(wb.text));
  var wAC = sim(mask(wa.text), mask(wc.text));
  var sAB = sim(mask(sa.text), mask(sb.text));
  var sAC = sim(mask(sa.text), mask(sc.text));
  console.log('  周报 掩名：同岗位异公司 ' + wAB.toFixed(3) + '，异岗位 ' + wAC.toFixed(3) +
    '；骨架 ' + wa.skeleton + '/' + wb.skeleton + '/' + wc.skeleton);
  console.log('  总结 掩名：同岗位异公司 ' + sAB.toFixed(3) + '，异岗位 ' + sAC.toFixed(3) +
    '；骨架 ' + sa.skeleton + '/' + sb.skeleton + '/' + sc.skeleton);
  ok(wAB < 0.55, '周报：同岗位不同公司 掩名相似度 ' + wAB.toFixed(3) + ' < 0.55', '旧版 0.927');
  ok(wAC < 0.55, '周报：不同岗位 掩名相似度 ' + wAC.toFixed(3) + ' < 0.55', '旧版 0.962');
  ok(sAB < 0.55, '总结：同岗位不同公司 掩名相似度 ' + sAB.toFixed(3) + ' < 0.55', '旧版 0.994');
  ok(sAC < 0.60, '总结：不同岗位 掩名相似度 ' + sAC.toFixed(3) + ' < 0.60', '旧版 0.978');

  // 同配置同区间必须逐字可复现（配置指纹不能把确定性也弄丢）
  var again = Composer.aggregate('weekly', FROM, TO, A.config, A.reports);
  ok(again.text === wa.text, '同配置 + 同区间 → 周报逐字可复现');
  ok(Composer.internshipSummary(A.config, A.reports).text === sa.text, '同配置 + 同日报集 → 总结逐字可复现');

  // 结构周期：8 套骨架，相邻两期必不同，第 N 期与第 N+8 期同骨架
  // （用一份独立的长语料，28 天只够 4 期）
  var LONG = pack('service', '甲公司', 140);
  var ids = [], wk = new Date(2026, 8, 7);
  for (var w = 0; w < 20; w++) {
    var f = fmt(addDays(wk, w * 7)), t = fmt(addDays(wk, w * 7 + 6));
    var one = Composer.aggregate('weekly', f, t, LONG.config, LONG.reports);
    ids.push(one && one.skeleton ? one.skeleton : '?');
  }
  var adjSame = 0;
  for (var i = 1; i < ids.length; i++) if (ids[i] === ids[i - 1]) adjSame++;
  var kinds = {}; ids.forEach(function (x) { kinds[x] = 1; });
  ok(adjSame === 0, '20 期周报相邻两期骨架均不同', ids.slice(0, 6).join(' '));
  ok(Object.keys(kinds).length >= 6, '周报用到 ' + Object.keys(kinds).length + ' 套骨架（≥6）', ids.join(' '));
  var same8 = 0;
  for (var k2 = 0; k2 + 8 < ids.length; k2++) if (ids[k2] === ids[k2 + 8]) same8++;
  ok(same8 === ids.length - 8, '第 N 期与第 N+8 期同骨架（结构周期 = 8 期）', same8 + '/' + (ids.length - 8));
})();

/* ============================================================
 * M12 每天工作项条数与同篇模块重复
 * 用户真实反馈：一篇日报里「短视频拍摄剪辑」出现 6 次，读着不像人写 ——
 * 这是「重复」在用户眼里的真实所指（不是句子层面）。
 * 成因：模块名在「今日完成 / 收获 / 问题 / 计划 / 补充记录」各自独立选用，
 * 彼此不知道对方用过；一篇合计要写 10+ 次模块名，而模块池只有 6~7 个。
 * 修法：每篇维护「模块 → 已用次数」预算（cap = 3），每天工作项 3 → 4 条（额度 9 → 12）。
 * ============================================================ */
section('M12 每天工作项条数与同篇模块重复');
(function () {
  var CASES = ['newmedia', 'service', 'nurse', 'general', 'admin'];
  var worstPeak = 0, worstPeakJob = '', worstRate = 0, worstRateJob = '';
  CASES.forEach(function (job) {
    var c = buildCorpus(job, 120, 300);
    var mods = Phrases.jobTypes[job].modules;
    var want = Math.min(4, mods.length);
    var wrongItems = 0, over4 = 0, peak = 0;
    c.order.forEach(function (d) {
      var rec = c.reports[d];
      if ((rec.modules || []).length !== want) wrongItems++;
      var mx = 0;
      mods.forEach(function (m) { var n = rec.text.split(m).length - 1; if (n > mx) mx = n; });
      if (mx >= 4) over4++;
      if (mx > peak) peak = mx;
    });
    var rate = over4 / c.order.length;
    console.log('  · ' + job + '（池 ' + mods.length + '）：每天 ' + want + ' 条，单篇峰值 ' + peak +
      '，某模块 ≥4 次的篇数 ' + pct(rate));
    ok(wrongItems === 0, job + '：每天 ' + want + ' 条工作项', '不符 ' + wrongItems + ' 篇');
    if (peak > worstPeak) { worstPeak = peak; worstPeakJob = job; }
    if (rate > worstRate) { worstRate = rate; worstRateJob = job; }
  });
  /* 2026-09-19 收紧：修掉「问题句按 cap=3 挑模块、解决句再补记一次 → 实际占掉 4 次」之后，
   * 300 字档峰值 4 → 3、≥4 次的篇数 31~42% → 0%（6 个岗位各 120 天实测）。 */
  ok(worstPeak <= 3, '单篇同模块名最多出现 3 次（实测峰值 ' + worstPeak + ' @ ' + worstPeakJob + '；修复前 7）');
  ok(worstRate < 0.05, '某模块 ≥4 次的篇数占比 ' + pct(worstRate) + ' < 5%（@ ' + worstRateJob + '；修复前 62.5%）');

  /* 用户勾几个模块就写几条 —— 旧版「池子不足 5 个就砍到 2 条」会让只勾 3 个模块的人
   * 每天只拿到 2 条，日报读起来很空。 */
  var smallMods = ['整理工作资料与文档', '参加晨会', '学习岗位业务知识'];
  var smallCfg = {
    jobType: 'general', modules: smallMods.slice(), startDate: '2026-09-07', endDate: '2026-09-26',
    minWords: 300, dailyLoad: 10, company: '某某公司', jobTitle: '通用/其他'
  };
  var smallRep = {}, smallStats = {}, badSmall = 0;
  for (var si = 0; si < 20; si++) {
    var sds = fmt(addDays(new Date(2026, 8, 7), si));
    var sr = Generator.generateDaily(sds, smallCfg, smallRep, smallStats, '');
    if ((sr.modules || []).length !== 3) badSmall++;
    smallRep[sds] = { date: sds, text: sr.text, modules: sr.modules, extra: sr.extra, problem: sr.problem, tpls: sr.tpls || [] };
  }
  ok(badSmall === 0, '只勾 3 个模块时每天出 3 条工作项', '不符 ' + badSmall + ' 篇');
})();

/* ============================================================
 * M13 时态错位（「今日完成」栏目里冒出"明天打算…"）
 * 用户反馈：今日完成里出现「明天准备把今天没吃透的部分再补一补。」——
 * 明明是当天完成的事，却写成了对明天的预告。
 * 根源：noteEnd 池（补充记录的收束句，会挂进「今日完成」）里有 13 条以未来动作开头的
 * 句子，doneActivity 池另 1 条。已把 10 条改写成带 {module} 的形式挪到 planTail
 * （那里本就是「明日计划」，语义正对），另 2 条改成回顾表述。
 *
 * 判定口径：把句子按 ，。；、 切分子句，**任一子句以未来时间词开头** = 错位。
 * 「方便明天接着用」「没有留到明天」这类目的状语/否定式不算 —— 它们的主干动作是今天做的。
 * （这条口径要拿捏准：done 池有 4 条含"明天"，全是合理提及，不能一竿子打掉。）
 * ============================================================ */
/* 「今日完成」区块提取 —— M13 / M14 共用。
 * ⚠️ 判断「这一行是不是栏目标题」不能只看行首编号：骨架的条目符号也有 `（1）` 形式，
 * 会把正文条目误当标题、导致区块边界错乱（我因此误报过一次"还有残留"）。 */
var SEC_RE = /^[（【]?\s*(一|二|三|四|五|1|2|3|4|5)\s*[、）】]/;
var HEAD_WORDS_RE = /(今日完成|今日工作|完成情况|收获|学习|问题|解决|反思|计划|安排|明日|后续)/;
function isSectionHead(t) { return SEC_RE.test(t) && HEAD_WORDS_RE.test(t) && !/[，。；]/.test(t); }
function doneBlockOf(text) {
  var out = [], on = false;
  text.split('\n').forEach(function (l) {
    var t = l.trim();
    if (!t) return;
    if (isSectionHead(t)) { on = /完成/.test(t); return; }
    if (on) out.push(t);
  });
  return out;
}

section('M13 「今日完成」栏目的时态错位');
(function () {
  var DONE_POOLS = ['done', 'doneActivity', 'noteLead', 'noteAct', 'noteEnd'];
  var FUT_LEAD = /^(明天|明日|次日|下次|接下来|下一步|日后|后续)/;
  var OFF = /(^|[，。；])\s*(明天|明日|次日|下次|接下来|下一步|日后|后续)/;
  var CLAUSE = /[，。；、]/;

  // ① 池级别（根因所在，最稳的一条）
  var off = [];
  DONE_POOLS.forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) {
      t.split(CLAUSE).forEach(function (c) {
        if (FUT_LEAD.test(c.trim())) off.push(k + ' → ' + t);
      });
    });
  });
  console.log('  · 「今日完成」用到的池：' + DONE_POOLS.join(' / ') +
    '（共 ' + DONE_POOLS.reduce(function (a, k) { return a + (Phrases[k] || []).length; }, 0) + ' 条）');
  ok(off.length === 0, '这 ' + DONE_POOLS.length + ' 个池里没有「未来动作开头」的句子',
    off.slice(0, 3).join('  |  '));

  // ② 搬走的句子确实落到了 planTail（否则就是删掉了，白丢内容）
  ok((Phrases.planTail || []).length >= 35, 'planTail 承接搬迁句后仍有 ' + (Phrases.planTail || []).length + ' 条 ≥ 35');
  ok((Phrases.planTail || []).every(function (t) { return t.indexOf('{module}') >= 0; }),
    'planTail 每条都含 {module}（接在计划条目后面才读得通）');

  // ③ 端到端：600 字档最容易触发补充记录，用它抽验成稿
  var c13 = buildCorpus('newmedia', 45, 600);
  var total = 0, bad = 0, sample = '';
  c13.order.forEach(function (d) {
    doneBlockOf(c13.reports[d].text).forEach(function (l) {
      total++;
      if (OFF.test(l)) { bad++; if (!sample) sample = d + ' ' + l; }
    });
  });
  console.log('  · 45 天 / 600 字：「今日完成」共 ' + total + ' 行，时态错位 ' + bad + ' 行');
  ok(bad === 0, '成稿里「今日完成」栏目时态错位 0 行（改前 25 行 / 7.02%）', sample);
})();

/* ============================================================
 * M14 补充记录的开场雷同（同篇内）
 * 用户反馈：一篇里几条补充记录开头一样，读起来像排比（三条都是「XX以外…」）。
 * 改前实测（45 天 / 600 字）：同篇内模块名重复 97.8%、「模块名后 2 字」重复 64.4%。
 * 成因：补充记录挂在「今日完成」末尾续编号，模块由 pickCapped 从当天 4 个模块里随机挑
 * （cap=3 允许重复）；引子句池里 80% 以 {module} 打头、三大簇就占 78%。
 * 修法（generator.js）：① noteMods 模块按轮次去重；② noteShapes 开场形态去重。
 * ⚠️ 试过「一轮用完后扩到当天全池」：600 字档重复降到 6.7%，但 800 字档篇对 16.7%、
 *    周报掩名 0.562 双双越线，已回退 —— 候选池一大，不同天的模块组合就趋同。
 * ============================================================ */
section('M14 补充记录的开场雷同（同篇内）');
(function () {
  var shapeOf = function (t) {
    var i = t.indexOf('{module}');
    return i === 0 ? t.slice(8, 10) : t.slice(0, 2);   // {module} 占 8 个字符
  };

  // ① 池子层面：开场形态不能过度集中（防止以后有人往一个形态里猛加句子）
  var cnt = {}, n = 0;
  Phrases.noteLead.forEach(function (t) { var k = shapeOf(t); cnt[k] = (cnt[k] || 0) + 1; n++; });
  var maxShape = '', maxN = 0;
  Object.keys(cnt).forEach(function (k) { if (cnt[k] > maxN) { maxN = cnt[k]; maxShape = k; } });
  console.log('  · noteLead ' + n + ' 条 / ' + Object.keys(cnt).length + ' 种开场形态，最大簇「' +
    maxShape + '…」' + maxN + ' 条');
  ok(maxN / n < 0.4, 'noteLead 最大形态簇占比 ' + pct(maxN / n) + ' < 40%');

  // ② 成稿层面：把「今日完成」区块里超出当天模块数的行视作补充记录
  var c14 = buildCorpus('newmedia', 45, 600);
  var ITEM = /^([（(]?\s*\d+\s*[）).、]\s*|[・•·\-*]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/;
  var days = 0, modDupDays = 0, shapeDupDays = 0, notesTotal = 0;
  c14.order.forEach(function (d) {
    var rec = c14.reports[d];
    var notes = doneBlockOf(rec.text).slice((rec.modules || []).length);
    if (!notes.length) return;
    days++; notesTotal += notes.length;
    var mods = [], shapes = [];
    notes.forEach(function (line) {
      var body = line.replace(ITEM, '').trim();
      var mod = '', after = '';
      var sorted = (rec.modules || []).slice().sort(function (a, b) { return b.length - a.length; });
      for (var k = 0; k < sorted.length; k++) {
        var idx = body.indexOf(sorted[k]);
        if (idx >= 0) { mod = sorted[k]; after = body.slice(idx + sorted[k].length, idx + sorted[k].length + 2); break; }
      }
      mods.push(mod || '-');
      shapes.push(mod ? after : body.slice(0, 2));
    });
    var seenM = {}, seenS = {}, dm = false, dsx = false;
    mods.forEach(function (m) { if (seenM[m]) dm = true; seenM[m] = 1; });
    shapes.forEach(function (s) { if (seenS[s]) dsx = true; seenS[s] = 1; });
    if (dm) modDupDays++;
    if (dsx) shapeDupDays++;
  });
  console.log('  · 45 天 / 600 字：' + days + ' 天有补充记录（共 ' + notesTotal + ' 条，篇均 ' +
    (notesTotal / (days || 1)).toFixed(1) + ' 条）；模块名重复 ' + pct(modDupDays / (days || 1)) +
    '，开场形态重复 ' + pct(shapeDupDays / (days || 1)));
  ok(shapeDupDays === 0, '同篇补充记录开场形态重复 0 天（改前 64.4%）');
  ok(modDupDays / (days || 1) < 0.25,
    '同篇补充记录模块名重复 ' + pct(modDupDays / (days || 1)) + ' < 25%（改前 97.8%）');

  /* ③ 计划尾句不能和同一区块的计划条目撞模块。
   * 用户真实日报里最后两句连着都是「短视频拍摄剪辑」—— 原因是收尾句只从 planMods（2 个）
   * 里挑，挑哪个都必然撞。改成先从当天全池找没用过的模块，找不到才退回。 */
  var ALL_MODS = [];
  Object.keys(Phrases.jobTypes).forEach(function (k) {
    Phrases.jobTypes[k].modules.forEach(function (m) { if (ALL_MODS.indexOf(m) < 0) ALL_MODS.push(m); });
  });
  ALL_MODS.sort(function (a, b) { return b.length - a.length; });
  function blockOf(text, kw) {
    var out = [], on = false;
    text.split('\n').forEach(function (l) {
      var t = l.trim();
      if (!t) return;
      if (isSectionHead(t)) { on = new RegExp(kw).test(t); return; }
      if (on) out.push(t);
    });
    return out;
  }
  function modIn(line) {
    var body = line.replace(ITEM, '').trim();
    for (var i = 0; i < ALL_MODS.length; i++) { if (body.indexOf(ALL_MODS[i]) >= 0) return ALL_MODS[i]; }
    return '';
  }
  var c14b = buildCorpus('newmedia', 60, 300);
  var tailDup = 0, tailDays = 0;
  c14b.order.forEach(function (d) {
    var blk = blockOf(c14b.reports[d].text, '计划|安排');
    if (blk.length < 2) return;
    tailDays++;
    var last = modIn(blk[blk.length - 1]);
    if (!last) return;
    for (var i = 0; i < blk.length - 1; i++) {
      if (modIn(blk[i]) === last) { tailDup++; break; }
    }
  });
  console.log('  · 「明日计划」尾句与同区块条目撞模块：' + tailDup + ' / ' + tailDays + ' 天');
  ok(tailDup / (tailDays || 1) < 0.15,
    '计划尾句极少与计划条目撞模块（' + pct(tailDup / (tailDays || 1)) + ' < 15%）');
})();

/* ============================================================
 * M15 岗位模块池（2026-09-19 扩池后的硬约束）
 * 28 个岗位的模块池从 6~7 个扩到 8~9 个（共补 56 条）。
 * 为什么必须 ≥8：每天出 4 条工作项，池 ≥8 时任意两天的 4 元子集可以完全不重叠
 * （|A∩B| ≥ |A|+|B|-|N| = 4+4-8 = 0）—— 实测跨天重叠 2/1 → 0。
 * 模块名还要满足：岗位内不重名、长度 3~12（太长塞不进句式、太短会跟模板的动词撞车）、
 * 不含花括号（否则会干扰 {module} 占位符替换）。
 * ============================================================ */
section('M15 岗位模块池');
(function () {
  var keys = Object.keys(Phrases.jobTypes);
  var small = [], dupIn = [], badLen = [], braces = [];
  var lens = [];
  keys.forEach(function (k) {
    var ms = Phrases.jobTypes[k].modules || [];
    lens.push(ms.length);
    if (ms.length < 8) small.push(k + '(' + ms.length + ')');
    var seen = {};
    ms.forEach(function (m) {
      if (seen[m]) dupIn.push(k + ':' + m);
      seen[m] = 1;
      if (m.length < 3 || m.length > 12) badLen.push(k + ':' + m + '(' + m.length + ')');
      if (/[{}]/.test(m)) braces.push(k + ':' + m);
    });
  });
  var totalMods = keys.reduce(function (a, k) { return a + Phrases.jobTypes[k].modules.length; }, 0);
  console.log('  · ' + keys.length + ' 个岗位 / ' + totalMods + ' 条模块；池最小 ' +
    Math.min.apply(null, lens) + ' 个、最大 ' + Math.max.apply(null, lens) + ' 个');
  ok(small.length === 0, '每个岗位的模块池 ≥8 个（不足：' + (small.join(',') || '无') + '）');
  ok(dupIn.length === 0, '岗位内模块名无重复', dupIn.slice(0, 3).join(' , '));
  ok(badLen.length === 0, '模块名长度 3~12 字', badLen.slice(0, 3).join(' , '));
  ok(braces.length === 0, '模块名不含花括号（不会干扰 {module} 替换）', braces.slice(0, 3).join(' , '));
})();

/* ============================================================
 * M16 排版样式选项（config.layout）
 * 用户诉求：生成出来的版式每天都在变（一会儿「1.」一会儿「①②③」），
 * 看着不像同一个人写的。所以加了 config.layout，三档语义必须钉死：
 *   ''           自动轮换 —— 相邻两天必不同（这是相似度最低的档，是默认值）
 *   'family:num' / 'family:sym' —— 只在家族内的 3 套之间轮换，仍是相邻天不同
 *   'skN'        完全固定 —— **同一天重复生成也必须还是同一套**，否则「固定」名不副实
 * 另外要保证三件事：
 *   ① 非法的 layout 一律降级为自动轮换（导入别人的备份不能把生成器带崩）
 *   ② 固定档下相邻两天版式相同（这是它相对默认档的已知代价，锁住以防"修回轮换"）
 *   ③ 换到固定档不会影响正文之外的东西 —— 骨架只决定抬头/编号/条目符号
 * ============================================================ */
section('M16 排版样式选项 config.layout');
(function () {
  function mkCtx() {
    var c = {
      window: {}, console: { log: function () { } },
      localStorage: {
        _s: {}, getItem: function (k) { return this._s[k] || null; },
        setItem: function (k, v) { this._s[k] = v; }, removeItem: function (k) { delete this._s[k]; }
      }
    };
    vm.createContext(c);
    ['store.js', 'phrases.js', 'generator.js', 'composer.js'].forEach(function (f) {
      vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), c, { filename: f });
    });
    ['Store', 'Phrases', 'Generator', 'Composer'].forEach(function (k) { c[k] = c.window[k]; });
    if (c.Store.data && c.Store.data.settings) c.Store.data.settings.deviceId = 'layout-test';
    return c;
  }
  /* tpls 里骨架以 '@sk3' 形式记录（'@' 是 generator 的 SKEL_KEY），不是裸 'sk3' */
  var SK_RE = /^@(sk[1-6])$/;
  function skOf(r) {
    var hit = (r && r.tpls ? r.tpls : []).filter(function (t) { return SK_RE.test(t); })[0] || '';
    return hit.slice(1);
  }

  /* 跑 days 天，返回每天用的骨架 id 与正文 */
  function runDays(c, cfg, days) {
    var G = c.Generator;
    var start = new Date(2026, 8, 7);
    var rep = {}, st = {}, out = [];
    for (var i = 0; i < days; i++) {
      var ds = fmt(addDays(start, i));
      var r = G.generateDaily(ds, cfg, rep, st, '');
      rep[ds] = { date: ds, text: r.text, modules: r.modules, extra: r.extra, problem: r.problem, tpls: r.tpls || [] };
      r.modules.forEach(function (m) { var s = st[m] || { count: 0 }; s.count++; st[m] = s; });
      var sk = skOf(r);
      out.push({ date: ds, sk: sk, text: r.text });
    }
    return out;
  }
  function baseCfg(layout) {
    return {
      jobType: 'newmedia', modules: Phrases.jobTypes.newmedia.modules.slice(0, 4),
      startDate: '2026-09-07', endDate: '2026-12-31', minWords: 300, dailyLoad: 10,
      company: '示例科技有限公司', jobTitle: '新媒体运营', layout: layout
    };
  }
  function adjacentSame(rows) {
    var n = 0;
    for (var i = 1; i < rows.length; i++) if (rows[i].sk && rows[i].sk === rows[i - 1].sk) n++;
    return n;
  }

  /* ---- ① 默认档：相邻两天必不同 ---- */
  (function () {
    var rows = runDays(mkCtx(), baseCfg(''), 30);
    var used = {};
    rows.forEach(function (r) { used[r.sk] = 1; });
    var uniq = Object.keys(used).length;
    var adj = adjacentSame(rows);
    console.log('  · 自动轮换 30 天：用到 ' + uniq + ' 套骨架，相邻天同款 ' + adj + ' 天');
    ok(uniq >= 5, '自动轮换会用满 6 套骨架（实测 ' + uniq + ' 套）');
    ok(adj === 0, '默认档相邻两天版式必不同（实测同款 ' + adj + ' 天）');
  })();

  /* ---- ② 固定档：同一日期重复生成，仍是同一套 ---- */
  (function () {
    ['sk1', 'sk3', 'sk6'].forEach(function (id) {
      var c = mkCtx();
      var cfg = baseCfg(id);
      var G = c.Generator;
      var ds = '2026-09-19';
      var a = G.generateDaily(ds, cfg, {}, {}, '');
      var b = G.generateDaily(ds, cfg, {}, {}, '');
      var sa = skOf(a), sb = skOf(b);
      ok(sa === id && sb === id, '固定 ' + id + '：同一天重复生成仍是 ' + id + '（得到 ' + sa + ' / ' + sb + '）');
    });
  })();

  /* ---- ③ 固定档：不再相邻天轮换（这是选它的代价，明码锁住） ---- */
  (function () {
    var rows = runDays(mkCtx(), baseCfg('sk2'), 20);
    var uniq = {};
    rows.forEach(function (r) { uniq[r.sk] = 1; });
    var adj = adjacentSame(rows);
    console.log('  · 固定 sk2 20 天：用到 ' + Object.keys(uniq).length + ' 套骨架，相邻天同款 ' + adj + ' 天');
    ok(Object.keys(uniq).length === 1 && uniq.sk2, '固定档全程只用 1 套骨架');
    ok(adj === 19, '固定档相邻天全部同款（' + adj + '/19）—— 与用户本意一致');
  })();

  /* ---- ④ 风格家族：只用家族内的 3 套，且相邻天仍不同 ---- */
  (function () {
    var allowed = { num: ['sk1', 'sk2', 'sk6'], sym: ['sk3', 'sk4', 'sk5'] };
    ['num', 'sym'].forEach(function (fam) {
      var rows = runDays(mkCtx(), baseCfg('family:' + fam), 24);
      var bad = rows.filter(function (r) { return allowed[fam].indexOf(r.sk) < 0; });
      var uniq = {};
      rows.forEach(function (r) { uniq[r.sk] = 1; });
      console.log('  · family:' + fam + ' 24 天：用到 ' + Object.keys(uniq).length + ' 套（' +
        Object.keys(uniq).join('/') + '），越界 ' + bad.length + ' 天');
      ok(bad.length === 0, 'family:' + fam + ' 不会用到家族外的骨架');
      ok(Object.keys(uniq).length === 3, 'family:' + fam + ' 会用满家族内 3 套');
      ok(adjacentSame(rows) === 0, 'family:' + fam + ' 相邻两天仍不重样');
    });
  })();

  /* ---- ⑤ 固定档不改动正文内容，只换排版 ---- */
  (function () {
    var cfgA = baseCfg('');
    var rowsA = runDays(mkCtx(), cfgA, 6);
    var rowsB = runDays(mkCtx(), baseCfg('sk1'), 6);
    // 去掉抬头行与编号符号后，两档的正文句子数量应处在同一量级（不因排版而缩水）
    function bodyLen(t) { return t.replace(/[\s]/g, '').length; }
    var avgA = mean(rowsA.map(function (r) { return bodyLen(r.text); }));
    var avgB = mean(rowsB.map(function (r) { return bodyLen(r.text); }));
    var delta = Math.abs(avgA - avgB) / avgA;
    console.log('  · 正文长度：自动轮换 ' + Math.round(avgA) + ' 字 vs 固定 sk1 ' + Math.round(avgB) + ' 字');
    ok(delta < 0.25, '换排版不会让正文长度大幅缩水（差异 ' + pct(delta) + ' < 25%）');
  })();

  /* ---- ⑥ 非法 layout 一律降级为自动轮换（导入他人备份不能把生成器带崩） ---- */
  (function () {
    var bads = ['sk9', 'sk0', 'family:xxx', '　', 'AG1', '../../etc/passwd', 'null', 'sk1;alert(1)'];
    var survived = 0, leaked = [];
    bads.forEach(function (v) {
      var rows;
      try { rows = runDays(mkCtx(), baseCfg(v), 8); } catch (e) { leaked.push(v + '(' + e.message + ')'); return; }
      var used = {};
      rows.forEach(function (r) { used[r.sk] = 1; });
      // 非法值应等价于自动轮换：会出现 2 套以上骨架
      if (Object.keys(used).length > 1) survived++;
      else leaked.push(v + '(被当成固定档:' + Object.keys(used).join('') + ')');
    });
    console.log('  · 非法 layout ' + bads.length + ' 个：正常降级 ' + survived + ' 个');
    ok(leaked.length === 0, '非法 layout 不会崩溃、也不会被当成固定档', leaked.join(' , '));
  })();

  /* ---- ⑦ store 校验白名单：非法值被拦下、合法值原样往返 ---- */
  (function () {
    var S = mkCtx().Store;
    var valid = ['', 'family:num', 'family:sym', 'sk1', 'sk2', 'sk3', 'sk4', 'sk5', 'sk6'];
    /* 注意 'sk1\n' / ' sk3 ' 不算非法 —— asLayout 先 trim，归一化后是合法值，
     * 这是有意的（用户从聊天里复制粘贴常带首尾空白），所以它们不进 dirty 列表。 */
    var dirty = ['sk9', 'sk0', 'family:x', 'javascript:1', ' SK1 ', 'auto', 'AG1', 123, null, {}, [], true];
    var keptOK = valid.every(function (v) {
      var d = S._sanitize({ reports: {}, config: { modules: ['a'], layout: v } });
      return d.data.config.layout === v;
    });
    ok(keptOK, '合法 layout（含空串）在 sanitize 后原样保留');
    var dropped = dirty.every(function (v) {
      var d = S._sanitize({ reports: {}, config: { modules: ['a'], layout: v } });
      return d.data.config.layout === '';
    });
    ok(dropped, '非法 layout 在 sanitize 时被丢弃为空串（不会写进配置）');
    // ' SK1 ' 这类带空白/大小写的应被丢弃（大小写敏感，不做模糊纠正）
    var spaced = S._sanitize({ reports: {}, config: { modules: ['a'], layout: ' sk3 ' } });
    ok(spaced.data.config.layout === 'sk3', '带首尾空白的合法值会被 trim 后保留（得到 ' +
      JSON.stringify(spaced.data.config.layout) + '）');
    var upper = S._sanitize({ reports: {}, config: { modules: ['a'], layout: ' SK3 ' } });
    ok(upper.data.config.layout === '', '大小写不匹配的档位被丢弃（得到 ' +
      JSON.stringify(upper.data.config.layout) + '）');
  })();

  /* ---- ⑧ 聚合稿（周报/月报/实习总结）也吃同一个字段 ---- */
  (function () {
    var c = mkCtx();
    var cfg = baseCfg('sk1');
    var weeks = [];
    for (var w = 0; w < 6; w++) {
      var from = fmt(addDays(new Date(2026, 8, 7), w * 7));
      var sk = c.Composer.pickAggSkeleton('weekly', from, cfg);
      weeks.push(sk.id);
    }
    var uniq = {};
    weeks.forEach(function (x) { uniq[x] = 1; });
    console.log('  · layout=sk1 时 6 期周报骨架：' + weeks.join(' '));
    ok(Object.keys(uniq).length === 1, '选了固定档后，周报不再逐期换版式（' + Object.keys(uniq).join('/') + '）');

    // 空 layout 时必须恢复「相邻周不同」的原行为
    var c2 = mkCtx();
    var cfg2 = baseCfg('');
    var seq = [];
    for (var w2 = 0; w2 < 16; w2++) {
      var f2 = fmt(addDays(new Date(2026, 8, 7), w2 * 7));
      seq.push(c2.Composer.pickAggSkeleton('weekly', f2, cfg2).id);
    }
    var adjSame = 0;
    for (var i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) adjSame++;
    var u2 = {};
    seq.forEach(function (x) { u2[x] = 1; });
    console.log('  · layout=\'\' 时 16 期周报骨架：' + seq.join(' ') + '（用到 ' + Object.keys(u2).length + ' 套）');
    ok(adjSame === 0, '自动档周报相邻周版式不同（实测同款 ' + adjSame + ' 周）');
    ok(Object.keys(u2).length === 8, '自动档 16 期会用到全部 8 套聚合骨架（实测 ' + Object.keys(u2).length + ' 套）');
  })();

  /* ---- ⑩ 聚合稿家族档真的收敛到 3 套（防「白名单 id 写错→家族档静默失效」） ---- */
  (function () {
    /* 这里踩过一次坑：白名单写成 'agg1'（骨架真实 id 是 'ag1'），
     * allow.indexOf 永远不命中 → fam 为空 → 悄悄落回 8 套轮换，
     * 界面上看着「选了家族档」，实际一点没生效。所以必须断言收敛后的骨架数量。 */
    /* 两派按「条目符号」划分（数字派 3 套 / 符号派 5 套，数量不等是骨架本身决定的） */
    var FAM = { num: ['ag1', 'ag4', 'ag6'], sym: ['ag2', 'ag3', 'ag5', 'ag7', 'ag8'] };
    Object.keys(FAM).forEach(function (fam) {
      var c = mkCtx();
      var cfg = baseCfg('family:' + fam);
      var seq = [], bad = [];
      for (var w = 0; w < 12; w++) {
        var from = fmt(addDays(new Date(2026, 8, 7), w * 7));
        var id = c.Composer.pickAggSkeleton('weekly', from, cfg).id;
        seq.push(id);
        if (FAM[fam].indexOf(id) < 0) bad.push(from + ':' + id);
      }
      var uniq = {};
      seq.forEach(function (x) { uniq[x] = 1; });
      console.log('  · 周报 family:' + fam + ' 12 期：' + seq.join(' ') + '（' + Object.keys(uniq).length + ' 套）');
      ok(bad.length === 0, '周末 family:' + fam + ' 只用家族内骨架（越界：' + (bad.slice(0, 3).join(',') || '无') + '）');
      ok(Object.keys(uniq).length === FAM[fam].length,
        '周报 family:' + fam + ' 收敛到 ' + FAM[fam].length + ' 套（实测 ' + Object.keys(uniq).length +
        '）—— 若等于 8 说明白名单 id 写错、档位静默失效');
    });

    // 实习总结也要跟着家族档走，不能仍是 8 套全轮换
    var cs = mkCtx();
    var sums = [];
    for (var k = 0; k < 12; k++) {
      sums.push(cs.Composer.pickAggSkeleton('monthly', '2026-' + pad2(k + 1) + '-01', baseCfg('family:num')).id);
    }
    var su = {};
    sums.forEach(function (x) { su[x] = 1; });
    ok(Object.keys(su).length === 3, '月报 family:num 收敛到 3 套（实测 ' + Object.keys(su).length + '）');
  })();

  /* ---- ⑨ 同配置同日期仍可复现（固定档不能破坏这条不变量） ---- */
  (function () {
    ['', 'family:sym', 'sk4'].forEach(function (v) {
      var a = runDays(mkCtx(), baseCfg(v), 5).map(function (r) { return r.text; }).join('\u0001');
      var b = runDays(mkCtx(), baseCfg(v), 5).map(function (r) { return r.text; }).join('\u0001');
      ok(a === b, 'layout=' + JSON.stringify(v) + ' 时同配置同日期仍逐字可复现');
    });
  })();
})();

/* ============================================================
 * M17 病句探测器的「灵敏度」锁（M7 的补充）
 *
 * M7 断言「badJoin 拒绝的组合数 = 0」—— 意思是池子干净到不需要过滤。
 * 这条断言有个致命盲区：**badJoin 一旦变瞎，M7 反而通过得更轻松**，
 * 因为它只保证「没有误报」，不保证「真病句能被抓住」。
 * 实测：旧版 badJoin 对全库 21 条「及物动词 + 动词开头模块」的模板
 * 漏判率 100%（「明天继续做」+「参加晨会」= 做参加），而 M7 当时是全绿的。
 *
 * 所以这条锁三件事：
 *   ① 灵敏度：已知的接缝病句必须被抓住（防 badJoin 再变瞎）
 *   ② 特异性：正常搭配不许被误杀（防越修越激进）
 *   ③ 端到端：实际生成的多岗位正文里不得出现接缝病句
 * ============================================================ */
section('M17 病句探测器灵敏度（接缝病句必须被抓住）');
(function () {
  /* 独立写一份「接缝」判定：只看「模板尾部 × 模块开头」这个交界，不做整行扫描。
   * ⚠️ 绝不能对填充后的整行跑动词对 —— 模块名自身就可能含两个动词
   * （「客户信息整理录入」「工位5S整理维护」），整行扫描会把这类正常句式全误杀。 */
  var VT = '做|完|完成|处理|跟进|开展|进行|推进|执行|承接|落实|参与|整理|记录|登记|维护|核对|撰写|制作|统计|检查|排查|更新|录入|对接|协调|接听|参加|学习|复盘';
  var TAIL = new RegExp('(' + VT + ')$');
  var HEAD = new RegExp('^(' + VT + ')');
  function junctionClash(tpl, mod) {
    var i = String(tpl).indexOf('{module}');
    if (i < 0) return false;
    return TAIL.test(String(tpl).slice(0, i)) && HEAD.test(mod);
  }

  /* ---- ① 灵敏度：这批以前 100% 漏判，现在必须全部被抓住 ---- */
  var wasMissed = [
    ['明天继续做{module}，把{lex}方面还没弄清的补上。', '参加晨会与业务通报'],
    ['跟着师傅做{module}，把不熟的部分多看了两遍。', '参加晨会与业务通报'],
    ['做{module}时试着按标准步骤走，结果比凭感觉做得更稳。', '学习产品知识与话术'],
    ['上午集中做{module}，完成{n}项，下午接着处理剩余部分。', '处理售后退换货'],
    ['继续跟进{module}的后续事项，确保今天留下的尾巴清零。', '跟进异常物流订单'],
    ['明天先核对{module}的前置资料，避免做到一半再回头找。', '核对考勤数据'],
    ['在同事指导下做{module}，做完请他过了一遍。', '参加科室业务学习'],
    ['跟着走完{module}的整个过程，逐渐摸清了各环节的前后衔接关系。', '参加晨会与业务通报']
  ];
  var invalid = wasMissed.filter(function (x) { return !junctionClash(x[0], x[1]); });
  ok(invalid.length === 0, '上列 ' + wasMissed.length + ' 组样本本身确实是接缝病句',
    invalid.map(function (x) { return x[0]; }).join(' | '));
  var notCaught = wasMissed.filter(function (x) {
    return junctionClash(x[0], x[1]) && !Generator.badJoin(x[0], x[1]);
  });
  ok(notCaught.length === 0,
    '接缝病句全部被 badJoin 抓住（' + wasMissed.length + ' 组，旧版漏判 100%）',
    notCaught.map(function (x) { return x[0]; }).join(' | '));

  /* ---- ② 特异性：正常搭配不许被误杀 ---- */
  var fine = [
    ['{module}明天继续按流程走。', '参加晨会与业务通报'],
    ['明天在{module}上放慢一点，把规范要求逐条对上。', '参加晨会与业务通报'],
    ['把{module}排进明天的优先级前列，避免被临时事务挤占。', '参加晨会与业务通报'],
    ['明天围绕{module}做一次小复盘，把问题点记下来。', '参加晨会与业务通报'],
    ['明天先{module}，趁上午精力充沛把难点处理掉。', '参加晨会与业务通报'],
    ['明天先做{module}。', '客户资料归档'],
    ['明天把{module}做完，再去协助同事的临时事务。', '客户资料归档'],
    ['数据和记录做了二次核对，确认前后能对得上。', '数据统计与复盘分析']
  ];
  var falseAlarm = fine.filter(function (x) { return Generator.badJoin(x[0], x[1]); });
  ok(falseAlarm.length === 0, '正常搭配没有被误杀（' + fine.length + ' 组）',
    falseAlarm.map(function (x) { return x[0]; }).join(' | '));

  /* ---- ③ 端到端：多岗位多天，正文里不得出现接缝病句 ---- */
  var modsAll = [];
  Object.keys(Phrases.jobTypes).forEach(function (k) {
    (Phrases.jobTypes[k].modules || []).forEach(function (m) {
      if (modsAll.indexOf(m) < 0) modsAll.push(m);
    });
  });
  /* 长模块优先，避免短名先命中把长名盖掉 */
  modsAll.sort(function (a, b) { return b.length - a.length; });
  var headMods = modsAll.filter(function (m) { return HEAD.test(m); });

  function lineHits(line) {
    var out = [];
    for (var k = 0; k < headMods.length; k++) {
      var mod = headMods[k];
      var p = line.indexOf(mod);
      if (p <= 0) continue;                                  // 模块在行首 → 左侧为空，不可能堆叠
      if (TAIL.test(line.slice(0, p))) {
        out.push(line.slice(Math.max(0, p - 6), p) + '×' + mod);
      }
    }
    return out;
  }

  var jobs = Object.keys(Phrases.jobTypes);
  var hits = [], gen = 0;
  jobs.forEach(function (jk) {
    var cfg = {
      jobType: jk, company: '示例', jobTitle: '实习',
      modules: Phrases.jobTypes[jk].modules.slice(), custom: [],
      sections: [{ key: 'done', title: '今日完成', on: true }, { key: 'gains', title: '收获与学习', on: true },
      { key: 'problems', title: '遇到的问题与解决', on: true }, { key: 'plans', title: '明日计划', on: true }],
      words: 300, dailyLoad: 10, startDate: '2026-09-01', layout: ''
    };
    var rep = {}, st = {};
    ['2026-09-01', '2026-09-04', '2026-09-08'].forEach(function (ds) {
      var r = Generator.generateDaily(ds, cfg, rep, st, '');
      if (!r) return;
      gen++;
      rep[ds] = { date: ds, text: r.text, tpls: r.tpls };
      r.text.split('\n').forEach(function (ln) {
        lineHits(ln).forEach(function (h) { hits.push('[' + jk + '] ' + h); });
      });
    });
  });
  console.log('  · 端到端：' + jobs.length + ' 岗位 × 3 天，生成 ' + gen + ' 篇，命中接缝病句 ' + hits.length + ' 处');
  ok(hits.length === 0, '实际生成的正文里没有接缝病句', hits.slice(0, 4).join('  |  '));
})();

/* ============================================================
 * M18 明日计划的「事实锚点」（修 2：套话治理）
 *
 * 起因：用户反馈「明日计划太套话、一看就是模板」。诊断后发现根因**不是骨架重复**
 * —— 旧池 70 条 70 种结构、骨架重复率 0%；真正的问题是**信息量为零**：
 * 91% 的句子在说「明天我会继续认真做这个模块」，与今天发生了什么完全无关
 * （{n} 占比 0%、含「今天」仅 6%）。对照组「今日完成」池 90% 带 {n}，读着就有内容。
 *
 * 修法 = 让计划句挂靠**真实事实**，可用性按模块判定：
 *   今天做过 → {left}/{n}/今天类；今天没做、昨天做过 → 昨天类；
 *   今天没做、上次更早 → {ago}/{last}；从没做过 → 无锚点兜底（永远成立）。
 * 本锁四件事：
 *   ① 池子侧：锚点比例下限、100% 含 {module}、**占位符白名单**
 *      （防 {left} 写进模板却忘了注入 → fill() 会把它替换成空串，生成「还剩 项」）
 *   ② 覆盖率：端到端生成里有事实挂靠的计划句占比（旧版 21%）
 *   ③ **事实一致性 = 0**：断言必须与数据相符 —— 这是「读着假」的根源
 *   ④ 同篇：锚点种类不重复（最多 1 条无锚点）+ 跨栏目数字一致
 * ============================================================ */
section('M18 明日计划的事实锚点（套话治理）');
(function () {
  var PLAN_POOLS = ['plans', 'plansActivity', 'planTail'];

  /* ---- ① 池子侧 ---- */
  var noMod = [];
  ['plans', 'plansActivity'].forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) {
      if (t.indexOf('{module}') < 0) noMod.push(k + ':' + t.slice(0, 10));
    });
  });
  ok(noMod.length === 0, 'plans / plansActivity 100% 含 {module}', noMod.slice(0, 3).join(' | '));

  var ALLOW = { module: 1, n: 1, left: 1, ago: 1, last: 1, lex: 1 };
  var badPh = [];
  PLAN_POOLS.forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) {
      (t.match(/\{\w+\}/g) || []).forEach(function (p) {
        if (!ALLOW[p.slice(1, -1)]) badPh.push(k + ':' + p);
      });
    });
  });
  ok(badPh.length === 0, '计划类池的占位符都在生成侧会注入的白名单内（防渲染成空）',
    badPh.slice(0, 4).join(' '));

  /* 判类：**看模板里的占位符**，不看句子里有没有「今天」二字
   *（「今天还剩 2 项」也含「今天」，按文本猜会把它误判成今天类）。 */
  function kindOfTpl(t) {
    if (t.indexOf('{left}') >= 0) return 'left';
    if (t.indexOf('{n}') >= 0) return 'n';
    if (t.indexOf('{ago}') >= 0) return 'ago';
    if (t.indexOf('{last}') >= 0) return 'last';
    if (/昨天|前天/.test(t)) return 'yday';
    if (/今天|今日/.test(t)) return 'today';
    return 'plain';
  }
  var rate = {};
  PLAN_POOLS.forEach(function (k) {
    var a = Phrases[k] || [];
    var c = 0;
    a.forEach(function (t) { if (kindOfTpl(t) !== 'plain') c++; });
    rate[k] = a.length ? c / a.length : 0;
  });
  ok(rate.plans >= 0.85, 'plans 池锚点比例 ' + pct(rate.plans) + ' ≥ 85%（旧池 21%）');
  ok(rate.planTail >= 0.60, 'planTail 池锚点比例 ' + pct(rate.planTail) + ' ≥ 60%（旧池 0% 带 {n}）');
  ok(rate.plansActivity >= 0.50, 'plansActivity 池锚点比例 ' + pct(rate.plansActivity) + ' ≥ 50%');
  var actNum = (Phrases.plansActivity || []).filter(function (t) {
    return t.indexOf('{left}') >= 0 || t.indexOf('{n}') >= 0;
  });
  ok(actNum.length === 0, 'plansActivity 不带数量锚点（事件型工作没有「还剩几项」）',
    actNum.slice(0, 2).join(' | '));
  ok((Phrases.plans || []).length >= 40 && (Phrases.plansActivity || []).length >= 20,
    'plans ' + (Phrases.plans || []).length + ' 条 / plansActivity '
    + (Phrases.plansActivity || []).length + ' 条（容量见 M5）');

  /* ---- ②③④ 端到端 ---- */
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var norm = function (s) { return s.replace(/。$/, ''); };   // 合并句拼接前会去掉句末句号
  var TPLS = [];
  PLAN_POOLS.forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) {
      var src = norm(t).split(/(\{\w+\})/)
        .map(function (p) { return /^\{\w+\}$/.test(p) ? '.+?' : esc(p); }).join('');
      TPLS.push({ t: t, re: new RegExp('^' + src + '$'), pool: k });
    });
  });
  function matchTpl(line) {
    var t = norm(line);
    for (var i = 0; i < TPLS.length; i++) if (TPLS[i].re.test(t)) return TPLS[i];
    return null;
  }
  /* 各锚点组的池容量：M5 只按整池算循环周期，分组之后可能错配（见下面 ⑥） */
  var groupCap = {};
  PLAN_POOLS.forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) {
      var g = k + '/' + kindOfTpl(t);
      groupCap[g] = (groupCap[g] || 0) + 1;
    });
  });
  var ITEM_RE = /^(?:[一二三四五六七八]、|（[一二三四五六七八\d]+）|\([一二三四五六七八\d]+\)|【[一二三四五六七八\d]+】|\d+[.、)）]|[①-⑩]|・|[-*]\s*)\s*/;
  var CLOSER_RE = /^(以上|综上|总之)/;

  var tot = 0, plain = 0, unknown = 0, badFact = [], residue = [], kindDup = 0, dupNonPlain = 0;
  var twoPlain = 0, days = 0, crossBad = 0, crossChk = 0, gen = 0;
  var groupUse = {}, claimBad = [];
  var jobs = Object.keys(Phrases.jobTypes);

  jobs.forEach(function (jk) {
    var mods = Phrases.jobTypes[jk].modules.slice();
    var cfg = {
      jobType: jk, company: '示例', jobTitle: '实习', modules: mods, custom: [], sections: null,
      minWords: 0, dailyLoad: 10, startDate: '2026-09-01', endDate: '2026-12-31', layout: ''
    };
    var rep = {}, st = {}, prevOf = {};
    ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08'].forEach(function (ds) {
      var r = Generator.generateDaily(ds, cfg, rep, st, '');
      if (!r) return;
      gen++;
      prevOf[ds] = Object.keys(rep).filter(function (x) { return x < ds; }).sort();
      rep[ds] = { date: ds, text: r.text, modules: r.modules, tpls: r.tpls, problem: r.problem };

      var ls = r.text.split('\n');
      var atPlans = -1, atDone = -1;
      ls.forEach(function (ln, i) {
        if (atDone < 0 && ln.indexOf('今日完成') >= 0) atDone = i;
        if (ln.indexOf('明日计划') >= 0) atPlans = i;
      });
      if (atPlans < 0) return;
      days++;
      /* 今日完成 里「模块 → 数字」：用于验证跨栏目数字一致 */
      var doneNum = {};
      if (atDone >= 0) {
        ls.slice(atDone + 1, atPlans).forEach(function (ln) {
          var hit = mods.filter(function (m) { return ln.indexOf(m) >= 0; });
          if (hit.length !== 1) return;
          var mm = /(\d+)\s*项/.exec(ln);
          if (mm) doneNum[hit[0]] = Number(mm[1]);
        });
      }

      var body = ls.slice(atPlans + 1)
        .map(function (x) { return x.replace(ITEM_RE, '').trim(); })
        .filter(function (x) { return x && !CLOSER_RE.test(x); });

      var kinds = [], plains = 0;
      body.forEach(function (raw) {
        // 合并句（骨架 plansJoin）把两条计划句用「；」连成一句，要先拆开再逐句判
        raw.split('；').forEach(function (part) {
          var t = part.trim();
          if (!t) return;
          tot++;
          var hit = matchTpl(t);
          if (!hit) { unknown++; residue.push(ds + ' 未匹配模板 「' + t + '」'); return; }
          var tpl = hit.t;
          var k = kindOfTpl(tpl);
          groupUse[hit.pool + '/' + k] = (groupUse[hit.pool + '/' + k] || 0) + 1;
          kinds.push(k);
          if (k === 'plain') { plain++; plains++; }

          var mentioned = mods.filter(function (m) { return t.indexOf(m) >= 0; });
          /* ⑤ 独立判据：**不看 planKind**，只看句子字面声明了哪个时点。
           * planKind 一旦把「今天…」误判成 yday，用同一套规则做的校验会把错误"复制"
           * 过去而不是发现它（实测就这样漏掉 3 条模板）。这里换成与生成侧无关的判据。 */
          if (/今天|今日/.test(t)) {
            mentioned.forEach(function (m) {
              if (r.modules.indexOf(m) < 0) claimBad.push(ds + ' 「' + t + '」← ' + m + ' 字面说「今天」但今天没做过');
            });
          }
          if (/昨天/.test(t)) {
            var yd = prevOf[ds][prevOf[ds].length - 1];
            mentioned.forEach(function (m) {
              if (!yd || (rep[yd].modules || []).indexOf(m) < 0) {
                claimBad.push(ds + ' 「' + t + '」← ' + m + ' 字面说「昨天」但昨天没做过');
              }
            });
          }
          if (k === 'left' || k === 'n' || k === 'today') {
            mentioned.forEach(function (m) {
              if (r.modules.indexOf(m) < 0) badFact.push(ds + ' [' + k + '] 「' + t + '」← ' + m + ' 今天没做过');
            });
          } else if (k === 'yday') {
            var y = prevOf[ds][prevOf[ds].length - 1];
            mentioned.forEach(function (m) {
              if (!y || (rep[y].modules || []).indexOf(m) < 0) {
                badFact.push(ds + ' [yday] 「' + t + '」← ' + m + ' 昨天没做过');
              }
            });
          } else if (k === 'ago' || k === 'last') {
            mentioned.forEach(function (m) {
              var last = null;
              prevOf[ds].slice().reverse().some(function (x) {
                if ((rep[x].modules || []).indexOf(m) >= 0) { last = x; return true; }
                return false;
              });
              var gap = last ? Math.round((Store.parse(ds) - Store.parse(last)) / 864e5) : null;
              if (gap === null || gap < 2) { badFact.push(ds + ' [' + k + '] 「' + t + '」← ' + m + ' 实际间隔 ' + gap); return; }
              var mm2 = /(\d+)天/.exec(t);
              if (mm2 && Number(mm2[1]) !== gap) badFact.push(ds + ' [' + k + '] 「' + t + '」← ' + m + ' 天数应为 ' + gap);
              var wd = /星期([一二三四五六日])/.exec(t);
              if (wd && last) {
                var real = '日一二三四五六'[Store.parse(last).getDay()];
                if (wd[1] !== real) badFact.push(ds + ' [' + k + '] 「' + t + '」← ' + m + ' 星期应为 ' + real);
              }
            });
          }
          /* 跨栏目数字一致：计划句说的「今天 N 项」必须与「今日完成」里同一模块的数字相同
           *（同一个 modToday 出来的，改错了这里会红） */
          if (k === 'n') {
            var mnum = /(\d+)\s*项/.exec(t);
            mentioned.forEach(function (m) {
              if (doneNum[m] === undefined || !mnum) return;
              crossChk++;
              if (doneNum[m] !== Number(mnum[1])) crossBad++;
            });
          }
          if (/\{\w+\}/.test(t) || /还剩\s|隔了\s|^\s*\d+项|完成\s*项|共\s*项|星期(?![一二三四五六日])/.test(t)) {
            residue.push(ds + ' 「' + t + '」');
          }
        });
      });
      if (plains > 1) twoPlain++;
      var seen = {};
      kinds.forEach(function (k) {
        if (seen[k]) { kindDup++; if (k !== 'plain') dupNonPlain++; }
        seen[k] = 1;
      });
    });
  });

  ok(tot > 0, '端到端样本 ' + jobs.length + ' 岗位 × 6 天 = ' + gen + ' 篇，计划句 ' + tot + ' 句');
  var anchoredRate = (tot - plain - unknown) / (tot || 1);
  ok(anchoredRate >= 0.75, '有事实挂靠的计划句占比 ' + pct(anchoredRate) + ' ≥ 75%（改动前 21%）');
  ok(badFact.length === 0, '计划句的事实与数据一致（0 处矛盾）', badFact.slice(0, 3).join(' | '));
  ok(residue.length === 0, '没有占位符残留（如「还剩 项」）', residue.slice(0, 3).join(' | '));
  ok(twoPlain / (days || 1) <= 0.15,
    '同篇两条都无锚点的天数占比 ' + pct(twoPlain / (days || 1)) + ' ≤ 15%'
    + '（' + twoPlain + '/' + days + ' 天）');
  ok(dupNonPlain / (days || 1) <= 0.05,
    '同篇锚点种类重复（非 plain）天数占比 ' + pct(dupNonPlain / (days || 1)) + ' ≤ 5%'
    + '（' + dupNonPlain + '/' + days + ' 天，共 ' + kindDup + ' 处重复）');
  ok(crossBad === 0 && crossChk > 0,
    '跨栏目数字一致：计划句的「今天 N 项」与「今日完成」相同模块一致（校验 ' + crossChk + ' 处）',
    '不一致 ' + crossBad + ' 处');
  ok(claimBad.length === 0,
    '独立判据：句子字面说「今天/昨天」时该模块当天确实做过（不依赖 planKind）',
    claimBad.slice(0, 3).join(' | '));
  /* ⑥ 每个锚点组的子周期 ≥ 20 天（M5 的口径）。
   * ⚠️ M5 只按整池算循环周期，分组之后可能错配：实测 plans/yday 组 9 条却承担 18%
   * 的计划句 → 子周期 20.1 天、模板复用间隔中位 19 天（低于 M2 的 20 天门槛，被整池掩盖）。 */
  var minCycle = Infinity, worstG = '';
  Object.keys(groupUse).forEach(function (g) {
    var cap = groupCap[g] || 0;
    if (!cap) return;
    var perDay = groupUse[g] / (days || 1);
    var cyc = perDay ? cap / perDay : Infinity;
    if (cyc < minCycle) { minCycle = cyc; worstG = g + '(' + cap + '条)'; }
  });
  ok(minCycle >= 20, '每个锚点组的子周期 ' + minCycle.toFixed(1) + ' 天 ≥ 20 天（最短 '
    + worstG + '；M5 只算整池，会掩盖分组错配）');
  console.log('  · 锚点分布：今天数字 ' + (tot - plain - unknown - 0) + ' 句中，无锚点 ' + plain
    + ' 句（' + pct(plain / (tot || 1)) + '），未匹配模板 ' + unknown + ' 句');
})();

/* ============================================================
 * 收尾
 * ============================================================ */
console.log('\n================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('================================');
process.exit(fail ? 1 : 0);
