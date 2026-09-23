/* ============================================================
 * integration.test.js — 真机冒烟测试（jsdom 加载真实 index.html）
 * 运行：node test/integration.test.js
 *
 * 与 harness/draft/backup 不同，这个测试把 index.html 整个跑起来：
 * 真的执行 7 个脚本、真的触发点击、真的走 localStorage。
 * 目的是抓「静态检查抓不到、只有运行才暴露」的问题，比如
 * 绑定了不存在的元素、事件回调里抛错、导入后界面渲染炸掉。
 *
 * 依赖 jsdom（唯一的可选依赖，其它三套测试零依赖）。找不到时按顺序自己找：
 *   1) 常规 require('jsdom')
 *   2) 环境变量 HMZ_JSDOM 指向的 node_modules
 *   3) 项目内 node_modules
 *   4) WorkBuddy 的隔离 node 工作区（本机已装）
 * 全都找不到才跳过。所以直接双击「跑测试.bat」即可，不必手动设 NODE_PATH。
 * ============================================================ */
var fs = require('fs');
var path = require('path');

function loadJsdom() {
  try {
    return require('jsdom');
  } catch (e) { /* 继续找 */ }
  var dirs = [];
  if (process.env.HMZ_JSDOM) dirs.push(process.env.HMZ_JSDOM);
  dirs.push(path.join(__dirname, '..', 'node_modules'));
  dirs.push(path.join(process.cwd(), 'node_modules'));
  dirs.push('C:/Users/ASUS/.workbuddy/binaries/node/workspace/node_modules');
  for (var i = 0; i < dirs.length; i++) {
    var p = path.join(dirs[i], 'jsdom');
    try {
      if (fs.existsSync(p)) return require(p);
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

var jsdomMod = loadJsdom();
if (!jsdomMod) {
  console.log('\n[跳过] 没装 jsdom，跳过真机冒烟测试。');
  console.log('      它是唯一的「可选」依赖（其它三套测试不需要任何依赖）。');
  console.log('      想跑的话：npm install jsdom，然后重跑本文件。\n');
  process.exit(0);
}
var JSDOM = jsdomMod.JSDOM;
var VirtualConsole = jsdomMod.VirtualConsole;

var SRC = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '   → ' + extra : '')); }
}
function section(t) { console.log('\n===== ' + t + ' ====='); }

/* ---------- 把外链脚本内联进 HTML（jsdom 处理不了 file: 的 ?v= 查询串） ---------- */
function buildHtml() {
  var html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  return html.replace(/<script defer src="([^"?]+)(\?[^"]*)?"><\/script>/g, function (m, src) {
    return '<script>' + fs.readFileSync(path.join(SRC, src), 'utf8') + '\n</script>';
  });
}

/* ---------- 启动一个页面实例，并等 DOMContentLoaded 跑完 init ---------- */
function boot(opts) {
  opts = opts || {};
  var errors = [];
  var vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { errors.push(e); });

  var dom = new JSDOM(buildHtml(), {
    url: 'https://youxialy.github.io/haomingzi/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse: function (win) {
      win.addEventListener('error', function (e) { errors.push(e.error || e.message); });
      // 预置 localStorage：jsdom 的 localStorage 在 beforeParse 阶段就可用，
      // 所以 store.js 执行 load() 时会读到这份数据（用于「重开页面后回显」这类断言）
      if (typeof opts.seed === 'function') opts.seed(win);
      win.matchMedia = function (q) {
        return {
          matches: !!(opts.prefersDark && /prefers-color-scheme:\s*dark/.test(q)),
          media: q,
          addEventListener: function () {}, removeEventListener: function () {},
          addListener: function () {}, removeListener: function () {}
        };
      };
      win.scrollTo = function () {};
      win.print = function () {};
      win.confirm = function () { return true; };
      if (!win.URL.createObjectURL) win.URL.createObjectURL = function () { return 'blob:x'; };
      if (!win.URL.revokeObjectURL) win.URL.revokeObjectURL = function () {};
      win.HTMLAnchorElement.prototype.click = function () {};
    }
  });

  // DOMContentLoaded 是异步触发的，必须等它跑完 init()，否则界面还是空的
  return new Promise(function (resolve) {
    function done() {
      resolve({ dom: dom, win: dom.window, doc: dom.window.document, errors: errors, realStorage: dom.window.localStorage });
    }
    if (dom.window.document.readyState === 'complete') setTimeout(done, 0);
    else dom.window.addEventListener('load', function () { setTimeout(done, 0); });
  });
}

