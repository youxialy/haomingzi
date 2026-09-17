/* ============================================================
 * store.js — 本地数据层
 * 所有数据只存浏览器 localStorage，无账号、无服务器、无上传。
 *
 * 本文件承担三件事：
 *   1. 读写 localStorage（含失败上报，配额满/隐私模式不再静默丢数据）
 *   2. 备份码编解码（紧凑线格式 + LZ 压缩，比旧版小 30 倍以上）
 *   3. 导入数据的深度校验（导入的东西来自外部，一律当作不可信输入）
 * ============================================================ */
(function () {
  var KEY = 'irdp_data_v1';
  var CODE_PREFIX = 'IR2:';    // 当前备份码：LZ 压缩 + base64
  var OLD_PREFIX = 'IR1:';     // 旧版备份码：base64(UTF-8 JSON)，仍可导入

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  var LIMIT = {
    reports: 8000,        // 最多接受的日报篇数，防止畸形备份码撑爆内存
    text: 200000,         // 单篇日报正文上限
    aggText: 400000,      // 单份周报/月报留档上限
    arr: 500,             // 通用数组上限
    item: 200,            // 通用字符串上限
    decompressed: 4000000 // 解压后最大 code unit 数（防解压炸弹）
  };

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

  /* ============================================================
   * 保存失败上报（配额满 / 隐私模式）
   * 以前只 console.error，用户毫无感知，其实数据已经没写进去。
   * 现在：save() 返回布尔值；首次失败、以及体积逼近配额时回调一次。
   * ============================================================ */
  var onSaveError = null;
  var reportedFail = false;
  var reportedQuota = false;
  var QUOTA_WARN = 3000000;    // 字符数，约合 localStorage 常见的 5MB 上限

  function bodySize(json) { return json.length; }

  function save() {
    var json;
    try {
      json = JSON.stringify(data);
    } catch (e) {
      console.error('数据序列化失败', e);
      return false;
    }
    try {
      localStorage.setItem(KEY, json);
      reportedFail = false;
      if (!reportedQuota && bodySize(json) > QUOTA_WARN) {
        reportedQuota = true;
        if (onSaveError) onSaveError({ reason: 'quota', size: bodySize(json) });
      }
      return true;
    } catch (e) {
      console.error('保存失败（可能是隐私模式或存储已满）', e);
      if (!reportedFail) {
        reportedFail = true;
        if (onSaveError) onSaveError({ reason: 'failed', error: e });
      }
      return false;
    }
  }

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

  /* ============================================================
   * 小工具
   * ============================================================ */
  function isPlainObject(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o);
  }
  function asStr(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // 去掉控制字符
    return max ? v.slice(0, max) : v;
  }
  function asDate(v) { var s = asStr(v, 10); return DATE_RE.test(s) ? s : ''; }
  function asInt(v, min, max, dflt) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }
  function asStrArr(v, maxItems, maxLen) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && out.length < maxItems; i++) {
      if (typeof v[i] !== 'string') continue;      // 数组里只认字符串，数字/对象一律当脏数据
      var s = v[i].trim();
      if (s && out.indexOf(s) < 0) out.push(s.slice(0, maxLen));
    }
    return out;
  }

  /* ============================================================
   * 导入数据校验
   * 备份码会在同学之间互发（页面上就是这么教的），所以一律按不可信输入处理：
   * 结构不对就拒绝，结构对但个别条目坏了就丢弃并计数上报。
   * ============================================================ */
  function sanitize(raw) {
    if (!isPlainObject(raw)) throw new Error('不是合法的数据对象');
    if (!isPlainObject(raw.reports)) throw new Error('缺少 reports 数据段');

    var out = DEFAULTS();
    var skipped = 0;

    /* ---- reports ---- */
    var keys = Object.keys(raw.reports);
    if (keys.length > LIMIT.reports) throw new Error('日报数量异常（' + keys.length + ' 篇）');
    keys.forEach(function (k) {
      var rec = raw.reports[k];
      if (!DATE_RE.test(k) || !isPlainObject(rec) || typeof rec.text !== 'string') { skipped++; return; }
      var o = {
        date: DATE_RE.test(rec.date) ? rec.date : k,
        text: asStr(rec.text, LIMIT.text),
        modules: asStrArr(rec.modules, 40, 60),
        extra: asStr(rec.extra, 2000),
        problem: asStr(rec.problem, 2000),
        submitted: rec.submitted === true
      };
      var tpls = asStrArr(rec.tpls, 40, 120);
      if (tpls.length) o.tpls = tpls;
      if (rec.updatedAt) { var u = asStr(rec.updatedAt, 30); if (u) o.updatedAt = u; }
      out.reports[k] = o;
    });

    /* ---- config ---- */
    if (isPlainObject(raw.config)) {
      var c = raw.config;
      var cfg = {
        jobType: asStr(c.jobType, 40),
        modules: asStrArr(c.modules, 60, 60),
        startDate: asDate(c.startDate),
        endDate: asDate(c.endDate),
        minWords: asInt(c.minWords, 0, 5000, 300),
        dailyLoad: asInt(c.dailyLoad, 2, 99, 10),
        company: asStr(c.company, 100),
        jobTitle: asStr(c.jobTitle, 100)
      };
      var wd = c.weeklyDue;
      cfg.weeklyDue = (wd === '' || wd === null || wd === undefined) ? '' : String(asInt(wd, 0, 6, ''));
      if (cfg.weeklyDue === 'NaN') cfg.weeklyDue = '';
      var md = String(c.monthlyDue === undefined || c.monthlyDue === null ? '' : c.monthlyDue);
      cfg.monthlyDue = (md === 'last' || (md && /^\d{1,2}$/.test(md) && Number(md) >= 1 && Number(md) <= 31)) ? md : '';
      cfg.jobType = cfg.jobType || '';
      if (Array.isArray(c.sections)) {
        cfg.sections = [];
        c.sections.slice(0, 12).forEach(function (s) {
          if (!isPlainObject(s)) return;
          var key = asStr(s.key, 20);
          if (!key) return;
          cfg.sections.push({ key: key, title: asStr(s.title, 30), on: s.on === true });
        });
      }
      out.config = cfg;
    }

    /* ---- savedAgg ---- */
    if (isPlainObject(raw.savedAgg)) {
      Object.keys(raw.savedAgg).slice(0, 2000).forEach(function (id) {
        var a = raw.savedAgg[id];
        if (!isPlainObject(a) || typeof a.text !== 'string') return;
        var type = a.type === 'monthly' ? 'monthly' : 'weekly';
        out.savedAgg[id] = {
          type: type,
          from: asDate(a.from),
          to: asDate(a.to),
          text: asStr(a.text, LIMIT.aggText),
          createdAt: asStr(a.createdAt, 30)
        };
      });
    }

    /* ---- moduleStats ---- */
    if (isPlainObject(raw.moduleStats)) {
      Object.keys(raw.moduleStats).slice(0, 500).forEach(function (m) {
        var s = raw.moduleStats[m];
        if (!isPlainObject(s)) return;
        out.moduleStats[asStr(m, 60)] = { count: asInt(s.count, 0, 1e6, 0), lastDate: asDate(s.lastDate) };
      });
    }

    /* ---- customPhrases / todos ---- */
    out.customPhrases = asStrArr(raw.customPhrases, LIMIT.arr, LIMIT.item);
    if (Array.isArray(raw.todos)) {
      raw.todos.slice(0, LIMIT.arr).forEach(function (t) {
        if (!isPlainObject(t)) return;
        var text = asStr(t.text, LIMIT.item).trim();
        if (!text) return;
        out.todos.push({ id: asStr(t.id, 40) || ('t' + out.todos.length), text: text, done: t.done === true });
      });
    }

    /* ---- settings：只保留自己认识的键 ---- */
    var st = isPlainObject(raw.settings) ? raw.settings : {};
    out.settings = { theme: (st.theme === 'dark' || st.theme === 'light') ? st.theme : '' };
    if (typeof st.installDismissedAt === 'number') out.settings.installDismissedAt = st.installDismissedAt;
    if (typeof st.lastBackupAt === 'number') out.settings.lastBackupAt = st.lastBackupAt;

    // drafts 属于临时草稿，不进备份、也不从备份恢复
    out.drafts = DEFAULTS().drafts;

    return { data: out, skipped: skipped };
  }

  /* ============================================================
   * 备份码：紧凑线格式 → JSON → LZ → base64
   * ============================================================ */

  /* ---- 紧凑线格式：去掉冗余字段，把 reports 变成二维数组 ---- */
  function wirePack(d) {
    var r = [];
    var dates = Object.keys(d.reports || {}).sort();
    dates.forEach(function (k) {
      var x = d.reports[k];
      if (!x || typeof x.text !== 'string') return;
      var row = [k, x.text];
      if (x.modules && x.modules.length) row.push(x.modules.join('|'));
      if (x.extra) row.push(x.extra);
      if (x.problem) row.push(x.problem);
      if (x.submitted) row.push(1);
      if (x.tpls && x.tpls.length) { while (row.length < 6) row.push(0); row.push(x.tpls.join('|')); }
      // 尾部空值/0 可以省掉
      while (row.length > 2 && (row[row.length - 1] === 0 || row[row.length - 1] === '')) row.pop();
      r.push(row);
    });

    var agg = [];
    Object.keys(d.savedAgg || {}).forEach(function (id) {
      var a = d.savedAgg[id];
      if (!a || typeof a.text !== 'string') return;
      agg.push([a.type === 'monthly' ? 1 : 0, a.from || '', a.to || '', a.text]);
    });

    var ms = [];
    Object.keys(d.moduleStats || {}).forEach(function (m) {
      var s = d.moduleStats[m] || {};
      ms.push([m, s.count || 0, s.lastDate || '']);
    });

    var o = { v: 2 };
    if (d.config) o.c = d.config;
    o.r = r;
    if (agg.length) o.a = agg;
    if (ms.length) o.m = ms;
    if (d.customPhrases && d.customPhrases.length) o.p = d.customPhrases;
    if (d.todos && d.todos.length) o.t = d.todos;
    o.s = d.settings || {};
    return o;
  }

  function wireUnpack(o) {
    if (!isPlainObject(o) || !Array.isArray(o.r)) throw new Error('备份码内容不完整');
    var raw = {
      config: o.c || null,
      reports: {},
      savedAgg: {},
      moduleStats: {},
      customPhrases: o.p || [],
      todos: o.t || [],
      settings: o.s || {}
    };
    o.r.forEach(function (row) {
      if (!Array.isArray(row) || row.length < 2) return;
      var rec = { date: row[0], text: row[1] };
      if (row[2]) rec.modules = String(row[2]).split('|');
      if (row[3]) rec.extra = row[3];
      if (row[4]) rec.problem = row[4];
      rec.submitted = row[5] === 1;
      if (row[6]) rec.tpls = String(row[6]).split('|');
      raw.reports[row[0]] = rec;
    });
    (o.a || []).forEach(function (a) {
      if (!Array.isArray(a) || a.length < 4) return;
      var type = a[0] === 1 ? 'monthly' : 'weekly';
      raw.savedAgg[type + '_' + a[1] + '_' + a[2]] = { type: type, from: a[1], to: a[2], text: a[3], createdAt: '' };
    });
    (o.m || []).forEach(function (m) {
      if (!Array.isArray(m) || m.length < 3) return;
      raw.moduleStats[m[0]] = { count: m[1], lastDate: m[2] };
    });
    return raw;
  }

  /* ---- LZ：按 UTF-16 code unit 做 LZSS ----
   * 令牌（比特流，低位在前）
   *   0 + 16bit                        字面量（一个 code unit）
   *   1 + 16bit(dist-1) + 6bit(len-3)  匹配，长度 3..66，窗口 64K
   * 纯 JS、同步、无依赖，任何浏览器都能跑（不依赖 CompressionStream）。
   */
  var WIN = 65536, MAXLEN = 66, MINLEN = 3, CHAIN = 48;

  function lzCompress(s) {
    var n = s.length;
    if (!n) return [];
    var out = [], acc = 0, accBits = 0;
    function put(v, bits) {
      acc = (acc | (v << accBits)) >>> 0;
      accBits += bits;
      while (accBits >= 8) { out.push(acc & 255); acc >>>= 8; accBits -= 8; }
    }
    var head = new Int32Array(65536).fill(-1);
    var prev = new Int32Array(n);
    var MASK = 65535;
    function hash(i) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      return (((a * 2654435761) ^ (b * 40503) ^ (c * 2246822519)) >>> 8) & MASK;
    }
    var i = 0;
    while (i < n) {
      var bestLen = 0, bestDist = 0;
      if (i + MINLEN <= n) {
        var h = hash(i), p = head[h], tries = 0;
        while (p >= 0 && tries++ < CHAIN) {
          var dist = i - p;
          if (dist > WIN) break;
          var max = n - i; if (max > MAXLEN) max = MAXLEN;
          var l = 0;
          while (l < max && s.charCodeAt(p + l) === s.charCodeAt(i + l)) l++;
          if (l > bestLen) { bestLen = l; bestDist = dist; if (l === max) break; }
          p = prev[p];
        }
      }
      if (bestLen >= MINLEN) {
        put(1, 1); put(bestDist - 1, 16); put(bestLen - MINLEN, 6);
        var end = i + bestLen;
        for (; i < end; i++) {
          if (i + MINLEN <= n) { var hh = hash(i); prev[i] = head[hh]; head[hh] = i; }
        }
      } else {
        put(0, 1); put(s.charCodeAt(i), 16);
        if (i + MINLEN <= n) { var h2 = hash(i); prev[i] = head[h2]; head[h2] = i; }
        i++;
      }
    }
    if (accBits > 0) out.push(acc & 255);
    return out;
  }

  function lzDecompress(bytes) {
    var out = [], pos = 0, acc = 0, accBits = 0;
    var totalBits = bytes.length * 8, used = 0;
    function need(bits) {
      while (accBits < bits) { acc = (acc | ((pos < bytes.length ? bytes[pos++] : 0) << accBits)) >>> 0; accBits += 8; }
    }
    function get(bits) {
      need(bits);
      var v = acc & ((1 << bits) - 1);
      acc >>>= bits; accBits -= bits;
      return v;
    }
    while (used < totalBits) {
      var flag = get(1); used += 1;
      if (!flag) {
        if (used + 16 > totalBits) break;
        out.push(String.fromCharCode(get(16))); used += 16;
      } else {
        if (used + 22 > totalBits) break;
        var dist = get(16) + 1, len = get(6) + MINLEN; used += 22;
        if (dist > out.length) throw new Error('备份码已损坏（引用越界）');
        var start = out.length - dist;
        for (var k = 0; k < len; k++) out.push(out[start + k]);
        if (out.length > LIMIT.decompressed) throw new Error('备份码异常（解压后过大）');
      }
      if (out.length > LIMIT.decompressed) throw new Error('备份码异常（解压后过大）');
    }
    return out.join('');
  }

  /* ---- base64（浏览器 btoa/atob）---- */
  function bytesToB64(bytes) {
    var CH = 8192, parts = [];
    for (var i = 0; i < bytes.length; i += CH) {
      parts.push(String.fromCharCode.apply(null, bytes.slice(i, i + CH)));
    }
    return btoa(parts.join(''));
  }
  function b64ToBytes(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function b64ToUtf8(b64) {
    var bytes = b64ToBytes(b64);
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { /* 落到下面的兜底 */ }
    }
    return decodeURIComponent(escape(atob(b64)));
  }

  /* ---- 备份码对外接口 ---- */
  function makeCode() {
    var wire = wirePack(data);
    return CODE_PREFIX + bytesToB64(lzCompress(JSON.stringify(wire)));
  }

  /* 把用户粘贴的内容规整成「前缀 + 纯 base64」。
   * 微信转发会带上换行、分段序号甚至重复前缀，这里全部容忍；
   * 但裸 JSON 一个字都不能动（JSON 字符串里可能有空格）。
   */
  function normalizeCode(text) {
    var s = String(text == null ? '' : text);
    var i2 = s.indexOf(CODE_PREFIX), i1 = s.indexOf(OLD_PREFIX);
    if (i2 < 0 && i1 < 0) return s.trim();                  // 裸 JSON：原样
    var pfx = (i2 >= 0 && (i1 < 0 || i2 <= i1)) ? CODE_PREFIX : OLD_PREFIX;
    var body = s.slice(s.indexOf(pfx) + pfx.length);
    body = body.replace(/IR1[：:]/g, '').replace(/IR2[：:]/g, '');   // 重复前缀（含全角冒号）
    body = body.replace(/第\s*\d+\s*\/\s*\d+\s*段\s*[：:]?/g, ''); // 分段序号：「第1/3段：」
    body = body.replace(/[^A-Za-z0-9+/=]/g, '');                    // 只留 base64 字符
    return pfx + body;
  }

  /* 把各种来源的文本解析成「原始数据结构」 */
  function unwrap(obj) {
    return (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.data && typeof obj.data === 'object') ? obj.data : obj;
  }
  function parseInput(text) {
    var s = normalizeCode(text);
    if (s.indexOf(CODE_PREFIX) === 0) {
      return wireUnpack(JSON.parse(lzDecompress(b64ToBytes(s.slice(CODE_PREFIX.length)))));
    }
    if (s.indexOf(OLD_PREFIX) === 0) {
      return unwrap(JSON.parse(b64ToUtf8(s.slice(OLD_PREFIX.length))));
    }
    return unwrap(JSON.parse(s));
  }

  /* ============================================================
   * 导出 / 导入
   * ============================================================ */
  function exportJSON() {
    return JSON.stringify({ app: 'intern-report', version: 1, exportedAt: new Date().toISOString(), data: data }, null, 2);
  }

  function markBackedUp() {
    data.settings.lastBackupAt = Date.now();
    save();
  }

  function importJSON(text, onDone, onFail) {
    var result;
    try {
      result = sanitize(parseInput(text));
      data = result.data;
      save();
    } catch (e) {
      onFail && onFail(e);
      return;
    }
    // 注意：onDone 必须在 try 之外调用。
    // 以前 onDone（刷新界面的回调）抛错会被同一个 catch 抓住，
    // 结果数据其实已经写进去了，用户看到的却是「备份码已损坏」。
    // 现在即使刷新界面出错，也只当成 UI 问题上报，不再谎报数据损坏。
    var info = { reports: Object.keys(data.reports).length, skipped: result.skipped };
    try {
      onDone && onDone(info);
    } catch (e2) {
      console.error('导入后刷新界面出错（数据已成功写入）', e2);
      info.uiError = e2;
      onDone && onDone(info);
    }
  }

  // 备份码 / 文件内容 / 裸 JSON 都走同一个入口，自动识别格式
  function importCode(text, onDone, onFail) {
    importJSON(text, onDone, onFail);
  }

  function reset() {
    data = DEFAULTS();
    save();
  }

  load();

  window.Store = {
    KEY: KEY,
    CODE_PREFIX: CODE_PREFIX,
    get data() { return data; },
    load: load,
    save: save,
    fmt: fmt,
    parse: parse,
    today: today,
    exportJSON: exportJSON,
    importJSON: importJSON,
    importCode: importCode,
    makeCode: makeCode,
    normalizeCode: normalizeCode,
    parseInput: parseInput,
    markBackedUp: markBackedUp,
    reset: reset,
    set onSaveError(fn) { onSaveError = fn; },
    // 供测试直接调用
    _sanitize: sanitize,
    _lz: { compress: lzCompress, decompress: lzDecompress }
  };

  function fmt(d) {
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function parse(s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function today() { return fmt(new Date()); }
})();
