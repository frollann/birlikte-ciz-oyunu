const $ = (id) => document.getElementById(id);

const paintCanvas = $('paintCanvas');
const paintCtx = paintCanvas.getContext('2d');
const activeCanvas = $('activeCanvas');   // SADECE benim çizdiğim çizgi
const activeCtx = activeCanvas.getContext('2d');
const remoteCanvas = $('remoteCanvas');   // SADECE karşı tarafın çizdiği çizgi
const remoteCtx = remoteCanvas.getContext('2d');
const templateCanvas = $('templateCanvas');
const templateCtx = templateCanvas.getContext('2d');
const container = $('canvas-container');
const viewport = $('viewport');

[paintCtx, activeCtx, remoteCtx, templateCtx].forEach(c => c.imageSmoothingEnabled = true);
templateCtx.imageSmoothingQuality = 'high';

let peer, conn;
let currentMode = 'pen';
let currentColor = '#ec4899';
let currentSize = 5;

// Çizim durumu
let isDrawing = false;
let myStroke = null;      // {points, color, size, mode}
let remoteStroke = null;

// Zoom / pan
let scale = 1, panX = 0, panY = 0;
let isPanning = false, startX = 0, startY = 0;
let isSpacePressed = false;
const pointers = new Map();
let pinch = null;

let historyStack = [];
let redoStack = [];
const MAX_HISTORY = 12;

// Çözünürlük: koordinatlar (LW x LH) sabit kalır, tuvalin iç çözünürlüğü RES kat büyür
let LW = 600, LH = 600, RES = 1;
const MAX_BACKING = 1800;   // tuvalin en uzun kenarı için iç piksel sınırı
const LOGICAL_MAX = 1000;   // şablonun koordinat sistemindeki en uzun kenarı

// Şablon
const MAX_TEMPLATE_DIM = 3000;   // şablon resminin saklanan en büyük boyutu
const TEMPLATE_BACKING = 3000;   // şablon katmanının iç çözünürlük sınırı
let TRES = 1;
const CHUNK = 16000;             // şablon parça boyutu (karakter)
let currentTemplate = null;      // {kind:'url', url} | {kind:'data', w, h, dataUrl}
const tplBuffers = {};


// ---------- Araçlar ----------
const PALETTE = ['#000000', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6',
                 '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#92400e', '#9ca3af'];

function setColor(c) {
    currentColor = c;
    $('colorPicker').value = c;
    if (currentMode !== 'pen') setMode('pen');
    $('palette').querySelectorAll('button').forEach(b => {
        b.style.outline = b.dataset.color === c.toLowerCase() ? '3px solid #fff' : '';
        b.style.outlineOffset = '1px';
    });
    // Özel renk seçildiyse gökkuşağı daire işaretlenir
    const cc = $('custom-color');
    cc.style.outline = PALETTE.includes(c.toLowerCase()) ? '' : '3px solid #fff';
    cc.style.outlineOffset = '1px';
    $('fab').style.borderColor = c;
}

function buildPalette() {
    PALETTE.forEach(c => {
        const b = document.createElement('button');
        b.className = 'w-9 h-9 sm:w-6 sm:h-6 rounded-full border-2 border-slate-600';
        b.style.background = c;
        b.dataset.color = c;
        b.setAttribute('aria-label', 'Renk ' + c);
        b.onclick = () => setColor(c);
        $('palette').insertBefore(b, $('custom-color'));
    });
}
$('colorPicker').addEventListener('input', (e) => setColor(e.target.value));

// ---------- Menü ve yüzen araç çubuğu (telefon) ----------
function toggleMenu() { $('mobile-menu').classList.toggle('hidden'); }
function closeMenu() { $('mobile-menu').classList.add('hidden'); }
function toggleToolbar() { $('toolbar').classList.toggle('tb-closed'); }
function closeToolbar() { $('toolbar').classList.add('tb-closed'); }
document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#mobile-menu, #menu-btn')) closeMenu();
});
viewport.addEventListener('pointerdown', closeToolbar);
$('sizePicker').addEventListener('input', (e) => {
    currentSize = Number(e.target.value);
    $('sizeValue').innerText = currentSize;
});

