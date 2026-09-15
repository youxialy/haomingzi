/* ============================================================
 * generator.js — 日报生成引擎
 * 纯函数实现（不依赖 DOM / Store），方便独立校验。
 * 策略：
 *   1. 模块轮换：排除昨日模块 + 按使用次数升序取「最不常用池」随机抽
 *   2. 句式变体：同一日期用日期做种子（可复现），重试时换盐值
 *   3. 跨天防重：模板级避开最近 6 天用过的句式；句子级与最近 3 天
 *      的正文逐句比对，相似即换——「换一版 / 重新生成」同样避开当天旧稿
 *   4. 叠词防护：模块首词（如「参加晨会」）与句式动词撞车时整条跳过
 *   5. 字数保障：不足下限时追加不重复的补充句
 *   6. 防雷同兜底：与最近 3 篇做整篇二元组重叠度检查，超阈值自动重抽
 * ============================================================ */
(function () {

  /* ---------- 默认栏目结构（可被 config.sections 覆盖：改名 / 关闭） ---------- */
  var DEFAULT_SECTIONS = [
    { key: 'done', title: '今日完成', on: true },
    { key: 'gains', title: '收获与学习', on: true },
    { key: 'problems', title: '遇到的问题与解决', on: true },
    { key: 'plans', title: '明日计划', on: true }
  ];
  function defaultSections() {
    return JSON.parse(JSON.stringify(DEFAULT_SECTIONS));
  }

  /* ---------- 随机数（种子化，可复现） ---------- */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rngFor(dateStr, salt) { return mulberry32(hashStr(dateStr + '#' + salt)); }
  function choice(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function pickN(rng, arr, n) {
    var c = arr.slice(), out = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(rng() * c.length), 1)[0]);
    return out;
  }

  /* ---------- 相似度：字符二元组的重叠系数 ---------- */
  function bigrams(t) {
    var s = [], x = (t || '').replace(/\s/g, '');
    for (var i = 0; i < x.length - 1; i++) s.push(x.substr(i, 2));
    return s;
  }
  function similarity(a, b) {
    var A = bigrams(a), B = bigrams(b);
    if (!A.length || !B.length) return 0;
    var setB = {}; B.forEach(function (g) { setB[g] = 1; });
    var inter = 0; A.forEach(function (g) { if (setB[g]) inter++; });
    return inter / Math.min(A.length, B.length);
  }

  function charCount(t) { return (t || '').replace(/\s/g, '').length; }

  function fill(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, function (m, k) {
      return (vars[k] !== undefined && vars[k] !== null && vars[k] !== '') ? String(vars[k]) : '';
    });
  }

  // 模板动词与模块名撞车时排除该模板（如模块「处理售后退换工单」× 模板「处理{module}…」→「处理处理…」）
  function pickTpl(rng, arr, mod) {
    var head = (mod || '').slice(0, 2);
    var ok = arr.filter(function (t) { return t.slice(0, 2) !== head; });
    return choice(rng, ok.length ? ok : arr);
  }

  /* ---------- 跨天防重 ---------- */
  var TPL_WINDOW = 6;   // 模板级：避开最近 6 天用过的句式
  var LINE_WINDOW = 3;  // 句子级：与最近 3 天的正文逐句比对
  var LINE_SIM = 0.8;   // 单句相似度阈值

  // 从一篇报告正文里提取「内容句」（去掉抬头/栏目标题/序号）
  function contentLines(text) {
    return (text || '').split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) {
        return s.length >= 8 && s.charAt(0) !== '【' && !/^[一二三四五六七八九十]、/.test(s);
      })
      .map(function (s) { return s.replace(/^\d+\.\s*/, ''); });
  }

  function maxSim(line, lines) {
    var worst = 0;
    for (var i = 0; i < lines.length; i++) {
      var s = similarity(line, lines[i]);
      if (s > worst) worst = s;
      if (worst >= LINE_SIM) break;
    }
    return worst;
  }

  // 汇总「近期用过的模板」与「近期正文句子」；同一天已有存稿（重新生成/换一版）一并计入
  function historyFor(dateStr, reports) {
    var tpls = {}, lines = [], i, j;
    var tDates = lastNDates(reports, dateStr, TPL_WINDOW);
    for (i = 0; i < tDates.length; i++) {
      var t = reports[tDates[i]].tpls || [];
      for (j = 0; j < t.length; j++) tpls[t[j]] = 1;
    }
    var lDates = lastNDates(reports, dateStr, LINE_WINDOW);
    for (i = 0; i < lDates.length; i++) {
      lines = lines.concat(contentLines(reports[lDates[i]].text));
    }
    var today = reports[dateStr];
    if (today) {
      var tt = today.tpls || [];
      for (j = 0; j < tt.length; j++) tpls[tt[j]] = 1;
      lines = lines.concat(contentLines(today.text));
    }
    return { tpls: tpls, lines: lines };
  }

  /* 选一条既避开近期模板、又与近期句子不雷同的表达；返回 { tpl, line }
   * 产出的句子会记入 hist.lines，保证同一篇内各栏目也互不雷同 */
  function takeFresh(rng, arr, mod, vars, hist) {
    var pk = pickFresh(rng, arr, mod, vars, hist);
    if (pk.tpl) hist.tpls[pk.tpl] = 1;   // 本篇内也不复用同一模板
    if (pk.line) hist.lines.push(pk.line);
    return pk;
  }

  /* 选一条避开近期模板/近期句子的表达（内部原语）；返回 { tpl, line } */
  function pickFresh(rng, arr, mod, vars, hist) {
    if (!arr || !arr.length) return { tpl: '', line: '' };
    var head = (mod || '').slice(0, 2);
    var dd = head + head; // 「参加」×「参加晨会」→「参加参加」这类叠词直接跳过
    var pool = arr.filter(function (t) { return !hist.tpls[t] && t.slice(0, 2) !== head; });
    if (pool.length < 2) pool = arr.filter(function (t) { return t.slice(0, 2) !== head; });
    if (!pool.length) pool = arr.slice();
    var order = pickN(rng, pool, pool.length);
    var best = null, bestS = Infinity;
    for (var i = 0; i < order.length; i++) {
      var line = fill(order[i], vars);
      if (dd && line.indexOf(dd) >= 0) continue;
      var s = maxSim(line, hist.lines);
      if (s < bestS) { bestS = s; best = { tpl: order[i], line: line }; }
      if (bestS < LINE_SIM) break;
    }
    return best || { tpl: arr[0], line: fill(arr[0], vars) };
  }

  // 单日事务量：围绕配置的「日均事务量」上下浮动 ±40%，避免相邻两天 4↔18 的突兀跳跃
  function dailyN(rng, config) {
    var base = Number(config && config.dailyLoad) > 0 ? Number(config.dailyLoad) : 10;
    var n = Math.round(base * (0.6 + rng() * 0.8));
    return Math.max(2, Math.min(99, n));
  }

  /* ---------- 模块轮换 ---------- */
  function pickModules(modules, stats, yesterdayMods, rng) {
    var take = modules.length >= 5 ? 3 : (modules.length >= 3 ? 2 : Math.max(1, modules.length));
    var pool = modules.filter(function (m) { return yesterdayMods.indexOf(m) < 0; });
    if (pool.length < take) pool = modules.slice(); // 模块太少时允许与昨日重叠
    // 使用次数少的优先进入候选池（保证周期内全覆盖）
    pool.sort(function (a, b) {
      return ((stats[a] ? stats[a].count : 0) - (stats[b] ? stats[b].count : 0));
    });
    var head = pool.slice(0, Math.max(take, Math.ceil(pool.length * 0.7)));
    return pickN(rng, head, Math.min(take, head.length));
  }

  function lastNDates(reports, dateStr, n) {
    return Object.keys(reports)
      .filter(function (d) { return d < dateStr; })
      .sort()
      .slice(-n);
  }

  /* ---------- 组装单日日报 ---------- */
  function buildDaily(dateStr, config, reports, stats, salt, extra) {
    var rng = rngFor(dateStr, salt);
    var d = Store.parse(dateStr);
    var dow = d.getDay();
    var weekday = '星期' + '日一二三四五六'[dow];
    var dayN = config.startDate
      ? Math.max(1, Math.round((d - Store.parse(config.startDate)) / 864e5) + 1)
      : null;

    var prevDates = lastNDates(reports, dateStr, 1);
    var yesterdayMods = prevDates.length ? (reports[prevDates[0]].modules || []) : [];

    var mods = pickModules(config.modules, stats, yesterdayMods, rng);

    // 明日计划模块：全局最不常用的优先
    var planPool = config.modules.slice().sort(function (a, b) {
      return ((stats[a] ? stats[a].count : 0) - (stats[b] ? stats[b].count : 0));
    });
    var planMods = pickN(rng, planPool, Math.min(2, planPool.length));

    var hist = historyFor(dateStr, reports);
    var usedTpls = [];

    var vars = { weekday: weekday, dayN: dayN, n: 0 };
    var head = [];
    var headExtra = [config.company, config.jobTitle].filter(Boolean).join(' · ');
    head.push('【实习日报】' + dateStr + ' ' + weekday + (headExtra ? '（' + headExtra + '）' : ''));
    head.push('');

    // 开头：周一/周五优先用对应池，同样避开近期用过的
    var openerPool = Phrases.openers;
    if (dow === 1 && Phrases.openersMon.length && rng() < 0.6) openerPool = Phrases.openersMon;
    else if (dow === 5 && Phrases.openersFri.length && rng() < 0.6) openerPool = Phrases.openersFri;
    var op = takeFresh(rng, openerPool, '', vars, hist);
    usedTpls.push(op.tpl);
    head.push(op.line);

    // 栏目驱动成文：按 config.sections 的顺序/标题/开关输出，「今日完成」强制保留
    var sections = (config.sections && config.sections.length) ? config.sections : defaultSections();
    var cn = ['一', '二', '三', '四', '五', '六'];
    var lines = head;
    var secNo = 0;
    var problem = null;

    function emit(title, contentLines) {
      lines = lines.concat(['', cn[secNo] + '、' + title]).concat(contentLines);
      secNo++;
    }

    sections.forEach(function (sec) {
      if (!sec.on && sec.key !== 'done') return;
      var fallbackTitle = { done: '今日完成', gains: '收获与学习', problems: '遇到的问题与解决', plans: '明日计划' }[sec.key];
      var title = (sec.title || '').trim() || fallbackTitle;

      if (sec.key === 'done') {
        // 活动型模块用不带数量的句式，避免「参加晨会…15项」这类别扭表达
        var doneLines = [];
        mods.forEach(function (m, i) {
          var isActivity = /^(参加|学习|复盘|晨间)/.test(m);
          vars.n = dailyN(rng, config);
          var pk = takeFresh(rng, isActivity ? Phrases.doneActivity : Phrases.done, m,
            Object.assign({ module: m }, vars), hist);
          usedTpls.push(pk.tpl);
          doneLines.push((i + 1) + '. ' + pk.line);
        });
        if (extra && extra.trim()) {
          doneLines.push((mods.length + 1) + '. ' + extra.trim().replace(/。$/, '') + '。');
        }
        emit(title, doneLines);
      } else if (sec.key === 'gains') {
        var gm = choice(rng, mods) || mods[0];
        var g = takeFresh(rng, Phrases.gains, gm, { module: gm }, hist);
        usedTpls.push(g.tpl);
        var gl = [g.line];
        if (rng() < 0.6) {
          var gt = takeFresh(rng, Phrases.gainsTail, '', {}, hist);
          usedTpls.push(gt.tpl);
          gl.push(gt.line);
        }
        emit(title, gl);
      } else if (sec.key === 'problems') {
        var pl = [];
        if (rng() < 0.65) {
          var pm = choice(rng, mods);
          var pr = takeFresh(rng, Phrases.problems, pm, { module: pm }, hist);
          usedTpls.push(pr.tpl);
          problem = pr.line;
          pl.push(problem);
          var so = takeFresh(rng, Phrases.solutions, '', {}, hist);
          usedTpls.push(so.tpl);
          pl.push(so.line);
        } else {
          var np = takeFresh(rng, Phrases.noProblem, '', {}, hist);
          usedTpls.push(np.tpl);
          pl.push(np.line);
        }
        emit(title, pl);
      } else if (sec.key === 'plans') {
        var pp = planMods.map(function (m, i) {
          var pk2 = takeFresh(rng, Phrases.plans, m, { module: m }, hist);
          usedTpls.push(pk2.tpl);
          return (i + 1) + '. ' + pk2.line;
        });
        if (rng() < 0.5) {
          var pt = takeFresh(rng, Phrases.planTail, '', {}, hist);
          usedTpls.push(pt.tpl);
          pp.push(pt.line);
        }
        emit(title, pp);
      }
    });

    var text = lines.join('\n');

    // 字数保障：不足下限时追加不重复的补充句
    var min = config.minWords || 0;
    var used = {};
    var guard = 0;
    while (charCount(text) < min && guard < 16) {
      var avail = Phrases.fillers.filter(function (f) {
        return !used[f] && !hist.tpls[f] && maxSim(f, hist.lines) < LINE_SIM;
      });
      if (!avail.length) avail = Phrases.fillers.filter(function (f) { return !used[f]; });
      if (!avail.length) break;
      var s = choice(rng, avail);
      used[s] = 1;
      usedTpls.push(s);
      text += '\n' + s;
      guard++;
    }

    return {
      date: dateStr,
      text: text,
      modules: mods,
      extra: extra ? extra.trim() : '',
      problem: problem,
      tpls: usedTpls
    };
  }

  /* ---------- 对外入口：带防雷同重试；opts.saltBase 用于「换一版」 ---------- */
  var SIM_THRESHOLD = 0.55;
  function generateDaily(dateStr, config, reports, stats, extra, opts) {
    if (!config || !config.modules || !config.modules.length) return null;
    var base = (opts && opts.saltBase) || 0;
    var prev = lastNDates(reports, dateStr, 3).map(function (d) { return reports[d].text || ''; });
    var today = reports[dateStr] && reports[dateStr].text ? [reports[dateStr].text] : [];
    prev = prev.concat(today); // 换一版时连当天旧稿一起比对
    var best = null, bestScore = Infinity;
    for (var salt = base; salt < base + 10; salt++) {
      var r = buildDaily(dateStr, config, reports, stats, salt, extra);
      var maxSim = 0;
      prev.forEach(function (t) {
        var s = similarity(r.text, t);
        if (s > maxSim) maxSim = s;
      });
      if (maxSim < SIM_THRESHOLD) return r;
      if (maxSim < bestScore) { bestScore = maxSim; best = r; }
    }
    return best; // 重试后仍偏高就返回重叠度最低的一版
  }

  window.Generator = {
    generateDaily: generateDaily,
    buildDaily: buildDaily,
    similarity: similarity,
    charCount: charCount,
    pickModules: pickModules,
    defaultSections: defaultSections
  };
})();
