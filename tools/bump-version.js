#!/usr/bin/env node
/* ============================================================
 * tools/bump-version.js — 一键升级缓存版本号（只改这 3 个文件，共 10 处）
 *
 * 用法：
 *   node tools/bump-version.js 2026091901   指定版本号（YYYYMMDDNN）
 *   node tools/bump-version.js              省略 = 按当天日期自动生成 YYYYMMDD01
 *   node tools/bump-version.js --dry-run    只预览，不落盘
 *
 * 覆盖范围：
 *   · index.html  —— css + 7 个 js 的 ?v=（8 处）
 *   · guide.html  —— css 的 ?v=（1 处）
 *   · sw.js       —— var VERSION = '...'（1 处）
 *
 * 为什么需要它：手工改 10 处极易漏，漏一处老用户就拿不到新代码。
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var FILES = ['index.html', 'guide.html', 'sw.js'];

var V_FIND = /\?v=(\d{8,})/;                  // 取当前值：不带 g，需要捕获组
var V_ALL = /\?v=[\w.-]+/g;                   // 计数 / 替换：带 g
var SW_FIND = /var VERSION = '(\d{8,})'/;     // 取 sw.js 当前值
var SW_REPL = /(var VERSION = ')[^']+(';)/;   // 替换 sw.js

function todayTag() {
  var d = new Date();
  var p = function (n) { return String(n).padStart(2, '0'); };
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '01';
}

function readIfExists(rel) {
  var abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.error('✗ 缺文件：' + rel); process.exit(1); }
  return fs.readFileSync(abs, 'utf8');
}

var args = process.argv.slice(2);
var dry = args.indexOf('--dry-run') >= 0 || args.indexOf('-n') >= 0;
var explicit = args.filter(function (a) { return a.charAt(0) !== '-'; })[0];
var next = explicit || todayTag();

if (!/^\d{8,}$/.test(next)) {
  console.error('✗ 版本号必须是 8 位以上数字（YYYYMMDDNN），收到：' + next);
  process.exit(1);
}

// 读取现状（顺便检查三处是否一致）
var seen = {}, srcs = {}, total = 0;
FILES.forEach(function (f) {
  var s = readIfExists(f);
  srcs[f] = s;
  var hit = (s.match(V_ALL) || []).length + (SW_FIND.test(s) ? 1 : 0);
  total += hit;
  var m = s.match(V_FIND) || s.match(SW_FIND);
  if (m) seen[m[1]] = (seen[m[1]] || 0) + 1;
});
var olds = Object.keys(seen);

console.log('仓库：' + ROOT);
console.log('当前版本号：' + (olds.length ? olds.join(' / ') : '(未找到)'));
console.log('需修改处数：' + total + ' 处');
if (olds.length !== 1 || total !== 10) {
  console.log('⚠️  与预期的「单一版本号 / 共 10 处」不符，请核对（仍会按匹配结果替换）');
}
console.log('目标版本号：' + next + (explicit ? '' : '（按当天日期自动生成）') + (dry ? '   [dry-run]' : ''));
console.log('');

var changed = 0;
FILES.forEach(function (f) {
  var s = srcs[f];
  var hits = (s.match(V_ALL) || []).length + (SW_FIND.test(s) ? 1 : 0);
  var out = s.replace(V_ALL, '?v=' + next).replace(SW_REPL, '$1' + next + '$2');
  var did = out !== s;
  if (did) { changed++; if (!dry) fs.writeFileSync(path.join(ROOT, f), out, 'utf8'); }
  console.log('  ' + (did ? '改' : '·') + '  ' + f.padEnd(12) + hits + ' 处');
});

console.log('');
console.log((dry ? '将修改 ' : '已修改 ') + total + ' 处 → ' + next + '（涉及 ' + changed + ' 个文件）');
if (dry) console.log('去掉 --dry-run 即真正写入。');
