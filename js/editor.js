/* ============================================================
 * editor.js — 日报 / 周报月报 / 实习总结 三个页签的交互逻辑
 * ============================================================ */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    date: Store.today(),          // 当前编辑的日报日期
    aggType: 'weekly',
    aggRange: 'this',
    aggFrom: null,
    aggTo: null
  };
  var lastGenerated = null;       // 最近一次生成结果（结构化字段随保存落库）
  var manualEdited = false;       // 用户是否手动改过当前编辑器内容（重新生成前据此确认）
  var snapshot = { date: null, text: '', extra: '' };  // 上一次写进编辑器的内容，用于识别未保存改动
  var draftTimer = null;          // 草稿落盘防抖
  var AGG_DRAFT_MAX = 12;         // 周月报草稿最多保留份数，防止 localStorage 无限增长
  var DRAFT_SAVE_DELAY = 400;     // 输入停顿多久后把草稿写进 localStorage

  /* ---------- 工具 ---------- */
  function shiftDate(dateStr, delta) {
    var d = Store.parse(dateStr);
    d.setDate(d.getDate() + delta);
    return Store.fmt(d);
  }

  /* ============================================================
   * 草稿暂存：任何「未点保存的输入」都先落进 Store.data.drafts，
   * 切日期 / 切范围 / 切页签 / 刷新 / 关页面都不会再丢内容。
   * ============================================================ */
  function drafts() {
    if (!Store.data.drafts || typeof Store.data.drafts !== 'object') Store.data.drafts = {};
    var d = Store.data.drafts;
    if (!d.daily || typeof d.daily !== 'object') d.daily = {};
    if (!d.agg || typeof d.agg !== 'object') d.agg = {};
    if (typeof d.summary !== 'string') d.summary = '';
    return d;
  }

  function scheduleSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { draftTimer = null; Store.save(); }, DRAFT_SAVE_DELAY);
  }

  function flushSave() {
    clearTimeout(draftTimer);
    draftTimer = null;
    Store.save();
  }

  // 与已保存的日报内容一致就删掉草稿，保持草稿库干净
  function putDailyDraft(date, text, extra) {
    var d = drafts();
    var rec = Store.data.reports[date];
    var savedText = rec ? (rec.text || '') : '';
    var savedExtra = (rec && rec.extra) || '';
    if (!text || (text === savedText && extra === savedExtra)) delete d.daily[date];
    else d.daily[date] = { text: text, extra: extra, updatedAt: Date.now() };
    scheduleSave();
  }

  function aggKey() {
    var r = currentRange();
    return state.aggType + '_' + r.from + '_' + r.to;
  }

  function putAggDraft() {
    var d = drafts();
    var key = aggKey();
    var raw = $('aggEditor').value;
    if (!raw.trim()) { delete d.agg[key]; scheduleSave(); return; }
    d.agg[key] = { text: raw, updatedAt: Date.now() };
    var keys = Object.keys(d.agg).sort(function (a, b) {
      return (d.agg[a].updatedAt || 0) - (d.agg[b].updatedAt || 0);
    });
    while (keys.length > AGG_DRAFT_MAX) delete d.agg[keys.shift()];
    scheduleSave();
  }

  function putSummaryDraft() {
    var d = drafts();
    d.summary = $('sumEditor').value.trim() ? $('sumEditor').value : '';
    scheduleSave();
  }

  function setHint(id, on, text) {
    var el = $(id);
    if (!el) return;
    if (on) { el.textContent = text; el.hidden = false; }
    else el.hidden = true;
  }

  // 当前日报是否有未保存的修改（与已保存记录比对）
  function dailyDiffers() {
    var rec = Store.data.reports[state.date];
    return $('reportEditor').value.trim() !== (rec ? (rec.text || '') : '') ||
      $('extraInput').value.trim() !== ((rec && rec.extra) || '');
  }

  function refreshDraftHint(restored) {
    if (restored) {
      setHint('draftHint', true, '已自动恢复上次未保存的修改；点「💾 保存」正式存入。');
      return;
    }
    setHint('draftHint', dailyDiffers(),
      '有未保存的修改（已自动暂存，切日期、关页面都不会丢）；点「💾 保存」正式存入。');
  }

  function wordCount() {
    return Generator.charCount($('reportEditor').value);
  }

  function copyText(text, tip) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); App.toast(tip || '已复制，去学习通粘贴提交吧'); }
      catch (e) { App.toast('复制失败，请手动全选复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        App.toast(tip || '已复制，去学习通粘贴提交吧');
      }, fallback);
    } else fallback();
  }

  function printText(text, title) {
    var sheet = $('printSheet');
    sheet.innerHTML = '';
    var pre = document.createElement('pre');
    pre.textContent = (title ? title + '\n\n' : '') + text;
    sheet.appendChild(pre);
    window.print();
  }

  /* ============================================================
   * 日报页签
   * ============================================================ */
  function renderDaily(skipStash) {
    // 先把编辑器里尚未落盘的改动按「上一次渲染的日期」暂存下来。
    // 切日期、存配置、导入备份等外部入口都会走到这里，统一在这一处兜住，不丢内容。
    if (!skipStash && snapshot.date) {
      var curText = $('reportEditor').value.trim();
      var curExtra = $('extraInput').value.trim();
      if (curText !== snapshot.text || curExtra !== snapshot.extra) {
        putDailyDraft(snapshot.date, curText, curExtra);
      }
    }

    var r = Store.data.reports[state.date];
    var savedText = r ? (r.text || '') : '';
    var savedExtra = (r && r.extra) || '';
    var draft = drafts().daily[state.date];
    var text = savedText, extra = savedExtra, restored = false;
    if (draft && draft.text && (draft.text !== savedText || (draft.extra || '') !== savedExtra)) {
      text = draft.text;
      extra = draft.extra || '';
      restored = true;
    }

    $('dateInput').value = state.date;
    $('reportEditor').value = text;
    $('extraInput').value = extra;

    // 统计行
    var cfg = Store.data.config;
    var parts = [];
    parts.push('已保存日报 <b>' + Object.keys(Store.data.reports).length + '</b> 篇');
    var submitted = 0;
    Object.keys(Store.data.reports).forEach(function (d) { if (Store.data.reports[d].submitted) submitted++; });
    parts.push('已提交 <b>' + submitted + '</b> 篇');
    if (r && r.submitted) parts.push('<b style="color:var(--ok)">当天报告已标记提交 ✓</b>');
    if (cfg && cfg.endDate) {
      var left = Math.ceil((Store.parse(cfg.endDate) - Store.parse(state.date)) / 864e5);
      parts.push(left > 0 ? '距实习结束 <b>' + left + '</b> 天' : '实习已结束');
    }
    $('dailyStat').innerHTML = parts.join('　·　');

    // 字数
    var min = cfg ? (cfg.minWords || 0) : 0;
    $('wordTarget').textContent = min ? ('要求 ≥ ' + min + ' 字') : '';
    updateWordCount();

    $('markBtn').textContent = (r && r.submitted) ? '↩ 取消已提交' : '✅ 标记已提交';
    manualEdited = restored;
    refreshDraftHint(restored);
    snapshot = { date: state.date, text: text.trim(), extra: extra.trim() };
  }

  // 切换编辑中的日期（统一入口：内容先由 renderDaily 暂存）
  function setDate(d) {
    if (!d || d === state.date) { renderDaily(); return; }
    state.date = d;
    renderDaily();
  }

  function updateWordCount() {
    var n = wordCount();
    var min = Store.data.config ? (Store.data.config.minWords || 0) : 0;
    var el = $('wordCount');
    el.textContent = n + ' 字';
    el.style.color = (min && n >= min) ? 'var(--ok)' : (min ? 'var(--warn)' : 'var(--primary)');
  }

  function configReady() {
    var cfg = Store.data.config;
    if (!cfg) {
      App.toast('请先在「设置」里完成岗位配置');
      App.goTab('settings');
      return null;
    }
    if (!cfg.modules || !cfg.modules.length) {
      App.toast('请先在「设置」里勾选工作模块');
      App.goTab('settings');
      return null;
    }
    return cfg;
  }

  // 轮换统计增减（dir=+1 计入 / -1 回退），保证同一日期重复生成不重复计数
  function bumpStats(dateStr, mods, dir) {
    (mods || []).forEach(function (m) {
      var s = Store.data.moduleStats[m];
      if (!s) {
        if (dir < 0) return;
        s = { count: 0, lastDate: '' };
        Store.data.moduleStats[m] = s;
      }
      s.count += dir;
      if (dir > 0) s.lastDate = dateStr;
      if (s.count <= 0) {
        s.count = 0;
        if (s.lastDate === dateStr) s.lastDate = '';
      }
    });
  }

  function finishGeneration(r, tip) {
    var rec = Store.data.reports[state.date];
    if (rec && rec.statCounted) bumpStats(state.date, rec.modules, -1);
    bumpStats(state.date, r.modules, 1);
    lastGenerated = r;
    manualEdited = false;
    $('reportEditor').value = r.text;
    updateWordCount();
    saveDaily(true);
    App.toast(tip);
    App.renderDue();
  }

  function generateDaily() {
    var cfg = configReady();
    if (!cfg) return;
    if (manualEdited && !confirm('当前内容有手动修改，重新生成会覆盖它。确定继续？')) return;
    var r = Generator.generateDaily(state.date, cfg, Store.data.reports, Store.data.moduleStats, $('extraInput').value.trim());
    if (!r) { App.toast('生成失败，请检查配置'); return; }
    finishGeneration(r, '已生成并保存，可修改后复制提交');
  }

  function generateVariant() {
    var cfg = configReady();
    if (!cfg) return;
    if (manualEdited && !confirm('当前内容有手动修改，换一版会覆盖它。确定继续？')) return;
    var r = Generator.generateDaily(state.date, cfg, Store.data.reports, Store.data.moduleStats,
      $('extraInput').value.trim(), { saltBase: Math.floor(Math.random() * 90000) + 1 });
    if (!r) { App.toast('生成失败，请检查配置'); return; }
    finishGeneration(r, '已换一版并保存，可修改后复制提交');
  }

  function saveDaily(silent) {
    var text = $('reportEditor').value.trim();
    if (!text) { if (!silent) App.toast('内容为空，先写点什么或点生成'); return; }
    var existing = Store.data.reports[state.date];
    var rec = existing || {};
    rec.date = state.date;
    rec.text = text;
    rec.extra = $('extraInput').value.trim();
    // 本次生成且未手动换日期：写入结构化字段（周月报聚合的素材来源）
    if (lastGenerated && lastGenerated.date === state.date) {
      rec.modules = lastGenerated.modules;
      rec.problem = lastGenerated.problem;
      rec.tpls = lastGenerated.tpls || [];
    }
    if (!rec.modules) rec.modules = [];
    rec.statCounted = true;
    rec.updatedAt = new Date().toISOString();
    Store.data.reports[state.date] = rec;
    // 已正式落库，临时草稿使命完成（先删草稿再 save，保证落盘的就是清干净的状态）
    delete drafts().daily[state.date];
    clearTimeout(draftTimer);
    draftTimer = null;
    Store.save();
    if (!silent) App.toast('已保存到本地');
    renderDaily(true); // 编辑器内容此刻就是库里的内容，跳过暂存，避免旧草稿回灌
    App.renderDue();
  }

  function markSubmitted() {
    var r = Store.data.reports[state.date];
    if (!r) { App.toast('请先保存当天的报告'); return; }
    r.submitted = !r.submitted;
    Store.save();
    renderDaily();
    App.renderDue();
    App.toast(r.submitted ? '已标记为已提交 ✓' : '已取消标记');
  }

  /* ============================================================
   * 周报月报页签
   * ============================================================ */
  function currentRange() {
    var today = new Date();
    var y = today.getFullYear(), m = today.getMonth();
    if (state.aggRange === 'custom') {
      return { from: state.aggFrom || Store.today(), to: state.aggTo || Store.today() };
    }
    if (state.aggType === 'weekly') {
      // 本周一 ~ 周日
      var day = today.getDay();
      var monday = new Date(y, m, today.getDate() - ((day + 6) % 7));
      var sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      if (state.aggRange === 'last') {
        monday.setDate(monday.getDate() - 7);
        sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      }
      return { from: Store.fmt(monday), to: Store.fmt(sunday) };
    }
    // 月报：本月 / 上月
    var first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
    if (state.aggRange === 'last') {
      first = new Date(y, m - 1, 1); last = new Date(y, m, 0);
    }
    return { from: Store.fmt(first), to: Store.fmt(last) };
  }

  function renderAggStat() {
    var range = currentRange();
    var n = Composer.inRange(Store.data.reports, range.from, range.to).length;
    var label = state.aggType === 'weekly' ? '周报' : '月报';
    var wn = state.aggType === 'weekly' ? Composer.weekNumber(Store.data.config, range.from) : null;
    $('aggStat').innerHTML =
      '范围：<b>' + range.from + '</b> ~ <b>' + range.to + '</b>' +
      (wn ? '（实习第 <b>' + wn + '</b> 周）' : '') +
      '　·　区间内已有日报 <b>' + n + '</b> 篇' +
      (n === 0 ? '　·　<span style="color:var(--warn)">先在「今日日报」里保存几天的日报再来汇总</span>' : '');
  }

  // 载入当前「类型 + 范围」对应的草稿（切范围、重新打开页面都能接着改）
  function loadAggDraft() {
    var d = drafts().agg[aggKey()];
    $('aggEditor').value = d ? d.text : '';
    setHint('aggDraftHint', !!d, '已自动恢复上次未保存的草稿（切范围、关页面都不会丢）。');
  }

  function generateAgg() {
    var range = currentRange();
    var result = Composer.aggregate(state.aggType, range.from, range.to, Store.data.config, Store.data.reports);
    if (!result) {
      App.toast('该区间还没有已保存的日报');
      return;
    }
    $('aggEditor').value = result.text;
    putAggDraft();
    setHint('aggDraftHint', false, '');
    App.toast('草稿已生成，检查修改后复制提交');
  }

  function saveAgg() {
    var text = $('aggEditor').value.trim();
    if (!text) { App.toast('先生成草稿或粘贴内容'); return; }
    var range = currentRange();
    var id = state.aggType + '_' + range.from + '_' + range.to;
    Store.data.savedAgg[id] = {
      type: state.aggType, from: range.from, to: range.to,
      text: text, createdAt: new Date().toISOString()
    };
    Store.save();
    renderSavedList();
    App.toast('已留档保存（只存本地）');
  }

  /* ---------- 留档列表 ---------- */
  function renderSavedList() {
    var card = $('savedCard'), list = $('savedList');
    if (!card || !list) return;
    var ids = Object.keys(Store.data.savedAgg).sort().reverse();
    card.hidden = ids.length === 0;
    list.innerHTML = '';
    ids.forEach(function (id) {
      var it = Store.data.savedAgg[id];
      var li = document.createElement('li');
      li.className = 'saved-item';

      var meta = document.createElement('div');
      meta.className = 'saved-meta';
      var kind = it.type === 'weekly' ? '周报' : '月报';
      // 留档可能来自导入的备份码，字段一律用纯文本写入，不拼 HTML
      var kindEl = document.createElement('b');
      kindEl.textContent = kind;
      meta.appendChild(kindEl);
      meta.appendChild(document.createTextNode(' ' + (it.from || '') + ' ~ ' + (it.to || '')));
      var atEl = document.createElement('span');
      atEl.className = 'hint';
      atEl.textContent = '　留档于 ' + String(it.createdAt || '').slice(0, 10);
      meta.appendChild(atEl);

      var ops = document.createElement('div');
      ops.className = 'saved-ops';
      var loadBtn = document.createElement('button');
      loadBtn.className = 'btn sm';
      loadBtn.textContent = '载入';
      loadBtn.addEventListener('click', function () {
        $('aggEditor').value = it.text;
        putAggDraft();
        setHint('aggDraftHint', false, '');
        App.toast('已载入留档，可复制或继续修改');
      });
      var delBtn = document.createElement('button');
      delBtn.className = 'btn sm ghost';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', function () {
        if (!confirm('删除这条留档？')) return;
        delete Store.data.savedAgg[id];
        Store.save();
        renderSavedList();
        App.toast('已删除');
      });
      ops.appendChild(loadBtn);
      ops.appendChild(delBtn);

      li.appendChild(meta);
      li.appendChild(ops);
      list.appendChild(li);
    });
  }

  /* ============================================================
   * 实习总结页签
   * ============================================================ */
  function renderSummaryStat() {
    var n = Object.keys(Store.data.reports).length;
    $('sumStat').innerHTML = n
      ? '已积累日报 <b>' + n + '</b> 篇，足以生成一份有血有肉的总结。'
      : '<span style="color:var(--warn)">还没有日报记录——先用一段时间积累，总结才有内容可写。</span>';
  }

  function loadSummaryDraft() {
    var s = drafts().summary;
    if (s) $('sumEditor').value = s;
    setHint('sumDraftHint', !!s, '已自动恢复上次未保存的草稿（关页面也不会丢）。');
  }

  function generateSummary() {
    var result = Composer.internshipSummary(Store.data.config, Store.data.reports);
    if (!result) { App.toast('还没有日报记录'); return; }
    $('sumEditor').value = result.text;
    putSummaryDraft();
    setHint('sumDraftHint', false, '');
    App.toast('实习总结已生成，建议通读一遍并补充个人细节');
  }

  /* ============================================================
   * 绑定事件
   * ============================================================ */
  function bind() {
    // 日报
    $('prevDay').addEventListener('click', function () { setDate(shiftDate(state.date, -1)); });
    $('nextDay').addEventListener('click', function () { setDate(shiftDate(state.date, 1)); });
    $('dateInput').addEventListener('change', function () {
      if (this.value) setDate(this.value);
    });
    $('genBtn').addEventListener('click', generateDaily);
    $('variantBtn').addEventListener('click', generateVariant);
    $('saveBtn').addEventListener('click', function () { saveDaily(false); });
    $('copyBtn').addEventListener('click', function () {
      var t = $('reportEditor').value.trim();
      if (!t) { App.toast('还没有内容'); return; }
      copyText(t);
    });
    $('markBtn').addEventListener('click', markSubmitted);
    $('reportEditor').addEventListener('input', function () {
      updateWordCount();
      var rec = Store.data.reports[state.date];
      var base = (lastGenerated && lastGenerated.date === state.date) ? lastGenerated.text : (rec ? rec.text : '');
      manualEdited = this.value !== base;
      putDailyDraft(state.date, this.value.trim(), $('extraInput').value.trim());
      refreshDraftHint();
    });
    $('extraInput').addEventListener('input', function () {
      putDailyDraft(state.date, $('reportEditor').value.trim(), this.value.trim());
      refreshDraftHint();
    });

    // 周报月报
    $('aggType').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-type]');
      if (!b) return;
      putAggDraft();  // 先把当前范围的草稿暂存，再去载入新范围的
      state.aggType = b.dataset.type;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('active', x === b); });
      renderAggStat();
      loadAggDraft();
    });
    $('rangePicks').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-range]');
      if (!b) return;
      putAggDraft();
      state.aggRange = b.dataset.range;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('active', x === b); });
      $('customRange').hidden = state.aggRange !== 'custom';
      renderAggStat();
      loadAggDraft();
    });
    $('aggFrom').addEventListener('change', function () { putAggDraft(); state.aggFrom = this.value; renderAggStat(); loadAggDraft(); });
    $('aggTo').addEventListener('change', function () { putAggDraft(); state.aggTo = this.value; renderAggStat(); loadAggDraft(); });
    $('aggEditor').addEventListener('input', function () {
      putAggDraft();
      setHint('aggDraftHint', false, '');
    });
    $('aggGenBtn').addEventListener('click', generateAgg);
    $('aggCopyBtn').addEventListener('click', function () {
      var t = $('aggEditor').value.trim();
      if (!t) { App.toast('先生成草稿'); return; }
      copyText(t);
    });
    $('aggSaveBtn').addEventListener('click', saveAgg);
    $('aggPrintBtn').addEventListener('click', function () {
      var t = $('aggEditor').value.trim();
      if (!t) { App.toast('先生成草稿'); return; }
      printText(t);
    });
    $('sumEditor').addEventListener('input', function () {
      putSummaryDraft();
      setHint('sumDraftHint', false, '');
    });

    // 实习总结
    $('sumGenBtn').addEventListener('click', generateSummary);
    $('sumCopyBtn').addEventListener('click', function () {
      var t = $('sumEditor').value.trim();
      if (!t) { App.toast('先生成总结'); return; }
      copyText(t);
    });
    $('sumPrintBtn').addEventListener('click', function () {
      var t = $('sumEditor').value.trim();
      if (!t) { App.toast('先生成总结'); return; }
      printText(t);
    });
  }

  /* ============================================================
   * 离开页面前兜底：把三个编辑器的内容全部落盘
   * （手机上切后台 / 关页面不一定触发 unload，所以 pagehide 与
   *   visibilitychange 都挂上，双保险）
   * ============================================================ */
  function flushAll() {
    if (snapshot.date) {
      var t = $('reportEditor').value.trim();
      var e = $('extraInput').value.trim();
      if (t !== snapshot.text || e !== snapshot.extra) putDailyDraft(snapshot.date, t, e);
    }
    putAggDraft();
    putSummaryDraft();
    flushSave();
  }
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushAll();
  });

  window.Editor = {
    init: function () {
      bind();
      renderDaily();
      renderAggStat();
      loadAggDraft();
      renderSavedList();
      renderSummaryStat();
      loadSummaryDraft();
    },
    renderDaily: renderDaily,
    renderAggStat: renderAggStat,
    renderSavedList: renderSavedList,
    renderSummaryStat: renderSummaryStat,
    setDate: setDate,
    // 整份数据被替换后（导入备份等）调用：重置快照并重绘，避免把旧内容当成草稿写回新数据
    resync: function () {
      snapshot = { date: null, text: '', extra: '' };
      state.date = Store.today();
      renderDaily();
      renderAggStat();
      loadAggDraft();
      renderSavedList();
      renderSummaryStat();
      loadSummaryDraft();
    },
    // 外部改动编辑器内容后调用（如素材库插入句式）：标记为手动修改并暂存草稿
    contentChanged: function () {
      updateWordCount();
      manualEdited = true;
      putDailyDraft(state.date, $('reportEditor').value.trim(), $('extraInput').value.trim());
      refreshDraftHint();
    },
    copyText: copyText,
    printText: printText
  };
})();
