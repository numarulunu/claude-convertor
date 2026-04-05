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
dom.codec.addEventListener('change', () => { saveSettings(); if (files.length > 0 && !isRunning) updateEstimates(); });
dom.resolution.addEventListener('change', () => { saveSettings(); if (files.length > 0 && !isRunning) updateEstimates(); });
dom.mode.addEventListener('change', () => { updateModeVisibility(); saveSettings(); if (files.length > 0 && !isRunning) updateEstimates(); });
dom.bitrate.addEventListener('input', () => { dom.bitrateValue.textContent = `${dom.bitrate.value} kbps`; saveSettings(); if (files.length > 0 && !isRunning) updateEstimates(); });
dom.crf.addEventListener('input', () => { dom.crfValue.textContent = dom.crf.value; saveSettings(); if (files.length > 0 && !isRunning) updateEstimates(); });
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
    if (files.length > 0 && !isRunning) updateEstimates();
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
    if (!f.duration || f.duration <= 0) return { size: 0, time: 0 };

    const sourceBitrate = f.bitrate || 0;
    const targetRes = parseInt(dom.resolution.value) || 1080;
    const sourceRes = f.height || 1080;
    const mode = dom.mode.value;

    // In CRF mode, estimate bitrate from CRF value
    // CRF 18 ≈ 90% of source bitrate (near-lossless)
    // CRF 23 ≈ 50% of source bitrate (balanced)
    // CRF 28 ≈ 25% of source bitrate (small files)
    let targetBitrate;
    if (mode === 'quality') {
        const crf = parseInt(dom.crf.value) || 23;
        // Map CRF to a fraction of source bitrate (exponential decay)
        // CRF 18 → 0.9, CRF 23 → 0.5, CRF 28 → 0.25
        const crfFraction = Math.pow(0.85, crf - 18);
        targetBitrate = sourceBitrate > 0 ? Math.round(sourceBitrate * crfFraction) : Math.round(2000 * crfFraction);
    } else {
        targetBitrate = parseInt(dom.bitrate.value) || 1200;
    }

    // Resolution scaling factor
    let resScale = 1.0;
    if (targetRes < sourceRes && sourceRes > 0) {
        resScale = (targetRes * targetRes) / (sourceRes * sourceRes);
    }

    let effectiveBitrate;
    if (mode === 'quality') {
        // CRF mode: targetBitrate is already CRF-derived estimate at source res.
        // Scale by resolution directly — no source bitrate cap.
        effectiveBitrate = Math.round(targetBitrate * resScale);
    } else {
        // Bitrate mode: cap at source, then apply resolution scaling
        effectiveBitrate = sourceBitrate > 0 ? Math.min(targetBitrate, sourceBitrate) : targetBitrate;
        if (resScale < 1.0 && sourceBitrate > 0) {
            effectiveBitrate = Math.min(effectiveBitrate, Math.round(sourceBitrate * resScale));
        }
    }

    // H.265 is ~40% more efficient than H.264 at the same quality
    const codec = dom.codec.value || 'h264';
    if (codec === 'h265') {
        effectiveBitrate = Math.round(effectiveBitrate * 0.6);
    }

    // Estimated output size = bitrate * duration / 8 + ~10% audio/container overhead
    const videoBytes = (effectiveBitrate * 1000 / 8) * f.duration;
    const estimatedSize = videoBytes * 1.1;

    // Encode time: GPU ~5-10x realtime, CPU ~1-2x. H.265 ~30% slower than H.264
    const gpuAvailable = systemInfo && systemInfo.gpu;
    let speedMultiplier = gpuAvailable ? 7 : 1.5;
    if (codec === 'h265') speedMultiplier *= 0.7;
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

    const pendingFiles = files.filter(f => f.status === 'pending' || f.status === 'encoding');
    const selectedFiles = pendingFiles.filter(f => f.selected !== false);
    const doneCount = files.filter(f => f.status === 'already_done').length;
    const totalSize = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
    const totalEstSize = selectedFiles.reduce((s, f) => s + estimateOutput(f).size, 0);
    const totalEstTime = selectedFiles.reduce((s, f) => s + estimateOutput(f).time, 0);
    const savings = totalSize > 0 && totalEstSize > 0 ? Math.round((1 - totalEstSize / totalSize) * 100) : 0;

    dom.queueHeader.style.display = 'flex';
    let summary = `${selectedFiles.length} to process`;
    if (doneCount > 0) summary += ` | ${doneCount} already done`;
    if (totalSize > 0) summary += ` | ${formatSize(totalSize)}`;
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

        const rowClass = f.status === 'already_done' ? 'file-row already_done' : 'file-row';
        const cbDisabled = (f.status !== 'pending' && f.status !== 'already_done') ? 'disabled' : '';

        return `
        <div class="${rowClass}" id="file-${i}">
            <input type="checkbox" class="file-check" id="check-${i}" ${f.selected !== false ? 'checked' : ''} ${cbDisabled}>
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
        if (cb) cb.addEventListener('change', () => {
            f.selected = cb.checked;
            // If checking an already-done file, mark it as pending for reconversion
            if (cb.checked && f.status === 'already_done') {
                f.status = 'pending';
                const row = document.getElementById(`file-${i}`);
                if (row) row.className = 'file-row';
                const resultEl = document.getElementById(`result-${i}`);
                if (resultEl) resultEl.textContent = 'Will reconvert';
            } else if (!cb.checked && f.resultText && f.resultText.startsWith('Already done')) {
                f.status = 'already_done';
                const row = document.getElementById(`file-${i}`);
                if (row) row.className = 'file-row already_done';
                const resultEl = document.getElementById(`result-${i}`);
                if (resultEl) resultEl.textContent = f.resultText;
            }
            updateStartButton();
            updateEstimates();
        });
    });

    updateStartButton();
}

function updateEstimates() {
    // Update estimate text in-place without rebuilding DOM
    files.forEach((f, i) => {
        if (f.resultText) return;
        const est = estimateOutput(f);
        const estSizeStr = est.size > 0 ? formatSize(est.size) : '';
        const reductionStr = est.size > 0 && f.size > 0 ? `${Math.round((1 - est.size / f.size) * 100)}%` : '';
        const resultEl = document.getElementById(`result-${i}`);
        if (resultEl) {
            resultEl.textContent = estSizeStr ? `\u2192 ~${estSizeStr} (${reductionStr} smaller)` : '';
        }
    });

    // Update queue header totals
    const pendingFiles = files.filter(f => f.status === 'pending' || f.status === 'encoding');
    const selectedFiles = pendingFiles.filter(f => f.selected !== false);
    const doneCount = files.filter(f => f.status === 'already_done').length;
    const totalSize = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
    const totalEstSize = selectedFiles.reduce((s, f) => s + estimateOutput(f).size, 0);
    const totalEstTime = selectedFiles.reduce((s, f) => s + estimateOutput(f).time, 0);
    const savings = totalSize > 0 && totalEstSize > 0 ? Math.round((1 - totalEstSize / totalSize) * 100) : 0;

    let summary = `${selectedFiles.length} to process`;
    if (doneCount > 0) summary += ` | ${doneCount} already done`;
    if (totalSize > 0) summary += ` | ${formatSize(totalSize)}`;
    if (totalEstSize > 0) {
        summary += ` \u2192 ~${formatSize(totalEstSize)} (${savings}% smaller) | ~${formatTime(totalEstTime)}`;
    }
    dom.fileCount.textContent = summary;
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
        case 'already_done': return '\u2713';
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

    // Add already-done files at the bottom
    const doneFiles = (result.done || []).map(f => ({
        ...f,
        status: 'already_done',
        percent: 100,
        resultText: `Already done (${formatSize(f.output_size)})`,
        selected: false,
    }));
    files = [...files, ...doneFiles];

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

    const result = await ipc.invoke('start-encoding', { ...settings, selectedFiles: selectedNames });
    if (result && result.error) {
        isRunning = false;
        dom.btnStart.textContent = 'Start';
        dom.btnStart.classList.remove('stop');
        dom.overallProgress.textContent = `Error: ${result.error}`;
    }
});

// Progress events from main process
ipc.on('encoding-progress', (data) => {
    // Overall progress bar text
    let overallText = `${data.done}/${data.total} files | ${Math.round(data.percent)}%`;
    if (data.eta_seconds > 0) overallText += ` | ETA ${formatTime(data.eta_seconds)}`;
    if (data.system_mode === 'PAUSED') overallText += ' | PAUSED (system busy)';
    else if (data.system_mode === 'THROTTLED' || data.system_mode === 'CONSERVATIVE') overallText += ' | Throttled';
    const activeCount = data.active_files ? Object.keys(data.active_files).length : 0;
    if (activeCount > 1) overallText += ` | ${activeCount} workers`;
    dom.overallProgress.textContent = overallText;

    // Update ALL active files
    const activeFiles = data.active_files || {};
    for (const [fileName, filePct] of Object.entries(activeFiles)) {
        const idx = files.findIndex(f => f.name === fileName);
        if (idx < 0) continue;

        // Mark as encoding
        if (files[idx].status === 'pending') {
            files[idx].status = 'encoding';
            const statusEl = document.getElementById(`status-${idx}`);
            if (statusEl) {
                statusEl.className = 'file-status encoding';
                statusEl.textContent = '\u25CB';
            }
        }

        // Update progress bar
        const progressEl = document.getElementById(`progress-${idx}`);
        if (progressEl) {
            progressEl.style.width = `${filePct}%`;
        }

        // Update status text
        const resultEl = document.getElementById(`result-${idx}`);
        if (resultEl && !files[idx].resultText) {
            const pct = Math.round(filePct);
            let statusText;
            if (pct === 0) {
                statusText = 'Starting encoder...';
            } else {
                statusText = `${pct}%`;
                if (data.system_mode === 'PAUSED') statusText += ' (paused)';
                else if (data.system_mode !== 'FULL SPEED') statusText += ` (${data.system_mode.toLowerCase()})`;
            }
            resultEl.textContent = statusText;
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