function setMode(mode) {
    currentMode = mode;
    const base = "px-3 py-2 sm:py-1 rounded-lg font-bold transition ";
    const on = "bg-pink-600 text-white", off = "text-slate-400 hover:text-white";
    $('btn-pen').className = base + (mode === 'pen' ? on : off);
    $('btn-eraser').className = base + (mode === 'eraser' ? on : off);
    $('btn-pan').className = base + (mode === 'pan' ? on : off);
    viewport.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
}

buildPalette();
setColor(currentColor);

// ---------- Geçmiş ----------
function snapshot() {
    const c = document.createElement('canvas');
    c.width = paintCanvas.width; c.height = paintCanvas.height;
    c.getContext('2d').drawImage(paintCanvas, 0, 0);
    return c;
}

function restoreSnapshot(snap, callback) {
    paintCtx.save();
    paintCtx.setTransform(1, 0, 0, 1, 0, 0);
    paintCtx.globalCompositeOperation = 'source-over';
    paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    paintCtx.drawImage(snap, 0, 0);
    paintCtx.restore();
    if (callback) callback();
}

function saveState() {
    if (!paintCanvas.width || !paintCanvas.height) return;
    historyStack.push(snapshot());
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    redoStack = [];
}

function syncPaintToPeer() {
    if (conn && conn.open) conn.send({ type: 'sync_paint_state', dataUrl: paintCanvas.toDataURL() });
}

function undo() {
    if (!historyStack.length) return;
    redoStack.push(snapshot());
    restoreSnapshot(historyStack.pop(), syncPaintToPeer);
}

function redo() {
    if (!redoStack.length) return;
    historyStack.push(snapshot());
    restoreSnapshot(redoStack.pop(), syncPaintToPeer);
}

function restoreCanvasState(dataUrl, callback) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            paintCtx.save();
            paintCtx.globalCompositeOperation = 'source-over';
            paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
            paintCtx.drawImage(img, 0, 0, LW, LH);
            paintCtx.restore();
            if (callback) callback();
            resolve();
        };
        img.onerror = resolve;
        img.src = dataUrl;
    });
}

// ---------- Zoom ----------
function updateTransform() {
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    $('zoom-level').innerText = `${Math.round(scale * 100)}%`;
}

function zoomAtPoint(factor, clientX, clientY) {
    const newScale = Math.min(Math.max(scale * factor, 0.2), 8);
    if (newScale === scale) return;
    const rect = viewport.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    panX = x - (x - panX) * (newScale / scale);
    panY = y - (y - panY) * (newScale / scale);
    scale = newScale;
    updateTransform();
}

function zoomIn() { const r = viewport.getBoundingClientRect(); zoomAtPoint(1.25, r.left + r.width / 2, r.top + r.height / 2); }
function zoomOut() { const r = viewport.getBoundingClientRect(); zoomAtPoint(0.8, r.left + r.width / 2, r.top + r.height / 2); }

function resetZoom() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h || !LW) return;
    scale = Math.min(w / LW, h / LH) * 0.95;
    panX = (w - LW * scale) / 2;
    panY = (h - LH * scale) / 2;
    updateTransform();
    container.style.opacity = '1';
}

viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAtPoint(e.deltaY < 0 ? 1.15 : 0.85, e.clientX, e.clientY);
}, { passive: false });

let resizeTimer;
const refit = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resetZoom, 150); };
window.addEventListener('resize', refit);
window.addEventListener('orientationchange', refit);

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        isSpacePressed = true; e.preventDefault();
    }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') isSpacePressed = false; });

// ---------- Girdi (mouse + dokunma + kalem tek sistemde) ----------
function getCanvasCoordinates(e) {
    const rect = paintCanvas.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left) * (LW / rect.width),
        y: (e.clientY - rect.top) * (LH / rect.height)
    };
}

