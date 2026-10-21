// 启动器：清掉 ELECTRON_RUN_AS_NODE，确保以真正的 Electron 桌面进程启动
//
// 关于参数：透明无边框浮窗不需要 GPU 合成，走软件渲染更稳、更省电，
// 也能规避部分机器/远程桌面/受限环境下 GPU 进程崩溃导致应用闪退的问题。
// 设 TICKER_GPU=1 可强制走默认 GPU 渲染。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronExe = require('electron');
const root = path.join(__dirname, '..');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const args = [root];
if (!process.env.TICKER_GPU) {
  args.push(
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--no-sandbox'
  );
}

// 子进程输出同时落盘：计划任务拉起时没有终端，闪退现场只能靠日志文件
const logDir = path.join(root, 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
const logFile = path.join(logDir, 'electron.log');
try {
  if (fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old');
} catch (e) {}

const out = fs.createWriteStream(logFile, { flags: 'a' });

const child = spawn(electronExe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env });
child.stdout.pipe(out);
child.stderr.pipe(out);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on('close', function (code, signal) {
  try {
    out.write(
      '[' + new Date().toISOString() + '] child exit code=' + code + ' signal=' + signal + '\n'
    );
  } catch (e) {}
  out.end(function () {
    process.exit(code === null ? 0 : code);
  });
});
