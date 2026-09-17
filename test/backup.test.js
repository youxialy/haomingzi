/* ============================================================
 * backup.test.js — 备份码 / 导入校验 回归测试（Node 环境）
 * 运行：node test/backup.test.js
 * ============================================================ */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   → ' + extra : '')); }
}
function section(t) { console.log('\n===== ' + t + ' ====='); }

/* ---------- 沙箱 ---------- */
function makeCtx() {
  var store = {};
  var ctx = {
    window: {},
    console: console,
    btoa: function (s) { return Buffer.from(s, 'binary').toString('base64'); },
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    escape: typeof escape === 'function' ? escape : global.escape,
    unescape: typeof unescape === 'function' ? unescape : global.unescape,
    decodeURIComponent: decodeURIComponent,
    encodeURIComponent: encodeURIComponent,
    localStorage: {
      _s: store,
      getItem: function (k) { return this._s[k] === undefined ? null : this._s[k]; },
      setItem: function (k, v) { this._s[k] = String(v); },
      removeItem: function (k) { delete this._s[k]; }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });
  ctx.Store = ctx.window.Store;
  return ctx;
}

/* ============================================================
 * 1. LZ 往返
 * ============================================================ */
section('1. LZ 压缩往返一致');
var c = makeCtx();
var lz = c.Store._lz;
[
  ['空串', ''],
  ['单字符', 'a'],
  ['两字符', 'ab'],
  ['纯中文重复', '中文'.repeat(200)],
  ['emoji 代理对', '😀😀😀测试 emoji 代理对🀄'],
  ['长同字符', 'x'.repeat(9000)],
  ['JSON 结构', JSON.stringify({ a: '值'.repeat(500), b: [1, 2, 3] })],
  ['含换行制表', '第一行\n第二行\t制表\r\n'],
  ['生僻字', '𠮷𠮷𠮷𠀀'],
  ['纯 ASCII', 'The quick brown fox jumps over the lazy dog. '.repeat(50)]
].forEach(function (t) {
  var z = lz.compress(t[1]);
  var back = lz.decompress(z);
  ok(back === t[1], t[0] + '（' + t[1].length + ' 字符 → ' + z.length + ' 字节）', back === t[1] ? '' : '往返不一致');
});

/* ============================================================
 * 2. 备份码往返
 * ============================================================ */
section('2. 备份码往返：数据不丢不变形');
var sample = {
  config: {
    jobType: 'service', modules: ['接听客户来电', '处理退换货', '整理客户资料与标签'],
    startDate: '2026-09-07', endDate: '2026-12-25', minWords: 300, dailyLoad: 12,
    company: '某电商公司', jobTitle: '电商客服', weeklyDue: '0', monthlyDue: '25',
    sections: [{ key: 'done', title: '今日完成', on: true }, { key: 'gains', title: '收获与学习', on: true }]
  },
  reports: {
    '2026-09-07': {
      date: '2026-09-07', text: '【实习日报】2026-09-07\n一、今日完成\n1. 完成 A 事项。',
      modules: ['接听客户来电'], extra: '参加了消防演练', problem: '物流信息同步滞后',
      submitted: true, tpls: ['tpl1', 'tpl2'], statCounted: true, updatedAt: '2026-09-07T10:00:00.000Z'
    },
    '2026-09-08': {
      date: '2026-09-08', text: '【实习日报】2026-09-08\n一、今日完成\n1. 完成 B 事项。',
      modules: ['处理退换货', '整理客户资料与标签'], extra: '', problem: '', submitted: false
    }
  },
  savedAgg: { 'weekly_2026-09-07_2026-09-13': { type: 'weekly', from: '2026-09-07', to: '2026-09-13', text: '本周小结…', createdAt: '2026-09-14T00:00:00.000Z' } },
  moduleStats: { '接听客户来电': { count: 3, lastDate: '2026-09-07' } },
  customPhrases: ['我的常用句式'],
  todos: [{ id: 't1', text: '学习通上班打卡', done: false }],
  settings: { theme: 'dark' }
};

var ctx2 = makeCtx();
ctx2.Store.data.config = sample.config;
ctx2.Store.data.reports = JSON.parse(JSON.stringify(sample.reports));
ctx2.Store.data.savedAgg = JSON.parse(JSON.stringify(sample.savedAgg));
ctx2.Store.data.moduleStats = JSON.parse(JSON.stringify(sample.moduleStats));
ctx2.Store.data.customPhrases = sample.customPhrases.slice();
ctx2.Store.data.todos = JSON.parse(JSON.stringify(sample.todos));
ctx2.Store.data.settings = { theme: 'dark' };

