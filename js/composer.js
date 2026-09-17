/* ============================================================
 * composer.js — 周报 / 月报 / 实习总结 聚合生成
 * 汇总来源是区间内已保存日报的结构化数据（modules / extra / problem）。
 *
 * P0-D 改造（与日报同源的三类问题）：
 *   1. 结构骨架：6 套聚合版式（抬头 / 章节编号 / 条目符号 / 段落是否合并），
 *      按「周期序号 % 6」轮换——不依赖任何存储字段，同一周期永远可复现。
 *      旧版抬头、章节编号、条目符号 13 周完全一致。
 *   2. 抽句不再"锁步"：旧版 `heads[i % n]` 与 `tails[i % n]` 同步取模，
 *      导致第 i 条永远配同一组头尾，且条目类型与模块性质不匹配
 *      （「学习产品知识与话术：累计处理 3 次」）。新版分别洗牌、按模块是否
 *      活动型选动词池。
 *   3. 问题段不再逐字照搬日报句子：改成按周期口径归纳（一是…；二是…；三是…），
 *      既保留事实，又不会被"周报 vs 日报"的文本比对直接命中。
 * ============================================================ */
(function () {

  function inRange(reports, from, to) {
    return Object.keys(reports)
      .filter(function (d) { return d >= from && d <= to; })
      .sort()
      .map(function (d) { return reports[d]; });
  }

  function moduleCounts(recs) {
    var m = {};
    recs.forEach(function (r) {
      (r.modules || []).forEach(function (x) { m[x] = (m[x] || 0) + 1; });
    });
    return m;
  }

  // 实习第几周（从配置的实习开始日期算）
  function weekNumber(config, from) {
    if (!config || !config.startDate) return null;
    var days = Math.round((Store.parse(from) - Store.parse(config.startDate)) / 864e5);
    if (days < 0) return 1;
    return Math.floor(days / 7) + 1;
  }

  /* ---------- 种子化随机（同一区间可复现，不同区间自动变化） ---------- */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function makeRng(s) {
    var a = hashStr(s);
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function choice(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function pickN(rng, arr, n) {
    var c = arr.slice(), out = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(rng() * c.length), 1)[0]);
    return out;
  }
  function tf(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, function (m, k) {
      return (vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : '';
    });
  }

  /* 配置指纹。P1 只把 cfgKey 混进了日报种子，聚合稿这里一直是「同起止日期 -> 同一条随机序列」，
   * 于是「同岗位、不同公司」的周报掩名相似度 0.927、实习总结 0.994 —— 一个班各自交周报必然互相命中。
   * P2-B 把同一个指纹接到聚合稿的随机种子与骨架选择上；同配置 + 同区间仍逐字可复现。 */
  function aggKey(config) {
    if (window.Generator && window.Generator.cfgKey) return window.Generator.cfgKey(config);
    return String((config && (config.jobType || '') + (config.company || '') + (config.jobTitle || '')) || '');
  }

  /* ============================================================
   * 聚合稿版式骨架
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
  function itemPrefix(sk, i) {
    var out = tf(sk.item, { i: i + 1, circ: CIRCLE[i] || '' });
    if (!out || !out.replace(/\s/g, '')) out = (i + 1) + '. ';
    return out;
  }

  var AGG_SKELETONS = [
    { id: 'ag1', head: '【实习{kind}】{range}{batch}{ext}', secStyle: 'cn', item: '{i}. ', joined: false, closer: '' },
    { id: 'ag2', head: '{kind}小结｜{range}{batch}{ext}', secStyle: 'cnParen', item: '・', joined: false, closer: '' },
    { id: 'ag3', head: '{range} · 实习{kind}{ext}', secStyle: 'cnBracket', item: '- ', joined: true, closer: '' },
    { id: 'ag4', head: '【实习{kind}】{batch}{range}{ext}', secStyle: 'cnClose', item: '{i}）', joined: false, closer: '以上为本{unit}工作情况汇总。' },
    { id: 'ag5', head: '实习{kind}记录 · {range}{batch}{ext}', secStyle: 'cn', item: '{circ}', joined: false, closer: '' },
    { id: 'ag6', head: '{range} 实习{kind}{ext}', secStyle: 'cnParen', item: '（{i}）', joined: true, closer: '' },
    { id: 'ag7', head: '{kind}｜{range}{batch}{ext}', secStyle: 'cnClose', item: '・', joined: false, closer: '' },
    { id: 'ag8', head: '【{range} 实习{kind}】{batch}{ext}', secStyle: 'cn', item: '- ', joined: true, closer: '以上为本{unit}实习情况小结。' }
  ];

  /* 周期序号 -> 骨架。不读任何存储字段：同一周期永远同一种版式，相邻周/月必然不同。
   * 8 套骨架 = 结构周期 8 期（P0 只有 6 套，52 周里「6 期间隔撞同骨架」46 对、
   * 同骨架篇对均值 0.610 vs 异骨架 0.552）；再用配置指纹加一个偏移，
   * 同一周不同人拿到的版式也不同。 */
  function pickAggSkeleton(type, from, config) {
    var n;
    if (type === 'monthly') {
      var m = /^(\d{4})-(\d{2})/.exec(from || '');
      n = m ? (Number(m[1]) * 12 + Number(m[2])) : 0;
    } else {
      var w = weekNumber(config, from);
      if (w === null) {
        var d = Date.UTC(2026, 0, 1);
        n = from ? Math.floor((Store.parse(from).getTime() - d) / 6048e5) : 0;
      } else n = w;
    }
    n = Math.abs(Math.round(n)) + (hashStr('agg#' + aggKey(config)) % AGG_SKELETONS.length);
    return AGG_SKELETONS[n % AGG_SKELETONS.length];
  }

  /* ---------- 周报 / 月报句式池 ---------- */
  // 事务型模块用的「动词头」×「收尾语」两组池子交叉组合
  var WORK_HEADS = [
    '{m}：累计开展 {c} 次',
    '{m}：共推进 {c} 次',
    '{m}：开展 {c} 次',
    '{m}：累计处理 {c} 次',
    '{m}：参与 {c} 次',
    '{m}：完成 {c} 次',
    '{m}：投入 {c} 次',
    '{m}：经手 {c} 次',
    '{m}：累计办结 {c} 次',
    '{m}：计 {c} 次',
    '{m}：前后投入 {c} 次',
    '{m}：跟进 {c} 次',
    '{m}：承接 {c} 次',
    '{m}：总计 {c} 次',
    '{m}：累计经手 {c} 次',
    '{m}：共处理 {c} 次',
    '{m}：累计完成 {c} 次',
    '{m}：累计跟进 {c} 次',
    '{m}：推进 {c} 次',
    '{m}：办结 {c} 次',
    '{m}：累计承接 {c} 次',
    '{m}：处理 {c} 次',
    '{m}：累计推进 {c} 次',
    '{m}：共完成 {c} 次',
    '{m}：跟进落实 {c} 次',
    '{m}：累计投入 {c} 次',
    '{m}：办理 {c} 次',
    '{m}：协同处理 {c} 次',
    '{m}：累计受理 {c} 次',
    '{m}：累计核对 {c} 次'
  ];
  // 活动型模块（参加/学习/复盘/会议/教研…）用中性动词，避免「学习…：累计处理 3 次」
  var WORK_HEADS_ACT = [
    '{m}：累计 {c} 次',
    '{m}：合计 {c} 次',
    '{m}：共 {c} 次',
    '{m}：按期开展 {c} 次',
    '{m}：照常开展 {c} 次',
    '{m}：本周期 {c} 次',
    '{m}：本{unit}累计 {c} 次',
    '{m}：共计 {c} 次',
    '{m}：按计划开展 {c} 次',
    '{m}：正常开展 {c} 次',
    '{m}：全程参与 {c} 次',
    '{m}：本{unit}开展 {c} 次',
    '{m}：共进行 {c} 次',
    '{m}：如期开展 {c} 次',
    '{m}：累计参加 {c} 次',
    '{m}：本{unit}合计 {c} 次',
    '{m}：开展 {c} 次',
    '{m}：本{unit}共 {c} 次',
    '{m}：累计学习 {c} 次',
    '{m}：按时参加 {c} 次'
  ];
  var WORK_TAILS = [
    '，均按要求完成。',
    '，完成质量保持稳定。',
    '，流程已经比较熟练。',
    '，关键要点均已记录归档。',
    '，从中提炼了不少实用做法。',
    '，相关注意事项已逐条落实。',
    '，未出现积压或返工。',
    '，处理结果均符合要求。',
    '，节奏与计划基本一致。',
    '，细节上的问题均当场更正。',
    '，与其他环节的衔接顺畅。',
    '，用时比上{unit}略有下降。',
    '，过程中的疑问都问清了。',
    '，台账更新及时。',
    '，各环节均按流程推进。',
    '，没有出现超出时限的情况。',
    '，相关记录已同步更新。',
    '，处理方式与标准保持一致。',
    '，遇到的问题均已当场记录。',
    '，整体用时在计划范围内。',
    '，结果经复核确认无误。',
    '，衔接环节没有出现等待。',
    '，重点环节都留了痕迹。',
    '，做法比上{unit}更顺手了。',
    '，临时插入的事项也已一并处理。',
    '，所有事项均有回音。',
    '，质量与时效都保持了稳定。',
    '，多数环节已能独立完成。',
    '，未留下需要跨{unit}处理的问题。',
    '，过程中的经验已整理成笔记。'
  ];
  var GAIN_MAIN = [
    '本{unit}通过持续参与「{mods}」等工作，岗位技能更加熟练，对{job}整体业务流程的理解更加系统。',
    '围绕「{mods}」等核心任务持续练习，操作明显熟练了，对{job}的工作全貌也有了更完整的认识。',
    '本{unit}在「{mods}」等方面投入最多，熟练度与规范意识同步提升，工作产出保持稳定。',
    '通过反复承担「{mods}」等任务，从最初需要提示才能完成，进步到能够独立按规范处理。',
    '以「{mods}」为主线推进本{unit}工作，把零散的操作逐渐串成了完整流程。',
    '「{mods}」这类工作本{unit}做得最多，从生疏到顺手，掌握了其中的关键节点。',
    '本{unit}把主要精力放在「{mods}」上，独立完成的比例比之前明显提高。',
    '在「{mods}」等工作中反复校正做法，逐渐固化成了一套自己顺手的工作习惯。',
    '本{unit}把「{mods}」这类高频工作做了一遍又一遍，操作越来越稳，也更清楚每一步为什么要这样做。',
    '围绕「{mods}」反复练手之后，速度和准确率都在往上走，对{job}的节奏也适应了。',
    '「{mods}」本{unit}承担得比较多，从需要人盯着到基本能自己把握，进步看得见。',
    '本{unit}重点在「{mods}」上打磨细节，规范意识和自查习惯都比之前强。',
    '通过「{mods}」等工作，逐步摸清了{job}的上下游关系，做事不再只看眼前一步。',
    '把「{mods}」的流程逐步理顺之后，本{unit}的返工明显减少，交付也更稳。',
    '本{unit}在「{mods}」上积累了不少实际处理经验，遇到同类情形基本能自行判断。',
    '「{mods}」这类任务本{unit}做得最扎实，基本功比刚来时牢了很多。'
  ];
  var GAIN_TAILS = [
    '坚持每日记录与复盘，工作规范意识、沟通协作能力都有明显提升。',
    '遇到疑问第一时间请教带教老师，积累的处理经验越来越成体系。',
    '把每天的小心得记进笔记，回头看能看到一条清晰的成长轨迹。',
    '与同事的配合越来越默契，逐渐融入了部门的工作节奏。',
    '对细节和标准的敏感度提高了，返工和遗漏都比之前减少。',
    '开始尝试站在岗位全局看问题，而不只是埋头完成分派的任务。',
    '逐渐能把课堂上的知识和岗位要求对应起来，理解更深了一层。',
    '学会了先确认要求再动手，返工次数少了，效率反而更高。',
    '对时间的安排更有把握，能大致估计一项工作要花多久。',
    '和同批实习生交流后有了对照，知道自己在哪些方面还需要补。',
    '遇到不确定的地方先把口径问清楚，做事比以前稳。',
    '把每天的完成情况简单记一笔，回看时能发现自己哪里在进步。',
    '慢慢养成了完工后自查一遍的习惯，问题多在前一步就被挡住。',
    '主动多做一步的意愿比之前强了，不再是完成就算。',
    '与同事的沟通更直接有效，需要配合的事情推进得更快。',
    '对工作标准的理解更具体了，知道什么样的结果才算合格。',
    '心态比刚开始稳，遇到忙的时候也能按顺序一件件处理。',
    '把学到的做法及时用起来，不至于学过又忘。',
    '对岗位的整体安排有了概念，知道自己的环节处在什么位置。',
    '越来越习惯把问题写下来再想办法，而不是放在心里。'
  ];
  var FIX_PATS = [
    '针对以上问题，后续将提前确认规范要求、合理安排时间，减少重复出错。',
    '后续会把这几类情况整理成检查清单，操作前逐项对照，避免再犯。',
    '下一步打算多向带教老师请教典型情形的处理思路，把不确定变成确定。',
    '之后会在动手前先确认口径与标准，完成后增加一道自查环节。',
    '改进方向是把经验落到清单和笔记上，让同类问题第一次就处理对。',
    '下{unit}准备把易错环节单独列出来，做完逐项打勾核对。',
    '针对这些情况，会提前预留缓冲时间，避免临时赶工影响质量。',
    '后续遇到同类情形先按标准流程走，拿不准的当场记录再统一请教。',
    '会把这几类问题的处理办法固定成自己的操作习惯，减少反复。',
    '后续会把这些情况做成一个简单的自查表，操作前后各看一遍。',
    '下{unit}打算把容易出错的环节提前演练一遍，做到心里有数。',
    '针对暴露出的不足，会主动多承担几次同类任务，用练习补上。',
    '后续会在每天收尾时多留五分钟检查，把问题挡在下班前。',
    '会把不清楚的口径提前问明白，不带着疑问往下做。',
    '下一步准备把手上的事分批处理，不再都挤在同一时间段。',
    '后续遇到反复出现的问题，会先从流程上找原因而不是只改结果。',
    '下{unit}给自己定一个复查节点，中途看一眼进度和质量。',
    '会把这些不足写进记事本，做同类工作前先翻一翻。'
  ];
  var SMOOTH_TAILS = [
    '个别细节问题均已当日解决并记录在日报中。',
    '偶发的小疑问都已在当天请教确认并记入笔记。',
    '各类事项均按计划推进，没有留下需要跨天处理的问题。',
    '整体节奏平稳，没有出现影响交付的情况。',
    '常规事务处理得比较顺手，未遇到需要额外协调的情形。',
    '工作中的疑问基本当场解决，未形成积压。',
    '各项工作按既定节奏推进，没有需要额外协调的事项。',
    '遇到的小疑问当场就弄清楚了，没有带到下一{unit}。',
    '整体推进顺利，质量与进度都在预期之内。',
    '日常事务处理得比较顺手，未出现需要返工的情况。',
    '各环节衔接顺畅，没有出现卡点。',
    '工作按计划完成，未出现异常情况。'
  ];
  var PLAN_PATS = [
    '继续做好{m}相关工作，进一步提高效率与质量。',
    '把{m}的熟练度再往上提一档，重点练习易错环节。',
    '系统梳理{m}的流程要点，形成自己的操作清单。',
    '主动承担更多{m}相关的任务，争取独立完成一整个环节。',
    '向带教老师请教{m}的进阶技巧，对照改进自己的做法。',
    '给{m}设定小的质量目标，逐日检查达成情况。',
    '把之前{m}中遇到的问题做一次集中复盘，巩固正确做法。',
    '预留整块时间推进{m}，减少被临时事务打断的影响。',
    '关注{m}与前后环节的衔接，减少交接时的返工。',
    '在{m}上尝试更快更稳的节奏，缩短单项处理耗时。',
    '把{m}的注意事项整理成一页要点，随时对照。',
    '下{unit}在{m}上多做一次自查，把差错挡在交付前。',
    '计划把{m}中重复性高的部分做成模板，节省时间。',
    '在{m}上减少对提示的依赖，尽量自己判断。',
    '下{unit}围绕{m}做一次小结，把进步和不足都写下来。',
    '把{m}的耗时记录下来，找出可以优化的环节。',
    '在{m}上多向同事取经，把做法磨得更规范。',
    '给{m}排一个优先级，确保按时完成不被挤占。',
    '{m}继续按现有节奏推进，重点盯住容易出错的两个位置。',
    '把{m}的做法再规范一遍，减少凭经验处理的情况。',
    '下{unit}在{m}上多做一次交叉核对，降低疏漏概率。',
    '把{m}的经验整理出来，形成一份可以照着做的说明。',
    '在{m}上尝试提前一天做准备，减少临时赶工。',
    '针对{m}的薄弱环节，下{unit}安排固定时间专门练。',
    '把{m}中重复的动作固定成流程，提高整体效率。',
    '{m}相关的新要求及时学习，避免按旧做法处理。',
    '在{m}上多和同事交换做法，取长补短。',
    '给{m}设一个时间上限，避免单件事占掉太多精力。',
    '下{unit}在{m}上减少返工，先确认要求再动手。',
    '把{m}中遇到的问题汇总一次，集中请教解决。',
    '在{m}上多做总结，把好的做法固定下来。',
    '继续跟进{m}的进度，做到心中有数。',
    '把{m}的细节把控再严一些，宁可慢一点也不出错。',
    '在{m}上主动向前一步，不等安排就先把准备做好。',
    '下{unit}把{m}与其他环节的配合再理顺一些。',
    '针对{m}制定一个小的改进目标，逐日检查。'
  ];
  var PLAN_CLOSERS = [
    '坚持每日记录与复盘，配合指导老师安排完成各项任务。',
    '继续做好每日台账与笔记，随时接受老师的检查与指导。',
    '保持稳定出勤与交付节奏，遇到临时任务优先配合。',
    '每周对自己的完成情况做一次小结，及时调整工作方法。',
    '把本{unit}形成的做法固定下来，减少重复摸索。',
    '继续保持主动请教和及时复盘的习惯，稳步把工作做扎实。',
    '按计划推进各项任务，同时留出时间补自己的短板。',
    '下{unit}会在时间安排上更从容一些，避免前松后紧。',
    '把待办清单维护好，做到每天的事每天清。',
    '遇到拿不准的先问清楚，不把疑问带过夜。',
    '保持记录的连续性，方便随时回看和汇总。',
    '按岗位要求稳定输出，质量优先于速度。',
    '给自己留一点余量，临时任务来了也不至于打乱全盘。',
    '继续把每一天的小结写扎实，积累比突击更有用。',
    '定期和带教老师对一次进度，及时校正方向。',
    '把本{unit}暴露出的短板列成清单，逐项消灭。'
  ];

  /* 把区间内的日报问题「按类型」归纳成一句周/月口径的话。
   * 优先用 Phrases.problemKinds（与 Phrases.problems 逐条对齐）做类型化归纳，
   * 这样周报里不会出现与日报逐字相同的长句；匹配不到（旧数据 / 自定义句式）时
   * 退回「一是…；二是…」的文字归纳。 */
  function problemSummaryOf(recs, problems, unit) {
    var pool = (typeof Phrases !== 'undefined' && Phrases.problems) ? Phrases.problems : null;
    var kinds = [], samples = [];
    if (pool && Phrases.problemKinds && Phrases.problemKinds.length === pool.length) {
      var seen = {};
      recs.forEach(function (r) {
        if (!r.problem) return;
        var mods = r.modules || [];
        for (var i = 0; i < mods.length; i++) {
          for (var j = 0; j < pool.length; j++) {
            if (tf(pool[j], { module: mods[i] }) !== r.problem) continue;
            var k = Phrases.problemKinds[j];
            if (!seen[k]) { seen[k] = 1; kinds.push(k); samples.push(mods[i]); }
            return;
          }
        }
      });
    }
    if (kinds.length) {
      var detail = kinds.slice(0, 3).map(function (k, i) {
        return k + '（' + samples[i] + '）';
      }).join('；');
      return '本' + unit + '遇到的问题集中在以下几类：' + detail + '。';
    }
    var core = function (p) { return String(p).replace(/。\s*$/, ''); };
    if (problems.length === 1) return '本' + unit + '遇到的主要问题：' + core(problems[0]) + '。';
    var idx = ['一是', '二是', '三是', '四是'];
    return '本' + unit + '遇到的问题集中在以下几类：' +
      problems.slice(0, 3).map(function (p, i) { return idx[i] + core(p); }).join('；') + '。';
  }

  var ACT_RE = /^(参加|学习|复盘|晨间|参与)/;

  /* ---------- 周报 / 月报 ---------- */
  function aggregate(type, from, to, config, reports) {
    var recs = inRange(reports, from, to);
    if (!recs.length) return null;

    var rng = makeRng(type + '#' + from + '#' + to + '#' + aggKey(config));
    var sk = pickAggSkeleton(type, from, config);

    var mc = moduleCounts(recs);
    var top = Object.keys(mc).map(function (k) { return [k, mc[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });

    var problems = [];
    recs.forEach(function (r) { if (r.problem) problems.push(r.problem); });
    problems = problems.filter(function (p, i) { return problems.indexOf(p) === i; });

    var extras = [];
    recs.forEach(function (r) { if (r.extra && extras.indexOf(r.extra) < 0) extras.push(r.extra); });

    var isWeek = type === 'weekly';
    var unit = isWeek ? '周' : '月';
    var kind = isWeek ? '周报' : '月报';
    var range = from + ' ~ ' + to;
    var batch = isWeek
      ? '（实习第' + (weekNumber(config, from) || '?') + '周）'
      : '（' + from.slice(0, 7) + '）';
    var headExtra = config && config.company ? '（' + config.company + '）' : '';
    var job = (config && config.jobTitle) || '岗位';

    var L = [];
    L.push(tf(sk.head, { unit: unit, kind: kind, range: range, batch: batch, ext: headExtra }));
    L.push('');

    // ---- 一、本周期完成工作 ----
    L.push(secPrefix(sk.secStyle, 0) + '本' + unit + '完成工作');
    // 头尾分别洗牌 + 尾语按步长错开取模：旧版两边都按 i 取模，导致"第 i 条永远同一组头尾"
    var heads = pickN(rng, WORK_HEADS, WORK_HEADS.length);
    var headsAct = pickN(rng, WORK_HEADS_ACT, WORK_HEADS_ACT.length);
    var tails = pickN(rng, WORK_TAILS, WORK_TAILS.length);
    var tailOff = Math.floor(rng() * tails.length);
    var tailStep = 1 + Math.floor(rng() * (tails.length - 1));
    var workLines = top.map(function (t, i) {
      var isAct = ACT_RE.test(t[0]);
      var hp = isAct ? headsAct : heads;
      var body = tf(hp[i % hp.length], { m: t[0], c: t[1], unit: unit }) +
        tf(tails[(i * tailStep + tailOff) % tails.length], { unit: unit });
      return sk.joined ? body.replace(/。$/, '') : (itemPrefix(sk, i) + body);
    });
    if (extras.length) {
      var extraLine = '其他专项工作：' + extras.join('；') + '。';
      workLines.push(sk.joined ? extraLine.replace(/。$/, '') : (itemPrefix(sk, top.length) + extraLine));
    }
    L.push(sk.joined ? (workLines.join('；') + '。') : workLines.join('\n'));

    // ---- 二、收获与成长 ----
    L.push('');
    L.push(secPrefix(sk.secStyle, 1) + '收获与成长');
    var modsStr = top.slice(0, 2).map(function (t) { return t[0]; }).join('」「');
    L.push(tf(choice(rng, GAIN_MAIN), { unit: unit, mods: modsStr, job: job }));
    pickN(rng, GAIN_TAILS, 2).forEach(function (s) { L.push(s); });

    // ---- 三、遇到的问题与改进（按周期口径归纳，不逐字照搬日报句子）----
    L.push('');
    L.push(secPrefix(sk.secStyle, 2) + '遇到的问题与改进');
    if (problems.length) {
      var summary = problemSummaryOf(recs, problems, unit);
      L.push(sk.joined ? (summary + choice(rng, FIX_PATS).replace(/\{unit\}/g, unit)) : (itemPrefix(sk, 0) + summary));
      if (!sk.joined) {
        L.push(itemPrefix(sk, 1) + choice(rng, FIX_PATS).replace(/\{unit\}/g, unit));
      }
    } else {
      var smooth = '本' + unit + '工作整体平稳顺利，未出现明显问题；' + choice(rng, SMOOTH_TAILS);
      L.push(sk.joined ? smooth : (itemPrefix(sk, 0) + smooth));
    }

    // ---- 四、下周期工作计划 ----
    L.push('');
    L.push(secPrefix(sk.secStyle, 3) + '下' + unit + '工作计划');
    var all = (config && config.modules) ? config.modules.slice() : top.map(function (t) { return t[0]; });
    var least = all.sort(function (a, b) { return (mc[a] || 0) - (mc[b] || 0); }).slice(0, 3);
    var planPool = pickN(rng, PLAN_PATS, PLAN_PATS.length);
    var planOff = Math.floor(rng() * planPool.length);
    var planLines = least.map(function (m, i) {
      var body = tf(planPool[(i * 2 + planOff) % planPool.length], { m: m, unit: unit });
      return sk.joined ? body.replace(/。$/, '') : (itemPrefix(sk, i) + body);
    });
    var closer = tf(choice(rng, PLAN_CLOSERS), { unit: unit });
    planLines.push(sk.joined ? closer.replace(/。$/, '') : (itemPrefix(sk, least.length) + closer));
    L.push(sk.joined ? (planLines.join('；') + '。') : planLines.join('\n'));

    if (sk.closer) L.push(tf(sk.closer, { unit: unit }));

    return { text: L.join('\n'), count: recs.length, from: from, to: to, type: type, skeleton: sk.id };
  }

  /* ---------- 实习总结句式池 ---------- */
  var SUM_OVERVIEW = [
    '在{co}进行{jt}岗位实习以来，我严格遵守单位的各项规章制度，按时出勤打卡，认真完成带教老师安排的各项工作任务，逐步实现了从学生到职场人的角色转变。',
    '自来到{co}担任{jt}实习生以来，我尽快适应了从校园到职场的转变，遵守单位制度、服从工作安排，在带教老师的指导下逐项落实岗位职责。',
    '{jt}岗位的实习让我第一次完整地经历了职场日常。在{co}期间，我坚持按时出勤、主动请教，把带教老师交办的每一件事做完整、有回音。',
    '这段在{co}的{jt}实习，是我第一次以岗位成员的身份参与工作。从第一天熟悉环境、记住流程，到后来能独立承担一部分任务，转变是一天天积累出来的。',
    '在{co}实习期间，我按部门安排参加日常业务，遵守作息与各项规范，遇到不懂的地方及时请教，逐步补齐了从课堂到岗位之间的那一段差距。',
    '实习这段时间，我在{co}的{jt}岗位上从生疏到上手，出勤稳定、服从安排，把每一次任务都当作练习的机会，也在过程中认清了自身的短板。',
    '在{co}的{jt}岗位上，我从最基础的事务做起，按部门要求逐步承担起固定的工作内容，实习期间出勤稳定、态度端正。',
    '这段在{co}的实习让我真正接触到{jt}的日常：从熟悉环境、记住流程，到能独立完成一部分工作，每一步都是实打实练出来的。',
    '{co}的这段实习里，我把自己当成部门的一员来看待工作，按时完成任务、及时反馈进度，慢慢补上了课堂和岗位之间的差距。',
    '在{co}实习期间，我按{jt}岗位的要求完成了各项日常事务，遇到不懂的地方随时请教，尽量把每件事做到有回音。',
    '{jt}是我第一次正式接触的岗位。在{co}这段时间里，我遵守各项规定、服从安排，从生手逐渐做到了能够独立上手。',
    '回顾在{co}的实习，我按要求完成了{jt}岗位的主要工作，也经历了从被动接受任务到主动认领任务的变化。'
  ];
  var SUM_WORK_HEADS = [
    '{m}：实习期间累计开展 {c} 次',
    '{m}：累计参与 {c} 次',
    '{m}：开展了 {c} 次',
    '{m}：经手 {c} 次',
    '{m}：累计完成 {c} 次',
    '{m}：前后投入 {c} 次',
    '{m}：累计办结 {c} 次',
    '{m}：合计 {c} 次',
    '{m}：跟进 {c} 次',
    '{m}：总计 {c} 次',
    '{m}：累计办理 {c} 次',
    '{m}：共完成 {c} 次',
    '{m}：累计处理 {c} 次',
    '{m}：经手办理 {c} 次',
    '{m}：全程参与 {c} 次',
    '{m}：累计跟进 {c} 次',
    '{m}：合计办结 {c} 次',
    '{m}：累计执行 {c} 次'
  ];
  /* 活动型模块用中性动词。旧版总结这里漏了：会产出「参加晨会与业务通报：累计办结 12 次」
   * ——日报那边 WORK_HEADS_ACT 早就修过，总结一直没跟上，P2 一并补齐 */
  var SUM_WORK_HEADS_ACT = [
    '{m}：累计 {c} 次',
    '{m}：合计 {c} 次',
    '{m}：共 {c} 次',
    '{m}：本{unit}累计 {c} 次',
    '{m}：共计 {c} 次',
    '{m}：按计划开展 {c} 次',
    '{m}：正常开展 {c} 次',
    '{m}：全程参与 {c} 次',
    '{m}：累计参加 {c} 次',
    '{m}：开展 {c} 次',
    '{m}：按期开展 {c} 次',
    '{m}：累计学习 {c} 次'
  ];
  var SUM_WORK_TAILS = [
    '，从最初需要在指导下完成，到后期能够独立、规范地处理。',
    '，已经能够按岗位标准独立完成，质量保持稳定。',
    '，从生疏到熟练，逐渐形成了自己的操作节奏。',
    '，相关流程与注意事项都已熟练掌握，并能提示同批实习生。',
    '，从一开始的手忙脚乱到现在的心里有数。',
    '，处理的规范程度多次得到带教老师认可。',
    '，过程中的疑问基本都能自行判断并处理。',
    '，用时比刚开始时明显缩短，返工也少了。',
    '，从需要人提醒到能自己安排顺序，独立完成的比例越来越高。',
    '，各项要求都已熟悉，处理起来基本不用再问。',
    '，出错率比开始时低了很多，效率也稳定下来。',
    '，逐渐形成了先确认要求、再动手、做完自查的固定节奏。',
    '，遇到没见过的情形也知道该从哪里入手。',
    '，处理质量得到了带教老师和同事的认可。',
    '，从一开始的生疏到后来能带着新来的实习生做。',
    '，整个过程中的疑问基本都能自行消化。'
  ];
  var SUM_SKILL = [
    '专业能力方面：通过「{mods}」等核心工作的反复实践，掌握了岗位的基本技能和操作规范，做到了理论与实际相结合。',
    '专业能力方面：「{mods}」等任务从上手到熟练，让我把课堂知识真正落到了操作层面，技能短板得到针对性补强。',
    '专业能力方面：围绕「{mods}」等工作持续练习，能够独立按规范完成主要业务，处理速度和准确率都有明显提升。',
    '专业能力方面：以「{mods}」为主线练下来，从需要一步步提示到能自己排顺序，岗位所需的基本功算是打下来了。',
    '专业能力方面：「{mods}」这类工作从看不懂到做得顺，让我对岗位所需技能的边界有了清楚的认识。',
    '专业能力方面：整个实习期间在「{mods}」上投入最多，也最能看出进步，规范操作逐渐变成了习惯。',
    '专业能力方面：在「{mods}」等工作中反复练手，把课本上的概念落成了具体动作，技能短板补得比较有针对性。',
    '专业能力方面：「{mods}」从不会到会、从慢到快，整个变化过程很清楚，岗位基本功算是打牢了。',
    '专业能力方面：围绕「{mods}」持续投入，现在能独立按标准完成主要业务，遇到变通情形也敢判断。',
    '专业能力方面：「{mods}」这类核心工作做得最多，也最能体现这段时间的进步。',
    '专业能力方面：把「{mods}」的流程要点整理成了自己的清单，操作时照着走，规范程度稳定。',
    '专业能力方面：通过「{mods}」的反复实践，理解了每一项操作背后的规则，不再只记步骤。'
  ];
  var SUM_QUALITY = [
    '职业素养方面：养成了按时出勤、每日记录、及时复盘的工作习惯，沟通表达和团队协作能力得到明显锻炼。',
    '职业素养方面：形成了守时、有条理、有回音的工作方式，主动沟通和团队配合的意识显著增强。',
    '职业素养方面：从被安排到主动认领任务，责任心和执行力得到了实实在在的锤炼。',
    '职业素养方面：学会了先确认要求再动手、办完及时反馈，工作有了闭环的习惯。',
    '职业素养方面：与同事的配合从生疏到顺畅，知道了在团队里怎样表达、怎样配合。',
    '职业素养方面：对时间和节奏的把控比开始时稳了，能大致安排出一项工作要花的工夫。',
    '职业素养方面：养成了先确认再动手、办完即反馈的习惯，工作有始有终有回音。',
    '职业素养方面：守时、守流程、守标准，逐渐形成了职场人应有的做事方式。',
    '职业素养方面：从"做完"到"做好"，对质量的要求比以前高了一档。',
    '职业素养方面：与同事的协作从陌生到顺畅，知道怎样表达需求、怎样配合节奏。',
    '职业素养方面：对时间的管理更自觉，能提前预估工作量并留出缓冲。',
    '职业素养方面：遇到问题不再等着别人发现，会主动上报并跟到底。'
  ];
  var SUM_MIND = [
    '个人认知方面：更加清楚地认识到细心、耐心和责任心在实际工作中的重要性，也更加明确了自己今后的努力方向。',
    '个人认知方面：体会到任何岗位都没有"简单的事"，把普通事做到位本身就是竞争力。',
    '个人认知方面：对职业选择有了更务实的判断，知道了差距在哪里、该往哪个方向补。',
    '个人认知方面：意识到学校里学的知识只是起点，岗位上的很多经验需要自己一点点攒。',
    '个人认知方面：明白了沟通和记录都不是"额外的活"，它们本身就是工作质量的一部分。',
    '个人认知方面：对"把事情做成"和"把事情做好"的区别有了具体的体会。',
    '个人认知方面：体会到岗位上的很多能力不是教出来的，而是做出来、总结出来的。',
    '个人认知方面：认识到把简单的事一直做对并不容易，稳定本身就是一种能力。',
    '个人认知方面：对行业和岗位的真实状态有了具体认识，职业方向比之前清晰。',
    '个人认知方面：明白了记录和复盘的价值，它们让经验真正留得下来。',
    '个人认知方面：意识到沟通成本往往比操作成本更高，把话说清楚很重要。',
    '个人认知方面：对自己的短板有了具体判断，不再只是笼统地觉得"还不够熟练"。'
  ];
  var SUM_SHORT = [
    '回顾整个实习过程，仍存在一些不足：一是遇到复杂问题时独立解决的能力还有待提高；二是对业务全貌的了解还不够全面；三是时间管理和统筹安排仍有优化空间。',
    '复盘这段实习，我的不足主要有三点：复杂情形下仍依赖老师提示、对跨环节业务的了解偏浅、工作节奏前松后紧需要更合理的统筹。',
    '这段实习也暴露出我的短板：遇到没见过的情形容易犹豫，习惯先问再做；对岗位之外的上下游环节了解不多；同时处理多件事时容易顾此失彼。',
    '回看整个过程，不足之处主要有：方法总结得不够及时，做过的事情没有立刻沉淀成经验；主动承担的广度还不够，多数时候是按安排做事。',
    '回看这段实习，不足之处主要在三个方面：处理复杂情形时还依赖提示，对上下游业务的了解偏浅，多任务并行时容易顾此失彼。',
    '这段实习暴露出的短板比较具体：总结沉淀不够及时，主动承担的广度有限，遇到没有先例的情况容易犹豫。',
    '复盘下来，需要改进的地方有几处：对业务全貌的把握还停留在本环节，时间统筹偏被动，方法的规范性有待继续打磨。',
    '这段经历也让我看清了差距：独立解决问题的能力仍显不足，跨环节协同的经验较少，学习的系统性还不够。'
  ];
  var SUM_NEXT = [
    '今后将有针对性地加强学习，多向老师傅和同事请教，主动承担任务，在实践中不断提升自己。',
    '接下来会带着问题清单补短板，把学到的规范和方法用到后续学习与工作中，争取独当一面。',
    '回到学校后，我会针对暴露出的弱项系统充电，为正式走上工作岗位做好更充分的准备。',
    '后续打算先把基本功继续练扎实，再主动争取一些有难度的事做，逼着自己独立判断。',
    '下一步会刻意练习先动手再求证的习惯，把"请教"用在真正的难点上，而不是每一步。',
    '这段时间的经验会继续用下去：凡事有记录、有反馈、有小结，让每一段工作都留下痕迹。',
    '接下来会针对薄弱环节制定具体的练习计划，把学到的规范和方法继续用下去。',
    '回到学校后会主动补上业务和工具方面的短板，为正式入职做好准备。',
    '后续打算把这次实习形成的工作习惯保持下来：凡事有记录、有反馈、有小结。',
    '下一步会争取更多独立承担的机会，在实践中练判断力和统筹能力。',
    '会继续保持请教和复盘的频率，把不懂的地方尽快变成懂的地方。',
    '今后会更主动地了解业务的上下游，而不是只盯着自己手上的一环。'
  ];
  var SUM_END = [
    '感谢学校提供的实习机会，感谢单位带教老师的悉心指导和同事们的热情帮助。这段实习经历让我收获了课堂上学不到的宝贵经验，为今后走上工作岗位打下了坚实基础。',
    '衷心感谢单位与学校的共同培养。这段日子让我完成了从课堂到岗位的第一步跨越，收获的经验和能力会一直受益。',
    '谢谢每一位帮助过我的老师和同事。这段实习让我对未来的职业道路更加笃定，也更有底气面对接下来的挑战。',
    '向单位、学校以及耐心带我的老师道一声感谢。这段经历最珍贵的不是学会了哪项具体操作，而是知道了该怎么学、怎么问、怎么把事做完。',
    '感谢单位提供的实习平台和带教老师的耐心指导。这段时间获得的经验，会成为我走上工作岗位的底气。',
    '感谢学校和单位给了这次实习机会，也感谢每一位愿意花时间教我的同事。这段经历值得记很久。',
    '向带教老师和同事们道一声感谢。这段时间学到的不只是技能，更是做事的态度和方法。',
    '感谢这段时间里所有帮助过我的人。实习的收获会一直陪着我，走好接下来的每一步。'
  ];

  /* ---------- 实习总结（学习通「总结」入口） ---------- */
  var SUM_HEADS = [
    '【实习总结】{co} · {jt}',
    '实习总结 · {co}{jt}',
    '{co} {jt} 实习总结',
    '【{co} · {jt} 实习总结】',
    '实习总结报告（{co} · {jt}）',
    '{co}实习总结 · {jt}岗位'
  ];
  var SUM_TIMES = [
    '实习时间：{span}（累计记录日报 {n} 天）',
    '实习起止：{span}　共记录 {n} 天',
    '记录区间：{span}，累计 {n} 天',
    '实习周期：{span}（{n} 天）',
    '起止时间 {span}　有效记录 {n} 天'
  ];

  function internshipSummary(config, reports) {
    var dates = Object.keys(reports).sort();
    if (!dates.length) return null;
    var recs = dates.map(function (d) { return reports[d]; });

    var ck = aggKey(config);
    var rng = makeRng('sum#' + dates[0] + '#' + dates[dates.length - 1] + '#' + recs.length + '#' + ck);
    var sk = AGG_SKELETONS[hashStr('sum#' + dates[0] + '#' + ck) % AGG_SKELETONS.length];

    var mc = moduleCounts(recs);
    var top = Object.keys(mc).map(function (k) { return [k, mc[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });

    var extras = [];
    recs.forEach(function (r) { if (r.extra && extras.indexOf(r.extra) < 0) extras.push(r.extra); });

    var span = dates[0] + ' ~ ' + dates[dates.length - 1];
    var company = (config && config.company) || '实习单位';
    var jobTitle = (config && config.jobTitle) || '实习岗位';
    var totalDays = recs.length;
    var modsStr = top.slice(0, 2).map(function (t) { return t[0]; }).join('」「');

    var L = [];
    L.push(tf(choice(rng, SUM_HEADS), { co: company, jt: jobTitle }));
    L.push(tf(choice(rng, SUM_TIMES), { span: span, n: totalDays }));
    L.push('');
    L.push(secPrefix(sk.secStyle, 0) + '实习概况');
    L.push(tf(choice(rng, SUM_OVERVIEW), { co: company, jt: jobTitle }));
    L.push('');
    L.push(secPrefix(sk.secStyle, 1) + '主要工作内容');
    // 头尾分别洗牌（旧版同步取模，第 i 条永远配同一组头尾）
    var wh = pickN(rng, SUM_WORK_HEADS, SUM_WORK_HEADS.length);
    var whAct = pickN(rng, SUM_WORK_HEADS_ACT, SUM_WORK_HEADS_ACT.length);
    var st = pickN(rng, SUM_WORK_TAILS, SUM_WORK_TAILS.length);
    var wOff = Math.floor(rng() * st.length);
    var wStep = 1 + Math.floor(rng() * (st.length - 1));
    var workRows = top.slice(0, 6).map(function (t, i) {
      var hp = ACT_RE.test(t[0]) ? whAct : wh;
      var body = tf(hp[i % hp.length], { m: t[0], c: t[1], unit: '月' }) +
        st[(i * wStep + wOff) % st.length];
      return itemPrefix(sk, i) + body;
    });
    if (extras.length) {
      workRows.push(itemPrefix(sk, Math.min(top.length, 6)) + '其他专项工作：' + extras.join('；') + '。');
    }
    L.push(workRows.join('\n'));
    L.push('');
    L.push(secPrefix(sk.secStyle, 2) + '收获与成长');
    L.push(tf(choice(rng, SUM_SKILL), { mods: modsStr }));
    L.push(choice(rng, SUM_QUALITY));
    L.push(choice(rng, SUM_MIND));
    L.push('');
    L.push(secPrefix(sk.secStyle, 3) + '不足与改进方向');
    L.push(choice(rng, SUM_SHORT));
    L.push(choice(rng, SUM_NEXT));
    L.push('');
    L.push(secPrefix(sk.secStyle, 4) + '结语');
    L.push(choice(rng, SUM_END));

    return { text: L.join('\n'), count: totalDays, span: span, skeleton: sk.id };
  }

  window.Composer = {
    aggregate: aggregate,
    internshipSummary: internshipSummary,
    weekNumber: weekNumber,
    inRange: inRange,
    aggSkeletons: AGG_SKELETONS,
    pickAggSkeleton: pickAggSkeleton,
    problemSummaryOf: problemSummaryOf,
    secPrefix: secPrefix,
    itemPrefix: itemPrefix
  };
})();
