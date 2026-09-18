/* ============================================================
 * eslint.config.js — ESLint 9 flat config
 *
 * 定位：只开「能真正抓 bug」的规则，不做代码风格强制
 *       （风格统一交给 .editorconfig；本项目是 ES5 风格 IIFE，
 *        不引入 prettier，避免大面积改写既有代码）。
 *
 * 用法：npm run lint
 * ============================================================ */
'use strict';

var RULES = {
  // —— 真·bug 类 ——
  'no-undef': 'error',              // 未声明变量（变量名拼错、漏 var）
  'no-redeclare': 'error',          // 重复声明同一变量
  'no-dupe-keys': 'error',          // 对象字面量重复键（后者静默覆盖前者）
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-unreachable': 'error',        // return 之后的死代码
  'no-fallthrough': 'error',        // switch case 漏 break
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],

  // —— 噪音可控的提醒 ——
  /* 只报「声明了却没用到」，忽略 catch(e) 的 e（`catch (e) {}` 是惯用写法） */
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-extra-semi': 'warn'
};

/* 浏览器侧脚本（js/*.js + sw.js）可用的全局 */
var BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', console: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly',
  navigator: 'readonly', location: 'readonly', history: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  fetch: 'readonly', caches: 'readonly', self: 'readonly',
  btoa: 'readonly', atob: 'readonly',
  TextDecoder: 'readonly', TextEncoder: 'readonly',
  Request: 'readonly', Response: 'readonly', Headers: 'readonly', FormData: 'readonly',
  URL: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  Image: 'readonly', CustomEvent: 'readonly', Event: 'readonly',
  getComputedStyle: 'readonly', matchMedia: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  // 项目内部全局：各 js 是 IIFE，结尾挂到 window，其它文件按裸名引用
  Store: 'readonly', Phrases: 'readonly', Generator: 'readonly',
  Composer: 'readonly', App: 'readonly', Editor: 'readonly', Calendar: 'readonly'
};

/* Node 侧脚本（test / tools）可用的全局 */
var NODE_GLOBALS = {
  console: 'readonly', process: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
  require: 'readonly', module: 'writable', exports: 'writable',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  URL: 'readonly', global: 'readonly'
};

module.exports = [
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2021, sourceType: 'script', globals: BROWSER_GLOBALS },
    rules: RULES
  },
  {
    files: ['test/**/*.js', 'tools/**/*.js'],
    languageOptions: { ecmaVersion: 2021, sourceType: 'script', globals: NODE_GLOBALS },
    rules: RULES
  },
  {
    ignores: ['node_modules/**']
  }
];
