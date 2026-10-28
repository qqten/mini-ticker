'use strict';

// 语法自检：不依赖 Electron / 网络，CI 和提交前都能跑。
// 用 node --check 而不是 require，避免把主进程代码真正执行起来。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['electron', 'scripts', 'test'];
const EXTS = new Set(['.js', '.cjs', '.mjs']);

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function (entry) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(entry.name))) out.push(full);
  });
}

const files = [];
TARGETS.forEach(function (name) {
  const dir = path.join(ROOT, name);
  if (fs.existsSync(dir)) walk(dir, files);
});

let failed = 0;
files.forEach(function (file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write('语法错误：' + path.relative(ROOT, file) + '\n');
    process.stderr.write((result.stderr || '') + '\n');
  }
});

if (failed) {
  console.error('共 ' + failed + ' 个文件未通过语法检查');
  process.exit(1);
}
console.log('语法检查通过：' + files.length + ' 个文件');