var code = ctx2.Store.makeCode();
ok(code.indexOf('IR2:') === 0, '生成的是新版压缩备份码（IR2: 前缀）');

var ctx3 = makeCtx();
var doneInfo = null, failErr = null;
ctx3.Store.importCode(code, function (info) { doneInfo = info; }, function (e) { failErr = e; });
ok(!failErr && doneInfo, '备份码可正常导入', failErr && failErr.message);
ok(doneInfo && doneInfo.reports === 2, '导入日报篇数正确（2 篇）', doneInfo && doneInfo.reports);

var d = ctx3.Store.data;
ok(d.config.jobType === 'service', '岗位类型保留');
ok(d.config.weeklyDue === '0' && d.config.monthlyDue === '25', '截止提醒设置保留');
ok(d.config.sections && d.config.sections.length === 2, '自定义栏目保留');
ok(d.reports['2026-09-07'].text === sample.reports['2026-09-07'].text, '日报正文逐字一致');
ok(d.reports['2026-09-07'].submitted === true && d.reports['2026-09-08'].submitted === false, '已提交标记保留');
ok(JSON.stringify(d.reports['2026-09-08'].modules) === JSON.stringify(['处理退换货', '整理客户资料与标签']), '模块列表保留');
ok(d.reports['2026-09-07'].extra === '参加了消防演练', '特殊事项保留');
ok(d.savedAgg['weekly_2026-09-07_2026-09-13'] && d.savedAgg['weekly_2026-09-07_2026-09-13'].text === '本周小结…', '周报留档保留');
ok(d.moduleStats['接听客户来电'] && d.moduleStats['接听客户来电'].count === 3, '模块轮换统计保留（影响后续生成公平性）');
ok(d.customPhrases[0] === '我的常用句式', '自建句式保留');
ok(d.todos[0].text === '学习通上班打卡', '待办保留');
ok(d.settings.theme === 'dark', '主题偏好保留');
ok(d.drafts && Object.keys(d.drafts.daily).length === 0, '临时草稿不进备份');

/* ============================================================
 * 3. 兼容旧格式
 * ============================================================ */
section('3. 兼容旧版备份码与裸 JSON');
var legacyJson = JSON.stringify({ app: 'intern-report', version: 1, exportedAt: '2026-09-07T00:00:00Z', data: sample });
var legacyCode = 'IR1:' + Buffer.from(legacyJson, 'utf8').toString('base64');

var ctxL = makeCtx();
var lOk = null, lErr = null;
ctxL.Store.importCode(legacyCode, function (i) { lOk = i; }, function (e) { lErr = e; });
ok(!lErr && lOk && lOk.reports === 2, '旧版 IR1 备份码仍可导入（老用户不丢数据）', lErr && lErr.message);

var ctxJ = makeCtx();
var jOk = null;
ctxJ.Store.importCode(legacyJson, function (i) { jOk = i; }, function () {});
ok(jOk && jOk.reports === 2, '直接粘贴 JSON 文本仍可导入');

/* ============================================================
 * 4. 粘贴容错：换行 / 空格 / 分段标记 / 重复前缀
 * ============================================================ */
section('4. 粘贴容错（微信分段、换行、多余前缀）');
var pretty = 'IR2:' + code.slice(4);
var chopped = pretty.match(/.{1,300}/g).map(function (seg, i, arr) {
  return '第' + (i + 1) + '/' + arr.length + '段：' + seg;
}).join('\n\n');
var ctxC = makeCtx();
var cOk = null;
ctxC.Store.importCode(chopped, function (i) { cOk = i; }, function () {});
ok(cOk && cOk.reports === 2, '分段 + 换行 + 段号 粘贴可自动还原', cOk && cOk.reports);

var body4 = code.slice(4);
var doubled = 'IR2:' + body4.slice(0, 300) + 'IR2:' + body4.slice(300);
var ctxD = makeCtx();
var dOk = null;
ctxD.Store.importCode(doubled, function (i) { dOk = i; }, function () {});
ok(dOk && dOk.reports === 2, '重复粘贴出多个前缀时可自动修掉');

