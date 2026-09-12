/* ============================================================
 * app.js — 页签路由 / 主题 / 今日该交面板 / 设置向导 / 素材库 / 备份
 * ============================================================ */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------- 页签 ---------- */
  function goTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
    if (name === 'calendar') Calendar.render();
    if (name === 'aggregate') { Editor.renderAggStat(); Editor.renderSavedList(); }
    if (name === 'summary') Editor.renderSummaryStat();
    window.scrollTo({ top: 0 });
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    var theme = Store.data.settings.theme || 'light';
    document.documentElement.dataset.theme = theme;
    $('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  function toggleTheme() {
    Store.data.settings.theme = Store.data.settings.theme === 'dark' ? 'light' : 'dark';
    Store.save();
    applyTheme();
  }

  /* ============================================================
   * 批次截止日计算（周报=每周星期X，月报=每月X日/月末）
   * ============================================================ */
  function nextWeeklyDeadline(dow) {
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var d = new Date(t);
    d.setDate(t.getDate() + (Number(dow) - t.getDay() + 7) % 7);
    return d;
  }
  function nextMonthlyDeadline(dom) {
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var y = t.getFullYear(), m = t.getMonth();
    if (dom === 'last') {
      var last = new Date(y, m + 1, 0);
      return last < t ? new Date(y, m + 2, 0) : last;
    }
    var d = new Date(y, m, Number(dom));
    if (d < t) d = new Date(y, m + 1, Number(dom));
    return d;
  }

  /* ============================================================
   * 今日该交（对照学习通：日报按天、周报月报按批次、过期可能不能补交）
   * ============================================================ */
  function renderDue() {
    var wrap = $('dueStripWrap');
    if (!Store.data.config) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var cfg = Store.data.config;

    var today = new Date();
    var todayStr = Store.today();
    var chips = [];

    // 日报
    var r = Store.data.reports[todayStr];
    if (r && r.submitted) {
      chips.push('<span class="due-chip ok">日报：今日已提交 ✓</span>');
    } else if (r) {
      chips.push('<span class="due-chip todo" data-goto="daily">日报：已生成未提交 → 去提交</span>');
    } else {
      chips.push('<span class="due-chip todo" data-goto="daily">日报：今天还没写 → 去生成</span>');
    }

    // 本周周报素材
    var day = today.getDay();
    var monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((day + 6) % 7));
    var sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    var weekN = Composer.inRange(Store.data.reports, Store.fmt(monday), Store.fmt(sunday)).length;
    chips.push('<span class="due-chip note" data-goto="aggregate">本周日报 ' + weekN + ' 篇 · 周报素材' + (weekN ? ' ✓' : '…') + '</span>');

    // 本月月报素材
    var mFirst = new Date(today.getFullYear(), today.getMonth(), 1);
    var mLast = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    var monthN = Composer.inRange(Store.data.reports, Store.fmt(mFirst), Store.fmt(mLast)).length;
    chips.push('<span class="due-chip note" data-goto="aggregate">本月日报 ' + monthN + ' 篇 · 月报素材</span>');

    // 批次截止倒计时（设置了截止日才显示；≤2 天或当天标警醒色）
    if (cfg.weeklyDue) {
      var wd = Store.fmt(nextWeeklyDeadline(cfg.weeklyDue));
      var daysW = Math.round((Store.parse(wd) - Store.parse(todayStr)) / 864e5);
      var wTxt = daysW === 0 ? '周报批次今天截止！' : '周报批次截止 ' + wd.slice(5) + '（还有 ' + daysW + ' 天）';
      chips.push('<span class="due-chip ' + (daysW <= 2 ? 'todo' : 'note') + '" data-goto="aggregate">' + wTxt + '</span>');
    }
    if (cfg.monthlyDue) {
      var md = Store.fmt(nextMonthlyDeadline(cfg.monthlyDue));
      var daysM = Math.round((Store.parse(md) - Store.parse(todayStr)) / 864e5);
      var mTxt = daysM === 0 ? '月报批次今天截止！' : '月报批次截止 ' + md.slice(5) + '（还有 ' + daysM + ' 天）';
      chips.push('<span class="due-chip ' + (daysM <= 2 ? 'todo' : 'note') + '" data-goto="aggregate">' + mTxt + '</span>');
    }

    // 提醒
    chips.push('<span class="due-chip note">⏰ 过期报告可能不让补交，尽量当天完成</span>');

    $('dueStrip').innerHTML = chips.join('');
  }

  /* ============================================================
   * 设置向导
   * ============================================================ */
  var sel = { jobType: null, modules: [], custom: [] };

  function renderJobGrid() {
    var grid = $('jobGrid');
    grid.innerHTML = '';
    Object.keys(Phrases.jobTypes).forEach(function (key) {
      var jt = Phrases.jobTypes[key];
      var card = document.createElement('div');
      card.className = 'job-card' + (sel.jobType === key ? ' active' : '');
      card.textContent = jt.name;
      card.addEventListener('click', function () {
        sel.jobType = key;
        // 预置模块默认勾选前 4 个
        sel.modules = jt.modules.slice(0, 4);
        renderJobGrid();
        renderModuleBox();
      });
      grid.appendChild(card);
    });
  }

  function renderModuleBox() {
    var box = $('moduleBox');
    box.innerHTML = '';
    if (!sel.jobType) {
      box.innerHTML = '<p class="hint">先在上方选择岗位类型，会自动带出该岗位常见的工作模块。</p>';
      return;
    }
    var preset = Phrases.jobTypes[sel.jobType].modules;
    preset.concat(sel.custom).forEach(function (m) {
      var chip = document.createElement('span');
      var on = sel.modules.indexOf(m) >= 0;
      chip.className = 'module-chip' + (on ? ' active' : '');
      chip.innerHTML = '<span class="m-name">' + m + '</span>' +
        (sel.custom.indexOf(m) >= 0 ? '<span class="m-del" title="移除">✕</span>' : '');
      chip.addEventListener('click', function (e) {
        if (e.target.className === 'm-del') {
          sel.custom = sel.custom.filter(function (x) { return x !== m; });
          sel.modules = sel.modules.filter(function (x) { return x !== m; });
          renderModuleBox();
          return;
        }
        var i = sel.modules.indexOf(m);
        if (i >= 0) sel.modules.splice(i, 1);
        else sel.modules.push(m);
        renderModuleBox();
      });
      box.appendChild(chip);
    });
  }

  /* ---------- 日报栏目自定义 ---------- */
  function renderSectionsEditor(sections) {
    var box = $('sectionsBox');
    box.innerHTML = '';
    sections.forEach(function (sec) {
      var row = document.createElement('div');
      row.className = 'sec-row';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.key = sec.key;
      cb.checked = sec.key === 'done' ? true : !!sec.on;
      cb.disabled = sec.key === 'done'; // 「今日完成」为核心栏目，不可关闭
      cb.title = cb.disabled ? '「今日完成」为核心栏目，不可关闭' : '';

      var input = document.createElement('input');
      input.type = 'text';
      input.value = sec.title;
      input.placeholder = { done: '今日完成', gains: '收获与学习', problems: '遇到的问题与解决', plans: '明日计划' }[sec.key];

      row.appendChild(cb);
      row.appendChild(input);
      box.appendChild(row);
    });
  }

  function collectSections() {
    var out = [];
    document.querySelectorAll('#sectionsBox .sec-row').forEach(function (row) {
      var cb = row.querySelector('input[type=checkbox]');
      var title = row.querySelector('input[type=text]').value.trim();
      out.push({ key: cb.dataset.key, title: title, on: cb.checked });
    });
    return out;
  }

  function loadConfigToWizard() {
    var cfg = Store.data.config;
    if (!cfg) {
      renderSectionsEditor(Generator.defaultSections());
      return;
    }
    sel.jobType = cfg.jobType;
    sel.modules = cfg.modules.slice();
    // 配置里不在预置里的模块视为自定义
    var preset = Phrases.jobTypes[cfg.jobType] ? Phrases.jobTypes[cfg.jobType].modules : [];
    sel.custom = cfg.modules.filter(function (m) { return preset.indexOf(m) < 0; });
    $('cfgStart').value = cfg.startDate || '';
    $('cfgEnd').value = cfg.endDate || '';
    $('cfgMinWords').value = cfg.minWords || 300;
    $('cfgCompany').value = cfg.company || '';
    $('cfgJobTitle').value = cfg.jobTitle || '';
    $('cfgWeeklyDue').value = cfg.weeklyDue || '';
    $('cfgMonthlyDue').value = cfg.monthlyDue || '';
    renderSectionsEditor(cfg.sections && cfg.sections.length ? cfg.sections : Generator.defaultSections());
    renderJobGrid();
    renderModuleBox();
  }

  function saveConfig() {
    if (!sel.jobType) { toast('请先选择岗位类型'); return; }
    if (!sel.modules.length) { toast('至少勾选一个工作模块'); return; }
    Store.data.config = {
      jobType: sel.jobType,
      modules: sel.modules.slice(),
      startDate: $('cfgStart').value || null,
      endDate: $('cfgEnd').value || null,
      minWords: parseInt($('cfgMinWords').value, 10) || 300,
      company: $('cfgCompany').value.trim(),
      jobTitle: $('cfgJobTitle').value.trim(),
      weeklyDue: $('cfgWeeklyDue').value,
      monthlyDue: $('cfgMonthlyDue').value,
      sections: collectSections()
    };
    Store.save();
    $('setupBanner').hidden = true;
    renderDue();
    Editor.renderDaily();
    Editor.renderAggStat();
    toast('配置已保存，去「今日日报」一键生成 ✨');
    goTab('daily');
  }

  /* ============================================================
   * 素材库
   * ============================================================ */
  var phraseCat = '全部';

  function renderPhraseCats() {
    var select = $('phraseCat');
    select.innerHTML = '';
    ['全部'].concat(Object.keys(Phrases.library).concat(['我的收藏'])).forEach(function (c) {
      var op = document.createElement('option');
      op.value = c; op.textContent = c;
      select.appendChild(op);
    });
    select.value = phraseCat;
  }

  function renderPhrases() {
    var list = $('phraseList');
    list.innerHTML = '';
    var items = [];
    if (phraseCat === '全部') {
      Object.keys(Phrases.library).forEach(function (c) {
        Phrases.library[c].forEach(function (p) { items.push(p); });
      });
      Store.data.customPhrases.forEach(function (p) { items.push(p); });
    } else if (phraseCat === '我的收藏') {
      items = Store.data.customPhrases.slice();
      if (!items.length) list.innerHTML = '<p class="hint">还没有收藏，在下方输入框收藏你的常用句式。</p>';
    } else {
      items = Phrases.library[phraseCat] || [];
    }

    items.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'phrase-item';
      var span = document.createElement('span');
      span.className = 'phrase-text';
      span.textContent = p;
      var copyBtn = document.createElement('button');
      copyBtn.className = 'btn sm ghost';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', function () { Editor.copyText(p, '句式已复制'); });
      var insBtn = document.createElement('button');
      insBtn.className = 'btn sm';
      insBtn.textContent = '插入今日日报';
      insBtn.addEventListener('click', function () {
        var ta = $('reportEditor');
        ta.value = (ta.value ? ta.value.replace(/\n$/, '') + '\n' : '') + p;
        Editor.renderDaily();
        goTab('daily');
        toast('已插入今日日报末尾');
      });
      li.appendChild(span); li.appendChild(insBtn); li.appendChild(copyBtn);
      list.appendChild(li);
    });
  }

  /* ============================================================
   * 备份
   * ============================================================ */
  function exportBackup() {
    var blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '实习日报备份_' + Store.today() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function bindBackup() {
    $('exportBtn').addEventListener('click', exportBackup);
    $('importFile').addEventListener('change', function () {
      var f = this.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        Store.importJSON(reader.result, function () {
          applyTheme();
          loadConfigToWizard();
          Editor.renderDaily(); Editor.renderAggStat(); Editor.renderSummaryStat();
          Calendar.render(); Calendar.renderTodos();
          renderDue(); renderPhrases();
          toast('导入成功 ✓');
        }, function () { toast('导入失败：文件格式不对'); });
      };
      reader.readAsText(f);
      this.value = '';
    });
    $('clearBtn').addEventListener('click', function () {
      if (!confirm('确定清空全部数据？建议先导出备份。（此操作不可恢复）')) return;
      Store.reset();
      location.reload();
    });
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  function init() {
    applyTheme();
    $('themeBtn').addEventListener('click', toggleTheme);

    // 页签
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (b) goTab(b.dataset.tab);
    });

    // 首次使用横幅
    if (!Store.data.config) {
      $('setupBanner').hidden = false;
    }
    $('bannerSetupBtn').addEventListener('click', function () { goTab('settings'); });

    // 今日该交面板点击跳转
    $('dueStrip').addEventListener('click', function (e) {
      var chip = e.target.closest('.due-chip');
      if (chip && chip.dataset.goto) goTab(chip.dataset.goto);
    });

    // 设置向导
    renderJobGrid();
    renderModuleBox();
    loadConfigToWizard();
    $('moduleAdd').addEventListener('click', function () {
      var v = $('customModule').value.trim();
      if (!v) return;
      if (sel.custom.indexOf(v) < 0 && sel.modules.indexOf(v) < 0) {
        sel.custom.push(v);
        sel.modules.push(v);
      }
      $('customModule').value = '';
      renderModuleBox();
    });
    $('customModule').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('moduleAdd').click();
    });
    $('cfgSave').addEventListener('click', saveConfig);

    // 素材库
    renderPhraseCats();
    renderPhrases();
    $('phraseCat').addEventListener('change', function () {
      phraseCat = this.value;
      renderPhrases();
    });
    $('phraseCatAll').addEventListener('click', function () {
      phraseCat = '全部';
      $('phraseCat').value = '全部';
      renderPhrases();
    });
    $('phraseAdd').addEventListener('click', function () {
      var v = $('phraseInput').value.trim();
      if (!v) return;
      Store.data.customPhrases.push(v);
      Store.save();
      $('phraseInput').value = '';
      phraseCat = '我的收藏';
      $('phraseCat').value = '我的收藏';
      renderPhrases();
      toast('已收藏');
    });

    // 备份
    bindBackup();

    // 子模块
    Editor.init();
    Calendar.init();

    // 面板
    renderDue();
  }

  window.App = {
    init: init,
    toast: toast,
    goTab: goTab,
    renderDue: renderDue
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
