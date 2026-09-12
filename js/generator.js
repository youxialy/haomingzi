/* ============================================================
 * generator.js — 日报生成引擎
 * 纯函数实现（不依赖 DOM / Store），方便独立校验。
 * 策略：
 *   1. 模块轮换：排除昨日模块 + 按使用次数升序取「最不常用池」随机抽
 *   2. 句式变体：同一日期用日期做种子（可复现），重试时换盐值
 *   3. 字数保障：不足下限时追加不重复的补充句
 *   4. 防雷同：与最近 3 篇做二元组重叠度检查，超阈值自动重抽
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
  function int(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }
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

    var vars = { weekday: weekday, dayN: dayN, n: 0 };
    var head = [];
    var headExtra = [config.company, config.jobTitle].filter(Boolean).join(' · ');
    head.push('【实习日报】' + dateStr + ' ' + weekday + (headExtra ? '（' + headExtra + '）' : ''));
    head.push('');

    var opener;
    if (dow === 1 && Phrases.openersMon.length && rng() < 0.6) opener = choice(rng, Phrases.openersMon);
    else if (dow === 5 && Phrases.openersFri.length && rng() < 0.6) opener = choice(rng, Phrases.openersFri);
    else opener = choice(rng, Phrases.openers);
    head.push(fill(opener, vars));

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
          var tpl = isActivity ? pickTpl(rng, Phrases.doneActivity, m) : pickTpl(rng, Phrases.done, m);
          vars.n = int(rng, 4, 18);
          doneLines.push((i + 1) + '. ' + fill(tpl, Object.assign({ module: m }, vars)));
        });
        if (extra && extra.trim()) {
          doneLines.push((mods.length + 1) + '. ' + extra.trim().replace(/。$/, '') + '。');
        }
        emit(title, doneLines);
      } else if (sec.key === 'gains') {
        var gl = [fill(pickTpl(rng, Phrases.gains, mods[0]), { module: mods[0] })];
        if (rng() < 0.6) gl.push(choice(rng, Phrases.gainsTail));
        emit(title, gl);
      } else if (sec.key === 'problems') {
        var pl = [];
        if (rng() < 0.65) {
          var pm = choice(rng, mods);
          problem = fill(pickTpl(rng, Phrases.problems, pm), { module: pm });
          pl.push(problem);
          pl.push(choice(rng, Phrases.solutions));
        } else {
          pl.push(choice(rng, Phrases.noProblem));
        }
        emit(title, pl);
      } else if (sec.key === 'plans') {
        var pp = planMods.map(function (m, i) {
          return (i + 1) + '. ' + fill(pickTpl(rng, Phrases.plans, m), { module: m });
        });
        if (rng() < 0.5) pp.push(choice(rng, Phrases.planTail));
        emit(title, pp);
      }
    });

    var text = lines.join('\n');

    // 字数保障：不足下限时追加不重复的补充句
    var min = config.minWords || 0;
    var used = {};
    var guard = 0;
    while (charCount(text) < min && guard < 16) {
      var avail = Phrases.fillers.filter(function (f) { return !used[f]; });
      if (!avail.length) break;
      var s = choice(rng, avail);
      used[s] = 1;
      text += '\n' + s;
      guard++;
    }

    return {
      date: dateStr,
      text: text,
      modules: mods,
      extra: extra ? extra.trim() : '',
      problem: problem
    };
  }

  /* ---------- 对外入口：带防雷同重试；opts.saltBase 用于「换一版」 ---------- */
  var SIM_THRESHOLD = 0.55;
  function generateDaily(dateStr, config, reports, stats, extra, opts) {
    if (!config || !config.modules || !config.modules.length) return null;
    var base = (opts && opts.saltBase) || 0;
    var prev = lastNDates(reports, dateStr, 3).map(function (d) { return reports[d].text || ''; });
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