function pinchInfo() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

viewport.addEventListener('pointerdown', (e) => {
    try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {            // ikinci parmak: çizimi iptal et, zoom/pan başlat
        cancelStroke();
        isPanning = false;
        pinch = pinchInfo();
        return;
    }
    if (pointers.size > 2) return;

    if (e.button === 1 || currentMode === 'pan' || isSpacePressed) {
        isPanning = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        viewport.style.cursor = 'grabbing';
        e.preventDefault();
    } else if (e.button === 0) {          // mouse sol tuş, parmak veya kalem
        saveState();
        startDraw(e);
    }
});

viewport.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && pointers.size >= 2) {
        const cur = pinchInfo();
        if (pinch.dist > 0) zoomAtPoint(cur.dist / pinch.dist, cur.cx, cur.cy);
        panX += cur.cx - pinch.cx;
        panY += cur.cy - pinch.cy;
        updateTransform();
        pinch = cur;
    } else if (isPanning) {
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
    } else if (isDrawing) {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        drawing(evs.length ? evs : [e]);
    }
});

function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (isDrawing) stopDraw();
    if (!pointers.size) {
        isPanning = false;
        viewport.style.cursor = (currentMode === 'pan' || isSpacePressed) ? 'grab' : 'crosshair';
    }
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

