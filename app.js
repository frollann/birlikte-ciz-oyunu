const paintCanvas = document.getElementById('paintCanvas');
const paintCtx = paintCanvas.getContext('2d');

const templateCanvas = document.getElementById('templateCanvas');
const templateCtx = templateCanvas.getContext('2d');

paintCtx.imageSmoothingEnabled = false;
templateCtx.imageSmoothingEnabled = false;

const container = document.getElementById('canvas-container');
const viewport = document.getElementById('viewport');

let isDrawing = false;
let peer, conn;

let currentMode = 'pen';
let currentColor = '#ec4899';
let currentSize = 5;

// ZOOM VE PAN DEĞİŞKENLERİ
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let startX = 0;
let startY = 0;
let isSpacePressed = false;
let initialTouchDist = 0;

let historyStack = [];
let redoStack = [];
const MAX_HISTORY = 25;

const dailyTemplates = [
    "https://i.imgur.com/NAhN7ge.jpg", 
];

const colorPicker = document.getElementById('colorPicker');
const sizePicker = document.getElementById('sizePicker');
const sizeValue = document.getElementById('sizeValue');

colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
    if (currentMode === 'eraser') setMode('pen');
});

sizePicker.addEventListener('input', (e) => {
    currentSize = e.target.value;
    sizeValue.innerText = currentSize;
});

// ÜST BARI GİZLE / GÖSTER FONKSİYONU
let isToolbarVisible = true;
function toggleToolbar() {
    isToolbarVisible = !isToolbarVisible;
    const toolbar = document.getElementById('toolbar');
    const toggleIcon = document.getElementById('toggle-icon');
    const toggleText = document.getElementById('toggle-text');

    if (isToolbarVisible) {
        toolbar.classList.remove('hidden');
        toggleIcon.innerText = "🔼";
        toggleText.innerText = "Barı Gizle";
    } else {
        toolbar.classList.add('hidden');
        toggleIcon.innerText = "🔽";
        toggleText.innerText = "Barı Aç";
    }
}

function setMode(mode) {
    currentMode = mode;
    const penBtn = document.getElementById('btn-pen');
    const eraserBtn = document.getElementById('btn-eraser');
    const panBtn = document.getElementById('btn-pan');

    penBtn.className = "px-2.5 py-1 rounded-lg font-bold transition " + (mode === 'pen' ? "bg-pink-600 text-white" : "text-slate-400 hover:text-white");
    eraserBtn.className = "px-2.5 py-1 rounded-lg font-bold transition " + (mode === 'eraser' ? "bg-pink-600 text-white" : "text-slate-400 hover:text-white");
    panBtn.className = "px-2.5 py-1 rounded-lg font-bold transition " + (mode === 'pan' ? "bg-pink-600 text-white" : "text-slate-400 hover:text-white");

    viewport.style.cursor = (mode === 'pan') ? 'grab' : 'crosshair';
}

function saveState() {
    if (paintCanvas.width === 0 || paintCanvas.height === 0) return;
    historyStack.push(paintCanvas.toDataURL());
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    redoStack = [];
}

function undo(broadcast = true) {
    if (historyStack.length === 0) return;
    redoStack.push(paintCanvas.toDataURL());
    restoreCanvasState(historyStack.pop(), () => {
        if (broadcast && conn && conn.open) {
            conn.send({ type: 'sync_paint_state', dataUrl: paintCanvas.toDataURL() });
        }
    });
}

function redo(broadcast = true) {
    if (redoStack.length === 0) return;
    historyStack.push(paintCanvas.toDataURL());
    restoreCanvasState(redoStack.pop(), () => {
        if (broadcast && conn && conn.open) {
            conn.send({ type: 'sync_paint_state', dataUrl: paintCanvas.toDataURL() });
        }
    });
}

function restoreCanvasState(dataUrl, callback) {
    const img = new Image();
    img.onload = function() {
        paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
        paintCtx.drawImage(img, 0, 0);
        if (callback) callback();
    }
    img.src = dataUrl;
}

// --- ZOOM VE NOKTA HİZALAMA MANTIĞI ---
function updateTransform() {
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    document.getElementById('zoom-level').innerText = `${Math.round(scale * 100)}%`;
}

