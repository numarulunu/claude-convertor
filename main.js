const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Paths
const IS_PACKAGED = app.isPackaged;
const APP_ROOT = IS_PACKAGED ? path.dirname(app.getPath('exe')) : __dirname;
const RESOURCES = path.join(__dirname, 'resources');
const ENGINE = IS_PACKAGED
    ? path.join(APP_ROOT, 'convertor.exe')
    : path.join(__dirname, '..', 'convertor.py');
const DATA_DIR = IS_PACKAGED ? app.getPath('userData') : __dirname;
const SETTINGS_FILE = path.join(DATA_DIR, 'convertor-settings.json');

let win = null;
let tray = null;
let engineProcess = null;


// Single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

// === Settings ===

const DEFAULT_SETTINGS = {
    inputFolder: '',
    outputFolder: '',
    resolution: 1080,
    bitrate: 1200,
    mode: 'bitrate',
    crf: 23,
    preset: 'medium',
    codec: 'h264',
    startWithWindows: false,
};

function readSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
}

function writeSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// === Engine communication ===

function runEngine(args) {
    if (IS_PACKAGED) {
        return spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
        return spawn('python', [ENGINE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
}

function runEngineAsync(args) {
    return new Promise((resolve, reject) => {
        const proc = runEngine(args);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr || `Exit code ${code}`));
        });
        proc.on('error', reject);
    });
}

// === IPC Handlers ===

ipcMain.handle('detect-system', async () => {
    try {
        const raw = await runEngineAsync(['--detect']);
        return JSON.parse(raw);
    } catch (err) {
        return { error: err.message, ffmpeg_found: false, cpu_cores: 0, ram_total_gb: 0, gpu: null, gpu_name: null, encoder: 'libx264', gpu_workers: 0, cpu_workers: 1, threads_per_cpu: 2 };
    }
});

ipcMain.handle('scan-files', async (_, { inputFolder, outputFolder }) => {
    try {
        // Use job file for Unicode path safety
        const jobFile = path.join(DATA_DIR, 'scan-job.json');
        fs.writeFileSync(jobFile, JSON.stringify({ input: inputFolder, output: outputFolder }), 'utf-8');
        const raw = await runEngineAsync(['--scan', '--job', jobFile]);
        return JSON.parse(raw);
    } catch (err) {
        return { files: [], done: [], error: err.message };
    }
});

ipcMain.handle('start-encoding', async (_, settings) => {
    if (engineProcess) return { error: 'Already running' };

    // Write settings to a temp JSON file to avoid Unicode path issues in CLI args
    const jobFile = path.join(DATA_DIR, 'current-job.json');
    fs.writeFileSync(jobFile, JSON.stringify({
        input: settings.inputFolder,
        output: settings.outputFolder,
        resolution: settings.resolution,
        bitrate: settings.bitrate,
        mode: settings.mode,
        preset: settings.preset,
        crf: settings.crf,
        codec: settings.codec || 'h264',
        files: settings.selectedFiles || [],
    }, null, 2), 'utf-8');

    engineProcess = runEngine(['--run', '--job', jobFile]);

    let lineCount = 0;

    const rl = readline.createInterface({ input: engineProcess.stdout });
    rl.on('line', (line) => {
        lineCount++;
        try {
            const data = JSON.parse(line);
            if (data.type === 'progress') {
                win?.webContents.send('encoding-progress', data);
            } else if (data.type === 'file_done') {
                win?.webContents.send('encoding-file-done', data);
            } else if (data.type === 'batch_done') {
                win?.webContents.send('encoding-batch-done', data);
            } else if (data.type === 'error') {
                win?.webContents.send('encoding-error', data);
            }
        } catch { /* ignore non-JSON lines */ }
    });

    engineProcess.stderr.on('data', (d) => {
        console.error('[engine stderr]', d.toString().substring(0, 200));
    });

    engineProcess.on('close', () => {
        engineProcess = null;
    });

    engineProcess.on('error', (err) => {
        win?.webContents.send('encoding-error', { message: err.message });
        engineProcess = null;
    });

    return { started: true };
});

ipcMain.on('stop-encoding', () => {
    if (engineProcess) {
        try {
            // On Windows, kill the entire process tree (convertor.exe + ffmpeg children)
            const { execSync } = require('child_process');
            execSync(`taskkill /PID ${engineProcess.pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
        } catch {}
        engineProcess = null;
    }
});

ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('read-settings', () => readSettings());

ipcMain.handle('write-settings', (_, settings) => {
    writeSettings(settings);
    return true;
});

// === Window ===

function createWindow() {
    win = new BrowserWindow({
        width: 900,
        height: 650,
        minWidth: 700,
        minHeight: 500,
        show: false,
        backgroundColor: '#111111',
        icon: path.join(RESOURCES, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    win.loadFile(path.join(RESOURCES, 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); win.hide(); }
    });
}

// === Tray ===

function createTray() {
    let icon;
    try {
        icon = nativeImage.createFromPath(path.join(RESOURCES, 'icon.png')).resize({ width: 16, height: 16 });
    } catch {
        icon = nativeImage.createEmpty();
    }
    tray = new Tray(icon);
    tray.setToolTip('Video Convertor');

    const rebuildMenu = () => {
        const prefs = readSettings();
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Show / Hide', click: () => { win?.isVisible() ? win.hide() : (win.show(), win.focus()); } },
            { type: 'separator' },
            {
                label: 'Start with Windows',
                type: 'checkbox',
                checked: prefs.startWithWindows,
                click: (item) => {
                    const s = readSettings();
                    s.startWithWindows = item.checked;
                    writeSettings(s);
                    app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
                }
            },
            { type: 'separator' },
            { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
        ]));
    };

    tray.on('click', () => { win?.isVisible() ? win.hide() : (win.show(), win.focus()); });
    rebuildMenu();
}

// === Auto-updater ===

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
});

autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    if (Notification.isSupported()) {
        new Notification({
            title: 'Video Convertor Update Ready',
            body: `Version ${info.version} will install on next restart.`,
        }).show();
    }
});

autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err.message);
});

// === App lifecycle ===

app.whenReady().then(() => {
    createTray();
    createWindow();

    const prefs = readSettings();
    if (prefs.startWithWindows) {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    }

    if (IS_PACKAGED) {
        setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    }
});

app.on('window-all-closed', (e) => e.preventDefault());

app.on('before-quit', () => {
    if (engineProcess) {
        try {
            const { execSync } = require('child_process');
            execSync(`taskkill /PID ${engineProcess.pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
        } catch {}
        engineProcess = null;
    }
});
