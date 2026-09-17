/* ============================================================
 * generator.js — 日报生成引擎
 * 纯函数实现（不依赖 DOM / Store 以外的东西），方便独立校验。
 *
 * P0 改造后的策略（旧版是「最近 6 天不重复」，见下方 ★ 说明）：
 *   1. 模块轮换：排除昨日模块 + 按使用次数升序取「最不常用池」随机抽
 *   2. 句式变体：同一日期用日期做种子（可复现），重试时换盐值
 *   3. 全周期使用台账（★ 核心改动）：把历史上每一篇用过的模板、以及每一篇
 *      用过的版式骨架，连同它们的「最近使用日期」建成台账。选句时先按
 *      「距上次使用 ≥ 21 天」分级筛选，再从最久未用的那一档里随机挑。
 *      —— 旧实现只看最近 6 天，而句子池的循环周期比 6 天还短，
 *         所以「7 天前那篇」从数学上就不可能被避开。
 *   4. 句子级近邻防重：与最近 7 天的正文逐句比对，相似度超阈值即换。
 *   5. 版式骨架：6 套（抬头形态 / 编号体系 / 条目符号 / 段落组织 / 结尾），
 *      同样走台账轮换，保证相邻几天的报告结构不雷同。
 *   6. 病句防护：模板动词与模块首词撞车（「按时进行参加晨会」）整条跳过。
 *   7. 字数保障 + 整篇防雷同兜底（与最近 7 天逐篇比对，超阈值换盐重抽）。
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

  /* ------------------------------------------------------------
   * 配置指纹：随机流必须「因岗位而异」，不能只由日期决定。
   *
   * 旧实现 rngFor(date, salt) 与配置完全无关 → **同一天生成任何两个岗位，
   * 拿到的是同一条随机序列**：同一套骨架、同一批池内下标、同一批
   * 「不含模块名」的句子（开头语 / 今日无异常 / 计划收尾 / 补充说明）。
   * 实测同一天 28 个岗位两两之间平均 3 行逐字相同——同一个班的同学
   * 各自交日报，抬头不同、正文却有整段一模一样，查重必命中。
   *
   * 把配置指纹混进种子后，同配置同日期仍然完全可复现（"换一版"仍用 salt），
   * 不同岗位/不同公司/不同模块组合则各自走不同的随机流。
   * ------------------------------------------------------------ */
  var CFG_KEY_CACHE = {};
  function cfgKey(config) {
    if (!config) return '0';
    var sig = [
      config.jobType || '',
      config.company || '',
      config.jobTitle || '',
      (config.modules || []).join('|'),
      ((config.sections || []).map(function (s) { return (s && s.key) + ':' + ((s && s.title) || ''); })).join('/')
    ].join('§');
    if (CFG_KEY_CACHE[sig] === undefined) CFG_KEY_CACHE[sig] = hashStr(sig);
    return CFG_KEY_CACHE[sig];
  }

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

  /* ============================================================
   * 版式骨架
   * ============================================================ */
  var CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八'];
  var CIRCLE = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  function secPrefix(style, i) {
    var c = CN_NUM[i] || String(i + 1);
    if (style === 'cnParen') return '（' + c + '）';
    if (style === 'cnBracket') return '【' + c + '】';
    if (style === 'cnClose') return c + '）';
    return c + '、';
  }
  function skeletonList() {
    return (Phrases && Phrases.skeletons && Phrases.skeletons.length) ? Phrases.skeletons : null;
  }
  function fallbackSkeleton() {
    return {
      id: 'sk1', header: '【实习日报】{date} {weekday}{ext}', secStyle: 'cn', item: '{i}. ',
      problemsStyle: 'lines', gainsTail: true, plansJoin: false, closer: ''
    };
  }
  function itemPrefix(sk, i) {
    var t = (sk && sk.item) ? sk.item : '{i}. ';
    var out = fill(t, { i: i + 1, circ: CIRCLE[i] || '' });
    if (!out || !out.replace(/\s/g, '')) out = (i + 1) + '. ';
    return out;
  }

  /* 从正文反推用了哪套骨架（旧数据没有 '@skN' 标记时兜底用） */
  var SKEL_DETECT = [
    { id: 'sk2', re: /^实习日报｜/ },
    { id: 'sk6', re: /^实习日报\s*·/ },
    { id: 'sk3', re: /^【日报】/ },
    { id: 'sk5', re: /^【实习日报】\S+\s*（星期[日一二三四五六]）/ },
    { id: 'sk1', re: /^【实习日报】/ },
    { id: 'sk4', re: /^\d{4}-\d{2}-\d{2}\s+星期[日一二三四五六]/ }
  ];
  function detectSkeleton(text) {
    var first = (text || '').split('\n')[0].trim();
    var list = skeletonList() || [];
    for (var i = 0; i < SKEL_DETECT.length; i++) {
      var id = SKEL_DETECT[i].id;
      if (!SKEL_DETECT[i].re.test(first)) continue;
      for (var j = 0; j < list.length; j++) if (list[j].id === id) return list[j];
      return null;
    }
    return null;
  }

  /* ============================================================
   * 正文/结构行识别（要同时吃下 6 套骨架）
   * 判据：以【或「实习日报/日报」开头 = 抬头；
   *       以章节编号开头 且 不含句末标点 且 去空格后 ≤16 字 = 栏目标题。
   * 内容句几乎都以「。」收尾，所以这条判据在任意编号体系下都不会误伤。
   * ============================================================ */
  var SEC_NUM_RE = /^(【[一二三四五六七八九十]】|（[一二三四五六七八九十]）|[一二三四五六七八九十][、.）)])/;
  var ITEM_MARK_RE = /^([・·•◆●○\-–—]|\d+[.、)）]|（\d+）|\(\d+\)|[①②③④⑤⑥⑦⑧⑨⑩])\s*/;

  function isHeaderLine(s) {
    return s.charAt(0) === '【'
      || /^(实习日报|日报|实习周报|实习月报)/.test(s)
      || /^\d{4}-\d{2}-\d{2}\s+星期[日一二三四五六]/.test(s);   // sk4 的「日期 星期 · 实习日报」抬头
  }
  function isSectionLine(s) {
    if (isHeaderLine(s)) return false;
    if (!SEC_NUM_RE.test(s)) return false;
    return s.replace(/\s/g, '').length <= 16 && !/[。！？；]/.test(s);
  }
  function stripItemMark(s) { return s.replace(ITEM_MARK_RE, ''); }

  // 从一篇报告正文里提取「内容句」（去掉抬头/栏目标题/条目符号）
  function contentLines(text) {
    return (text || '').split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 8 && !isHeaderLine(s) && !isSectionLine(s); })
      .map(stripItemMark);
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

  /* ============================================================
   * 全周期使用台账
   * ============================================================ */
  var AGE_NEVER = 9999;
  var LINE_WINDOW = 7;    // 句子级：与最近 7 天的正文逐句比对
  var LINE_SIM = 0.8;     // 单句相似度阈值
  var HARD_DAYS = 21;     // 模板级硬窗口：优先只用「距上次 ≥21 天」的句式
  var TIERS = [HARD_DAYS, 14, 7, 3, 0];  // 逐级放宽，保证池子小的时候也能出句
  // 通用动词紧跟模块首词会生成病句（「按时进行参加晨会」「完成处理售后退换工单」）。
  // 注意：**不能对填充后的整行做这个判断**——模块名自身就可能含两个动词
  // （「工位5S整理维护」「会员信息登记维护」），整行判断会把这类模块的全部句式都误杀。
  // 所以只在「模板内部」与「占位符接缝」两处判定：见 badJoin()。
  var BAD_PAIR = /(进行|完成|做好|落实|开展|参与|安排|承接|推进|执行|处理|整理|记录|登记|维护|参加|学习|复盘)(参加|学习|复盘|处理|整理|登记|记录|维护)/;
  var LEFT_VERB = /^(进行|完成|做好|落实|开展|参与|安排|承接|推进|执行|处理|整理|记录|登记|维护|参加|学习|复盘)$/;
  var HEAD_VERB = /^(参加|学习|复盘|处理|整理|登记|记录|维护)$/;
  var SKEL_KEY = '@';     // 骨架在 tpls 里以 '@sk3' 形式记录，无需改存储格式

  /**
   * 判定「模板 × 模块」这一组合会不会生成病句。
   * @param {string} tpl 未填充的模板（可含 {module}）
   * @param {string} mod 模块名
   */
  function badJoin(tpl, mod) {
    if (!tpl) return false;
    if (BAD_PAIR.test(tpl)) return true;          // 模板自身就写错了
    if (!mod) return false;
    var mh = mod.slice(0, 2);
    if (tpl.slice(0, 2) === mh) return true;      // 「处理{module}」×「处理售后…」→ 处理处理
    var i = tpl.indexOf('{module}');
    if (i < 0) return false;
    var left = tpl.slice(0, i).slice(-2);         // 紧挨占位符左边的两个字
    if (LEFT_VERB.test(left) && (HEAD_VERB.test(mh) || left === mh)) return true;
    return false;
  }

  /**
   * 扫全部历史报告，建「模板 -> 最近使用日期」与「骨架 -> 最近使用日期」台账。
   * TPL_KEY 说明：报告里的 tpls 数组同时存句式与骨架（'@sk1'），一次扫完。
   * @param {object} reports date -> record
   * @param {string} curDate 当前生成的日期（该天旧稿不计入台账，改为计入「今日已用」）
   */
  function makeLedger(reports, curDate) {
    var tpl = {}, skel = {};
    var keys = Object.keys(reports);
    for (var i = 0; i < keys.length; i++) {
      var d = keys[i];
      if (d === curDate) continue;
      var rec = reports[d] || {};
      var ts = rec.tpls || [];
      for (var j = 0; j < ts.length; j++) {
        var k = String(ts[j]);
        if (!k) continue;
        if (k.charAt(0) === SKEL_KEY) {
          if (!skel[k] || d > skel[k]) skel[k] = d;
        } else if (!tpl[k] || d > tpl[k]) {
          tpl[k] = d;
        }
      }
    }
    return { tpl: tpl, skel: skel };
  }

  function dayMs(d) { return Store.parse(d).getTime(); }

  /**
   * 构造本次生成的「上下文」：台账 + 近 7 天正文句子 + 本篇已用集合。
   * age(tpl) 返回距上次使用的天数（从未用过返回 AGE_NEVER）。
   */
  function makeHist(dateStr, reports, ledger) {
    var msCache = {};
    function msOf(d) {
      if (msCache[d] === undefined) msCache[d] = dayMs(d);
      return msCache[d];
    }
    var curMs = msOf(dateStr);
    var lines = [];
    var lDates = lastNDates(reports, dateStr, LINE_WINDOW);
    for (var i = 0; i < lDates.length; i++) {
      lines = lines.concat(contentLines((reports[lDates[i]] || {}).text));
    }
    var todayUsed = {};
    var todaySkeleton = null;
    var today = reports[dateStr];
    if (today) {
      lines = lines.concat(contentLines(today.text));
      var tt = today.tpls || [];
      for (var j = 0; j < tt.length; j++) {
        var k = String(tt[j]);
        if (!k) continue;
        if (k.charAt(0) === SKEL_KEY) todaySkeleton = k.slice(1);
        else todayUsed[k] = 1;
      }
      // 兼容旧数据：本次改造之前生成的报告没有 '@skN' 标记，用正文反推一次
      if (!todaySkeleton && today.text) {
        var old = detectSkeleton(today.text);
        if (old) todaySkeleton = old.id;
      }
    }
    // 句子级比对的对象太多会拖慢生成，只保留最近的 140 句
    if (lines.length > 140) lines = lines.slice(lines.length - 140);
    return {
      date: dateStr,
      today: todayUsed,
      lines: lines,
      todaySkeleton: todaySkeleton,
      age: function (t) {
        var l = ledger.tpl[t];
        if (!l) return AGE_NEVER;
        return Math.round((curMs - msOf(l)) / 864e5);
      },
      skelAge: function (id) {
        var l = ledger.skel[SKEL_KEY + id];
        if (!l) return AGE_NEVER;
        return Math.round((curMs - msOf(l)) / 864e5);
      }
    };
  }

  /* 从池子里筛出候选：先排「本篇已用 / 模块首词撞车」，再按硬窗口分级 */
  function candidatePool(arr, mod, hist) {
    var head = (mod || '').slice(0, 2);
    function noClash(t) { return !head || t.slice(0, 2) !== head; }
    var base = arr.filter(function (t) { return !hist.today[t] && noClash(t); });
    if (!base.length) base = arr.filter(noClash);
    if (!base.length) base = arr.slice();
    for (var i = 0; i < TIERS.length; i++) {
      var e = base.filter(function (t) { return hist.age(t) >= TIERS[i]; });
      if (e.length >= 2) return e;
    }
    return base;
  }

  /* 选一条既避开近期模板、又与近期句子不雷同的表达；返回 { tpl, line }
   * 产出的句子会记入 hist.lines，保证同一篇内各栏目也互不雷同 */
  function takeFresh(rng, arr, mod, vars, hist) {
    var pk = pickFresh(rng, arr, mod, vars, hist);
    if (pk.tpl) hist.today[pk.tpl] = 1;   // 本篇内也不复用同一模板
    if (pk.line) hist.lines.push(pk.line);
    return pk;
  }

  /* 选一条表达（内部原语）：在「最久未用」的前 45% 里随机挑，
   * 再取与近 7 天句子最不相似的一条 */
  function pickFresh(rng, arr, mod, vars, hist) {
    if (!arr || !arr.length) return { tpl: '', line: '' };
    var pool = candidatePool(arr, mod, hist);
    pool = pool.slice().sort(function (a, b) { return hist.age(b) - hist.age(a); });
    var headN = Math.max(1, Math.ceil(pool.length * 0.45));
    var order = pickN(rng, pool.slice(0, headN), headN);
    var best = null, bestS = Infinity;
    for (var i = 0; i < order.length; i++) {
      if (badJoin(order[i], mod)) continue;
      var line = fill(order[i], vars);
      var s = maxSim(line, hist.lines);
      if (s < bestS) { bestS = s; best = { tpl: order[i], line: line }; }
      if (bestS < LINE_SIM) break;
    }
    if (best) return best;
    // 候选全被判为病句/近邻时，退回到「最久未用且不成病句」的第一条
    for (var j = 0; j < order.length; j++) {
      if (!badJoin(order[j], mod)) return { tpl: order[j], line: fill(order[j], vars) };
    }
    return { tpl: pool[0], line: fill(pool[0], vars) };
  }

  /* 骨架轮换：取「最久未用」的一档，同档内随机（等价于 6 天一轮的轮转） */
  function pickSkeleton(rng, hist) {
    var list = skeletonList();
    if (!list) return fallbackSkeleton();
    var cand = list.filter(function (s) { return s.id !== hist.todaySkeleton; });
    if (!cand.length) cand = list;
    var scored = cand.map(function (s) { return { s: s, age: hist.skelAge(s.id) }; });
    var maxAge = Math.max.apply(null, scored.map(function (x) { return x.age; }));
    var top = scored.filter(function (x) { return x.age === maxAge; }).map(function (x) { return x.s; });
    return choice(rng, top);
  }

  // 单日事务量：围绕配置的「日均事务量」上下浮动 ±40%
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
  function buildDaily(dateStr, config, reports, stats, salt, extra, ledger) {
    var rng = rngFor(dateStr, salt + '|' + cfgKey(config));
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

    var hist = makeHist(dateStr, reports, ledger || makeLedger(reports, dateStr));
    var sk = pickSkeleton(rng, hist);
    var usedTpls = [SKEL_KEY + sk.id];

    var vars = { weekday: weekday, dayN: dayN, n: 0, module: mods[0] || '' };
    var headExtra = [config.company, config.jobTitle].filter(Boolean).join(' · ');
    var lines = [];
    lines.push(fill(sk.header, {
      date: dateStr,
      weekday: weekday,
      dayPart: dayN ? ('第' + dayN + '天 · ') : '',
      ext: headExtra ? '（' + headExtra + '）' : ''
    }));
    lines.push('');

    // 开头：周一/周五优先用对应池，同样走台账挑最久未用的
    var openerPool = Phrases.openers;
    if (dow === 1 && Phrases.openersMon.length && rng() < 0.6) openerPool = Phrases.openersMon;
    else if (dow === 5 && Phrases.openersFri.length && rng() < 0.6) openerPool = Phrases.openersFri;
    var op = takeFresh(rng, openerPool, '', vars, hist);
    usedTpls.push(op.tpl);
    lines.push(op.line);

    // 栏目驱动成文：按 config.sections 的顺序/标题/开关输出，「今日完成」强制保留
    var sections = (config.sections && config.sections.length) ? config.sections : defaultSections();
    var secNo = 0;
    var problem = null;

    function emit(title, body) {
      lines.push('');
      lines.push(secPrefix(sk.secStyle, secNo) + title);
      for (var i = 0; i < body.length; i++) lines.push(body[i]);
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
            { module: m, n: vars.n, weekday: weekday, dayN: dayN }, hist);
          usedTpls.push(pk.tpl);
          doneLines.push(itemPrefix(sk, i) + pk.line);
        });
        if (extra && extra.trim()) {
          doneLines.push(itemPrefix(sk, mods.length) + extra.trim().replace(/。$/, '') + '。');
        }
        emit(title, doneLines);

      } else if (sec.key === 'gains') {
        var gm = choice(rng, mods) || mods[0];
        var g = takeFresh(rng, Phrases.gains, gm, { module: gm }, hist);
        usedTpls.push(g.tpl);
        var gl = [g.line];
        if (sk.gainsTail !== false && rng() < 0.6) {
          var gt = takeFresh(rng, Phrases.gainsTail, gm, { module: gm }, hist);
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
          var so = takeFresh(rng, Phrases.solutions, pm, { module: pm }, hist);
          usedTpls.push(so.tpl);
          if (sk.problemsStyle === 'joined') {
            pl.push(pr.line + so.line);
          } else if (sk.problemsStyle === 'itemed') {
            pl.push(itemPrefix(sk, 0) + pr.line);
            pl.push(itemPrefix(sk, 1) + so.line);
          } else {
            pl.push(pr.line);
            pl.push(so.line);
          }
        } else {
          var nm = choice(rng, mods) || mods[0];
          var np = takeFresh(rng, Phrases.noProblem, nm, { module: nm }, hist);
          usedTpls.push(np.tpl);
          pl.push(sk.problemsStyle === 'itemed' ? (itemPrefix(sk, 0) + np.line) : np.line);
        }
        emit(title, pl);

      } else if (sec.key === 'plans') {
        var pp = [];
        if (sk.plansJoin) {
          var parts = planMods.map(function (m) {
            var pk2 = takeFresh(rng, Phrases.plans, m, { module: m }, hist);
            usedTpls.push(pk2.tpl);
            return pk2.line.replace(/。\s*$/, '');
          });
          pp.push(parts.join('；') + '。');
        } else {
          planMods.forEach(function (m, i) {
            var pk3 = takeFresh(rng, Phrases.plans, m, { module: m }, hist);
            usedTpls.push(pk3.tpl);
            pp.push(itemPrefix(sk, i) + pk3.line);
          });
        }
        if (rng() < 0.5) {
          var tm = planMods[0] || mods[0] || '';
          var pt = takeFresh(rng, Phrases.planTail, tm, { module: tm }, hist);
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
      var fm = choice(rng, mods) || mods[0] || '';
      var avail = Phrases.fillers.filter(function (f) {
        return !used[f] && !hist.today[f] && !badJoin(f, fm) &&
          maxSim(fill(f, { module: fm }), hist.lines) < LINE_SIM;
      });
      if (!avail.length) avail = Phrases.fillers.filter(function (f) { return !used[f]; });
      if (!avail.length) break;
      var s = choice(rng, avail);
      used[s] = 1;
      usedTpls.push(s);
      text += '\n' + fill(s, { module: fm });
      guard++;
    }

    if (sk.closer) text += '\n' + sk.closer;

    return {
      date: dateStr,
      text: text,
      modules: mods,
      extra: extra ? extra.trim() : '',
      problem: problem,
      skeleton: sk.id,
      tpls: usedTpls
    };
  }

  /* ---------- 对外入口：带防雷同重试；opts.saltBase 用于「换一版」 ---------- */
  // 阈值 0.55 = 「与比对集里任一篇相似度 ≥0.55 就换个 salt 重出一版」，阈值越低越严格。
  //
  // 比对集就取「近 7 天 + 当天旧稿」，**不要再动它**——两种"加强"方案都实测过，都不划算：
  //   · 窗口 7 → 30 天：120 天验收语料上最大篇对 0.661→0.665、≥0.5 篇对 323→304（噪声级），
  //     代价是单日 6.8 ms → 17 ms、31 天批量 182 ms → 547 ms（3 倍）。
  //   · 改成「同骨架定向比对」（同骨架的篇才最像，实测 top12 里 11 对同骨架）：
  //     最大篇对降到 0.653，但 ≥0.5 篇对反而升到 329、单日 33.5 ms（5 倍）——
  //     换掉一版会与"比对集之外"的其它篇变像，属于打地鼠。
  // 结论：篇级重试只负责挡住"近期明显撞车"，更远的雷交给①全周期台账②30 天池周期③6 天骨架轮换。
  var SIM_THRESHOLD = 0.55;
  var COMPARE_DAYS = 7;

  /* 相似度预编译：比对集里每篇的二元组集合只算一次、新稿每次只算一次。
   * 朴素写法是每次 similarity(新稿, 老稿) 两边都重算，10 次重试 × 8 篇 = 80 次重复分词。 */
  function prepBigrams(t) {
    var g = bigrams(t), set = {};
    for (var i = 0; i < g.length; i++) set[g[i]] = 1;
    return { g: g, set: set };
  }
  function simPrepped(a, b) {
    if (!a.g.length || !b.g.length) return 0;
    var inter = 0;
    for (var i = 0; i < a.g.length; i++) if (b.set[a.g[i]]) inter++;
    return inter / Math.min(a.g.length, b.g.length);
  }

  function generateDaily(dateStr, config, reports, stats, extra, opts) {
    if (!config || !config.modules || !config.modules.length) return null;
    var base = (opts && opts.saltBase) || 0;
    var ledger = makeLedger(reports, dateStr);   // 全周期台账每次生成只建一次
    var prev = lastNDates(reports, dateStr, COMPARE_DAYS).map(function (d) { return reports[d].text || ''; });
    if (reports[dateStr] && reports[dateStr].text) prev = prev.concat([reports[dateStr].text]);
    var prevPrep = prev.map(prepBigrams);
    var best = null, bestScore = Infinity;
    for (var salt = base; salt < base + 10; salt++) {
      var r = buildDaily(dateStr, config, reports, stats, salt, extra, ledger);
      var mine = prepBigrams(r.text), mx = 0;
      for (var i = 0; i < prevPrep.length; i++) {
        var s = simPrepped(mine, prevPrep[i]);
        if (s > mx) mx = s;
      }
      if (mx < SIM_THRESHOLD) return r;
      if (mx < bestScore) { bestScore = mx; best = r; }
    }
    return best; // 重试后仍偏高就返回重叠度最低的一版
  }

  window.Generator = {
    generateDaily: generateDaily,
    buildDaily: buildDaily,
    similarity: similarity,
    charCount: charCount,
    pickModules: pickModules,
    defaultSections: defaultSections,
    contentLines: contentLines,
    isSectionLine: isSectionLine,
    isHeaderLine: isHeaderLine,
    makeLedger: makeLedger,
    skeletonList: skeletonList,
    detectSkeleton: detectSkeleton,
    secPrefix: secPrefix,
    itemPrefix: itemPrefix,
    BAD_PAIR: BAD_PAIR,
    badJoin: badJoin
  };
})();
