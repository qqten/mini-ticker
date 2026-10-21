// 雪球连通性探测：填好 credentials.json 后运行 node scripts/xq-probe.js
// 只打印接口返回的结构，不会打印 cookie 内容
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CRED_PATH = path.join(ROOT, 'credentials.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

let cookie = '';
try {
  const c = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  cookie = ((c.xueqiu && c.xueqiu.cookie) || '').trim();
} catch (e) {}

if (!cookie) {
  console.log('');
  console.log('  ✗ credentials.json 里的 cookie 还是空的，先把雪球的 Cookie 粘进去再运行。');
  console.log('    路径：' + CRED_PATH);
  console.log('');
  process.exit(1);
}

console.log('\n  cookie 已读取，长度 ' + cookie.length + ' 字符（内容不显示）');
console.log('  含关键字段：' + ['xq_a_token', 'xq_r_token', 'u=', 'xq_id_token']
  .map(function (k) { return (cookie.indexOf(k) >= 0 ? '✓ ' : '✗ ') + k.replace(/=$/, ''); }).join('   '));

const H = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://xueqiu.com/',
  'X-Requested-With': 'XMLHttpRequest',
  'Cookie': cookie
};

async function probe(tag, url) {
  const short = url.replace('https://xueqiu.com', '');
  try {
    const r = await fetch(url, { headers: H });
    const t = await r.text();
    console.log('\n─── ' + tag + '  [HTTP ' + r.status + ']  ' + short);
    if (r.status === 200) {
      try {
        const j = JSON.parse(t);
        console.log('    top keys : ' + Object.keys(j).join(', '));
        const arr = j.list || j.items || j.data || (Array.isArray(j) ? j : null);
        if (Array.isArray(arr) && arr.length) {
          console.log('    条数     : ' + arr.length);
          console.log('    首条字段 : ' + Object.keys(arr[0]).slice(0, 24).join(', '));
          console.log('    首条样例 : ' + JSON.stringify(arr[0]).slice(0, 420));
        } else {
          console.log('    内容     : ' + JSON.stringify(j).slice(0, 420));
        }
      } catch (e) {
        console.log('    (非 JSON): ' + t.slice(0, 200));
      }
    } else {
      console.log('    ' + t.slice(0, 220));
    }
  } catch (e) {
    console.log('\n─── ' + tag + '  [ERR] ' + e.message);
  }
}

(async function () {
  await probe('① 登录态检查', 'https://xueqiu.com/v4/statuses/public_timeline_by_category.json?since_id=-1&max_id=-1&count=1&category=-1');
  await probe('② 组合榜 category=14', 'https://xueqiu.com/cubes/discover/rank/cube/list.json?category=14&count=5&market=CN');
  await probe('③ 组合榜 不带 category', 'https://xueqiu.com/cubes/discover/rank/cube/list.json?count=5&market=CN');
  await probe('④ 组合实时行情', 'https://xueqiu.com/cubes/quote.json?code=ZH024581');
  await probe('⑤ 调仓历史', 'https://xueqiu.com/cubes/rebalancing/history.json?cube_symbol=ZH024581&count=3&page=1');
  console.log('');
})();