function zoomAtPoint(zoomFactor, clientX, clientY) {
    const newScale = Math.min(Math.max(scale * zoomFactor, 0.4), 5);
    if (newScale === scale) return;

    const rect = viewport.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    panX = x - (x - panX) * (newScale / scale);
    panY = y - (y - panY) * (newScale / scale);
    scale = newScale;

    updateTransform();
}

function zoomIn() {
    const rect = viewport.getBoundingClientRect();
    zoomAtPoint(1.25, rect.width / 2, rect.height / 2);
}

function zoomOut() {
    const rect = viewport.getBoundingClientRect();
    zoomAtPoint(0.8, rect.width / 2, rect.height / 2);
}

function resetZoom() {
    scale = 1;
    panX = (viewport.clientWidth - paintCanvas.width) / 2;
    panY = (viewport.clientHeight - paintCanvas.height) / 2;
    updateTransform();
}

viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    zoomAtPoint(factor, e.clientX, e.clientY);
}, { passive: false });

// --- FARE VE PAN KONTROLLERİ ---
viewport.addEventListener('mousedown', (e) => {
    if (e.button === 1 || currentMode === 'pan' || (e.button === 0 && isSpacePressed)) {
        isPanning = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        viewport.style.cursor = 'grabbing';
        e.preventDefault();
    }
});

window.addEventListener('mousemove', (e) => {
    if (isPanning) {
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
    }
});

window.addEventListener('mouseup', () => {
    if (isPanning) {
        isPanning = false;
        viewport.style.cursor = (currentMode === 'pan' || isSpacePressed) ? 'grab' : 'crosshair';
    }
});

// --- MOBİL / TABLET DOKUNMATİK DESTEĞİ ---
viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        initialTouchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
    } else if (e.touches.length === 1 && (currentMode === 'pan' || isSpacePressed)) {
        isPanning = true;
        startX = e.touches[0].clientX - panX;
        startY = e.touches[0].clientY - panY;
    }
}, { passive: false });

viewport.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const currentDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const currentCenter = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };

        if (initialTouchDist > 0) {
            const factor = currentDist / initialTouchDist;
            zoomAtPoint(factor, currentCenter.x, currentCenter.y);
        }
        initialTouchDist = currentDist;
    } else if (e.touches.length === 1 && isPanning) {
        panX = e.touches[0].clientX - startX;
        panY = e.touches[0].clientY - startY;
        updateTransform();
    }
}, { passive: false });

viewport.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) initialTouchDist = 0;
    isPanning = false;
});

// --- ÇİZİM İŞLEMLERİ VE ÇAKIŞMA ÖNLEME ---
function getCanvasCoordinates(e) {
    const rect = paintCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (paintCanvas.width / rect.width);
    const y = (e.clientY - rect.top) * (paintCanvas.height / rect.height);
    return { x, y };
}

paintCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && currentMode !== 'pan' && !isSpacePressed) {
        saveState();
        startDraw(e);
    }
});

paintCanvas.addEventListener('mousemove', (e) => {
    if (currentMode !== 'pan' && !isSpacePressed && isDrawing) {
        drawing(e);
    }
});

paintCanvas.addEventListener('mouseup', stopDraw);

paintCanvas.addEventListener('touchstart', (e) => { 
    if (e.touches.length === 1 && currentMode !== 'pan') {
        e.preventDefault();
        saveState();
        startDraw(e.touches[0]); 
    }
}, { passive: false });

paintCanvas.addEventListener('touchmove', (e) => { 
    if (e.touches.length === 1 && currentMode !== 'pan' && isDrawing) {
        e.preventDefault(); 
        drawing(e.touches[0]); 
    }
}, { passive: false });

paintCanvas.addEventListener('touchend', stopDraw);

function startDraw(e) {
    isDrawing = true;
    paintCtx.beginPath();
    const coords = getCanvasCoordinates(e);
    paintCtx.moveTo(coords.x, coords.y);

    if (currentMode === 'eraser') {
        paintCtx.globalCompositeOperation = 'destination-out';
    } else {
        paintCtx.globalCompositeOperation = 'source-over';
        paintCtx.strokeStyle = currentColor;
    }

    if (conn && conn.open) {
        conn.send({
            type: 'start',
            x: coords.x,
            y: coords.y,
            color: currentColor,
            size: currentSize,
            mode: currentMode
        });
    }
}

