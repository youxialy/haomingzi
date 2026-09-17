/* ============================================================
 * app.js — 页签路由 / 主题 / 今日该交面板 / 设置向导 / 素材库 / 备份
 * ============================================================ */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 反馈渠道配置（填上即显示对应入口；按顺序展示，GitHub 永远兜底） ---------- */
  var FEEDBACK = {
    qqGroup: '702547095',   // QQ 反馈群号（同学零门槛：复制群号搜索加群）
    txc: '',       // 腾讯兔小巢链接，如 'https://support.qq.com/product/xxxxx'（QQ/微信登录即可留言）
    github: 'https://github.com/youxialy/haomingzi/issues'  // 兜底渠道：需 GitHub 账号
  };

  /* ---------- Toast ---------- */
  var toastTimer = null;
  // 屏幕阅读器播报：错误类消息用 assertive，普通提示用 polite
  function toast(msg, kind) {
    var t = $('toast');
    t.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 4200 : 2400);
  }

  /* ---------- 常驻提示条（保存失败 / 备份码过大 / 导入异常） ---------- */
  function showNotice(html, kind) {
    var b = $('noticeBanner');
    if (!b) return;
    $('noticeText').innerHTML = html;
    b.className = 'banner ' + (kind || 'warn');
    b.hidden = false;
  }
  function hideNotice() {
    var b = $('noticeBanner');
    if (b) b.hidden = true;
  }

  /* ---------- 页签 ---------- */
  function goTab(name) {
    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var panels = document.querySelectorAll('.panel');
    Array.prototype.forEach.call(panels, function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
    if (name === 'calendar') Calendar.render();
    if (name === 'aggregate') { Editor.renderAggStat(); Editor.renderSavedList(); }
    if (name === 'summary') Editor.renderSummaryStat();
    if (name === 'settings') renderBackupHint();
    window.scrollTo({ top: 0 });
  }

  /* ---------- 主题 ---------- */
  // '' = 跟随系统；'light' / 'dark' = 用户显式选择（点过切换按钮）
  var darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function resolvedTheme() {
    var t = Store.data.settings.theme;
    if (t === 'dark' || t === 'light') return t;
    return (darkMQ && darkMQ.matches) ? 'dark' : 'light';
  }
  function applyTheme() {
    var theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    $('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
    $('themeBtn').title = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    var meta = $('themeColorMeta');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#14161c' : '#3b56e0');
  }
  function toggleTheme() {
    Store.data.settings.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
    Store.save();
    applyTheme();
  }
  // 用户没手动选过主题时，跟随系统实时变化
  if (darkMQ) {
    var onSystemThemeChange = function () { if (!Store.data.settings.theme) applyTheme(); };
    if (darkMQ.addEventListener) darkMQ.addEventListener('change', onSystemThemeChange);
    else if (darkMQ.addListener) darkMQ.addListener(onSystemThemeChange);
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
      // 用真正的 button：键盘可 Tab 到、可回车触发，读屏也能报出「按钮」
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'job-card' + (sel.jobType === key ? ' active' : '');
      card.setAttribute('aria-pressed', sel.jobType === key ? 'true' : 'false');
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
    var jt = Phrases.jobTypes[sel.jobType];
    if (!jt) {
      // 配置里的岗位 key 在本版本不存在（多由导入他人备份或旧版数据造成）。
      // 这里必须给提示而不是直接取 .modules —— 否则会抛错，而抛错会被导入流程
      // 误判成「备份码已损坏」，用户会以为数据没恢复。
      var warn = document.createElement('p');
      warn.className = 'hint';
      warn.textContent = '当前保存的岗位类型「' + sel.jobType + '」在本版本里不存在（可能来自旧版本或他人的备份）。'
        + '你的日报数据都还在，请在上方重新选择一个岗位类型，然后点「💾 保存配置」。';
      box.appendChild(warn);
      return;
    }
    var preset = jt.modules;
    preset.concat(sel.custom).forEach(function (m) {
      var chip = document.createElement('span');
      var on = sel.modules.indexOf(m) >= 0;
      chip.className = 'module-chip' + (on ? ' active' : '');
      chip.setAttribute('role', 'checkbox');
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
      chip.tabIndex = 0;

      // 模块名可能来自用户输入或导入的备份码，一律用 textContent 写入，
      // 绝不拼 innerHTML —— 否则一条恶意备份码就能执行脚本（本工具还在教用户互发备份码）。
      var mName = document.createElement('span');
      mName.className = 'm-name';
      mName.textContent = m;
      chip.appendChild(mName);

      if (sel.custom.indexOf(m) >= 0) {
        var del = document.createElement('span');
        del.className = 'm-del';
        del.title = '移除';
        del.textContent = '✕';
        chip.appendChild(del);
      }

      function activate(e) {
        if (e.target && e.target.className === 'm-del') {
          sel.custom = sel.custom.filter(function (x) { return x !== m; });
          sel.modules = sel.modules.filter(function (x) { return x !== m; });
          renderModuleBox();
          return;
        }
        var i = sel.modules.indexOf(m);
        if (i >= 0) sel.modules.splice(i, 1);
        else sel.modules.push(m);
        renderModuleBox();
      }
      chip.addEventListener('click', activate);
      chip.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); activate({ target: chip }); }
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
    $('cfgDailyLoad').value = cfg.dailyLoad || 10;
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
      dailyLoad: parseInt($('cfgDailyLoad').value, 10) || 10,
      company: $('cfgCompany').value.trim(),
      jobTitle: $('cfgJobTitle').value.trim(),
      weeklyDue: $('cfgWeeklyDue').value,
      monthlyDue: $('cfgMonthlyDue').value,
      sections: collectSections()
    };
    Store.save();
    $('setupBanner').hidden = true;
    renderDue();
    maybeShowInstall(); // 配置完成后，安装横幅可以接班了
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
        // 不能调 renderDaily()：那会把编辑器内容按库里的记录重置，插入的句子会被抹掉
        Editor.contentChanged();
        goTab('daily');
        toast('已插入今日日报末尾，点「💾 保存」正式存入');
      });
      li.appendChild(span); li.appendChild(insBtn); li.appendChild(copyBtn);
      list.appendChild(li);
    });
  }

  /* ============================================================
   * 备份
   * ============================================================ */
  // 备份码长度分档：微信单条文字消息装不下很长的文本，超过就直接引导走文件
  var CODE_SAFE = 1500;      // 以内：微信聊天直接发没问题
  var CODE_MAX = 20000;      // 以上：别走微信文字了，改成发文件

  function exportBackup() {
    var blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '实习日报备份_' + Store.today() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    Store.markBackedUp();
    renderBackupHint();
    hideNotice();
    toast('备份文件已下载：可以发到微信「文件传输助手」长期保存');
  }

  // 「该备份了」提醒
  function renderBackupHint() {
    var el = $('backupHint');
    if (!el) return;
    var n = Object.keys(Store.data.reports).length;
    var at = Store.data.settings.lastBackupAt;
    var days = at ? Math.floor((Date.now() - at) / 864e5) : null;
    if (!n) {
      el.textContent = '还没有生成过日报，暂时不需要备份。';
      return;
    }
    if (days === null) {
      el.textContent = '你有 ' + n + ' 篇日报，但还没有备份过——手机丢失、清缓存、换浏览器都会全部丢失，建议现在就备份一次。';
    } else if (days >= 7) {
      el.textContent = '上次备份是 ' + days + ' 天前，现在已有 ' + n + ' 篇日报，建议再备份一次。';
    } else {
      el.textContent = '上次备份：' + (days === 0 ? '今天' : days + ' 天前') + '｜当前已保存 ' + n + ' 篇日报。';
    }
  }

  function copyBackupCode() {
    var code = Store.makeCode();
    var n = code.length;
    if (n > CODE_MAX) {
      showNotice('数据比较多，备份码约 <b>' + Math.round(n / 1024) + ' KB</b>，微信单条文字消息装不下。'
        + '请改用上面那个「⬇ 导出备份文件」，把生成的 .json 文件发给微信「文件传输助手」——文件没有长度限制。');
      return;
    }
    Store.markBackedUp();
    renderBackupHint();
    hideNotice();
    if (n <= CODE_SAFE) {
      Editor.copyText(code, '备份码已复制（' + n + ' 字符）：微信发给自己或存备忘录，新设备粘贴即可恢复');
    } else {
      Editor.copyText(code, '备份码已复制（约 ' + Math.round(n / 1024) + ' KB）：较长，建议存进微信「收藏」笔记或备忘录，别直接发聊天；也可以改用「导出备份文件」');
    }
  }

  // 导入成功后统一刷新界面
  function afterImport(info, label) {
    applyTheme();
    loadConfigToWizard();
    Editor.resync();
    Calendar.render(); Calendar.renderTodos();
    renderDue(); renderPhrases(); renderBackupHint();

    var msg = label + '成功 ✓ 共恢复 ' + info.reports + ' 篇日报';
    if (info.skipped) msg += '（跳过 ' + info.skipped + ' 条损坏记录）';
    toast(msg);

    var cfg = Store.data.config;
    if (cfg && cfg.jobType && !Phrases.jobTypes[cfg.jobType]) {
      showNotice('数据已恢复，但备份里的岗位类型「' + escapeHtml(cfg.jobType) + '」在本版本中不存在。'
        + '你的日报都在，请到「设置」里重新选一个岗位类型，然后点「💾 保存配置」。');
      goTab('settings');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function bindBackup() {
    $('exportBtn').addEventListener('click', exportBackup);
    $('copyCodeBtn').addEventListener('click', copyBackupCode);
    $('restoreCodeBtn').addEventListener('click', function () {
      var v = $('backupCodeIn').value.trim();
      if (!v) { toast('先把备份码粘贴到输入框'); return; }
      Store.importCode(v, function (info) {
        $('backupCodeIn').value = '';
        afterImport(info, '恢复');
      }, function (e) {
        console.error('恢复失败', e);
        toast('恢复失败：备份码不完整或已损坏（' + (e && e.message ? e.message : '无法解析') + '）', 'error');
      });
    });
    $('importFile').addEventListener('change', function () {
      var f = this.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        Store.importCode(reader.result, function (info) {
          afterImport(info, '导入');
        }, function (e) {
          console.error('导入失败', e);
          toast('导入失败：文件格式不对（' + (e && e.message ? e.message : '无法解析') + '）', 'error');
        });
      };
      reader.onerror = function () { toast('文件读取失败，请重试', 'error'); };
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

    // 保存失败 / 配额将满：必须让用户看见，不能只写 console
    Store.onSaveError = function (info) {
      if (info.reason === 'quota') {
        showNotice('浏览器给本站的存储空间快满了（当前约 ' + Math.round(info.size / 1024) + ' KB）。'
          + '建议现在点「⬇ 导出备份文件」保存一份，再清掉不需要的旧数据。');
      } else {
        showNotice('保存失败：数据没能写进浏览器。常见原因是<b>无痕/隐私模式</b>，或浏览器存储被占满。'
          + '请立即用「⬇ 导出备份文件」把数据保存到文件，否则关闭页面就会丢失。', 'danger');
      }
    };

    // 常驻提示条关闭
    $('noticeClose').addEventListener('click', hideNotice);

    // 页签（含左右方向键切换，键盘用户不用一个个 Tab）
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (b) goTab(b.dataset.tab);
    });
    $('tabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      var list = Array.prototype.slice.call(this.querySelectorAll('.tab'));
      var i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') i = (i - 1 + list.length) % list.length;
      else if (e.key === 'ArrowRight') i = (i + 1) % list.length;
      else if (e.key === 'Home') i = 0;
      else i = list.length - 1;
      list[i].focus();
      goTab(list[i].dataset.tab);
    });

    // Esc 关闭当前打开的弹窗
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      ['feedbackMask', 'installMask'].forEach(function (id) {
        var m = $(id);
        if (m && !m.hidden) closeModal(m);
      });
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

    // PWA 安装引导
    $('installBtn').addEventListener('click', function () {
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall = null;
        $('installBanner').hidden = true;
      } else {
        openInstallHelp();
      }
    });
    $('installDismiss').addEventListener('click', function () {
      Store.data.settings.installDismissedAt = Date.now();
      Store.save();
      $('installBanner').hidden = true;
    });
    $('installHelpClose').addEventListener('click', function () { closeModal($('installMask')); });
    $('installMask').addEventListener('click', function (e) {
      if (e.target === this) closeModal(this);
    });
    $('settingsInstallBtn').addEventListener('click', function () {
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall = null;
      } else {
        openInstallHelp();
      }
    });
    maybeShowInstall();

    // 备份
    bindBackup();
    renderBackupHint();

    // 意见反馈
    $('feedbackLink').addEventListener('click', openFeedback);
    $('fbCloseBtn').addEventListener('click', closeFeedback);
    $('fbTplBtn').addEventListener('click', copyFeedbackTpl);
    $('feedbackMask').addEventListener('click', function (e) {
      if (e.target === this) closeFeedback(); // 点遮罩关闭
    });

    // 子模块
    Editor.init();
    Calendar.init();

    // 面板
    renderDue();

    // 从写作指南页跳转过来的反馈请求
    if (location.hash === '#feedback') openFeedback();

    // PWA：注册 Service Worker（本地 file:// 直接打开时跳过，不影响离线双击用法）
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  /* ---------- PWA 安装引导 ---------- */
  var deferredInstall = null;
  var DISMISS_RESHOW_MS = 7 * 864e5; // 点过「暂不」7 天后可再提示
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }
  function isIOSLike() {
    var ua = navigator.userAgent;
    // 新款 iPad 的 UA 伪装成 Mac，用触点数识别
    return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  }
  function maybeShowInstall() {
    if (isStandalone()) return;
    // 配置横幅优先：新用户先完成配置，之后再提安装
    if (!$('setupBanner').hidden) return;
    // 旧字段迁移：永久「暂不」→ 记时间戳，7 天后可再提示
    if (Store.data.settings.installDismissed === true) {
      Store.data.settings.installDismissedAt = Store.data.settings.installDismissedAt || Date.now();
      delete Store.data.settings.installDismissed;
      Store.save();
    }
    var at = Store.data.settings.installDismissedAt;
    if (at && Date.now() - at < DISMISS_RESHOW_MS) return;
    var ua = navigator.userAgent;
    if (deferredInstall) {
      $('installBannerText').textContent = '📲 把「实习日报一点通」安装到手机桌面，点开即用、离线也能看。';
      $('installBtn').textContent = '立即安装';
      $('installBanner').hidden = false;
    } else if (isIOSLike() && /safari/i.test(ua)) {
      $('installBannerText').textContent = '📲 想像 App 一样用？添加到主屏幕即可。';
      $('installBtn').textContent = '怎么装';
      $('installBanner').hidden = false;
    }
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    maybeShowInstall();
  });
  function openInstallHelp() { openModal($('installMask')); }

  /* ============================================================
   * 弹窗：统一的打开 / 关闭（含 Esc 关闭与焦点归位）
   * ============================================================ */
  var lastFocus = null;
  function openModal(mask) {
    lastFocus = document.activeElement;
    mask.hidden = false;
    var card = mask.querySelector('.modal-card');
    if (card) { try { card.focus(); } catch (e) {} }
  }
  function closeModal(mask) {
    mask.hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  /* ============================================================
   * 意见反馈弹窗
   * ============================================================ */
  function openFeedback() {
    var box = $('fbChannels');
    box.innerHTML = '';
    var hasEasy = !!(FEEDBACK.qqGroup || FEEDBACK.txc);

    function row(text, hint, btn) {
      var r = document.createElement('div');
      r.className = 'fb-row';
      var left = document.createElement('span');
      left.textContent = text;
      if (hint) {
        var h = document.createElement('span');
        h.className = 'hint';
        h.appendChild(document.createElement('br'));
        h.appendChild(document.createTextNode(hint));
        left.appendChild(h);
      }
      r.appendChild(left);
      r.appendChild(btn);
      return r;
    }
    function linkBtn(text, href) {
      var a = document.createElement('a');
      a.className = 'btn sm';
      a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = text;
      return a;
    }

    if (FEEDBACK.qqGroup) {
      var copyQQ = document.createElement('button');
      copyQQ.className = 'btn sm';
      copyQQ.id = 'fbCopyQQ';
      copyQQ.textContent = '复制群号';
      copyQQ.addEventListener('click', function () {
        Editor.copyText(FEEDBACK.qqGroup, '已复制群号，去 QQ 搜索加入即可');
      });
      box.appendChild(row('QQ 反馈群：' + FEEDBACK.qqGroup, '加群提意见，还能第一时间收到更新通知', copyQQ));
    }
    if (FEEDBACK.txc) {
      box.appendChild(row('在线留言板', 'QQ/微信一键登录即可留言，无需注册', linkBtn('去留言', FEEDBACK.txc)));
    }
    box.appendChild(row('网页反馈' + (hasEasy ? '（进阶）' : ''),
      '需 GitHub 账号' + (hasEasy ? '' : '，适合能用 GitHub 的同学'),
      linkBtn('去填写', FEEDBACK.github)));

    $('fbNote').textContent = hasEasy
      ? '以上渠道任选其一，反馈都会尽快处理；通用问题可先点「复制反馈模板」。'
      : '点「复制反馈模板」填好内容，可通过任意你能联系到站长的渠道发送。';
    openModal($('feedbackMask'));
  }
  function closeFeedback() { closeModal($('feedbackMask')); }
  function copyFeedbackTpl() {
    Editor.copyText(
      '【实习日报一点通 · 意见反馈】\n' +
      '问题描述：\n' +
      '（例：想增加「酒店前台」岗位 / 某类句子生成得太重复 / 某按钮点了没反应）\n' +
      '使用设备：手机或电脑 + 浏览器名\n',
      '模板已复制，填写后通过任意渠道发给站长即可'
    );
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
