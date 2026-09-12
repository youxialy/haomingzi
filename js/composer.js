/* ============================================================
 * composer.js — 周报 / 月报 / 实习总结 聚合生成
 * 汇总来源是区间内已保存日报的结构化数据（modules / extra / problem）。
 * 全部段落走句式池 + 种子化随机：同一区间可复现，不同周/月自动换写法。
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

  /* ---------- 周报 / 月报句式池 ---------- */
  /* 动词头 × 收尾语 两组池子交叉组合，8 项以内条条句式不同 */
  var WORK_HEADS = [
    '{m}：累计开展 {c} 次',
    '{m}：共推进 {c} 次',
    '{m}：开展 {c} 次',
    '{m}：累计处理 {c} 次',
    '{m}：参与 {c} 次',
    '{m}：完成 {c} 次',
    '{m}：投入 {c} 次',
    '{m}：经手 {c} 次'
  ];
  var WORK_TAILS = [
    '，均按要求完成。',
    '，完成质量保持稳定。',
    '，流程已经比较熟练。',
    '，关键要点均已记录归档。',
    '，从中提炼了不少实用做法。',
    '，相关注意事项已逐条落实。',
    '，未出现积压或返工。',
    '，处理结果均符合要求。'
  ];
  var GAIN_MAIN = [
    '本{unit}通过持续参与「{mods}」等工作，岗位技能更加熟练，对{job}整体业务流程的理解更加系统。',
    '围绕「{mods}」等核心任务持续练习，操作明显熟练了，对{job}的工作全貌也有了更完整的认识。',
    '本{unit}在「{mods}」等方面投入最多，熟练度与规范意识同步提升，工作产出保持稳定。',
    '通过反复承担「{mods}」等任务，从最初需要提示才能完成，进步到能够独立按规范处理。'
  ];
  var GAIN_TAILS = [
    '坚持每日记录与复盘，工作规范意识、沟通协作能力都有明显提升。',
    '遇到疑问第一时间请教带教老师，积累的处理经验越来越成体系。',
    '把每天的小心得记进笔记，回头看能看到一条清晰的成长轨迹。',
    '与同事的配合越来越默契，逐渐融入了部门的工作节奏。',
    '对细节和标准的敏感度提高了，返工和遗漏都比之前减少。',
    '开始尝试站在岗位全局看问题，而不只是埋头完成分派的任务。'
  ];
  var FIX_PATS = [
    '针对以上问题，后续将提前确认规范要求、合理安排时间，减少重复出错。',
    '后续会把这几类情况整理成检查清单，操作前逐项对照，避免再犯。',
    '下一步打算多向带教老师请教典型情形的处理思路，把不确定变成确定。',
    '之后会在动手前先确认口径与标准，完成后增加一道自查环节。',
    '改进方向是把经验落到清单和笔记上，让同类问题第一次就处理对。'
  ];
  var SMOOTH_TAILS = [
    '个别细节问题均已当日解决并记录在日报中。',
    '偶发的小疑问都已在当天请教确认并记入笔记。',
    '各类事项均按计划推进，没有留下需要跨天处理的问题。'
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
    '在{m}上尝试更快更稳的节奏，缩短单项处理耗时。'
  ];
  var PLAN_CLOSERS = [
    '坚持每日记录与复盘，配合指导老师安排完成各项任务。',
    '继续做好每日台账与笔记，随时接受老师的检查与指导。',
    '保持稳定出勤与交付节奏，遇到临时任务优先配合。',
    '每周对自己的完成情况做一次小结，及时调整工作方法。'
  ];

  /* ---------- 周报 / 月报 ---------- */
  function aggregate(type, from, to, config, reports) {
    var recs = inRange(reports, from, to);
    if (!recs.length) return null;

    var rng = makeRng(type + '#' + from + '#' + to);

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
    var batch = isWeek
      ? '（实习第' + (weekNumber(config, from) || '?') + '周）'
      : '（' + from.slice(0, 7) + '）';
    var headExtra = config && config.company ? '（' + config.company + '）' : '';
    var job = (config && config.jobTitle) || '岗位';

    var L = [];
    L.push('【实习' + (isWeek ? '周报' : '月报') + '】' + from + ' ~ ' + to + batch + headExtra);
    L.push('');
    L.push('一、本' + unit + '完成工作');
    var heads = pickN(rng, WORK_HEADS, WORK_HEADS.length);
    var tails = pickN(rng, WORK_TAILS, WORK_TAILS.length);
    top.forEach(function (t, i) {
      L.push((i + 1) + '. ' + tf(heads[i % heads.length], { m: t[0], c: t[1] }) + tails[i % tails.length]);
    });
    if (extras.length) {
      L.push((top.length + 1) + '. 其他专项工作：' + extras.join('；') + '。');
    }
    L.push('');
    L.push('二、收获与成长');
    var modsStr = top.slice(0, 2).map(function (t) { return t[0]; }).join('」「');
    L.push(tf(choice(rng, GAIN_MAIN), { unit: unit, mods: modsStr, job: job }));
    pickN(rng, GAIN_TAILS, 2).forEach(function (s) { L.push(s); });
    L.push('');
    L.push('三、遇到的问题与改进');
    if (problems.length) {
      problems.slice(0, 3).forEach(function (p, i) { L.push((i + 1) + '. ' + p); });
      L.push((Math.min(problems.length, 3) + 1) + '. ' + choice(rng, FIX_PATS));
    } else {
      L.push('本' + unit + '工作整体平稳顺利，未出现明显问题；' + choice(rng, SMOOTH_TAILS));
    }
    L.push('');
    L.push('四、下' + unit + '工作计划');
    var all = (config && config.modules) ? config.modules.slice() : top.map(function (t) { return t[0]; });
    var least = all.sort(function (a, b) { return (mc[a] || 0) - (mc[b] || 0); }).slice(0, 3);
    var planPool = pickN(rng, PLAN_PATS, PLAN_PATS.length);
    least.forEach(function (m, i) {
      L.push((i + 1) + '. ' + tf(planPool[i % planPool.length], { m: m }));
    });
    L.push((least.length + 1) + '. ' + choice(rng, PLAN_CLOSERS));

    return { text: L.join('\n'), count: recs.length, from: from, to: to, type: type };
  }

  /* ---------- 实习总结句式池 ---------- */
  var SUM_OVERVIEW = [
    '在{co}进行{jt}岗位实习以来，我严格遵守单位的各项规章制度，按时出勤打卡，认真完成带教老师安排的各项工作任务，逐步实现了从学生到职场人的角色转变。',
    '自来到{co}担任{jt}实习生以来，我尽快适应了从校园到职场的转变，遵守单位制度、服从工作安排，在带教老师的指导下逐项落实岗位职责。',
    '{jt}岗位的实习让我第一次完整地经历了职场日常。在{co}期间，我坚持按时出勤、主动请教，把带教老师交办的每一件事做完整、有回音。'
  ];
  var SUM_WORK_HEADS = [
    '{m}：实习期间累计开展 {c} 次',
    '{m}：累计参与 {c} 次',
    '{m}：开展了 {c} 次',
    '{m}：经手 {c} 次',
    '{m}：累计完成 {c} 次',
    '{m}：前后投入 {c} 次'
  ];
  var SUM_WORK_TAILS = [
    '，从最初需要在指导下完成，到后期能够独立、规范地处理。',
    '，已经能够按岗位标准独立完成，质量保持稳定。',
    '，从生疏到熟练，逐渐形成了自己的操作节奏。',
    '，相关流程与注意事项都已熟练掌握，并能提示同批实习生。',
    '，从一开始的手忙脚乱到现在的心里有数。',
    '，处理的规范程度多次得到带教老师认可。'
  ];
  var SUM_SKILL = [
    '专业能力方面：通过「{mods}」等核心工作的反复实践，掌握了岗位的基本技能和操作规范，做到了理论与实际相结合。',
    '专业能力方面：「{mods}」等任务从上手到熟练，让我把课堂知识真正落到了操作层面，技能短板得到针对性补强。',
    '专业能力方面：围绕「{mods}」等工作持续练习，能够独立按规范完成主要业务，处理速度和准确率都有明显提升。'
  ];
  var SUM_QUALITY = [
    '职业素养方面：养成了按时出勤、每日记录、及时复盘的工作习惯，沟通表达和团队协作能力得到明显锻炼。',
    '职业素养方面：形成了守时、有条理、有回音的工作方式，主动沟通和团队配合的意识显著增强。',
    '职业素养方面：从被安排到主动认领任务，责任心和执行力得到了实实在在的锤炼。'
  ];
  var SUM_MIND = [
    '个人认知方面：更加清楚地认识到细心、耐心和责任心在实际工作中的重要性，也更加明确了自己今后的努力方向。',
    '个人认知方面：体会到任何岗位都没有"简单的事"，把普通事做到位本身就是竞争力。',
    '个人认知方面：对职业选择有了更务实的判断，知道了差距在哪里、该往哪个方向补。'
  ];
  var SUM_SHORT = [
    '回顾整个实习过程，仍存在一些不足：一是遇到复杂问题时独立解决的能力还有待提高；二是对业务全貌的了解还不够全面；三是时间管理和统筹安排仍有优化空间。',
    '复盘这段实习，我的不足主要有三点：复杂情形下仍依赖老师提示、对跨环节业务的了解偏浅、工作节奏前松后紧需要更合理的统筹。'
  ];
  var SUM_NEXT = [
    '今后将有针对性地加强学习，多向老师傅和同事请教，主动承担任务，在实践中不断提升自己。',
    '接下来会带着问题清单补短板，把学到的规范和方法用到后续学习与工作中，争取独当一面。',
    '回到学校后，我会针对暴露出的弱项系统充电，为正式走上工作岗位做好更充分的准备。'
  ];
  var SUM_END = [
    '感谢学校提供的实习机会，感谢单位带教老师的悉心指导和同事们的热情帮助。这段实习经历让我收获了课堂上学不到的宝贵经验，为今后走上工作岗位打下了坚实基础。',
    '衷心感谢单位与学校的共同培养。这段日子让我完成了从课堂到岗位的第一步跨越，收获的经验和能力会一直受益。',
    '谢谢每一位帮助过我的老师和同事。这段实习让我对未来的职业道路更加笃定，也更有底气面对接下来的挑战。'
  ];

  /* ---------- 实习总结（学习通「总结」入口） ---------- */
  function internshipSummary(config, reports) {
    var dates = Object.keys(reports).sort();
    if (!dates.length) return null;
    var recs = dates.map(function (d) { return reports[d]; });

    var rng = makeRng('sum#' + dates[0] + '#' + dates[dates.length - 1] + '#' + recs.length);

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
    L.push('【实习总结】' + company + ' · ' + jobTitle);
    L.push('实习时间：' + span + '（累计记录日报 ' + totalDays + ' 天）');
    L.push('');
    L.push('一、实习概况');
    L.push(tf(choice(rng, SUM_OVERVIEW), { co: company, jt: jobTitle }));
    L.push('');
    L.push('二、主要工作内容');
    var wh = pickN(rng, SUM_WORK_HEADS, SUM_WORK_HEADS.length);
    var st = pickN(rng, SUM_WORK_TAILS, SUM_WORK_TAILS.length);
    top.slice(0, 6).forEach(function (t, i) {
      L.push((i + 1) + '. ' + tf(wh[i % wh.length], { m: t[0], c: t[1] }) + st[i % st.length]);
    });
    if (extras.length) {
      L.push((Math.min(top.length, 6) + 1) + '. 其他专项工作：' + extras.join('；') + '。');
    }
    L.push('');
    L.push('三、收获与成长');
    L.push(tf(choice(rng, SUM_SKILL), { mods: modsStr }));
    L.push(choice(rng, SUM_QUALITY));
    L.push(choice(rng, SUM_MIND));
    L.push('');
    L.push('四、不足与改进方向');
    L.push(choice(rng, SUM_SHORT));
    L.push(choice(rng, SUM_NEXT));
    L.push('');
    L.push('五、结语');
    L.push(choice(rng, SUM_END));

    return { text: L.join('\n'), count: totalDays, span: span };
  }

  window.Composer = {
    aggregate: aggregate,
    internshipSummary: internshipSummary,
    weekNumber: weekNumber,
    inRange: inRange
  };
})();
