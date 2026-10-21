import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '0.0.0.0', '--port', '3000'], { stdio: 'inherit' }),
  spawn(process.execPath, ['dist/server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT: '3001', HOST: '0.0.0.0' } }),
];
let stopping = false;
let exitCode = 0;
let outstanding = children.length;
let deadline;
function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill(signal);
  deadline = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 30_000);
  deadline.unref();
}
for (const child of children) {
  child.once('error', error => { console.error('Relay process could not start:', error.message); stop(1); });
  child.once('exit', (code, signal) => {
    outstanding -= 1;
    if (!stopping) stop(code || (signal ? 1 : 0));
    if (outstanding === 0) { clearTimeout(deadline); process.exit(exitCode); }
  });
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0, 'SIGINT'));
