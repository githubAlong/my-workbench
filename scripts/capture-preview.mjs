import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const [url, output, widthText, heightText, mobileText = '0'] = process.argv.slice(2);
if (!url || !output || !widthText || !heightText) {
  console.error('Usage: node scripts/capture-preview.mjs URL OUTPUT WIDTH HEIGHT [MOBILE]');
  process.exit(2);
}

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = path.join(os.tmpdir(), `wb-chrome-${process.pid}-${Date.now()}`);
const width = Number(widthText);
const height = Number(heightText);
const mobile = mobileText === '1';

const child = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--disable-extensions',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

async function waitForTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools target did not start');
}

function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Chrome DevTools WebSocket failed'));
  });
  const send = async (method, params = {}) => {
    await ready;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { socket, send };
}

try {
  const endpoint = await waitForTarget();
  const { socket, send } = connect(endpoint);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await send('Page.navigate', { url });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.__previewReady || Date.now() - started > 8000) {
          clearInterval(timer);
          resolve(!!window.__previewReady);
        }
      }, 100);
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  const metrics = await send('Runtime.evaluate', {
    expression: `({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      title: document.title
    })`,
    returnByValue: true,
  });
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(shot.data, 'base64'));
  socket.close();
  console.log(JSON.stringify({ output, width, height, mobile, ...metrics.result.value }, null, 2));
} finally {
  child.kill();
}