// ---------- Çizim ----------
function renderStroke(ctx, s, commit, from = 0) {
    const erase = s.mode === 'eraser';
    const p = s.points;
    ctx.save();
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.lineWidth = s.size;
    // Silgi: önizlemede beyaz çizgi, tuvale işlenirken gerçek silme
    ctx.globalCompositeOperation = (erase && commit) ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = erase ? '#ffffff' : s.color;
    ctx.beginPath();
    if (p.length === 1) {
        ctx.arc(p[0].x, p[0].y, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
    } else if (from < p.length) {
        const i0 = Math.max(from - 1, 0);
        ctx.moveTo(p[i0].x, p[i0].y);
        for (let i = i0 + 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
        ctx.stroke();
    }
    ctx.restore();
}

const clear = (ctx, cv) => ctx.clearRect(0, 0, cv.width, cv.height);

function startDraw(e) {
    isDrawing = true;
    const c = getCanvasCoordinates(e);
    myStroke = { points: [c], color: currentColor, size: currentSize, mode: currentMode };
    clear(activeCtx, activeCanvas);
    renderStroke(activeCtx, myStroke, false);
    if (conn && conn.open) {
        conn.send({ type: 'start', x: c.x, y: c.y, color: myStroke.color, size: myStroke.size, mode: myStroke.mode });
    }
}

let pending = [], flushTimer = null;

function flushPoints() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (pending.length && conn && conn.open) conn.send({ type: 'draw', pts: pending });
    pending = [];
}

function drawing(events) {
    if (!isDrawing || !myStroke) return;
    const n0 = myStroke.points.length;
    for (const ev of events) {
        const c = getCanvasCoordinates(ev);
        myStroke.points.push(c);
        pending.push([Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10]);
    }
    if (!flushTimer) flushTimer = setTimeout(flushPoints, 30);
    renderStroke(activeCtx, myStroke, false, n0);
}

function stopDraw() {
    if (!isDrawing) return;
    isDrawing = false;
    if (myStroke) renderStroke(paintCtx, myStroke, true);
    clear(activeCtx, activeCanvas);
    myStroke = null;
    flushPoints();
    if (conn && conn.open) conn.send({ type: 'stop' });
}

function cancelStroke() {
    if (!isDrawing) return;
    isDrawing = false;
    myStroke = null;
    clear(activeCtx, activeCanvas);
    historyStack.pop();           // başlangıçta kaydedilen geçmişi geri al
    pending = []; clearTimeout(flushTimer); flushTimer = null;
    if (conn && conn.open) conn.send({ type: 'cancel' });
}

// ---------- Karşı tarafın verileri ----------
let dataQueue = Promise.resolve();

function setupConnection() {
    conn.on('data', (d) => {
        dataQueue = dataQueue.then(() => handleData(d)).catch(console.error);
    });
}

function handleData(d) {
        switch (d.type) {
            case 'start':
                remoteStroke = { points: [{ x: d.x, y: d.y }], color: d.color, size: d.size, mode: d.mode };
                clear(remoteCtx, remoteCanvas);
                renderStroke(remoteCtx, remoteStroke, false);
                break;
            case 'draw':
                if (!remoteStroke) break;
                {
                    const n0 = remoteStroke.points.length;
                    for (const q of d.pts) remoteStroke.points.push({ x: q[0], y: q[1] });
                    renderStroke(remoteCtx, remoteStroke, false, n0);
                }
                break;
            case 'stop':
                if (remoteStroke) renderStroke(paintCtx, remoteStroke, true);
                clear(remoteCtx, remoteCanvas);
                remoteStroke = null;
                break;
            case 'cancel':
                clear(remoteCtx, remoteCanvas);
                remoteStroke = null;
                break;
            case 'clear_drawings':
                clear(paintCtx, paintCanvas);
                break;
            case 'remove_template':
                currentTemplate = null;
                clear(templateCtx, templateCanvas);
                break;
            case 'init_size':
                currentTemplate = null;
                setCanvasSize(d.w, d.h);
                break;
            case 'template_url':
                return applyTemplate({ kind: 'url', url: d.url });
            case 'tpl_chunk': {
                const b = tplBuffers[d.id] || (tplBuffers[d.id] = { parts: [], got: 0 });
                b.parts[d.i] = d.part;
                if (++b.got === d.n) {
                    delete tplBuffers[d.id];
                    return applyTemplate({ kind: 'data', w: d.w, h: d.h, dataUrl: b.parts.join('') });
                }
                break;
            }
            case 'sync_paint_state':
                return restoreCanvasState(d.dataUrl);
        }
}

function clearCanvas(broadcast = true) {
    saveState();
    clear(paintCtx, paintCanvas);
    if (broadcast && conn && conn.open) conn.send({ type: 'clear_drawings' });
}

function removeTemplate() {
    if (!confirm("Şablonu kaldırmak istediğine emin misin?")) return;
    currentTemplate = null;
    clear(templateCtx, templateCanvas);
    if (conn && conn.open) conn.send({ type: 'remove_template' });
}

function setCanvasSize(w, h) {
    LW = w; LH = h;
    RES = Math.max(1, Math.min(2, MAX_BACKING / Math.max(w, h)));
    TRES = Math.max(1, Math.min(3, TEMPLATE_BACKING / Math.max(w, h)));
    [[paintCanvas, RES], [activeCanvas, RES], [remoteCanvas, RES], [templateCanvas, TRES]].forEach(([cv, r]) => {
        cv.width = Math.round(w * r); cv.height = Math.round(h * r);
        cv.style.width = w + 'px'; cv.style.height = h + 'px';
    });
    [[paintCtx, RES], [activeCtx, RES], [remoteCtx, RES], [templateCtx, TRES]].forEach(([c, r]) => {
        c.setTransform(r, 0, 0, r, 0, 0);
        c.imageSmoothingEnabled = true;
    });
    templateCtx.imageSmoothingQuality = 'high';
    container.style.width = w + 'px';
    container.style.height = h + 'px';
    historyStack = []; redoStack = [];
    myStroke = null; remoteStroke = null; isDrawing = false;
    setTimeout(resetZoom, 50);
}

function downloadCanvas() {
    const t = document.createElement('canvas');
    t.width = templateCanvas.width; t.height = templateCanvas.height;
    const c = t.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, t.width, t.height);
    c.drawImage(paintCanvas, 0, 0, t.width, t.height);
    c.globalCompositeOperation = 'multiply';
    c.drawImage(templateCanvas, 0, 0);
    const a = document.createElement('a');
    a.download = 'ortak-cizim-eserimiz.png';
    a.href = t.toDataURL('image/png');
    a.click();
}

