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
    codec: $('codec'),
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
    queueHeader: $('queueHeader'),
    selectAll: $('selectAll'),
    fileCount: $('fileCount'),
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
    dom.codec.value = settings.codec || 'h264';
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
        codec: dom.codec.value,
    };
    await ipc.invoke('write-settings', settings);
}

// Setting change handlers
dom.codec.addEventListener('change', saveSettings);
dom.resolution.addEventListener('change', saveSettings);
dom.mode.addEventListener('change', () => { updateModeVisibility(); saveSettings(); });
dom.bitrate.addEventListener('input', () => { dom.bitrateValue.textContent = `${dom.bitrate.value} kbps`; saveSettings(); if (files.length > 0 && !isRunning) renderFiles(); });
dom.crf.addEventListener('input', () => { dom.crfValue.textContent = dom.crf.value; saveSettings(); });
// Preset → auto-adjust bitrate and CRF (faster = needs more bitrate / lower CRF for same quality)
const PRESET_BITRATES = {
    ultrafast: 800, superfast: 900, veryfast: 1000, faster: 1100,
    fast: 1200, medium: 1400, slow: 1600, slower: 2000, veryslow: 2500,
};
const PRESET_CRFS = {
    ultrafast: 28, superfast: 27, veryfast: 26, faster: 25,
    fast: 24, medium: 23, slow: 22, slower: 20, veryslow: 18,
};
dom.preset.addEventListener('change', () => {
    const preset = dom.preset.value;
    if (PRESET_BITRATES[preset]) {
        dom.bitrate.value = PRESET_BITRATES[preset];
        dom.bitrateValue.textContent = `${PRESET_BITRATES[preset]} kbps`;
    }
    if (PRESET_CRFS[preset]) {
        dom.crf.value = PRESET_CRFS[preset];
        dom.crfValue.textContent = String(PRESET_CRFS[preset]);
    }
    saveSettings();
    if (files.length > 0 && !isRunning) renderFiles();
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

function estimateOutput(f) {
    // Estimate output size based on target bitrate, duration, and source bitrate cap
    if (!f.duration || f.duration <= 0) return { size: 0, time: 0 };

    const targetBitrate = parseInt(dom.bitrate.value) || 1200; // kbps
    const sourceBitrate = f.bitrate || 0;
    // Cap at source bitrate (same logic as engine)
    const effectiveBitrate = sourceBitrate > 0 ? Math.min(targetBitrate, sourceBitrate) : targetBitrate;

    // Estimated output size = bitrate * duration / 8 (bits to bytes) + ~10% audio overhead
    const videoBytes = (effectiveBitrate * 1000 / 8) * f.duration;
    const estimatedSize = videoBytes * 1.1; // +10% for audio + container overhead

    // Rough encode time estimate: GPU ~5-10x realtime, CPU ~1-2x realtime
    const gpuAvailable = systemInfo && systemInfo.gpu;
    const speedMultiplier = gpuAvailable ? 7 : 1.5; // average
    const estimatedTime = f.duration / speedMultiplier;

    return { size: estimatedSize, time: estimatedTime };
}

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

function renderFiles() {
    if (files.length === 0) {
        dom.fileQueue.innerHTML = '<div class="empty-state">No pending files found</div>';
        dom.queueHeader.style.display = 'none';
        dom.btnStart.disabled = true;
        return;
    }

    const selectedFiles = files.filter(f => f.selected !== false);
    const totalSize = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
    const totalEstSize = selectedFiles.reduce((s, f) => s + estimateOutput(f).size, 0);
    const totalEstTime = selectedFiles.reduce((s, f) => s + estimateOutput(f).time, 0);
    const savings = totalSize > 0 && totalEstSize > 0 ? Math.round((1 - totalEstSize / totalSize) * 100) : 0;

    dom.queueHeader.style.display = 'flex';
    let summary = `${selectedFiles.length}/${files.length} selected | ${formatSize(totalSize)}`;
    if (totalEstSize > 0) {
        summary += ` \u2192 ~${formatSize(totalEstSize)} (${savings}% smaller) | ~${formatTime(totalEstTime)}`;
    }
    dom.fileCount.textContent = summary;

    dom.fileQueue.innerHTML = files.map((f, i) => {
        const est = estimateOutput(f);
        const durStr = formatDuration(f.duration);
        const estSizeStr = est.size > 0 ? formatSize(est.size) : '';
        const reductionStr = est.size > 0 && f.size > 0 ? `${Math.round((1 - est.size / f.size) * 100)}%` : '';
        const resultOrEstimate = f.resultText || (estSizeStr ? `\u2192 ~${estSizeStr} (${reductionStr} smaller)` : '');

        return `
        <div class="file-row" id="file-${i}">
            <input type="checkbox" class="file-check" id="check-${i}" ${f.selected !== false ? 'checked' : ''} ${f.status !== 'pending' ? 'disabled' : ''}>
            <div class="file-status ${f.status}" id="status-${i}">${statusIcon(f.status)}</div>
            <div class="file-name">${f.name}</div>
            <div class="file-duration dim">${durStr}</div>
            <div class="file-size">${formatSize(f.size)}</div>
            <div class="file-progress">
                <div class="progress-bar">
                    <div class="progress-fill ${f.status}" id="progress-${i}" style="width:${f.percent || 0}%"></div>
                </div>
            </div>
            <div class="file-result ${f.status === 'failed' ? 'failed' : ''}" id="result-${i}">${resultOrEstimate}</div>
        </div>`;
    }).join('');

    // Wire up checkbox handlers
    files.forEach((f, i) => {
        const cb = document.getElementById(`check-${i}`);
        if (cb) cb.addEventListener('change', () => { f.selected = cb.checked; updateStartButton(); });
    });

    updateStartButton();
}

function updateStartButton() {
    if (isRunning) { dom.btnStart.disabled = false; return; }
    dom.btnStart.disabled = !files.some(f => f.status === 'pending' && f.selected !== false);
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
    if (!settings.inputFolder) {
        dom.fileQueue.innerHTML = '<div class="empty-state">Select an Input folder first</div>';
        return;
    }
    if (!settings.outputFolder) {
        dom.fileQueue.innerHTML = '<div class="empty-state">Select an Output folder first</div>';
        return;
    }
    const result = await ipc.invoke('scan-files', {
        inputFolder: settings.inputFolder,
        outputFolder: settings.outputFolder,
    });
    files = (result.files || []).map(f => ({
        ...f,
        status: 'pending',
        percent: 0,
        resultText: '',
        selected: true,
    }));
    renderFiles();
}

dom.btnRefresh.addEventListener('click', () => {
    if (!isRunning) scanFiles();
});

dom.selectAll.addEventListener('change', () => {
    const checked = dom.selectAll.checked;
    files.forEach((f, i) => {
        if (f.status === 'pending') {
            f.selected = checked;
            const cb = document.getElementById(`check-${i}`);
            if (cb) cb.checked = checked;
        }
    });
    updateStartButton();
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

    // Reset selected file states, mark deselected as skipped
    const selectedNames = [];
    files.forEach(f => {
        if (f.selected !== false) {
            f.status = 'pending'; f.percent = 0; f.resultText = '';
            selectedNames.push(f.name);
        }
    });
    renderFiles();

    await ipc.invoke('start-encoding', { ...settings, selectedFiles: selectedNames });
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
    const encoderNote = systemInfo.gpu ? 'GPU' : 'CPU';
    const hevc = systemInfo.hevc_supported ? ' | H.265 ready' : '';
    dom.systemInfo.textContent = `${systemInfo.cpu_cores} cores | ${systemInfo.ram_total_gb} GB RAM | ${gpu} (${encoderNote})${hevc}`;
    dom.btnStart.disabled = files.length === 0;

    // Disable H.265 option if not supported
    if (!systemInfo.hevc_supported) {
        const h265opt = dom.codec.querySelector('option[value="h265"]');
        if (h265opt) { h265opt.disabled = true; h265opt.textContent = 'H.265 (not available)'; }
    }
}

// === Init ===

(async () => {
    await loadSettings();
    await detectSystem();
    if (settings.inputFolder && settings.outputFolder) {
        await scanFiles();
    }
})();
