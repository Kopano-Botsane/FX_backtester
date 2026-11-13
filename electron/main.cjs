'use strict';

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = 8000;
const BASE = `http://${HOST}:${PORT}`;
const ROOT = path.join(__dirname, '..');

let backend = null;
let quitting = false;

function frontendDist() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'frontend', 'dist')
    : path.join(ROOT, 'frontend', 'dist');
}

function probe() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(400, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function backendCommand() {
  if (process.env.BT_BACKEND) return { exe: process.env.BT_BACKEND, args: [] };
  if (app.isPackaged) {
    return { exe: path.join(process.resourcesPath, 'backend', 'backtester-backend'), args: [] };
  }
  return { exe: path.join(ROOT, 'backend', '.venv', 'bin', 'python'), args: ['-m', 'app.main'] };
}

function backendEnv() {
  const env = {
    ...process.env,
    BT_FRONTEND_DIST: frontendDist(),
    PYTHONUNBUFFERED: '1',
  };
  if (app.isPackaged) {
    // A one-file bundle unpacks to a temp dir, so keep writable state in userData.
    const userData = app.getPath('userData');
    // An externally supplied BT_DATA_DIR wins, e.g. launching with
    //   BT_DATA_DIR=.../backend/data ./Backtester.AppImage
    // to reuse the dev working copy's imported MT5 exports.
    env.BT_DATA_DIR ||= path.join(userData, 'data');
    env.BT_CACHE_DIR ||= path.join(userData, 'cache');
  }
  env.BT_WATCH_STDIN = '1';
  return env;
}

function startBackend() {
  const { exe, args } = backendCommand();
  backend = spawn(exe, args, {
    cwd: app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'backend'),
    env: backendEnv(),
    // stdin stays open and unwritten: the backend exits on EOF, so quitting
    // the app (or crashing) never leaves an orphaned server on the port.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backend.on('exit', (code, signal) => {
    backend = null;
    if (!quitting) console.error(`backend exited (code=${code} signal=${signal})`);
  });
}

async function ensureBackend() {
  if (await probe()) return true;
  try {
    startBackend();
  } catch (err) {
    console.error('failed to spawn backend', err);
    return false;
  }
  return waitForBackend();
}

function stopBackend() {
  quitting = true;
  if (!backend) return;
  backend.kill('SIGTERM');
  const proc = backend;
  setTimeout(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }, 3000).unref();
}

async function createWindow() {
  const ok = await ensureBackend();
  if (!ok) {
    dialog.showErrorBox(
      'Backend unavailable',
      'Could not start the replay backend.\n\n' +
        'Development: create backend/.venv and install backend/requirements.txt.\n' +
        'Packaged: build the PyInstaller binary (see README).',
    );
    app.quit();
    return;
  }

  // Setup screen: native folder/file picker for the tick data path.
  ipcMain.handle('bt:pick-tick-data', async (_event, currentPath) => {
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      title: 'Choose tick data folder or file',
      defaultPath: currentPath || undefined,
      properties: ['openFile', 'openDirectory', 'dontAddToRecent'],
    };
    const res = await dialog.showOpenDialog(win, opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    title: 'Backtester',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.BT_DEV_URL;
  // Belt and braces: a user-data HTTP cache can serve a stale demo bundle
  // when the packaged frontend was rebuilt. The backend also sends
  // Cache-Control: no-cache for HTML, but clear once on boot anyway.
  await win.webContents.session.clearCache();
  if (devUrl) {
    await win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadURL(BASE);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopBackend);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
