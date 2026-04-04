const ipc = window.api;

// State
let settings = {};
let files = [];
let isRunning = false;
let systemInfo = null;

// DOM refs
const $ = (id) => document.getElementById(id);

const dom = {
    ffmpegWarning: $('ffmpegWarning'),
    ffmpegLink: $('ffmpegLink'),
    inputPath: $('inputPath'),
    outputPath: $('outputPath'),
    btnInputFolder: $('btnInputFolder'),
    btnOutputFolder: $('btnOutputFolder'),
    resolution: $('resolution'),
    mode: $('mode'),
    bitrateGroup: $('bitrateGroup'),
    bitrate: $('bitrate'),
    bitrateValue: $('bitrateValue'),
    crfGroup: $('crfGroup'),
    crf: $('crf'),
    crfValue: $('crfValue'),
    preset: $('preset'),
    btnRefresh: $('btnRefresh'),
    fileQueue: $('fileQueue'),
    emptyState: $('emptyState'),
    systemInfo: $('systemInfo'),
    overallProgress: $('overallProgress'),
    btnStart: $('btnStart'),
};

// External link handling
dom.ffmpegLink.addEventListener('click', (e) => {
    e.preventDefault();
    ipc.openExternal('https://ffmpeg.org/download.html');
});

// === Settings ===

async function loadSettings() {
    settings = await ipc.invoke('read-settings');
    dom.inputPath.textContent = settings.inputFolder || 'No folder selected';
    dom.outputPath.textContent = settings.outputFolder || 'No folder selected';
    dom.resolution.value = String(settings.resolution || 1080);
    dom.mode.value = settings.mode || 'bitrate';
    dom.bitrate.value = settings.bitrate || 1200;
    dom.bitrateValue.textContent = `${settings.bitrate || 1200} kbps`;
    dom.crf.value = settings.crf || 23;
    dom.crfValue.textContent = String(settings.crf || 23);
    dom.preset.value = settings.preset || 'medium';
    updateModeVisibility();
}

function updateModeVisibility() {
    const isBitrate = dom.mode.value === 'bitrate';
    dom.bitrateGroup.style.display = isBitrate ? '' : 'none';
    dom.crfGroup.style.display = isBitrate ? 'none' : '';
}

async function saveSettings() {
    settings = {
        ...settings,
        inputFolder: settings.inputFolder || '',
        outputFolder: settings.outputFolder || '',
        resolution: parseInt(dom.resolution.value),
        bitrate: parseInt(dom.bitrate.value),
        mode: dom.mode.value,
        crf: parseInt(dom.crf.value),
        preset: dom.preset.value,
    };
    await ipc.invoke('write-settings', settings);
}

// Setting change handlers
dom.resolution.addEventListener('change', saveSettings);
dom.mode.addEventListener('change', () => { updateModeVisibility(); saveSettings(); });
dom.bitrate.addEventListener('input', () => { dom.bitrateValue.textContent = `${dom.bitrate.value} kbps`; saveSettings(); });
dom.crf.addEventListener('input', () => { dom.crfValue.textContent = dom.crf.value; saveSettings(); });
// Preset → auto-adjust bitrate (faster = needs more bitrate for same quality)
const PRESET_BITRATES = {
    ultrafast: 2200, superfast: 2000, veryfast: 1800, faster: 1600,
    fast: 1400, medium: 1200, slow: 1000, slower: 900, veryslow: 800,
};
dom.preset.addEventListener('change', () => {
    const suggested = PRESET_BITRATES[dom.preset.value];
    if (suggested) {
        dom.bitrate.value = suggested;
        dom.bitrateValue.textContent = `${suggested} kbps`;
    }
    saveSettings();
});

// Folder pickers
dom.btnInputFolder.addEventListener('click', async () => {
    const folder = await ipc.invoke('pick-folder');
    if (folder) {
        settings.inputFolder = folder;
        dom.inputPath.textContent = folder;
        await saveSettings();
        scanFiles();
    }
});

dom.btnOutputFolder.addEventListener('click', async () => {
    const folder = await ipc.invoke('pick-folder');
    if (folder) {
        settings.outputFolder = folder;
        dom.outputPath.textContent = folder;
        await saveSettings();
    }
});