/* ============================================================
 * 5. 畸形数据必须被拒绝（而不是写进库里）
 * ============================================================ */
section('5. 畸形输入被拒绝');
function tryImport(text) {
  var x = makeCtx();
  var done = false, err = null;
  x.Store.importCode(text, function () { done = true; }, function (e) { err = e; });
  return { ok: done, err: err, data: x.Store.data };
}
[
  ['完全不是 JSON', '这不是备份码'],
  ['JSON 但不是对象', '"hello"'],
  ['是对象但没有 reports', JSON.stringify({ foo: 1 })],
  ['reports 是数组', JSON.stringify({ reports: [] })],
  ['reports 是字符串', JSON.stringify({ reports: 'x' })],
  ['导出结构但 data 缺失', JSON.stringify({ app: 'intern-report', data: 'nope' })],
  ['日报数量异常（超上限）', JSON.stringify({ reports: (function () { var o = {}, d0 = new Date(1970, 0, 1); for (var i = 0; i < 9000; i++) { var x = new Date(d0); x.setDate(d0.getDate() + i); o[x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')] = { text: 'x' }; } return o; })() })]
].forEach(function (t) {
  var r = tryImport(t[1]);
  ok(!r.ok && r.err, '拒绝：' + t[0]);
});
var r0 = tryImport('这不是备份码');
ok(r0.data && Object.keys(r0.data.reports).length === 0, '被拒绝时不会污染本地数据');

/* ============================================================
 * 6. 局部脏数据：丢弃坏条目但保留好条目
 * ============================================================ */
section('6. 局部脏数据：坏的丢掉，好的保住');
var dirty = {
  reports: {
    '2026-09-07': { date: '2026-09-07', text: '好的一天', modules: ['正常模块'], submitted: true },
    'not-a-date': { date: 'not-a-date', text: '日期键非法', modules: [] },
    '2026-09-09': { date: '2026-09-09', text: 12345 },                       // text 不是字符串
    '2026-09-10': null,                                                       // 整条是 null
    '2026-09-11': { date: '2026-09-11', text: '好的一天二', modules: ['正常模块', 123, null, '', '正常模块'] }
  },
  moduleStats: { '正常模块': { count: 'abc', lastDate: 'garbage' } },
  customPhrases: ['短的', 42, null, '', '正常句式']
};
var ctx6 = makeCtx();
var i6 = null;
ctx6.Store.importCode(JSON.stringify(dirty), function (info) { i6 = info; }, function () {});
ok(i6 && i6.reports === 2, '只保留 2 篇合法日报', i6 && i6.reports);
ok(i6 && i6.skipped === 3, '上报跳过了 3 条脏记录', i6 && i6.skipped);
var d6 = ctx6.Store.data;
ok(JSON.stringify(d6.reports['2026-09-11'].modules) === JSON.stringify(['正常模块']), '模块数组里的非字符串被剔除');
ok(JSON.stringify(d6.customPhrases) === JSON.stringify(['短的', '正常句式']), '自定义句式里的非字符串被剔除');
ok(d6.moduleStats['正常模块'].count === 0, '非法计数被归零');
ok(d6.moduleStats['正常模块'].lastDate === '', '非法日期被清空');

/* ============================================================
 * 7. XSS 载荷：值保持原样（不执行），且未知岗位不崩
 * ============================================================ */
section('7. XSS 载荷与未知岗位');
var evil = '<img src=x onerror=alert(1)>';
var ctx7 = makeCtx();
var i7 = null, e7 = null;
ctx7.Store.importCode(JSON.stringify({
  config: { jobType: 'job_type_that_does_not_exist', modules: [evil], startDate: '2026-09-07', endDate: '2026-12-25' },
  reports: { '2026-09-07': { date: '2026-09-07', text: evil, modules: [evil], submitted: true } }
}), function (info) { i7 = info; }, function (e) { e7 = e; });
ok(i7 && !i7.uiError, '未知岗位类型不会让导入失败（数据保住）', e7 && e7.message);
ok(ctx7.Store.data.reports['2026-09-07'].modules[0] === evil, '模块名按纯文本原样保留（交给渲染层转义）');
ok(ctx7.Store.data.config.jobType === 'job_type_that_does_not_exist', '未知岗位 key 被原样保留，由界面提示用户重选');

// 静态护栏：渲染模块名的 DOM 汇聚点必须用 textContent，不能再拼 innerHTML
var appSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
ok(appSrc.indexOf("'<span class=\"m-name\">' + m + '</span>'") < 0, 'app.js 不再用 innerHTML 拼接模块名');
ok(/mName\.textContent\s*=\s*m/.test(appSrc), 'app.js 改用 textContent 写入模块名');
ok(appSrc.indexOf('Store.importCode') >= 0, 'app.js 走新的 importCode 通道');

/* ============================================================
 * 8. 体积：新版备份码必须远小于旧版
 * ============================================================ */
section('8. 备份码体积');
function legacySize(data) {
  return ('IR1:' + Buffer.from(JSON.stringify({ app: 'intern-report', version: 1, exportedAt: new Date().toISOString(), data: data }, null, 2), 'utf8').toString('base64')).length;
}
[['2 篇', 2, 2], ['20 篇', 20, 5], ['60 篇', 60, 10]].forEach(function (sc) {
  var n = sc[1], minRatio = sc[2];
  var ctxS = makeCtx();
  ctxS.Store.data.config = sample.config;
  var reps = {}, stats = {};
  for (var i = 0; i < n; i++) {
    var dt = new Date(2026, 8, 7 + i);
    var ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    // 模拟同模板产出的中文正文
    reps[ds] = {
      date: ds, submitted: true,
      text: '【实习日报】' + ds + '\n\n一、今日完成\n1. 做好了参加晨会与业务通报相关工作，与同事配合顺畅，达到了预期效果。\n2. 配合班组安排完成跟进异常物流订单相关事项' + (i % 9 + 2) + '项，处理结果均符合要求。\n\n二、收获与学习\n在实际操作中熟悉了业务流程，对' + (i % 5 + 2) + '个环节的配合方式有了更具体的认识。\n\n三、遇到的问题与解决\n物流信息同步存在滞后，已与对接同事确认按日核对的方式解决。\n\n四、明日计划\n继续跟进未完成事项，做好记录与交接。',
      modules: ['接听客户来电', '处理退换货', i % 3 ? '整理客户资料与标签' : '跟进异常物流订单']
    };
  }
  ctxS.Store.data.reports = reps;
  ctxS.Store.data.moduleStats = stats;
  var oldLen = legacySize({ config: sample.config, reports: reps, savedAgg: {}, moduleStats: {}, customPhrases: [], todos: [], settings: {} });
  var newLen = ctxS.Store.makeCode().length;
  var got = Math.round(oldLen / newLen);
  console.log('    ' + sc[0] + '：旧 ' + oldLen + ' 字符 → 新 ' + newLen + ' 字符  （缩小 ' + got + ' 倍）');
  ok(newLen < oldLen / minRatio, sc[0] + ' 新版备份码至少小 ' + minRatio + ' 倍', 'old=' + oldLen + ' new=' + newLen);
  ok(newLen < 30000, sc[0] + ' 备份码绝对长度可控（微信可发送）', newLen + ' 字符');
});

/* ============================================================
 * 9. 解压炸弹防护
 * ============================================================ */
section('9. 畸形压缩流不会卡死');
var ctxB = makeCtx();
var t0 = Date.now();
var bad = 'IR2:' + Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0]).toString('base64');
var bErr = null, bDone = false;
ctxB.Store.importCode(bad, function () { bDone = true; }, function (e) { bErr = e; });
ok(!bDone && bErr, '随机字节被判定为损坏并拒绝');
ok(Date.now() - t0 < 3000, '拒绝过程不卡顿（<' + (Date.now() - t0) + 'ms）');

/* ============================================================
 * 10. 保存失败上报
 * ============================================================ */
section('10. 保存失败会被上报，不再静默');
var ctxF = makeCtx();
var reports10 = [];
ctxF.Store.onSaveError = function (info) { reports10.push(info); };
ctxF.Store.data.reports['2026-09-07'] = { date: '2026-09-07', text: 'x', modules: [], submitted: false };
var okSave = ctxF.Store.save();
ok(okSave === true, '正常写入返回 true');
// 模拟配额写满
ctxF.localStorage.setItem = function () { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
var okSave2 = ctxF.Store.save();
ok(okSave2 === false, '写入失败返回 false');
ok(reports10.length === 1 && reports10[0].reason === 'failed', '保存失败回调恰好触发一次（不刷屏）');
var hadReported = reports10.length;
ctxF.Store.save();
ok(reports10.length === hadReported, '持续失败时不重复回调');

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
