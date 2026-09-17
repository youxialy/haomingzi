/* ============================================================
 * store.js — 本地数据层
 * 所有数据只存浏览器 localStorage，无账号、无服务器、无上传。
 * ============================================================ */
(function () {
  var KEY = 'irdp_data_v1';

  var DEFAULTS = function () {
    return {
      config: null,        // { jobType, modules[], startDate, endDate, minWords, company, jobTitle }
      reports: {},         // dateStr -> { date, text, modules[], extra, problem, submitted, updatedAt }
      savedAgg: {},        // id -> { type, from, to, text, createdAt }  周报/月报留档
      moduleStats: {},     // module -> { count, lastDate }  轮换公平性统计
      customPhrases: [],   // 用户自建句式
      todos: [],           // { id, text, done }
      drafts: {            // 未保存的临时草稿（切换日期·刷新·关页面都不丢）
        daily: {},         //   dateStr -> { text, extra, updatedAt }
        agg: {},           //   'weekly_2026-09-14_2026-09-20' -> { text, updatedAt }
        summary: ''        //   实习总结草稿纯文本
      },
      settings: { theme: '' }  // '' = 跟随系统；'light' / 'dark' = 用户显式选择
    };
  };

  var data = null;

  function load() {
    try {
      var raw = (typeof localStorage !== 'undefined') && localStorage.getItem(KEY);
      data = raw ? JSON.parse(raw) : DEFAULTS();
    } catch (e) {
      data = DEFAULTS();
    }
    // 补齐可能缺失的字段（版本兼容）
    var d = DEFAULTS();
    Object.keys(d).forEach(function (k) { if (data[k] === undefined) data[k] = d[k]; });
    return data;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.error('保存失败（可能是浏览器隐私模式）', e);
    }
  }

  function fmt(d) {
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function parse(s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function today() { return fmt(new Date()); }

  function exportJSON() {
    return JSON.stringify({ app: 'intern-report', version: 1, exportedAt: new Date().toISOString(), data: data }, null, 2);
  }

  function importJSON(text, onDone, onFail) {
    try {
      var obj = JSON.parse(text);
      var incoming = obj && obj.data ? obj.data : obj;
      if (!incoming || typeof incoming !== 'object' || !('reports' in incoming)) throw new Error('格式不认识');
      data = incoming;
      var d = DEFAULTS();
      Object.keys(d).forEach(function (k) { if (data[k] === undefined) data[k] = d[k]; });
      save();
      onDone && onDone();
    } catch (e) {
      onFail && onFail(e);
    }
  }

  function reset() {
    data = DEFAULTS();
    save();
  }

  load();

  window.Store = {
    get data() { return data; },
    load: load,
    save: save,
    fmt: fmt,
    parse: parse,
    today: today,
    exportJSON: exportJSON,
    importJSON: importJSON,
    reset: reset
  };
})();