// ---------- Şablonlar ----------
// Resmi küçültür, açık gri/kağıt rengi arka planı beyaza çeker
function cleanAndOptimizeTemplate(img) {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const k = Math.min(1, MAX_TEMPLATE_DIM / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 235) d[i] = d[i + 1] = d[i + 2] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    const k2 = Math.min(1, LOGICAL_MAX / Math.max(w, h));
    return { dataUrl: cv.toDataURL('image/png'), w: Math.round(w * k2), h: Math.round(h * k2) };
}

function drawTemplateData(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            clear(templateCtx, templateCanvas);
            templateCtx.drawImage(img, 0, 0, LW, LH);
            resolve();
        };
        img.onerror = resolve;
        img.src = dataUrl;
    });
}

// Şablonu bu cihazda uygula (hem benim hem karşı taraf için aynı fonksiyon)
function applyTemplate(t) {
    if (t.kind === 'data') {
        currentTemplate = t;
        setCanvasSize(t.w, t.h);
        return drawTemplateData(t.dataUrl);
    }
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            const r = cleanAndOptimizeTemplate(img);
            currentTemplate = t;
            setCanvasSize(r.w, r.h);
            drawTemplateData(r.dataUrl).then(resolve);
        };
        img.onerror = () => { $('status').innerText = "Şablon yüklenemedi ⚠️"; resolve(); };
        img.src = t.url;
    });
}

// Şablonu karşıya gönder (URL küçük; yüklenen dosya parçalara bölünür)
function sendTemplate(t) {
    if (!conn || !conn.open || !t) return;
    if (t.kind === 'url') {
        conn.send({ type: 'template_url', url: t.url });
        return;
    }
    const id = Date.now() + Math.random();
    const n = Math.ceil(t.dataUrl.length / CHUNK);
    for (let i = 0; i < n; i++) {
        conn.send({ type: 'tpl_chunk', id, i, n, w: t.w, h: t.h, part: t.dataUrl.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
}

const LEVELS = [
    { id: 'kolay', name: '🟢 Kolay' },
    { id: 'orta', name: '🟡 Orta' },
    { id: 'zor', name: '🔴 Zor' }
];
let activeLevel = 'kolay';

function openTemplateModal() {
    const list = (typeof templates !== 'undefined' ? templates : [])
        .filter(t => t.url).map(t => ({ level: 'kolay', ...t }));
    if (!list.some(t => t.level === activeLevel)) {
        const first = LEVELS.find(l => list.some(t => t.level === l.id));
        if (first) activeLevel = first.id;
    }
    renderTemplates(list);
    $('template-modal').classList.remove('hidden');
}

function renderTemplates(list) {
    const tabs = $('template-tabs');
    tabs.innerHTML = '';
    LEVELS.forEach(l => {
        const n = list.filter(t => t.level === l.id).length;
        const b = document.createElement('button');
        b.className = 'px-3 py-2 rounded-xl text-xs font-bold ' +
            (l.id === activeLevel ? 'bg-pink-600 text-white' : 'bg-slate-700 text-slate-300');
        b.textContent = `📁 ${l.name} (${n})`;
        b.onclick = () => { activeLevel = l.id; renderTemplates(list); };
        tabs.appendChild(b);
    });

    const grid = $('template-grid');
    grid.innerHTML = '';
    const items = list.filter(t => t.level === activeLevel);
    if (!items.length) {
        grid.innerHTML = '<p class="col-span-2 text-center text-xs text-slate-400 py-6">Bu kategoride henüz şablon yok.</p>';
        return;
    }
    items.forEach(t => {
        const b = document.createElement('button');
        b.className = 'bg-slate-700 hover:bg-slate-600 rounded-xl p-2 flex flex-col gap-1.5 items-center';
        b.innerHTML = '<img loading="lazy" class="w-full aspect-square object-contain bg-white rounded-lg"><span class="text-xs font-bold"></span>';
        b.querySelector('img').src = t.thumb || t.url;
        b.querySelector('span').textContent = t.name;
        b.onclick = () => selectTemplate(t);
        grid.appendChild(b);
    });
}

function closeTemplateModal() { $('template-modal').classList.add('hidden'); }

function selectTemplate(t) {
    if (hasDrawings(paintCanvas) && !confirm("Şablon değişince mevcut çizimler silinir. Devam edilsin mi?")) return;
    closeTemplateModal();
    const tpl = { kind: 'url', url: t.url };
    applyTemplate(tpl);
    sendTemplate(tpl);
}

$('imageLoader').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            const r = cleanAndOptimizeTemplate(img);
            const t = { kind: 'data', w: r.w, h: r.h, dataUrl: r.dataUrl };
            applyTemplate(t);
            sendTemplate(t);
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});

function hasDrawings(canvas) {
    const blank = document.createElement('canvas');
    blank.width = canvas.width; blank.height = canvas.height;
    return canvas.toDataURL() !== blank.toDataURL();
}

// ---------- P2P bağlantı ve oda ----------
const PEER_OPTIONS = {
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
            // Mobil veriyle bağlanamama olursa buraya TURN sunucusu ekle:
            // { urls: 'turn:SUNUCU:3478', username: '...', credential: '...' }
        ]
    }
};

function generateRoomCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let r = '';
    for (let i = 0; i < length; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}

function showGame() {
    $('menu-screen').classList.add('hidden');
    $('room-modal').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
    setTimeout(resetZoom, 50);
}

function createRoom() {
    setCanvasSize(600, 600);

    peer = new Peer(generateRoomCode(6), PEER_OPTIONS);
    peer.on('open', (id) => {
        $('menu-screen').classList.add('hidden');
        $('room-modal').classList.remove('hidden');
        $('room-code-display').value = id;
    });
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') createRoom();
        else alert("Bağlantı hatası: " + err.type);
    });
    peer.on('connection', (connection) => {
        conn = connection;
        setupConnection();
        conn.on('open', () => {
            conn.send({ type: 'init_size', w: LW, h: LH });
            sendTemplate(currentTemplate);
            if (hasDrawings(paintCanvas)) syncPaintToPeer();
        });
        showGame();
        $('status').innerText = "Bağlantı sağlandı, çizebilirsiniz! 🎉";
    });
}

function copyCode() {
    const input = $('room-code-display');
    input.select();
    navigator.clipboard.writeText(input.value);
    $('copy-feedback').innerText = "Kopyalandı! ✔️";
    setTimeout(() => { $('copy-feedback').innerText = ""; }, 2000);
}

function closeModalToGame() {
    showGame();
    $('status').innerText = "Arkadaşının katılması bekleniyor...";
}

function joinRoom() {
    const roomID = $('room-input').value.trim().toUpperCase();
    if (!roomID) { alert("Lütfen oda kodu gir!"); return; }

    peer = new Peer(PEER_OPTIONS);
    peer.on('error', (err) => alert("Bağlantı hatası: " + err.type));
    peer.on('open', () => {
        conn = peer.connect(roomID, { reliable: true });
        setupConnection();
        conn.on('open', () => {
            showGame();
            $('status').innerText = "Bağlantı sağlandı, çizebilirsiniz! 🎉";
        });
    });
}

// ---------- Tuval boyutu menüsü ----------
function openSizeModal() { $('size-modal').classList.remove('hidden'); }
function closeSizeModal() { $('size-modal').classList.add('hidden'); }

function changeCanvasSize(w, h) {
    closeSizeModal();
    currentTemplate = null;
    setCanvasSize(w, h);   // çizimler ve şablon temizlenir
    if (conn && conn.open) conn.send({ type: 'init_size', w, h });
}
