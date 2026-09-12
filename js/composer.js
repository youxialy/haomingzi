/* ============================================================
 * composer.js — 周报 / 月报 / 实习总结 聚合生成
 * 汇总来源是区间内已保存日报的结构化数据（modules / extra / problem）。
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

  /* ---------- 周报 / 月报 ---------- */
  function aggregate(type, from, to, config, reports) {
    var recs = inRange(reports, from, to);
    if (!recs.length) return null;

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

    var L = [];
    L.push('【实习' + (isWeek ? '周报' : '月报') + '】' + from + ' ~ ' + to + batch + headExtra);
    L.push('');
    L.push('一、本' + unit + '完成工作');
    top.forEach(function (t, i) {
      L.push((i + 1) + '. ' + t[0] + '：累计开展 ' + t[1] + ' 次，均按要求完成。');
    });
    if (extras.length) {
      L.push((top.length + 1) + '. 其他专项工作：' + extras.join('；') + '。');
    }
    L.push('');
    L.push('二、收获与成长');
    L.push('本' + unit + '通过持续参与「' + top.slice(0, 2).map(function (t) { return t[0]; }).join('」「') + '」等工作，岗位技能更加熟练，对' + ((config && config.jobTitle) || '岗位') + '整体业务流程的理解更加系统。');
    L.push('坚持每日记录与复盘，工作规范意识、沟通协作能力都有明显提升。');
    L.push('');
    L.push('三、遇到的问题与改进');
    if (problems.length) {
      problems.slice(0, 3).forEach(function (p, i) { L.push((i + 1) + '. ' + p); });
      L.push((Math.min(problems.length, 3) + 1) + '. 针对以上问题，后续将提前确认规范要求、合理安排时间，减少重复出错。');
    } else {
      L.push('本' + unit + '工作整体平稳顺利，未出现明显问题；个别细节问题均已当日解决并记录在日报中。');
    }
    L.push('');
    L.push('四、下' + unit + '工作计划');
    var all = (config && config.modules) ? config.modules.slice() : top.map(function (t) { return t[0]; });
    var least = all.sort(function (a, b) { return (mc[a] || 0) - (mc[b] || 0); }).slice(0, 3);
    least.forEach(function (m, i) {
      L.push((i + 1) + '. 继续做好' + m + '相关工作，进一步提高效率与质量。');
    });
    L.push((least.length + 1) + '. 坚持每日记录与复盘，配合指导老师安排完成各项任务。');

    return { text: L.join('\n'), count: recs.length, from: from, to: to, type: type };
  }

  /* ---------- 实习总结（学习通「总结」入口） ---------- */
  function internshipSummary(config, reports) {
    var dates = Object.keys(reports).sort();
    if (!dates.length) return null;
    var recs = dates.map(function (d) { return reports[d]; });

    var mc = moduleCounts(recs);
    var top = Object.keys(mc).map(function (k) { return [k, mc[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });

    var extras = [];
    recs.forEach(function (r) { if (r.extra && extras.indexOf(r.extra) < 0) extras.push(r.extra); });

    var span = dates[0] + ' ~ ' + dates[dates.length - 1];
    var company = (config && config.company) || '实习单位';
    var jobTitle = (config && config.jobTitle) || '实习岗位';
    var totalDays = recs.length;

    var L = [];
    L.push('【实习总结】' + company + ' · ' + jobTitle);
    L.push('实习时间：' + span + '（累计记录日报 ' + totalDays + ' 天）');
    L.push('');
    L.push('一、实习概况');
    L.push('在' + company + '进行' + jobTitle + '岗位实习以来，我严格遵守单位的各项规章制度，按时出勤打卡，认真完成带教老师安排的各项工作任务，逐步实现了从学生到职场人的角色转变。');
    L.push('');
    L.push('二、主要工作内容');
    top.slice(0, 6).forEach(function (t, i) {
      L.push((i + 1) + '. ' + t[0] + '：实习期间累计开展 ' + t[1] + ' 次，从最初需要在指导下完成，到后期能够独立、规范地处理。');
    });
    if (extras.length) {
      L.push((Math.min(top.length, 6) + 1) + '. 其他专项工作：' + extras.join('；') + '。');
    }
    L.push('');
    L.push('三、收获与成长');
    L.push('专业能力方面：通过「' + top.slice(0, 2).map(function (t) { return t[0]; }).join('」「') + '」等核心工作的反复实践，掌握了岗位的基本技能和操作规范，做到了理论与实际相结合。');
    L.push('职业素养方面：养成了按时出勤、每日记录、及时复盘的工作习惯，沟通表达和团队协作能力得到明显锻炼。');
    L.push('个人认知方面：更加清楚地认识到细心、耐心和责任心在实际工作中的重要性，也更加明确了自己今后的努力方向。');
    L.push('');
    L.push('四、不足与改进方向');
    L.push('回顾整个实习过程，仍存在一些不足：一是遇到复杂问题时独立解决的能力还有待提高；二是对业务全貌的了解还不够全面；三是时间管理和统筹安排仍有优化空间。');
    L.push('今后将有针对性地加强学习，多向老师傅和同事请教，主动承担任务，在实践中不断提升自己。');
    L.push('');
    L.push('五、结语');
    L.push('感谢学校提供的实习机会，感谢单位带教老师的悉心指导和同事们的热情帮助。这段实习经历让我收获了课堂上学不到的宝贵经验，为今后走上工作岗位打下了坚实基础。');

    return { text: L.join('\n'), count: totalDays, span: span };
  }

  window.Composer = {
    aggregate: aggregate,
    internshipSummary: internshipSummary,
    weekNumber: weekNumber,
    inRange: inRange
  };
})();
