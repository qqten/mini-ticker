// 把 dist/latest.yml 改写成 Gitee 用的 update/latest.yml
//
// 为什么要多这一步：GitHub 有 releases/latest/download 这个固定别名，
// 更新器只要拼上文件名就行；Gitee 没有，下载路径必须带 tag。
// 所以 App 里预置的 feed 指向仓库里的 update/ 目录（路径永远不变），
// 而这份 yml 里的下载地址写成带 tag 的绝对 URL —— electron-updater
// 遇到绝对 URL 会直接用它，不再和 feed 地址拼接。
//
// 发版时跑：node scripts/make-update-yml.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const OWNER_REPO = 'qqten/mini-ticker';

const srcYml = path.join(ROOT, 'dist', 'latest.yml');
if (!fs.existsSync(srcYml)) {
  console.error('找不到 dist/latest.yml，先跑 npm run dist');
  process.exit(1);
}

const lines = fs.readFileSync(srcYml, 'utf8').split(/\r?\n/);
let rewritten = 0;
const out = lines.map(function (line) {
  // 只改顶层 files[] 里的 url，path/sha512 那些原样留着
  const m = line.match(/^(\s*-\s*url:\s*)(\S+)\s*$/);
  if (!m) return line;
  const name = path.basename(m[2]);
  rewritten++;
  return m[1] + 'https://gitee.com/' + OWNER_REPO + '/releases/download/' + tag + '/' + name;
});

if (!rewritten) {
  console.error('dist/latest.yml 里没找到 url 字段，格式变了？');
  process.exit(1);
}

const outDir = path.join(ROOT, 'update');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'latest.yml');
fs.writeFileSync(outFile, out.join('\n'), 'utf8');
console.log('已写入 ' + path.relative(ROOT, outFile) + '（' + version + '，' + rewritten + ' 个文件）');
console.log(out.filter(function (l) { return /url:/.test(l); }).join('\n'));
