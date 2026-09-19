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

  /* ---------- 每篇的「模块使用预算」 ----------
   * 按「本篇已用次数」挑模块：优先挑还没用过的，都用过了才挑用得最少的。
   *
   * 背景：此前各栏目**各自独立**选模块 —— 「收获与学习」的正句和收尾句用同一个模块、
   * 「明日计划」正文与收尾句也用同一个、补充记录的引导句还会与正文撞上，
   * 于是一篇日报里同一个模块名能出现 4~7 次（实测新媒体运营：同篇 ≥4 次的占 62.5%，
   * 单篇最高 7 次）。真人写日报不会这样，这是「读着不像人写的」最主要的原因。
   * 全部选模块的地方改走这里后，同一模块在一篇里最多出现在 2 个栏目。
   *
   * 注意：只有一个候选时不消耗随机数，尽量少扰动既有随机流。 */
  function tally(used, m) { if (m) used[m] = (used[m] || 0) + 1; }
  /* 选模块（带次数上限）：从候选里**随机**挑，但跳过「本篇已用满 cap 次」的；全都用满才放宽。
   *
   * 为什么是「随机 + 上限」而不是「优先挑用得最少的」：
   * 试过「优先挑最少」的版本 —— 模块名重复确实压住了，但它把每天的模块集合
   * 推向「尽量把全部模块都用一遍」，于是不同天的用词高度趋同，
   * 整篇两两相似度从 3.8% 反弹到 16.3%（超过 10% 红线）。
   * 现在保留原有的随机性，只加一条硬约束：同一模块名在一篇里最多出现 cap 次。 */
  function pickCapped(rng, candidates, used, cap, fallback) {
    cap = cap || 3;
    if (!candidates || !candidates.length) return '';
    var ok = [];
    for (var i = 0; i < candidates.length; i++) {
      if ((used[candidates[i]] || 0) < cap) ok.push(candidates[i]);
    }
    if (!ok.length) {
      /* 候选（通常是当天选的 3 个模块）全用满了 —— 到「全池」里找还没满的。
       * 一篇日报合计要用 10+ 次模块，3 个模块 × 3 次 = 9 个额度偶尔不够，
       * 没有这一步就只能硬顶上限（实测超到 4~6 次）。 */
      var pool = (fallback && fallback.length) ? fallback : candidates;
      for (var j = 0; j < pool.length; j++) {
        if ((used[pool[j]] || 0) < cap) ok.push(pool[j]);
      }
    }
    if (!ok.length) {
      // 全池也用满了（超长文）：挑用得最少的那一个，避免无脑超限
      var min = Infinity, best = candidates[0];
      for (var k = 0; k < candidates.length; k++) {
        var u = used[candidates[k]] || 0;
        if (u < min) { min = u; best = candidates[k]; }
      }
      tally(used, best);
      return best;
    }
    if (ok.length === 1) { tally(used, ok[0]); return ok[0]; }
    var pick = ok[Math.floor(rng() * ok.length) % ok.length];
    tally(used, pick);
    return pick;
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
    var pk = pickFresh(rng, arr, mod, withLex(rng, arr, vars, hist), hist);
    if (pk.tpl) hist.today[pk.tpl] = 1;   // 本篇内也不复用同一模板
    if (pk.line) hist.lines.push(pk.line);
    return pk;
  }

  /* 给 vars 补上 {lex}：从当前岗位的语域词表里随机取一个词（客户 / 病人 / 设备…）。
   * 模板里的 {lex} 是「领域名词位」，于是同一批句式在不同岗位产出不同措辞，
   * 跨岗位相似度才不会只剩下「脚手架 + 模板骨架」。
   * 只有池里确实含 {lex} 模板时才消耗随机数 —— 不含 {lex} 的池行为完全不变。 */
  function withLex(rng, arr, vars, hist) {
    var lw = hist && hist.lexWords;
    if (!lw || !lw.length || !arr) return vars;
    var need = false;
    for (var i = 0; i < arr.length; i++) { if (arr[i].indexOf('{lex}') >= 0) { need = true; break; } }
    if (!need) return vars;
    var v = {}, k;
    if (vars) { for (k in vars) { if (Object.prototype.hasOwnProperty.call(vars, k)) v[k] = vars[k]; } }
    v.lex = lw[Math.floor(rng() * lw.length) % lw.length];
    return v;
  }

  /* 选一条表达（内部原语）：在「最久未用」的前 45% 里随机挑，
   * 再取与近 7 天句子最不相似的一条 */
  function pickFresh(rng, arr, mod, vars, hist) {
    if (!arr || !arr.length) return { tpl: '', line: '' };
    var pool = candidatePool(arr, mod, hist);
    /* 按「距上次使用天数」降序取「最久未用」；
     * age 相同时用模板内容哈希打散 —— 这里曾经是漏洞：
     * 相同 age 保持数组原顺序，而新增句式总是**追加在池末尾**，
     * 于是「从未用过」的新模板永远排在后面、进不了下面 headN 的头部 45%，
     * 要等整池轮换一遍才可能被用到（新句式长期不生效的根因）。
     * 用内容哈希而非 rng 做 tie-break：不消耗随机数，同配置仍完全可复现。 */
    pool = pool.slice().sort(function (a, b) {
      var d = hist.age(b) - hist.age(a);
      if (d) return d;
      return (hashStr(a) % 100000) - (hashStr(b) % 100000);
    });
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
  /* 每天的工作项条数 = 当天选几个模块（「今日完成」按模块逐条写）。
   *
   * 为什么从 3 提到 4：一篇日报的「今日完成 / 收获 / 问题与解决 / 明日计划 / 补充记录」
   * 合计要写 10+ 次模块名。每天只选 3 个模块时，每模块 3 次的额度只有 9 个槽位，
   * 必然不够 —— 兜底一放宽，同一模块名就会在一篇里出现 4~7 次，
   * 这是「读着不像人写」的主因（真实反馈：一篇里「短视频拍摄剪辑」出现 6 次）。
   * 选 4 个模块后额度升到 12 个，篇内峰值能压到 ≤3 次，日报本身也更饱满。 */
  var DAILY_ITEMS = 4;

  function pickModules(modules, stats, yesterdayMods, rng) {
    /* 条数 = min(4, 模块池大小)。不再按「池子够不够 5 个」分档：
     * 用户勾了 3 个模块就该出 3 条（原来只出 2 条，日报读起来很空）；
     * 勾了 7 个就出 4 条。上限 4 是为了让「今日完成」不像流水账。 */
    var take = Math.min(DAILY_ITEMS, modules.length);
    var byUse = function (a, b) {
      return ((stats[a] ? stats[a].count : 0) - (stats[b] ? stats[b].count : 0));
    };
    // 首选昨天没用过的模块（相邻两天尽量不写同样的事）
    var fresh = modules.filter(function (m) { return yesterdayMods.indexOf(m) < 0; }).sort(byUse);
    if (fresh.length >= take) {
      // 在最久未用的一批里随机挑，兼顾「周期内全覆盖」与多样性
      var head = fresh.slice(0, Math.max(take, Math.ceil(fresh.length * 0.7)));
      return pickN(rng, head, Math.min(take, head.length));
    }
    /* 模块池只有 6~7 个、却要写 4 条：昨天用掉 4 个只剩 3 个 ——
     * 数学上不可能与昨天完全不重叠。退化为「尽量少重叠」：
     * 把没用过的全用上，再按「全局最久未用」从昨天用过的里补差额（只差 1~2 个）。 */
    var stale = yesterdayMods.filter(function (m) { return modules.indexOf(m) >= 0; }).sort(byUse);
    var out = pickN(rng, fresh, fresh.length);
    // 注意：need 必须先算出来。写成 `i < take - out.length` 会因为 push 后 out.length 自增，
    // 循环提前一轮结束（曾导致 6 模块岗位每天只出 3 条）。
    var need = take - out.length;
    for (var i = 0; i < need && i < stale.length; i++) out.push(stale[i]);
    return out;
  }

  function lastNDates(reports, dateStr, n) {
    return Object.keys(reports)
      .filter(function (d) { return d < dateStr; })
      .sort()
      .slice(-n);
  }

  /* ---------- 组装单日日报 ---------- */
  function buildDaily(dateStr, config, reports, stats, salt, extra, ledger) {
    /* 种子 = 日期 + 盐 + 配置指纹 + 本机标识。
     * 加本机标识（Store.data.settings.deviceId）是为了解决：两个人配置**完全相同**
     * （公司名/岗位名留空、勾选模块一致）时，同一天会产出逐字相同的日报。
     * 同一台设备上 deviceId 持久不变，所以「同配置 + 同日期 → 逐字可复现」依然成立。 */
    var dev = (typeof Store !== 'undefined' && Store.data && Store.data.settings && Store.data.settings.deviceId) || '';
    var rng = rngFor(dateStr, salt + '|' + cfgKey(config) + '|' + dev);
    var d = Store.parse(dateStr);
    var dow = d.getDay();
    var weekday = '星期' + '日一二三四五六'[dow];
    var dayN = config.startDate
      ? Math.max(1, Math.round((d - Store.parse(config.startDate)) / 864e5) + 1)
      : null;

    var prevDates = lastNDates(reports, dateStr, 1);
    var yesterdayMods = prevDates.length ? (reports[prevDates[0]].modules || []) : [];

    var mods = pickModules(config.modules, stats, yesterdayMods, rng);

    /* 本篇的模块使用预算：每个模块名被用到就 +1，之后所有选模块的地方都优先挑用得少的，
     * 避免同一模块名在一篇里被反复写（见 pickLite 的说明）。 */
    var used = {};
    mods.forEach(function (m) { tally(used, m); });

    // 明日计划模块：全局最不常用的优先，同时受本篇预算约束
    var planPool = config.modules.slice().sort(function (a, b) {
      return ((stats[a] ? stats[a].count : 0) - (stats[b] ? stats[b].count : 0));
    });
    var planHead = planPool.slice(0, Math.max(2, Math.ceil(planPool.length * 0.7)));
    var planA = pickCapped(rng, planHead, used, 3, config.modules);
    var planB = pickCapped(rng, planHead, used, 3, config.modules);
    var planMods = (planB && planB !== planA) ? [planA, planB] : [planA];

    var hist = makeHist(dateStr, reports, ledger || makeLedger(reports, dateStr));
    // 岗位语域词表：供模板里的 {lex} 取词（跨岗位措辞差异，见 withLex）
    hist.lexWords = (Phrases.jobLex && Phrases.jobLex[config.jobType]) || [];
    var sk = pickSkeleton(rng, hist);
    var usedTpls = [SKEL_KEY + sk.id];

    // 开头语（openers 池）多数以 {module} 起头，这里同样走预算：优先挑本篇还没用过的模块
    var vars = { weekday: weekday, dayN: dayN, n: 0, module: pickCapped(rng, mods, used, 3, config.modules) };
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
    var doneAt = -1;    // 「今日完成」正文之后的插入点（补充记录续在此处）
    var doneIdx = 0;    // 该栏目已有条目数，补充记录从这里继续编号

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
        doneAt = lines.length;
        doneIdx = doneLines.length;

      } else if (sec.key === 'gains') {
        var gm = pickCapped(rng, mods, used, 3, config.modules);
        var g = takeFresh(rng, Phrases.gains, gm, { module: gm }, hist);
        usedTpls.push(g.tpl);
        var gl = [g.line];
        if (sk.gainsTail !== false && rng() < 0.6) {
          // 收尾句换一个模块：两句都以 {module} 开头，同模块连出两句会一模一样地起头
          var gm2 = pickCapped(rng, mods, used, 3, config.modules);
          var gt = takeFresh(rng, Phrases.gainsTail, gm2, { module: gm2 }, hist);
          usedTpls.push(gt.tpl);
          gl.push(gt.line);
        }
        emit(title, gl);

      } else if (sec.key === 'problems') {
        var pl = [];
        if (rng() < 0.65) {
          /* cap 传 2（不是 3）：问题和解决两句**共用同一个模块**，下面还会补记一次。
           * 这里若按 cap=3 挑，补记之后实际就占掉 4 次 —— 用户真实日报里
           * 「图文内容选题策划」出现 4 次（今日完成 1 + 问题 1 + 解决 1 + 计划 1）
           * 正是这条路径造成的：按 3 挑中时它已被用过 2 次，补记后变成 4。
           * 传 2 相当于「给解决句预留一个额度」，选中的一定满足 used ≤ 1。 */
          var pm = pickCapped(rng, mods, used, 2, config.modules);
          var pr = takeFresh(rng, Phrases.problems, pm, { module: pm }, hist);
          usedTpls.push(pr.tpl);
          problem = pr.line;
          var so = takeFresh(rng, Phrases.solutions, pm, { module: pm }, hist);
          usedTpls.push(so.tpl);
          tally(used, pm);   // 解决句也用同一个模块，预算要补记（否则它会被反复挑中）
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
          var nm = pickCapped(rng, mods, used, 3, config.modules);
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
          /* 收尾句优先挑「计划里还没出现过的模块」。原来从 planMods（只有 2 个）里挑，
           * 挑哪个都必然与上面某条计划撞模块 —— 用户日报里计划 2) 和尾句连着两句都是
           * 「短视频拍摄剪辑明天……」，读起来像同一条写了两次。
           * 改成先到当天全池找没用过的模块，找不到才退回 planMods。 */
          var tailCand = config.modules.filter(function (m) {
            return planMods.indexOf(m) < 0 && (used[m] || 0) < 3;
          });
          var tm = tailCand.length ? pickCapped(rng, tailCand, used, 3) : '';
          if (!tm) tm = planMods[0] || mods[0] || '';
          var pt = takeFresh(rng, Phrases.planTail, tm, { module: tm }, hist);
          usedTpls.push(pt.tpl);
          pp.push(pt.line);
        }
        emit(title, pp);
      }
    });

    /* ---------- 字数保障 ----------
     * 旧版这里直接 `Phrases.fillers.filter(...)`，只过滤「本篇已用 / 今日已用 / 近 7 天相似」，
     * **完全绕过 candidatePool / tier / 全周期台账**——P0 建的台账这个池一次都没查过。
     * 池子只有 30 条、默认 300 字时篇均只追加 0.04 条（750 天都够用），所以问题被掩盖了；
     * 字数目标一调高就暴露：400 字起 6 天内复用 75 次，600 字 905 次，800 字 1755 次、M1 89.7%。
     *
     * 现在分两层：
     *   ① 结构化补充记录（noteLead × noteAct × noteEnd，27000 种组合）插进「今日完成」栏目末尾续编号，
     *      读起来仍是一条工作记录，而不是贴在文末的一堆空话；
     *   ② 仍不够才退回 fillers 作文末补充说明。
     * 两层都走 takeFresh，于是台账、tier（21/14/7/3 天）、同日去重、接缝病句检查全部生效，
     * 每一维的模板编号都会写进 tpls，下次生成时按「最久未用」轮换。
     */
    var min = config.minWords || 0;
    var need = min ? (min - charCount(lines.join('\n'))) : 0;
    var noteLines = [], tailLines = [], guard = 0;
    /* 补充记录的两层「同篇去重」。
     * 用户反馈：一篇里几条补充记录开头雷同（三条都是「XX以外…」）。实测 45 天 / 600 字：
     * 同篇内**模块名重复 97.8%**、「模块名后 2 字」重复 64.4%、篇均 4 条。
     *   ① noteMods —— 本轮用过的模块不再选（4 个模块 → 前 4 条各不相同）；
     *      一圈用满才开新一轮，避免第 5 条与第 1 条紧挨着撞车。
     *   ② noteShapes —— 引子句的「开场形态」不重复。池里 80% 的句子以 {module} 打头，
     *      且「这块…」「之外…」「今天…」三簇就占了 78%，不按形态去重必然撞开头。
     * ⚠️ 这**不是**「挑全局用得最少的」——那种写法会把每天的模块集合推向固定，
     *    整篇相似度实测从 3.8% 反弹到 16.3%（第一步踩过的弯路）。 */
    var noteMods = {}, noteShapes = {};
    var leadShape = function (t) {
      var i = t.indexOf('{module}');
      return i === 0 ? t.slice(8, 10) : t.slice(0, 2);   // {module} 占 8 个字符
    };
    while (need > 0 && guard < 28) {
      /* 补充记录的模块：只在本轮没用过的模块里挑，且受「每模块 ≤3 次」的总预算约束。
       * 原先是 pickCapped(rng, mods, used, 3) —— cap 允许同一模块出现到 3 次，
       * 于是 4 条补充记录里几乎必有重复（用户那篇「短视频拍摄剪辑」出现 6 次，一段来自这里）。
       * 同样**不引入全池兜底**：800 字档要补 10+ 条，一旦补到全池，不同天的模块组合就会趋同，
       * 实测整篇相似度从 5% 反弹到 21%。 */
      /* ⚠️ 不要在这里扩到「当天全池」。试过：一轮用完后从 config.modules 里挑没用过的模块，
       * 600 字档的模块重复确实从 15.6% 降到 6.7%，但代价是两条红线失守 ——
       * 800 字档 ≥0.5 篇对 16.7%（>15%）、周报掩名相似度 0.562（>0.55）。
       * 原因和第一步的弯路同源：候选池一大，不同天的模块组合就趋同。
       * 800 字档篇均补 7.2 条、全池只有 7 个模块，重复是数学必然 —— 留待"扩模块池"解决。 */
      var freshMods = mods.filter(function (m) { return !noteMods[m]; });
      if (!freshMods.length) { noteMods = {}; freshMods = mods.slice(); }   // 一轮用完，开新一轮
      var nm = pickCapped(rng, freshMods, used, 3) || freshMods[0] || mods[0] || '';
      noteMods[nm] = 1;
      var nv = { module: nm, weekday: weekday, dayN: dayN };
      var parts = [];
      // 引导句必带 {module}：补充记录挂在「今日完成」栏目里，不绑定到某项工作就会读成
      // 「先做了两遍摸底，再正式下手做。」这种和上文完全脱节的句子（初版 22% 概率省略引子，已去掉）。
      var leadCand = Phrases.noteLead.filter(function (t) { return !noteShapes[leadShape(t)]; });
      if (!leadCand.length) { noteShapes = {}; leadCand = Phrases.noteLead; }
      var lead = takeFresh(rng, leadCand, nm, nv, hist);
      if (lead.tpl) noteShapes[leadShape(lead.tpl)] = 1;
      usedTpls.push(lead.tpl);
      parts.push(lead.line);
      var actN = rng() < 0.5 ? 2 : 1;
      for (var k = 0; k < actN; k++) {
        var act = takeFresh(rng, Phrases.noteAct, nm, nv, hist);
        usedTpls.push(act.tpl);
        parts.push(act.line);
      }
      if (rng() < 0.72) {                      // 28% 不加收束句，长短错落
        var tail = takeFresh(rng, Phrases.noteEnd, nm, nv, hist);
        usedTpls.push(tail.tpl);
        parts.push(tail.line);
      }
      var nt = parts.join('');
      noteLines.push(nt);
      need -= charCount(nt);
      guard++;
    }
    guard = 0;
    while (need > 0 && guard < 16) {
      var fm2 = mods[guard % mods.length] || '';
      var fp = takeFresh(rng, Phrases.fillers, fm2, { module: fm2 }, hist);
      if (!fp.tpl) break;
      usedTpls.push(fp.tpl);
      tailLines.push(fp.line);
      need -= charCount(fp.line);
      guard++;
    }

    if (noteLines.length && doneAt >= 0) {
      var insLines = noteLines.map(function (s, i) { return itemPrefix(sk, doneIdx + i) + s; });
      lines.splice.apply(lines, [doneAt, 0].concat(insLines));
    }
    var text = lines.join('\n');
    if (tailLines.length) text += '\n\n' + tailLines.join('\n');

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
    badJoin: badJoin,
    /* 配置指纹（P1 起混入日报随机种子；P2-B 起 composer 的周报/月报/总结也用它做隔离）。
     * 同一配置 + 同一日期/区间必须仍然逐字可复现，改这里要留意。 */
    cfgKey: cfgKey
  };
})();