function drawing(e) {
    if (!isDrawing) return;
    const coords = getCanvasCoordinates(e);

    drawOnCanvas(coords.x, coords.y, currentColor, currentSize, currentMode);

    if (conn && conn.open) {
        conn.send({
            type: 'draw',
            x: coords.x,
            y: coords.y,
            color: currentColor,
            size: currentSize,
            mode: currentMode
        });
    }
}

function stopDraw() {
    isDrawing = false;
    paintCtx.beginPath();
}

function drawOnCanvas(x, y, color, size = 4, mode = 'pen') {
    paintCtx.lineWidth = size;
    paintCtx.lineCap = 'round';
    paintCtx.lineJoin = 'round';

    if (mode === 'eraser') {
        paintCtx.globalCompositeOperation = 'destination-out';
    } else {
        paintCtx.globalCompositeOperation = 'source-over';
        paintCtx.strokeStyle = color;
    }

    paintCtx.lineTo(x, y);
    paintCtx.stroke();
    paintCtx.beginPath();
    paintCtx.moveTo(x, y);
}

// --- P2P BAĞLANTI VE ODA ---
function generateRoomCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function createRoom() {
    const sizeSelectVal = document.getElementById('canvas-size-select').value.split('x');
    setCanvasSize(parseInt(sizeSelectVal[0]), parseInt(sizeSelectVal[1]));

    const shortRoomId = generateRoomCode(6);
    peer = new Peer(shortRoomId);

    peer.on('open', (id) => {
        document.getElementById('menu-screen').classList.add('hidden');
        document.getElementById('room-modal').classList.remove('hidden');
        document.getElementById('room-code-display').value = id;
    });

    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') createRoom();
        else alert("Bağlantı hatası: " + err.type);
    });

    peer.on('connection', (connection) => {
        conn = connection;
        conn.on('open', () => {
            conn.send({ type: 'init_size', w: paintCanvas.width, h: paintCanvas.height });
            if (hasTemplate(templateCanvas)) {
                conn.send({ type: 'resize_and_load', w: templateCanvas.width, h: templateCanvas.height, dataUrl: templateCanvas.toDataURL() });
            }
            if (hasDrawings(paintCanvas)) {
                conn.send({ type: 'sync_paint_state', dataUrl: paintCanvas.toDataURL() });
            }
        });

        document.getElementById('room-modal').classList.add('hidden');
        document.getElementById('game-screen').classList.remove('hidden');
        document.getElementById('status').innerText = "Bağlantı sağlandı, çizebilirsiniz! 🎉";
        setupConnection();
    });
}

function copyCode() {
    const codeInput = document.getElementById('room-code-display');
    codeInput.select();
    navigator.clipboard.writeText(codeInput.value);
    const feedback = document.getElementById('copy-feedback');
    feedback.innerText = "Kopyalandı! ✔️";
    setTimeout(() => { feedback.innerText = ""; }, 2000);
}

function closeModalToGame() {
    document.getElementById('room-modal').classList.add('hidden');
    document.getElementById('game-screen').classList.remove('hidden');
    document.getElementById('status').innerText = "Arkadaşının katılması bekleniyor...";
}

function joinRoom() {
    const roomID = document.getElementById('room-input').value.trim();
    if (!roomID) { alert("Lütfen oda kodu gir!"); return; }

    peer = new Peer();
    peer.on('open', () => {
        conn = peer.connect(roomID);
        conn.on('open', () => {
            document.getElementById('menu-screen').classList.add('hidden');
            document.getElementById('game-screen').classList.remove('hidden');
            document.getElementById('status').innerText = "Bağlantı sağlandı, çizebilirsiniz! 🎉";
            setupConnection();
        });
    });
}

