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
var Phrases = ctx.window.Phrases, Generator = ctx.window.Generator, Composer = ctx.window.Composer;

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
section('M4 空信息句（不含岗位实体、换岗位也一模一样）字数占比');
(function () {
  var mods = corpus.config.modules.slice().sort(function (a, b) { return b.length - a.length; });
  var rates = [];
  corpus.order.forEach(function (d) {
    var tot = 0, empty = 0;
    corpus.reports[d].text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (s) {
      if (isHeader(s) || isSection(s) || s.length < 8) return;
      var body = s.replace(MARK_RE, '');
      tot += body.replace(/\s/g, '').length;
      var masked = s;
      mods.forEach(function (m) { masked = masked.split(m).join('«»'); });
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
    plans: 2, planTail: 0.5, fillers: 1
  };
  var worst = null;
  Object.keys(rate).forEach(function (k) {
    var size = (Phrases[k] || []).length;
    var cycle = size / rate[k];
    if (!worst || cycle < worst.cycle) worst = { name: k, size: size, cycle: cycle };
  });
  ok(worst.cycle >= 20, '最小循环周期 ' + worst.cycle.toFixed(1) + ' 天（' + worst.name + '，' + worst.size + ' 条）≥ 20 天');
  // 模块绑定池必须 100% 含 {module}，否则换岗位就是同一句话
  var bound = ['done', 'doneActivity', 'gains', 'problems', 'solutions', 'plans'];
  var noMod = [];
  bound.forEach(function (k) {
    (Phrases[k] || []).forEach(function (t) { if (t.indexOf('{module}') < 0) noMod.push(k + ':' + t.slice(0, 12)); });
  });
  ok(noMod.length === 0, '模块绑定池（done/doneActivity/gains/problems/solutions/plans）100% 含 {module}',
    noMod.length ? noMod.slice(0, 3).join(' / ') : '');
  ok((Phrases.skeletons || []).length >= 5, '版式骨架 ' + (Phrases.skeletons || []).length + ' 套 ≥ 5');
  ok((Composer.aggSkeletons || []).length >= 5, '聚合稿骨架 ' + (Composer.aggSkeletons || []).length + ' 套 ≥ 5');
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
    'noProblem', 'plans', 'planTail', 'fillers', 'openers', 'openersMon', 'openersFri'];
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
      var t = c.reports[d].text, m;
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
 * 收尾
 * ============================================================ */
console.log('\n================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('================================');
process.exit(fail ? 1 : 0);