// === File queue ===

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatTime(seconds) {
    if (seconds < 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function renderFiles() {
    if (files.length === 0) {
        dom.fileQueue.innerHTML = '<div class="empty-state">No pending files found</div>';
        dom.btnStart.disabled = true;
        return;
    }

    dom.fileQueue.innerHTML = files.map((f, i) => `
        <div class="file-row" id="file-${i}">
            <div class="file-status ${f.status}" id="status-${i}">${statusIcon(f.status)}</div>
            <div class="file-name">${f.name}</div>
            <div class="file-size">${formatSize(f.size)}</div>
            <div class="file-progress">
                <div class="progress-bar">
                    <div class="progress-fill ${f.status}" id="progress-${i}" style="width:${f.percent || 0}%"></div>
                </div>
            </div>
            <div class="file-result ${f.status === 'failed' ? 'failed' : ''}" id="result-${i}">${f.resultText || ''}</div>
        </div>
    `).join('');

    dom.btnStart.disabled = isRunning ? false : !files.some(f => f.status === 'pending');
}

function statusIcon(status) {
    switch (status) {
        case 'pending': return '\u2022';
        case 'encoding': return '\u25CB';
        case 'done': return '\u2713';
        case 'failed': return '\u2717';
        default: return '\u2022';
    }
}

async function scanFiles() {
    if (!settings.inputFolder || !settings.outputFolder) return;
    const result = await ipc.invoke('scan-files', {
        inputFolder: settings.inputFolder,
        outputFolder: settings.outputFolder,
    });
    files = (result.files || []).map(f => ({
        ...f,
        status: 'pending',
        percent: 0,
        resultText: '',
    }));
    renderFiles();
}

dom.btnRefresh.addEventListener('click', () => {
    if (!isRunning) scanFiles();
});

// === Encoding ===

dom.btnStart.addEventListener('click', async () => {
    if (isRunning) {
        ipc.send('stop-encoding');
        isRunning = false;
        dom.btnStart.textContent = 'Start';
        dom.btnStart.classList.remove('stop');
        return;
    }

    if (!settings.inputFolder || !settings.outputFolder) return;

    isRunning = true;
    dom.btnStart.textContent = 'Stop';
    dom.btnStart.classList.add('stop');
    dom.overallProgress.textContent = 'Starting...';

    // Reset file states
    files.forEach(f => { f.status = 'pending'; f.percent = 0; f.resultText = ''; });
    renderFiles();

    await ipc.invoke('start-encoding', settings);
});

// Progress events from main process
ipc.on('encoding-progress', (data) => {
    // Update overall progress
    dom.overallProgress.textContent = `${data.done}/${data.total} files | ${data.percent}% | ETA ${formatTime(data.eta_seconds)}`;

    // Mark current file as encoding
    if (data.file) {
        const idx = files.findIndex(f => f.name === data.file);
        if (idx >= 0 && files[idx].status === 'pending') {
            files[idx].status = 'encoding';
            const statusEl = document.getElementById(`status-${idx}`);
            if (statusEl) {
                statusEl.className = 'file-status encoding';
                statusEl.textContent = '\u25CB';
            }
        }
    }
});

ipc.on('encoding-file-done', (data) => {
    const idx = files.findIndex(f => f.name === data.file);
    if (idx < 0) return;

    if (data.success) {
        files[idx].status = 'done';
        files[idx].percent = 100;
        files[idx].resultText = `${formatSize(data.original_size)} \u2192 ${formatSize(data.compressed_size)} (${data.reduction_pct}% saved) [${data.worker}] ${formatTime(data.elapsed_seconds)}`;
    } else {
        files[idx].status = 'failed';
        files[idx].resultText = data.error;
    }

    // Update DOM directly for performance
    const statusEl = document.getElementById(`status-${idx}`);
    const progressEl = document.getElementById(`progress-${idx}`);
    const resultEl = document.getElementById(`result-${idx}`);

    if (statusEl) {
        statusEl.className = `file-status ${files[idx].status}`;
        statusEl.textContent = statusIcon(files[idx].status);
    }
    if (progressEl) {
        progressEl.style.width = data.success ? '100%' : '0%';
        progressEl.className = `progress-fill ${files[idx].status}`;
    }
    if (resultEl) {
        resultEl.className = `file-result ${files[idx].status === 'failed' ? 'failed' : ''}`;
        resultEl.textContent = files[idx].resultText;
    }
});

ipc.on('encoding-batch-done', (data) => {
    isRunning = false;
    dom.btnStart.textContent = 'Start';
    dom.btnStart.classList.remove('stop');

    let summary = `${data.processed} done`;
    if (data.failed > 0) summary += `, ${data.failed} failed`;
    if (data.total_original > 0 && data.total_compressed > 0) {
        summary += ` | ${formatSize(data.total_original)} \u2192 ${formatSize(data.total_compressed)} (${data.total_reduction_pct}% saved)`;
    }
    summary += ` | ${formatTime(data.elapsed_seconds)}`;
    dom.overallProgress.textContent = summary;
});

ipc.on('encoding-error', (data) => {
    isRunning = false;
    dom.btnStart.textContent = 'Start';
    dom.btnStart.classList.remove('stop');
    dom.overallProgress.textContent = `Error: ${data.message}`;
});

// === System detection ===

async function detectSystem() {
    systemInfo = await ipc.invoke('detect-system');

    if (!systemInfo.ffmpeg_found) {
        dom.ffmpegWarning.style.display = 'block';
        dom.systemInfo.textContent = 'FFmpeg not found';
        dom.btnStart.disabled = true;
        return;
    }

    const gpu = systemInfo.gpu_name || 'No GPU';
    const encoder = systemInfo.encoder;
    const encoderNote = systemInfo.gpu ? 'GPU' : 'CPU';
    dom.systemInfo.textContent = `${systemInfo.cpu_cores} cores | ${systemInfo.ram_total_gb} GB RAM | ${gpu} | ${encoder} (${encoderNote})`;
    dom.btnStart.disabled = files.length === 0;
}

// === Init ===

(async () => {
    await loadSettings();
    await detectSystem();
    if (settings.inputFolder && settings.outputFolder) {
        await scanFiles();
    }
})();
