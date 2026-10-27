// electron-builder afterPack：剥掉用不到的东西，把安装包压小
// 只保留中文简繁 + 英文三个语言包，其余 52 个语种（印地、泰卢固、孟加拉…）全删。
// Chromium 的 locales 单个 0.5-1.4MB，55 个合计 39MB，删完剩 1.4MB。
const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak', 'zh-TW.pak']);

module.exports = async function afterPack(context) {
  const outDir = context.appOutDir;
  const localeDir = path.join(outDir, 'locales');
  if (!fs.existsSync(localeDir)) return;

  let removed = 0;
  let freed = 0;
  for (const name of fs.readdirSync(localeDir)) {
    if (KEEP_LOCALES.has(name)) continue;
    const file = path.join(localeDir, name);
    try {
      freed += fs.statSync(file).size;
      fs.unlinkSync(file);
      removed++;
    } catch (e) {
      // 文件被占用就跳过，不影响出包
    }
  }
  console.log(
    `  • locales 精简 删除 ${removed} 个语言包，省下 ${(freed / 1048576).toFixed(1)} MB`
  );
};
