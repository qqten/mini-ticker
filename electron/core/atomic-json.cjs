'use strict';

const fs = require('fs');
const path = require('path');

// 读 JSON 时去掉可能的 UTF-8 BOM：用记事本之类改过配置就会带上，
// 而 JSON.parse 会因此直接失败 → 静默退回默认值，用户的自选/配色全"丢"了。
function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

// 先写同目录临时文件，再 rename 原子替换；rename 被安全软件短暂占用时重试，
// 最后才退回 copyFile（不原子，但至少不会把原文件截断）。
function writeJsonAtomic(file, data, options) {
  const pretty = !options || options.pretty !== false;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.mini-ticker-' + process.pid + '-' + Date.now() + '-' +
    Math.random().toString(36).slice(2, 8) + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (cleanupError) {}
    throw lastError || error;
  }
}

// 备份前先确认现有文件是合法 JSON，避免把损坏内容覆盖到唯一的好备份上。
function backupJson(file, backupFile) {
  try {
    readJson(file);
    fs.copyFileSync(file, backupFile);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = { readJson, writeJsonAtomic, backupJson };