function fire(el, type) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
}
function tabTo(doc, name) {
  Array.prototype.forEach.call(doc.querySelectorAll('.tab'), function (b) {
    if (b.dataset.tab === name) b.click();
  });
}

async function main() {
  /* ============================================================
   * 1. 页面能正常启动
   * ============================================================ */
  section('1. 页面启动（7 个脚本全部执行、绑定全部命中）');
  var A = await boot();
  var win = A.win, doc = A.doc;
  /* deviceId 由 store.js 加载时随机生成 → 每次运行种子都不同，生成类断言会偶发抖动。
   * 测试里固定它（生产逻辑不变），保证结果可复现。 */
  if (win.Store.data && win.Store.data.settings) win.Store.data.settings.deviceId = 'test-fixed';
  ok(A.errors.length === 0, '启动无未捕获异常', A.errors.map(function (e) { return (e && e.message) || e; }).join(' | '));
  ['App', 'Store', 'Editor', 'Calendar', 'Phrases', 'Generator', 'Composer'].forEach(function (k) {
    ok(win[k] && (typeof win[k] === 'object' || typeof win[k] === 'function'), '全局 ' + k + ' 已就绪');
  });
  ok(win.Store.data && typeof win.Store.data.reports === 'object', '数据层已初始化');
  ok(!!doc.getElementById('noticeBanner').hidden, '启动时没有误报警示条');
  ok(doc.getElementById('tabbtn-daily').getAttribute('aria-selected') === 'true', '首屏页签 aria-selected 正确');
  ok(!!doc.getElementById('mainContent'), 'skip-link 目标 #mainContent 存在');
  ok(doc.getElementById('toast').getAttribute('aria-live') === 'polite', 'toast 带 aria-live');
  ok(doc.querySelectorAll('#jobGrid .job-card').length === 28, 'init 跑完了（岗位卡片已渲染）');

  /* ============================================================
   * 2. 主流程：配置 → 生成 → 保存 → 切日期不丢
   * ============================================================ */
  section('2. 主流程：配置 → 生成 → 保存 → 切日期不丢');
  tabTo(doc, 'settings');
  ok(doc.getElementById('tab-settings').classList.contains('active'), '点击页签能切到「设置」');

  var cards = doc.querySelectorAll('#jobGrid .job-card');
  ok(cards[0].tagName === 'BUTTON', '岗位卡片是真正的 button（键盘可达）');
  cards[0].click();
  ok(doc.querySelectorAll('#moduleBox .module-chip').length > 0, '选中岗位后带出工作模块');
  ok(doc.querySelectorAll('#moduleBox .module-chip[aria-checked="true"]').length === 4, '默认勾选前 4 个模块');

  doc.getElementById('cfgStart').value = '2026-09-07';
  doc.getElementById('cfgEnd').value = '2026-12-25';
  doc.getElementById('cfgMinWords').value = '300';
  doc.getElementById('cfgSave').click();
  ok(!!win.Store.data.config, '配置已保存');
  ok(win.Store.data.config.modules.length === 4, '配置里存下 4 个模块');

  /* --- 模块的动态增 / 改 / 删 / 恢复默认（2026-09-19 新增能力）---
   * 只改编辑态，不点保存，所以不会污染上面刚存好的配置。 */
  var chipNames = function () {
    return [].map.call(doc.querySelectorAll('#moduleBox .module-chip .m-name'), function (n) { return n.textContent; });
  };
  var findChip = function (name) {
    return [].filter.call(doc.querySelectorAll('#moduleBox .module-chip'), function (c) {
      return c.querySelector('.m-name').textContent === name;
    })[0];
  };
  var pressKey = function (el, key) {
    el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: key, bubbles: true }));
  };

  doc.getElementById('customModule').value = '自定义测试模块';
  doc.getElementById('moduleAdd').click();
  ok(chipNames().indexOf('自定义测试模块') >= 0, '新增自定义模块出现在列表里');
  var newChip = findChip('自定义测试模块');
  ok(!!newChip && newChip.getAttribute('aria-checked') === 'true', '新增的自定义模块默认勾选');
  ok(!!newChip.querySelector('.m-del'), '自定义模块带移除按钮');
  ok(!!newChip.querySelector('.m-edit'), '每个模块都带重命名按钮');

  newChip.querySelector('.m-edit').click();
  var rn = doc.querySelector('#moduleBox .m-rename');
  ok(!!rn, '点 ✎ 出现重命名输入框');
  if (rn) {
    rn.value = '改名后的模块';
    pressKey(rn, 'Enter');
    ok(chipNames().indexOf('改名后的模块') >= 0, '回车后重命名生效');
    ok(chipNames().indexOf('自定义测试模块') < 0, '旧名字已消失');
  }

  var renamed = findChip('改名后的模块') || newChip;
  renamed.querySelector('.m-del').click();
  ok(chipNames().indexOf('改名后的模块') < 0, '点 ✕ 能移除自定义模块');

  // 重命名一个预设模块 → 应变成「自定义 + 原预设不再勾选」，不能凭空多出一个勾选项
  var presetChip = findChip(cards[0] && win.Phrases.jobTypes[win.Store.data.config.jobType].modules[0]);
  if (presetChip) {
    presetChip.querySelector('.m-edit').click();
    var rn2 = doc.querySelector('#moduleBox .m-rename');
    if (rn2) {
      rn2.value = '预设改名后的模块';
      pressKey(rn2, 'Enter');
      ok(chipNames().indexOf('预设改名后的模块') >= 0, '预设模块也能重命名');
      ok(!!findChip('预设改名后的模块').querySelector('.m-del'), '重命名后的预设变成了自定义模块');
    }
  }

  doc.getElementById('moduleReset').click();
  ok(doc.querySelectorAll('#moduleBox .module-chip[aria-checked="true"]').length === 4, '恢复默认后回到勾选 4 个');
  ok(doc.querySelectorAll('#moduleBox .m-del').length === 0, '恢复默认后自定义模块已清空');

  tabTo(doc, 'daily');
  var dateInput = doc.getElementById('dateInput');
  dateInput.value = '2026-09-07';
  fire(dateInput, 'change');
  ok(doc.getElementById('dailyStat').textContent.indexOf('已保存日报') >= 0, '顶部统计行渲染出来');

  doc.getElementById('genBtn').click();
  var generated = doc.getElementById('reportEditor').value;
  ok(generated.length > 100, '生成日报成功（' + generated.length + ' 字）');
  ok(doc.getElementById('wordCount').textContent.indexOf('字') > 0, '字数统计已更新');

  doc.getElementById('saveBtn').click();
  var stored = JSON.parse(win.localStorage.getItem('irdp_data_v1'));
  ok(!!stored.reports['2026-09-07'], '日报已写入 localStorage');
  ok(stored.reports['2026-09-07'].text === generated, '落盘内容与编辑器一致');

  // 未保存的改动 + 切日期 → 草稿必须还在
  doc.getElementById('reportEditor').value += '\n手工补的一句。';
  fire(doc.getElementById('reportEditor'), 'input');
  doc.getElementById('nextDay').click();
  ok(doc.getElementById('dateInput').value === '2026-09-08', '切到下一天');
  doc.getElementById('prevDay').click();
  ok(doc.getElementById('reportEditor').value.indexOf('手工补的一句') > 0, '切回来后未保存的改动还在（不再白写）');
  ok(!doc.getElementById('draftHint').hidden, '显示「已恢复未保存草稿」提示');

  /* ============================================================
   * 3. 周报/月报
   * ============================================================ */
  section('3. 周报月报');
  tabTo(doc, 'aggregate');
  ok(doc.getElementById('tab-aggregate').classList.contains('active'), '切到周报月报页签');
  // 「本期」是本周（今天 2026-09-17），而测试数据在 09-07，改用自定义范围覆盖
  Array.prototype.forEach.call(doc.querySelectorAll('#rangePicks button'), function (b) {
    if (b.dataset.range === 'custom') b.click();
  });
  ok(!doc.getElementById('customRange').hidden, '选「自定义」后显示起止日期输入框');
  doc.getElementById('aggFrom').value = '2026-09-07';
  doc.getElementById('aggTo').value = '2026-09-30';
  fire(doc.getElementById('aggFrom'), 'change');
  fire(doc.getElementById('aggTo'), 'change');
  doc.getElementById('aggGenBtn').click();
  ok(doc.getElementById('aggEditor').value.length > 50, '周报草稿生成成功（' + doc.getElementById('aggEditor').value.length + ' 字）');
  doc.getElementById('aggSaveBtn').click();
  ok(Object.keys(win.Store.data.savedAgg).length === 1, '周报留档已保存');
  ok(doc.getElementById('savedList').children.length === 1, '留档列表渲染出 1 条');
  // 切到月报再切回，草稿不丢
  Array.prototype.forEach.call(doc.querySelectorAll('#aggType button'), function (b) { if (b.dataset.type === 'monthly') b.click(); });
  Array.prototype.forEach.call(doc.querySelectorAll('#aggType button'), function (b) { if (b.dataset.type === 'weekly') b.click(); });
  ok(doc.getElementById('aggEditor').value.length > 50, '周报/月报来回切，草稿不丢');

  /* ============================================================
   * 4. 备份码端到端
   * ============================================================ */
  section('4. 备份码端到端');
  tabTo(doc, 'settings');
  var code = win.Store.makeCode();
  ok(code.indexOf('IR2:') === 0, '生成压缩备份码（IR2:）');
  ok(code.length < 30000, '备份码长度可控（' + code.length + ' 字符）');

  var box = doc.getElementById('backupCodeIn');
  box.value = code;
  doc.getElementById('restoreCodeBtn').click();
  ok(!!win.Store.data.reports['2026-09-07'], '粘贴备份码点「恢复」后数据仍在');
  ok(box.value === '', '恢复后输入框已清空');
  ok(doc.getElementById('toast').textContent.indexOf('恢复成功') >= 0, '给出「恢复成功」提示');

  var seg = code.match(/.{1,200}/g).map(function (s, i, a) { return '第' + (i + 1) + '/' + a.length + '段：' + s; }).join('\n\n');
  box.value = seg;
  doc.getElementById('restoreCodeBtn').click();
  ok(!!win.Store.data.reports['2026-09-07'], '分段 + 换行 + 段号 粘贴也能恢复');

  box.value = 'IR2:AAAA这不是真的备份码';
  doc.getElementById('restoreCodeBtn').click();
  ok(doc.getElementById('toast').textContent.indexOf('恢复失败') >= 0, '坏备份码给出明确失败提示');
  ok(!!win.Store.data.reports['2026-09-07'], '坏备份码不会清掉现有数据');

  /* ============================================================
   * 5. 未知岗位 + XSS 载荷（端到端）
   * ============================================================ */
  section('5. 未知岗位与 XSS 载荷（端到端）');
  var lz = win.Store._lz;
  function makeEvil(wire) {
    return 'IR2:' + win.btoa(String.fromCharCode.apply(null, lz.compress(JSON.stringify(wire))));
  }

  box.value = makeEvil({
    v: 2,
    c: { jobType: '<img src=x onerror="window.__pwned=1">', modules: ['<svg onload="window.__pwned=2">'], startDate: '2026-09-07', endDate: '2026-12-25' },
    r: [['2026-09-07', '恶意正文', '<img src=x onerror="window.__pwned=3">', '', '', 1]],
    m: [], s: {}
  });
  doc.getElementById('restoreCodeBtn').click();

  ok(win.__pwned === undefined, '没有任何脚本被注入执行');
  var notice = doc.getElementById('noticeBanner');
  ok(!notice.hidden, '未知岗位弹出常驻提示条');
  ok(doc.getElementById('noticeText').querySelector('img') === null, '提示条里没有真的 img 元素（已转义）');
  ok(doc.getElementById('noticeText').textContent.indexOf('<img') >= 0, '提示条把恶意串当纯文本显示');
  ok(!!win.Store.data.reports['2026-09-07'], '恶意码里的日报数据仍然恢复（不因岗位未知而丢）');
  ok(win.Store.data.config.jobType === '<img src=x onerror="window.__pwned=1">', '未知岗位 key 原样保留，等待用户重选');
  ok(doc.querySelectorAll('#moduleBox .module-chip').length === 0, '未知岗位时不渲染模块列表（而不是抛错）');
  ok(doc.getElementById('moduleBox').textContent.indexOf('在本版本里不存在') >= 0, '给出「岗位类型不存在，请重选」的说明');
  ok(doc.getElementById('toast').textContent.indexOf('成功') >= 0, '导入被判定为成功（不再谎报「已损坏」）');

  // 存在的岗位 + 恶意模块名 → chip 必须是纯文本
  box.value = makeEvil({
    v: 2,
    c: { jobType: 'service', modules: ['<img src=x onerror="window.__pwned=4">'], startDate: '2026-09-07', endDate: '2026-12-25' },
    r: [['2026-09-07', '正文', '', '', '', 1]],
    m: [], s: {}
  });
  doc.getElementById('restoreCodeBtn').click();
  ok(win.__pwned === undefined, '模块名载荷也没执行');
  var modBox = doc.getElementById('moduleBox');
  ok(modBox.querySelector('img') === null, '模块 chip 里没有真的 img 元素');
  ok(modBox.textContent.indexOf('<img') >= 0, '模块名以纯文本呈现');
  ok(modBox.querySelectorAll('.module-chip[aria-checked]').length > 0, '模块 chip 带 aria-checked');

  /* ============================================================
   * 6. 主题 / 弹窗 / 页签键盘
   * ============================================================ */
  section('6. 主题、弹窗、页签键盘');
  var before = doc.documentElement.getAttribute('data-theme');
  doc.getElementById('themeBtn').click();
  ok(doc.documentElement.getAttribute('data-theme') !== before, '主题按钮能切换深浅色');
  ok(win.Store.data.settings.theme === 'dark' || win.Store.data.settings.theme === 'light', '主题选择已落盘');
  ok(!!doc.getElementById('themeBtn').getAttribute('aria-label'), '主题按钮有 aria-label');

  doc.getElementById('feedbackLink').click();
  var fbMask = doc.getElementById('feedbackMask');
  ok(!fbMask.hidden, '意见反馈弹窗能打开');
  ok(fbMask.querySelector('.modal-card').getAttribute('aria-modal') === 'true', '弹窗带 aria-modal');
  ok(!!fbMask.querySelector('#fbCopyQQ'), '反馈渠道用 DOM 构建（含复制群号按钮）');
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(fbMask.hidden, 'Esc 能关闭弹窗');

  doc.getElementById('settingsInstallBtn').click();
  ok(!doc.getElementById('installMask').hidden, '安装说明弹窗能打开');
  doc.getElementById('installHelpClose').click();
  ok(doc.getElementById('installMask').hidden, '按钮能关闭弹窗');

  doc.getElementById('tabs').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  doc.getElementById('tabbtn-daily').focus();
  doc.getElementById('tabs').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  ok(doc.getElementById('tabbtn-aggregate').getAttribute('aria-selected') === 'true', '页签支持左右方向键切换');

  /* ============================================================
   * 7. 保存失败会被看见
   * ============================================================ */
  section('7. 保存失败不再静默');
  // 注意：不能直接赋值 win.localStorage.setItem —— jsdom 的 Storage 是 Proxy，
  // 赋值会被当成「写一条名为 setItem 的数据」，方法根本没被替换（踩过）。
  // 正确做法是把整个 localStorage 访问器换掉。
  var fakeStorage = {
    _s: {},
    getItem: function (k) { return this._s[k] === undefined ? null : this._s[k]; },
    setItem: function () { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
    key: function () { return null; },
    length: 0
  };
  Object.defineProperty(win, 'localStorage', { value: fakeStorage, configurable: true, writable: true });
  ok(win.Store.save() === false, '写入失败时 save 返回 false');
  var nb = doc.getElementById('noticeBanner');
  ok(!nb.hidden, '保存失败后弹出常驻警示条');
  ok(nb.className.indexOf('danger') >= 0, '保存失败用 danger 样式（红色）', nb.className);
  ok(doc.getElementById('noticeText').textContent.indexOf('导出备份') >= 0, '提示里引导用户导出备份');
  doc.getElementById('noticeClose').click();
  ok(nb.hidden, '警示条可关闭');
  Object.defineProperty(win, 'localStorage', { value: A.realStorage, configurable: true, writable: true });
  ok(win.Store.save() === true, '恢复写入后 save 返回 true');
  ok(!!win.Store.data.reports['2026-09-07'], '数据未被破坏');

  /* ============================================================
   * 8. 备份提醒
   * ============================================================ */
  section('8. 备份提醒文案');
  tabTo(doc, 'settings');
  var hint = doc.getElementById('backupHint').textContent;
  ok(hint.indexOf('还没有备份过') >= 0, '从未备份时提示「还没备份过」：' + hint.slice(0, 40) + '…');
  win.Store.markBackedUp();
  win.App.goTab('settings');
  ok(doc.getElementById('backupHint').textContent.indexOf('今天') >= 0, '备份后提示更新为「今天」');

  /* ============================================================
   * 9. 导出备份文件
   * ============================================================ */
  section('9. 导出备份文件');
  var realCreate = win.URL.createObjectURL;
  var madeBlob = null;
  win.URL.createObjectURL = function (b) { madeBlob = b; return 'blob:x'; };
  doc.getElementById('exportBtn').click();
  ok(!!madeBlob, '导出按钮真的创建了 Blob');
  ok(typeof win.Store.data.settings.lastBackupAt === 'number', '导出后记下备份时间（用于提醒）');
  win.URL.createObjectURL = realCreate;

  /* ============================================================
   * 10. 深色系统偏好 + 首屏
   * ============================================================ */
  section('10. 跟随系统深色');
  var D = await boot({ prefersDark: true });
  ok(D.win.document.documentElement.getAttribute('data-theme') === 'dark', '系统深色时首次打开就是深色（不闪白）');
  var L = await boot({ prefersDark: false });
  ok(L.win.document.documentElement.getAttribute('data-theme') === 'light', '系统浅色时是浅色');

  /* ============================================================
   * 11. 排版样式控件（端到端：点单选 → 保存 → 生成时生效）
   * 这是 2026-09-19 新增的 UI，静态检查抓不到「id 改名了但 JS 还在找旧 id」
   * 这类问题，所以必须在真实 DOM 上点一遍。
   * ============================================================ */
  section('11. 排版样式选项（端到端）');
  (function () {
    tabTo(doc, 'settings');
    var radios = doc.querySelectorAll('#layoutBox input[name=layout]');
    ok(radios.length === 4, '排版选项有 4 个档位（自动轮换 / 数字派 / 符号派 / 固定）', '实际 ' + radios.length);
    var byVal = {};
    [].forEach.call(radios, function (r) { byVal[r.value] = r; });
    ok(byVal[''] && byVal['family:num'] && byVal['family:sym'] && byVal['fixed'],
      '四个档位的 value 齐全（含默认空值档）');
    ok(byVal[''].checked === true, '默认选中「自动轮换」');
    ok(doc.getElementById('layoutFixedBox').hidden === true, '非固定档时不显示「选哪一套」下拉');
    ok(doc.getElementById('layoutFixed').options.length === 6, '固定档下拉列出全部 6 套版式',
      '实际 ' + doc.getElementById('layoutFixed').options.length);

    // 切到固定档 → 下拉出现 + 风险提示出现
    byVal['fixed'].checked = true;
    byVal['fixed'].dispatchEvent(new win.Event('change', { bubbles: true }));
    ok(doc.getElementById('layoutFixedBox').hidden === false, '切到固定档后下拉展开');
    ok(/固定版式/.test(doc.getElementById('layoutWarn').textContent), '固定档给出风险提示文案');

    doc.getElementById('layoutFixed').value = 'sk3';
    doc.getElementById('cfgSave').click();
    ok(win.Store.data.config.layout === 'sk3', '保存后 config.layout = sk3（得到 ' +
      win.Store.data.config.layout + '）');

    // 切回自动轮换并保存
    byVal[''].checked = true;
    byVal[''].dispatchEvent(new win.Event('change', { bubbles: true }));
    ok(doc.getElementById('layoutFixedBox').hidden === true, '切回自动轮换后下拉收起');
    doc.getElementById('cfgSave').click();
    ok(win.Store.data.config.layout === '', '切回自动轮换后 config.layout 为空串（得到 ' +
      JSON.stringify(win.Store.data.config.layout) + '）');

    // 重新载入设置页时，已保存的档位要回显到控件上。
    // 注意：tabTo 只切页签、不重跑 loadConfigToWizard（那是初始化时跑一次的），
    // 所以这里走「保存 → 记下 → 重新 boot 一个页面」的路径来验回显。
    win.Store.data.config.layout = 'family:sym';
    win.Store.save();

    // 固定档要能真正影响生成结果：直接走界面上的「生成日报」按钮
    win.Store.data.config.layout = 'sk5';
    win.Store.data.config.minWords = 300;
    win.Store.save();
    tabTo(doc, 'daily');
    doc.getElementById('genBtn').click();
    var day = doc.getElementById('dateInput').value;
    var rec = win.Store.data.reports[day];
    var sk = rec && (rec.tpls || []).filter(function (t) { return /^@sk[1-6]$/.test(t); })[0];
    ok(sk === '@sk5', '固定档真的决定了生成用的版式（' + day + ' 得到 ' + sk + '）');

    // 收尾：还原成默认档，别影响后续小节
    win.Store.data.config.layout = '';
    win.Store.save();
  })();

  /* 回显：把 layout 存进 localStorage，再启动一次页面，设置页控件应选中对应档位 */
  var reloadLayout = await boot({ seed: function (w) {
    w.localStorage.setItem('irdp_data_v1', JSON.stringify({
      config: { jobType: 'newmedia', modules: ['图文内容选题策划'], startDate: '2026-09-07', layout: 'family:sym' },
      reports: {}, savedAgg: {}, moduleStats: {}, customPhrases: [], todos: [],
      drafts: { daily: {}, agg: {}, summary: '' },
      settings: { theme: '', deviceId: 'test-fixed' }
    }));
  } });
  (function () {
    var rd = reloadLayout.doc;
    var shown = '';
    [].forEach.call(rd.querySelectorAll('#layoutBox input[name=layout]'), function (r) { if (r.checked) shown = r.value; });
    ok(shown === 'family:sym', '重开页面后已保存的档位回显到控件（得到 ' + JSON.stringify(shown) + '）');
    ok(rd.getElementById('layoutFixedBox').hidden === true, '家族档不展开「固定某一套」下拉');
  })();

  /* ============================================================
   * 12. guide.html
   * ============================================================ */
  section('12. guide.html');
  var gHtml = fs.readFileSync(path.join(SRC, 'guide.html'), 'utf8');
  ok(gHtml.indexOf('prefers-color-scheme') > 0, 'guide.html 头部有主题判定脚本');
  ok(gHtml.indexOf('name="theme-color"') > 0, 'guide.html 有 theme-color meta（且随主题切换）');
  ok(gHtml.indexOf('themeColorMeta') > 0, 'guide.html 的 theme-color 带 id，深色时会被改写');
  var G = new JSDOM(gHtml, { url: 'https://youxialy.github.io/haomingzi/guide.html', runScripts: 'dangerously', pretendToBeVisual: true });
  ok(!!G.window.document.getElementById('toast'), 'guide.html 能解析并保留 toast 容器');

  /* ============================================================
   * 13. 复制到剪贴板（iOS 三条硬约束的回归锁）
   *
   * 起因（2026-09-23）：iOS Safari 要求 execCommand('copy') **待在用户手势的同步调用栈内**，
   * 不得位于 Promise.then / setTimeout / 后续微任务里。旧实现先调 Clipboard API、把 execCommand
   * 放进 .then 的兜底 → 手势链断掉 → iPhone 上复制失败，只能提示「请手动全选复制」。
   * 这里锁四件事：① 同步路径**先于** Clipboard API 被调用 ② 临时元素是 textarea（input 会吃掉换行）
   *              ③ 元素真的拿到焦点 + setSelectionRange 生效 + 满足 iOS「可见性」要求
   *              ④ 用完即清理，不留 DOM 残留
   * ============================================================ */
  section('13. 复制到剪贴板（iOS 同步约束）');
  {
    var hadExec = typeof doc.execCommand === 'function';
    var origExec = doc.execCommand;
    var origClip = win.navigator.clipboard;
    var calls = [], seen = null, seenVal = null, seenInDoc = false;
    var SAMPLE = '第一行\n第二行';

    function mockExec(ret) {
      doc.execCommand = function () {
        calls.push('exec');
        seen = doc.activeElement;                 // 抓「谁真的拿到了焦点」
        seenVal = seen ? seen.value : null;
        // ⚠️ 必须在「当场」判断是否挂在文档上 —— 复制结束后元素会被移除，那时 parentNode 已变 null
        seenInDoc = !!(seen && seen.parentNode);
        return ret;
      };
    }
    function mockApi(ok2) {
      var called = false;
      win.navigator.clipboard = {
        writeText: function () {
          called = true;
          return ok2 ? Promise.resolve() : Promise.reject(new Error('nope'));
        }
      };
      return function () { return called; };
    }

    try {
      /* ---- ① 同步路径优先（旧实现正好相反） ---- */
      var nTa = doc.querySelectorAll('textarea').length;
      mockExec(true);
      var apiCalled = mockApi(true);
      win.Editor.copyText(SAMPLE);
      ok(calls.length > 0 && calls[0] === 'exec',
        'execCommand 先于 Clipboard API 被调用（旧实现反了 → iOS 上必然失败）', calls.join(' > '));
      ok(apiCalled() === false, '同步路径成功时不再调用 Clipboard API');

      /* ---- ② 临时元素的形态 ---- */
      ok(!!seen && seen.tagName === 'TEXTAREA',
        'execCommand 执行时持焦点的是临时 textarea（focus 落到实处，且用 textarea 而不是 input —— '
        + 'input 的 value 会吃掉换行，日报会被压成一行）',
        seen ? seen.tagName : 'activeElement 为空');
      ok(seenVal === SAMPLE, '内容完整、换行保留', JSON.stringify(seenVal));
      ok(!!seen && seen.hasAttribute('readonly'), '临时元素是 readonly（否则 iOS 会弹软键盘）');

      /* ---- ③ iOS 的三条约束 ---- */
      /* 焦点这条由上面那句覆盖：mock 里抓的 doc.activeElement 就是「谁真的拿到了焦点」。
       * 这里补一条「复制时元素确实在文档里」—— iOS 要求被选中的是真实存在的元素。
       * （seenInDoc 是当场抓的：复制结束后元素已被移除，那时再看 parentNode 已经晚了） */
      ok(seenInDoc, '复制发生时元素已挂进文档（不是在游离节点上选）');
      ok(!!seen && seen.selectionStart === 0 && seen.selectionEnd === SAMPLE.length,
        'setSelectionRange 选中了全部内容（光靠 select() 在 iOS 上不可靠）',
        seen ? (seen.selectionStart + '~' + seen.selectionEnd) : '');
      var st = seen ? seen.style : null;
      ok(!!st && st.opacity !== '0' && st.display !== 'none' && st.visibility !== 'hidden',
        '元素不是「不可见」（iOS 会因为 opacity:0 / display:none 拒绝复制）', st ? st.cssText : '');
      ok(!!st && /-?\d{4}px/.test(st.left || ''), '元素靠「移出视口」隐藏而不是靠透明', st ? st.left : '');

      /* ---- ④ 清理 ---- */
      ok(doc.querySelectorAll('textarea').length === nTa, '临时元素用完即清理，DOM 不留残留');

      /* ---- ⑤ 同步失败 → 回退 Clipboard API ---- */
      calls = [];
      mockExec(false);
      var api2 = mockApi(true);
      win.Editor.copyText('x');
      ok(calls.indexOf('exec') === 0 && api2() === true, '同步失败时回退到 Clipboard API', calls.join(' > '));

      /* ---- ⑥ 两条都失败 → 明确提示（不再静默） ---- */
      mockExec(false);
      mockApi(false);
      win.Editor.copyText('x');
      await Promise.resolve();
      await Promise.resolve();
      var tt = doc.getElementById('toast');
      ok(!!tt && tt.textContent.indexOf('复制失败') >= 0,
        '两条路都失败时给出明确提示（旧实现失败也可能显示「已复制」）', tt ? tt.textContent : '');
    } finally {
      if (hadExec) doc.execCommand = origExec; else delete doc.execCommand;
      win.navigator.clipboard = origClip;
    }
  }

  /* ============================================================
   * 汇总
   * ============================================================ */
  console.log('\n================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('\n未捕获异常列表：');
    A.errors.forEach(function (e) { console.log('  · ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e)); });
  }
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试自身出错：', e);
  process.exit(2);
});
