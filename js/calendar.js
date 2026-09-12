/* ============================================================
 * calendar.js — 日报日历（补写入口）+ 今日待办
 * ============================================================ */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var view = { y: 0, m: 0 };   // 当前查看的年月

  /* ---------- 日历 ---------- */
  function render() {
    if (!view.y) { var t = new Date(); view.y = t.getFullYear(); view.m = t.getMonth(); }
    $('calTitle').textContent = view.y + ' 年 ' + (view.m + 1) + ' 月';

    var grid = $('calGrid');
    grid.innerHTML = '';

    // 表头星期
    ['日', '一', '二', '三', '四', '五', '六'].forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'cal-dow';
      el.textContent = '周' + d;
      grid.appendChild(el);
    });

    var first = new Date(view.y, view.m, 1);
    var days = new Date(view.y, view.m + 1, 0).getDate();
    var startDow = first.getDay();
    var todayStr = Store.today();

    // 前置空白
    for (var i = 0; i < startDow; i++) {
      var blank = document.createElement('div');
      blank.className = 'cal-cell blank';
      grid.appendChild(blank);
    }

    for (var d = 1; d <= days; d++) {
      var ds = view.y + '-' + String(view.m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var cell = document.createElement('div');
      cell.className = 'cal-cell';
      cell.textContent = d;
      if (ds === todayStr) cell.classList.add('today');

      var r = Store.data.reports[ds];
      if (r) {
        var dot = document.createElement('i');
        dot.className = 'dot ' + (r.submitted ? 'dot-ok' : 'dot-draft');
        cell.appendChild(dot);
        cell.title = (r.submitted ? '已提交' : '已生成未提交');
      }
      (function (dateStr) {
        cell.addEventListener('click', function () {
          Editor.setDate(dateStr);
          App.goTab('daily');
        });
      })(ds);
      grid.appendChild(cell);
    }
  }

  /* ---------- 批量补写缺失日报 ---------- */
  function missingDates() {
    var cfg = Store.data.config;
    if (!cfg || !cfg.startDate) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var start = Store.parse(cfg.startDate);
    // 最多回溯 31 天，避免实习开始日期很久以前时一次生成几百篇
    var earliest = new Date(today);
    earliest.setDate(earliest.getDate() - 30);
    if (start < earliest) start = earliest;
    var dates = [];
    for (var d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      var dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // 只列周一至周五
      var ds = Store.fmt(d);
      if (!Store.data.reports[ds]) dates.push(ds);
    }
    return dates;
  }

  function renderBackfill() {
    var panel = $('backfillPanel'), list = $('backfillList'), stat = $('backfillStat');
    if (!panel || panel.hidden) return;
    list.innerHTML = '';
    var miss = missingDates();
    if (miss === null) {
      stat.innerHTML = '<span style="color:var(--warn)">先在「设置」里填写实习开始日期，才能找出缺哪些天。</span>';
      return;
    }
    if (!miss.length) {
      stat.innerHTML = '没有缺失的工作日报告，安排得明明白白 ✓';
      return;
    }
    stat.innerHTML = '找到 <b>' + miss.length + '</b> 个没写报告的工作日（默认全选）：';
    miss.forEach(function (ds) {
      var label = document.createElement('label');
      label.className = 'backfill-chip';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.value = ds;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(ds));
      list.appendChild(label);
    });
  }

  function runBackfill() {
    var cfg = Store.data.config;
    if (!cfg) { App.toast('先在「设置」里完成岗位配置'); return; }
    var sel = Array.prototype.slice
      .call($('backfillList').querySelectorAll('input:checked'))
      .map(function (cb) { return cb.value; })
      .sort();
    if (!sel.length) { App.toast('先勾选要补写的日期'); return; }
    var n = 0;
    // 按日期升序逐篇生成：前一篇落库后，后一篇的防雷同和模块轮换能衔接上
    sel.forEach(function (ds) {
      var r = Generator.generateDaily(ds, cfg, Store.data.reports, Store.data.moduleStats, '');
      if (!r) return;
      Store.data.reports[ds] = {
        date: ds, text: r.text, modules: r.modules,
        extra: '', problem: r.problem, statCounted: true
      };
      r.modules.forEach(function (m) {
        var s = Store.data.moduleStats[m] || { count: 0, lastDate: '' };
        s.count++; s.lastDate = ds;
        Store.data.moduleStats[m] = s;
      });
      n++;
    });
    Store.save();
    $('backfillPanel').hidden = true;
    render();
    Editor.renderDaily();
    App.renderDue();
    App.toast('已补齐 ' + n + ' 篇日报，记得逐篇过目后再提交');
  }

  /* ---------- 待办 ---------- */
  function renderTodos() {
    var list = $('todoList');
    list.innerHTML = '';
    Store.data.todos.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'todo-item' + (t.done ? ' done' : '');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'todo-check';
      cb.checked = !!t.done;

      var span = document.createElement('span');
      span.className = 'todo-text';
      span.textContent = t.text;

      var del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '✕';
      del.title = '删除';

      li.appendChild(cb); li.appendChild(span); li.appendChild(del);
      list.appendChild(li);
    });
  }

  function bindTodos() {
    $('todoAdd').addEventListener('click', function () {
      var v = $('todoInput').value.trim();
      if (!v) return;
      Store.data.todos.push({ id: Date.now(), text: v, done: false });
      $('todoInput').value = '';
      Store.save();
      renderTodos();
    });
    $('todoInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('todoAdd').click();
    });
    $('todoPreset').addEventListener('click', function () {
      Store.data.todos.push({ id: Date.now(), text: '记得去学习通「上班打卡」', done: false });
      Store.save(); renderTodos();
    });
    $('todoPreset2').addEventListener('click', function () {
      Store.data.todos.push({ id: Date.now(), text: '提交今日日报到学习通', done: false });
      Store.save(); renderTodos();
    });
    $('todoList').addEventListener('change', function (e) {
      if (e.target.type !== 'checkbox') return;
      var idx = Array.prototype.indexOf.call($('todoList').children, e.target.closest('li'));
      if (idx > -1 && Store.data.todos[idx]) {
        Store.data.todos[idx].done = e.target.checked;
        Store.save();
        renderTodos();
      }
    });
    $('todoList').addEventListener('click', function (e) {
      if (e.target.className !== 'icon-btn') return;
      var idx = Array.prototype.indexOf.call($('todoList').children, e.target.closest('li'));
      if (idx > -1) {
        Store.data.todos.splice(idx, 1);
        Store.save();
        renderTodos();
      }
    });
  }

  window.Calendar = {
    init: function () {
      $('calPrev').addEventListener('click', function () {
        view.m--; if (view.m < 0) { view.m = 11; view.y--; }
        render();
      });
      $('calNext').addEventListener('click', function () {
        view.m++; if (view.m > 11) { view.m = 0; view.y++; }
        render();
      });
      // 批量补写
      $('backfillBtn').addEventListener('click', function () {
        $('backfillPanel').hidden = !$('backfillPanel').hidden;
        renderBackfill();
      });
      $('backfillRun').addEventListener('click', runBackfill);
      $('backfillToggleAll').addEventListener('click', function () {
        var cbs = $('backfillList').querySelectorAll('input[type=checkbox]');
        if (!cbs.length) return;
        var target = !cbs[0].checked;
        Array.prototype.forEach.call(cbs, function (cb) { cb.checked = target; });
      });
      bindTodos();
      render();
      renderTodos();
    },
    render: render,
    renderTodos: renderTodos
  };
})();