function setupConnection() {
    conn.on('data', (data) => {
        if (data.type === 'start') {
            paintCtx.beginPath();
            paintCtx.moveTo(data.x, data.y);
            if (data.mode === 'eraser') paintCtx.globalCompositeOperation = 'destination-out';
            else {
                paintCtx.globalCompositeOperation = 'source-over';
                paintCtx.strokeStyle = data.color;
            }
        }
        else if (data.type === 'draw') {
            drawOnCanvas(data.x, data.y, data.color, data.size, data.mode);
        }
        else if (data.type === 'clear_drawings') {
            paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
        }
        else if (data.type === 'remove_template') {
            templateCtx.clearRect(0, 0, templateCanvas.width, templateCanvas.height);
        }
        else if (data.type === 'init_size') {
            setCanvasSize(data.w, data.h);
        }
        else if (data.type === 'resize_and_load') {
            setCanvasSize(data.w, data.h);
            loadTemplateFromUrl(data.dataUrl);
        }
        else if (data.type === 'sync_paint_state') {
            restoreCanvasState(data.dataUrl);
        }
    });
}

function clearCanvas(broadcast = true) {
    saveState();
    paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    if (broadcast && conn && conn.open) conn.send({ type: 'clear_drawings' });
}

function removeTemplate() {
    if (confirm("Şablonu kaldırmak istediğine emin misin?")) {
        templateCtx.clearRect(0, 0, templateCanvas.width, templateCanvas.height);
        if (conn && conn.open) conn.send({ type: 'remove_template' });
    }
}

function setCanvasSize(width, height) {
    paintCanvas.width = width;
    paintCanvas.height = height;
    paintCanvas.style.width = width + 'px';
    paintCanvas.style.height = height + 'px';

    templateCanvas.width = width;
    templateCanvas.height = height;
    templateCanvas.style.width = width + 'px';
    templateCanvas.style.height = height + 'px';

    container.style.width = width + 'px';
    container.style.height = height + 'px';
    
    historyStack = [];
    redoStack = [];
    resetZoom();
}

function downloadCanvas() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = paintCanvas.width;
    tempCanvas.height = paintCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.fillStyle = '#ffffff';
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tempCtx.drawImage(paintCanvas, 0, 0);
    tempCtx.globalCompositeOperation = 'multiply';
    tempCtx.drawImage(templateCanvas, 0, 0);

    const link = document.createElement('a');
    link.download = 'ortak-cizim-eserimiz.png';
    link.href = tempCanvas.toDataURL('image/png');
    link.click();
}

function loadDailyTemplate() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = (now - start) + ((start.getTimezoneOffset() - now.getTimezoneOffset()) * 60 * 1000);
    const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
    loadPresetTemplate(dailyTemplates[dayOfYear % dailyTemplates.length]);
}

function loadPresetTemplate(imageUrl) {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = function() {
        const origW = img.naturalWidth || img.width;
        const origH = img.naturalHeight || img.height;
        setCanvasSize(origW, origH);

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = origW;
        tempCanvas.height = origH;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0, origW, origH);
        const optimizedDataUrl = tempCanvas.toDataURL('image/jpeg', 0.85);

        loadTemplateFromUrl(optimizedDataUrl);
        if (conn && conn.open) {
            conn.send({ type: 'resize_and_load', w: origW, h: origH, dataUrl: optimizedDataUrl });
        }
    }
    img.src = imageUrl;
}

document.getElementById('imageLoader').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = function() {
            const origW = img.naturalWidth || img.width;
            const origH = img.naturalHeight || img.height;
            setCanvasSize(origW, origH);

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = origW;
            tempCanvas.height = origH;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(img, 0, 0, origW, origH);
            const optimizedDataUrl = tempCanvas.toDataURL('image/jpeg', 0.85);

            loadTemplateFromUrl(optimizedDataUrl);
            if (conn && conn.open) {
                conn.send({ type: 'resize_and_load', w: origW, h: origH, dataUrl: optimizedDataUrl });
            }
        }
        img.src = event.target.result;
    }
    reader.readAsDataURL(file);
});

function loadTemplateFromUrl(dataUrl) {
    const img = new Image();
    img.onload = function() {
        templateCtx.clearRect(0, 0, templateCanvas.width, templateCanvas.height);
        templateCtx.drawImage(img, 0, 0, templateCanvas.width, templateCanvas.height);
    }
    img.src = dataUrl;
}

function hasTemplate(canvas) {
    const blank = document.createElement('canvas');
    blank.width = canvas.width; blank.height = canvas.height;
    return canvas.toDataURL() !== blank.toDataURL();
}

function hasDrawings(canvas) {
    const blank = document.createElement('canvas');
    blank.width = canvas.width; blank.height = canvas.height;
    return canvas.toDataURL() !== blank.toDataURL();
}
