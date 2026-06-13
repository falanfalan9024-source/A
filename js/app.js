/**
 * PixelPro - Professional Image Processing Platform
 * v2.0 - Smart Crop + Manual Crop Edition
 */

'use strict';

// ============================================================
// STATE
// ============================================================
const State = {
  originalImage: null,      // original dataURL
  currentDataURL: null,     // current working dataURL (restored on every filter apply)
  fileName: '',
  fileSize: 0,
  imageWidth: 0,
  imageHeight: 0,
  zoom: 1,
  activeTab: 'crop',
  activeTool: 'select',
  brushSize: 20,
  isDrawing: false,
  drawMode: 'erase',
  isProcessing: false,
  cropRect: null,           // { x, y, w, h } in canvas pixels
  isCropping: false,
  cropStart: null,
  cropEnd: null,
  filters: {
    brightness: 0, contrast: 0, saturation: 0,
    hue: 0, exposure: 0, highlights: 0,
    shadows: 0, temperature: 0, vibrance: 0,
    sharpness: 0,
  },
  exportFormat: 'png',
  isAutoCropMode: true,
  aspectRatioLock: null,
  activeScanFilter: 'original',
};

// ============================================================
// UTILS
// ============================================================
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// Safe helper to update the status badge (avoids XSS via innerHTML)
function setStatusBadge(text, badgeClass = 'badge-ready') {
  const badge = $('statusBadge');
  if (!badge) return;
  badge.className = `status-badge ${badgeClass}`;
  badge.textContent = '';
  const dot = document.createElement('div');
  dot.className = 'status-dot';
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(text));
}

function showToast(msg, type = 'info') {
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle', warning: 'fa-exclamation-triangle' };
  const colors = { success: '#10b981', error: '#ef4444', info: '#6366f1', warning: '#f59e0b' };
  const validTypes = ['success', 'error', 'info', 'warning'];
  if (!validTypes.includes(type)) type = 'info';
  const container = $('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  // Safe DOM construction (no innerHTML with user data)
  const icon = document.createElement('i');
  icon.className = `fas ${icons[type]}`;
  icon.style.color = colors[type];
  const span = document.createElement('span');
  span.textContent = msg; // textContent prevents XSS
  t.appendChild(icon);
  t.appendChild(span);
  container.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 3200);
}

function setProgress(val, text) {
  const bar = $('progressBar'), pct = $('progressPct'), lbl = $('progressText');
  if (bar) bar.style.width = val + '%';
  if (pct) pct.textContent = Math.round(val) + '%';
  if (lbl && text) lbl.textContent = text;
}

function showLoading(text = 'جارٍ المعالجة...') {
  const o = $('loadingOverlay');
  if (!o) return;
  o.classList.add('active');
  const t = o.querySelector('.loading-text');
  if (t) t.textContent = text;
}
function hideLoading() { $('loadingOverlay')?.classList.remove('active'); }

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function imageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('فشل تحميل الصورة'));
    img.src = src;
  });
}

// ============================================================
// CANVAS MANAGER
// ============================================================
const CM = {
  c: null,  // main canvas
  x: null,  // main context

  init() {
    this.c = $('mainCanvas');
    this.x = this.c.getContext('2d', { willReadFrequently: true });
  },

  async loadSrc(src) {
    const img = await imageFromSrc(src);
    const maxW = Math.min(window.innerWidth - 640, 900);
    const maxH = window.innerHeight - 200;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > maxW || h > maxH) {
      const r = Math.min(maxW / w, maxH / h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    this.c.width = w;
    this.c.height = h;
    this.x.clearRect(0, 0, w, h);
    this.x.drawImage(img, 0, 0, w, h);
    return { w, h };
  },

  snapshot() { return this.c.toDataURL('image/png'); },

  async restoreFrom(src) {
    const img = await imageFromSrc(src);
    this.x.clearRect(0, 0, this.c.width, this.c.height);
    this.x.drawImage(img, 0, 0, this.c.width, this.c.height);
  },

  getImageData() { return this.x.getImageData(0, 0, this.c.width, this.c.height); },
  putImageData(d) { this.x.putImageData(d, 0, 0); },
};

// ============================================================
// HISTORY
// ============================================================
const History = {
  stack: [],
  ptr: -1,

  push(label, src) {
    this.stack = this.stack.slice(0, this.ptr + 1);
    this.stack.push({ label, src, t: new Date() });
    if (this.stack.length > 25) this.stack.shift();
    this.ptr = this.stack.length - 1;
    this.render();
  },

  async undo() {
    if (this.ptr <= 0) { showToast('لا يوجد إجراء للتراجع عنه', 'warning'); return; }
    this.ptr--;
    await CM.restoreFrom(this.stack[this.ptr].src);
    State.currentDataURL = CM.snapshot();
    ColorTools.baseSnap = CM.snapshot();
    showToast('تراجع ✓', 'info');
    this.render();
  },

  async redo() {
    if (this.ptr >= this.stack.length - 1) { showToast('لا يوجد إجراء للتقدم', 'warning'); return; }
    this.ptr++;
    await CM.restoreFrom(this.stack[this.ptr].src);
    State.currentDataURL = CM.snapshot();
    ColorTools.baseSnap = CM.snapshot();
    showToast('تقدم ✓', 'info');
    this.render();
  },

  async jumpTo(i) {
    this.ptr = i;
    await CM.restoreFrom(this.stack[i].src);
    State.currentDataURL = CM.snapshot();
    ColorTools.baseSnap = CM.snapshot();
    this.render();
  },

  render() {
    const list = $('historyList');
    if (!list) return;
    if (!this.stack.length) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:0.78rem;padding:8px 0">لا توجد عمليات</div>';
    } else {
      list.innerHTML = [...this.stack].reverse().map((item, ri) => {
        const i = this.stack.length - 1 - ri;
        return `<div class="history-item ${i === this.ptr ? 'current' : ''}" onclick="History.jumpTo(${i})">
          <i class="fas fa-circle-dot"></i>
          <span>${item.label}</span>
          <span style="margin-right:auto;color:var(--text-muted);font-size:0.67rem">${item.t.toLocaleTimeString('ar-SA')}</span>
        </div>`;
      }).join('');
    }
    $('btnUndo').disabled = this.ptr <= 0;
    $('btnRedo').disabled = this.ptr >= this.stack.length - 1;
  }
};

// ============================================================
// UPLOAD
// ============================================================
const Upload = {
  init() {
    const zone = $('uploadZone');
    const input = $('fileInput');
    // Only open dialog when clicking the zone itself, not its children (prevents double dialog)
    zone.addEventListener('click', (e) => {
      if (e.target === zone || e.target.classList.contains('upload-icon') ||
        e.target.classList.contains('upload-title') || e.target.classList.contains('upload-sub') ||
        e.target.classList.contains('upload-formats') || e.target.classList.contains('format-tag')) {
        input.click();
      }
    });
    input.addEventListener('change', e => {
      if (e.target.files[0]) this.handle(e.target.files[0]);
      // Reset input so same file can be re-uploaded
      e.target.value = '';
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) this.handle(droppedFile);
    });
  },

  async handle(file) {
    if (!file) return;
    // Validate MIME type
    if (!file.type.startsWith('image/')) { showToast('اختر ملف صورة صالح (PNG، JPG، WEBP، BMP، GIF)', 'error'); return; }
    // Validate file extension
    const allowedExts = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'tif', 'svg'];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowedExts.includes(ext)) { showToast('صيغة الملف غير مدعومة', 'error'); return; }
    // Validate file size (max 50MB)
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) { showToast('حجم الملف كبير جداً (الحد الأقصى 50 ميجابايت)', 'error'); return; }
    State.fileName = file.name;
    State.fileSize = file.size;

    showLoading('تحميل الصورة...');

    const src = await new Promise(r => {
      const reader = new FileReader();
      reader.onload = e => r(e.target.result);
      reader.readAsDataURL(file);
    });

    State.originalImage = src;
    State.currentDataURL = src;

    const { w, h } = await CM.loadSrc(src);
    State.imageWidth = w;
    State.imageHeight = h;

    hideLoading();

    // Show canvas, hide upload
    $('uploadZone').style.display = 'none';
    const cc = $('canvasContainer');
    cc.style.display = 'flex';

    // Reset history & color tools
    History.stack = []; History.ptr = -1;
    History.push('الصورة الأصلية', CM.snapshot());
    ColorTools.baseSnap = CM.snapshot();

    // Update info
    $('infoWidth').textContent = w + ' px';
    $('infoHeight').textContent = h + ' px';
    $('infoSize').textContent = formatBytes(file.size);
    $('infoType').textContent = file.type.split('/')[1].toUpperCase();
    $('infoFileName').textContent = file.name.length > 22 ? file.name.slice(0, 22) + '…' : file.name;

    App.enableTools();
    showToast('تم تحميل الصورة: ' + file.name, 'success');

    // Init crop overlay and trigger auto-detection immediately
    CropTool.initOverlay();
    setTimeout(() => {
      AutoCrop.detectAndShow();
    }, 250);
  }
};

// ============================================================
// SMART AUTO CROP
// ============================================================
const AutoCrop = {
  detectAndShow() {
    if (!State.originalImage) return;
    const canvas = CM.c;
    const ctx = CM.x;
    const w = canvas.width, h = canvas.height;

    // Sample background
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    let isWhiteBg = true;
    const bgType = $('bgTypeSelect')?.value || 'auto';

    if (bgType === 'white') {
      isWhiteBg = true;
    } else if (bgType === 'dark') {
      isWhiteBg = false;
    } else {
      // Auto: Sample corners
      const corners = [
        getPixelBrightness(data, 0, 0, w),
        getPixelBrightness(data, w - 1, 0, w),
        getPixelBrightness(data, 0, h - 1, w),
        getPixelBrightness(data, w - 1, h - 1, w)
      ];
      const avgBrightness = corners.reduce((a, b) => a + b, 0) / 4;
      isWhiteBg = avgBrightness > 127;
    }

    const sens = parseInt($('cropSens')?.value) || 20;
    const isBg = isWhiteBg
      ? (r, g, b) => r > 255 - sens && g > 255 - sens && b > 255 - sens
      : (r, g, b) => r < sens && g < sens && b < sens;

    let minX = w, minY = h, maxX = 0, maxY = 0;
    let found = false;

    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const idx = (y * w + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
        if (a < 10) continue;
        if (!isBg(r, g, b)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found) {
      minX = 0; minY = 0; maxX = w; maxY = h;
    }

    const pad = 8;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w, maxX + pad);
    maxY = Math.min(h, maxY + pad);

    const rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

    // Map to crop box overlay
    if (!CropTool.overlay) return;
    CropTool.overlay.style.display = 'block';

    const scaleX = canvas.offsetWidth / w;
    const scaleY = canvas.offsetHeight / h;

    CropTool.boxX = Math.round(rect.x * scaleX);
    CropTool.boxY = Math.round(rect.y * scaleY);
    CropTool.boxW = Math.round(rect.w * scaleX);
    CropTool.boxH = Math.round(rect.h * scaleY);

    if (State.aspectRatioLock) {
      CropTool.applyAspectRatioLock(State.aspectRatioLock);
    } else {
      CropTool.updateBox();
    }

    setStatusBadge('تم الكشف تلقائياً');
  },

  applyCrop({ x, y, w: cw, h: ch }) {
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    cw = Math.min(CM.c.width - x, Math.round(cw));
    ch = Math.min(CM.c.height - y, Math.round(ch));

    if (cw < 10 || ch < 10) throw new Error('منطقة الاقتصاص صغيرة جداً');

    const cropData = CM.x.getImageData(x, y, cw, ch);
    CM.c.width = cw;
    CM.c.height = ch;
    CM.x.putImageData(cropData, 0, 0);
  },

  resetToOriginal() {
    if (!State.originalImage) return;
    CM.loadSrc(State.originalImage).then(({ w, h }) => {
      State.imageWidth = w;
      State.imageHeight = h;
      $('infoWidth').textContent = w + ' px';
      $('infoHeight').textContent = h + ' px';
      State.currentDataURL = CM.snapshot();
      ColorTools.baseSnap = CM.snapshot();
      History.push('استعادة الصورة الأصلية', CM.snapshot());

      // Reset active filters UI
      applyScanFilter('original');

      if (State.isAutoCropMode) {
        AutoCrop.detectAndShow();
      } else {
        CropTool.activate();
      }
      showToast('تمت استعادة الصورة الأصلية', 'info');
    });
  }
};

function getPixelBrightness(data, x, y, w) {
  const i = (y * w + x) * 4;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

// ============================================================
// MANUAL CROP TOOL
// ============================================================
const CropTool = {
  overlay: null,
  cropBox: null,
  handles: {},
  dragging: false,
  resizing: false,
  activeHandle: null,
  startX: 0, startY: 0,
  boxX: 0, boxY: 0, boxW: 0, boxH: 0,
  canvasRect: null,

  initOverlay() {
    const existingOverlay = document.getElementById('cropOverlay');
    if (existingOverlay) existingOverlay.remove();
    this.overlay = null;
    this.cropBox = null;
    this.handles = {};

    const canvas = $('mainCanvas');
    const canvasContainer = $('canvasContainer');

    let wrapper = document.getElementById('cropCanvasWrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'cropCanvasWrapper';
      canvasContainer.insertBefore(wrapper, canvas);
      wrapper.appendChild(canvas);
    }
    this._canvasWrapper = wrapper;

    const overlay = document.createElement('div');
    overlay.id = 'cropOverlay';
    overlay.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 20;
      display: none;
    `;

    const box = document.createElement('div');
    box.id = 'cropBox';
    box.style.cssText = `
      position: absolute;
      cursor: move;
      pointer-events: all;
      box-sizing: border-box;
    `;

    box.innerHTML = `
      <div style="position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr;pointer-events:none;">
        ${Array(4).fill('<div style="border-right:1px dashed rgba(255,255,255,0.3);border-bottom:1px dashed rgba(255,255,255,0.3);"></div>').join('')}
        <div></div>
        ${Array(4).fill('<div style="border-right:1px dashed rgba(255,255,255,0.3);border-bottom:1px dashed rgba(255,255,255,0.3);"></div>').join('')}
        <div></div>
      </div>`;

    // Corner handles
    const corners = ['nw', 'ne', 'sw', 'se'];
    const cursors = { nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize' };
    const positions = {
      nw: 'top:0;left:0',
      ne: 'top:0;right:0',
      sw: 'bottom:0;left:0',
      se: 'bottom:0;right:0',
    };
    corners.forEach(c => {
      const h = document.createElement('div');
      h.dataset.handle = c;
      h.className = 'crop-handle corner-handle';
      h.style.cssText = `
        cursor:${cursors[c]};
        ${positions[c]};
      `;
      box.appendChild(h);
      this.handles[c] = h;
    });

    // Edge handles
    const edges = ['n', 's', 'e', 'w'];
    const edgeCursors = { n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize' };
    const edgePos = {
      n: 'top:0;left:50%;transform:translateX(-50%)',
      s: 'bottom:0;left:50%;transform:translateX(-50%)',
      e: 'right:0;top:50%;transform:translateY(-50%)',
      w: 'left:0;top:50%;transform:translateY(-50%)',
    };
    edges.forEach(e => {
      const h = document.createElement('div');
      h.dataset.handle = e;
      h.className = 'crop-handle edge-handle';
      h.style.cssText = `
        cursor:${edgeCursors[e]};
        ${edgePos[e]};
      `;
      box.appendChild(h);
      this.handles[e] = h;
    });

    overlay.appendChild(box);
    this.overlay = overlay;
    this.cropBox = box;

    wrapper.appendChild(overlay);
    this.setupEvents();
  },

  activate() {
    if (!State.originalImage) { showToast('ارفع صورة أولاً', 'warning'); return; }
    const canvas = $('mainCanvas');
    if (!canvas || !this.overlay) return;
    this.overlay.style.display = 'block';

    const cw = canvas.offsetWidth;
    const ch = canvas.offsetHeight;

    this.boxW = Math.round(cw * 0.85);
    this.boxH = Math.round(ch * 0.85);
    this.boxX = Math.round((cw - this.boxW) / 2);
    this.boxY = Math.round((ch - this.boxH) / 2);

    if (State.aspectRatioLock) {
      this.applyAspectRatioLock(State.aspectRatioLock);
    } else {
      this.updateBox();
    }

    canvas.style.cursor = 'crosshair';
  },

  syncOverlaySize() {
    // Overlay sizes automatically using inset:0 inside wrapper
  },

  setupEvents() {
    const overlay = this.overlay;
    const box = this.cropBox;

    box.addEventListener('mousedown', e => {
      if (e.target.dataset.handle) return;
      e.preventDefault();
      this.dragging = true;
      this.startX = e.clientX - this.boxX;
      this.startY = e.clientY - this.boxY;
    });

    Object.values(this.handles).forEach(h => {
      h.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        this.resizing = true;
        this.activeHandle = e.target.dataset.handle;
        this.startX = e.clientX;
        this.startY = e.clientY;
        this._origBox = { x: this.boxX, y: this.boxY, w: this.boxW, h: this.boxH };
      });
    });

    overlay.addEventListener('mousedown', e => {
      if (e.target !== overlay) return;
      e.preventDefault();
      const r = overlay.getBoundingClientRect();
      this.startX = Math.max(0, Math.min(overlay.offsetWidth, e.clientX - r.left));
      this.startY = Math.max(0, Math.min(overlay.offsetHeight, e.clientY - r.top));
      this.boxX = this.startX;
      this.boxY = this.startY;
      this.boxW = 0; this.boxH = 0;
      this.dragging = false;
      this.resizing = false;
      this._newSelection = true;
    });

    if (this._mouseMoveHandler) document.removeEventListener('mousemove', this._mouseMoveHandler);
    if (this._mouseUpHandler) document.removeEventListener('mouseup', this._mouseUpHandler);

    this._mouseMoveHandler = e => {
      if (!this.overlay || this.overlay.style.display === 'none') return;

      if (this._newSelection) {
        const r = overlay.getBoundingClientRect();
        const maxW = overlay.offsetWidth;
        const maxH = overlay.offsetHeight;
        const cx = Math.max(0, Math.min(maxW, e.clientX - r.left));
        const cy = Math.max(0, Math.min(maxH, e.clientY - r.top));
        this.boxX = Math.min(this.startX, cx);
        this.boxY = Math.min(this.startY, cy);
        this.boxW = Math.abs(cx - this.startX);
        this.boxH = Math.abs(cy - this.startY);
        this.boxW = Math.min(this.boxW, maxW - this.boxX);
        this.boxH = Math.min(this.boxH, maxH - this.boxY);
        this.updateBox();
        return;
      }

      if (this.dragging) {
        const maxW = overlay.offsetWidth;
        const maxH = overlay.offsetHeight;
        this.boxX = Math.max(0, Math.min(maxW - this.boxW, e.clientX - this.startX));
        this.boxY = Math.max(0, Math.min(maxH - this.boxH, e.clientY - this.startY));
        this.updateBox();
      }

      if (this.resizing && this._origBox) {
        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;
        const { x: ox, y: oy, w: ow, h: oh } = this._origBox;
        const maxW = overlay.offsetWidth;
        const maxH = overlay.offsetHeight;
        const minSize = 20;

        let nx = ox, ny = oy, nw = ow, nh = oh;
        const handle = this.activeHandle;

        if (State.aspectRatioLock) {
          const [rw, rh] = State.aspectRatioLock.split(':').map(Number);
          const ratio = rw / rh;

          if (handle === 'se') {
            nw = Math.max(minSize, Math.min(maxW - ox, ow + dx));
            nh = nw / ratio;
            if (ny + nh > maxH) { nh = maxH - ny; nw = nh * ratio; }
          } else if (handle === 'sw') {
            nx = Math.max(0, Math.min(ox + ow - minSize, ox + dx));
            nw = ow + ox - nx;
            nh = nw / ratio;
            if (ny + nh > maxH) { nh = maxH - ny; nw = nh * ratio; nx = ox + ow - nw; }
          } else if (handle === 'ne') {
            nw = Math.max(minSize, Math.min(maxW - ox, ow + dx));
            nh = nw / ratio;
            ny = oy + oh - nh;
            if (ny < 0) { ny = 0; nh = oy + oh; nw = nh * ratio; }
          } else if (handle === 'nw') {
            nx = Math.max(0, Math.min(ox + ow - minSize, ox + dx));
            nw = ow + ox - nx;
            nh = nw / ratio;
            ny = oy + oh - nh;
            if (ny < 0) { ny = 0; nh = oy + oh; nw = nh * ratio; nx = ox + ow - nw; }
          }
        } else {
          if (handle.includes('e')) nw = Math.max(minSize, Math.min(maxW - ox, ow + dx));
          if (handle.includes('s')) nh = Math.max(minSize, Math.min(maxH - oy, oh + dy));
          if (handle.includes('w')) { nx = Math.max(0, Math.min(ox + ow - minSize, ox + dx)); nw = ow + ox - nx; }
          if (handle.includes('n')) { ny = Math.max(0, Math.min(oy + oh - minSize, oy + dy)); nh = oh + oy - ny; }
        }

        this.boxX = nx; this.boxY = ny;
        this.boxW = Math.max(minSize, nw);
        this.boxH = Math.max(minSize, nh);
        this.updateBox();

        if (State.isAutoCropMode) {
          setStatusBadge('معدل يدوياً');
        }
      }
    };

    this._mouseUpHandler = () => {
      this.dragging = false;
      this.resizing = false;
      this.activeHandle = null;
      this._origBox = null;
      this._newSelection = false;
    };

    document.addEventListener('mousemove', this._mouseMoveHandler);
    document.addEventListener('mouseup', this._mouseUpHandler);
  },

  updateBox() {
    if (!this.cropBox || !this.overlay) return;
    const maxW = this.overlay.offsetWidth;
    const maxH = this.overlay.offsetHeight;

    this.boxX = Math.max(0, Math.min(maxW, this.boxX));
    this.boxY = Math.max(0, Math.min(maxH, this.boxY));
    this.boxW = Math.max(10, Math.min(maxW - this.boxX, this.boxW));
    this.boxH = Math.max(10, Math.min(maxH - this.boxY, this.boxH));

    this.cropBox.style.left = this.boxX + 'px';
    this.cropBox.style.top = this.boxY + 'px';
    this.cropBox.style.width = this.boxW + 'px';
    this.cropBox.style.height = this.boxH + 'px';

    const canvas = $('mainCanvas');
    if (!canvas) return;
    const scaleX = canvas.width / (this.overlay.offsetWidth || canvas.width);
    const scaleY = canvas.height / (this.overlay.offsetHeight || canvas.height);
    const rw = Math.round(this.boxW * scaleX);
    const rh = Math.round(this.boxH * scaleY);
    const dimEl = $('cropDimDisplay');
    if (dimEl) dimEl.textContent = `${rw} × ${rh} px`;
  },

  async apply() {
    if (this.boxW < 10 || this.boxH < 10) {
      showToast('الرجاء رسم منطقة قص أولاً', 'warning');
      return;
    }

    const canvas = $('mainCanvas');
    const scaleX = canvas.width / (this.overlay.offsetWidth || canvas.width);
    const scaleY = canvas.height / (this.overlay.offsetHeight || canvas.height);

    const cropX = Math.round(this.boxX * scaleX);
    const cropY = Math.round(this.boxY * scaleY);
    const cropW = Math.round(this.boxW * scaleX);
    const cropH = Math.round(this.boxH * scaleY);

    AutoCrop.applyCrop({ x: cropX, y: cropY, w: cropW, h: cropH });

    $('infoWidth').textContent = canvas.width + ' px';
    $('infoHeight').textContent = canvas.height + ' px';

    History.push('قص المستند', CM.snapshot());
    State.currentDataURL = CM.snapshot();
    ColorTools.baseSnap = CM.snapshot();

    this.clearOverlay();
    showToast(`تم قص المستند إلى ${canvas.width}×${canvas.height} px ✓`, 'success');
  },

  clearOverlay() {
    const canvas = $('mainCanvas');
    if (canvas) canvas.style.cursor = 'default';
    if (this.overlay) { this.overlay.style.display = 'none'; }
    this.boxW = 0; this.boxH = 0;
    const dim = $('cropDimDisplay');
    if (dim) dim.textContent = '';
  },

  cancel() {
    this.clearOverlay();
    showToast('تم إلغاء القص', 'info');
  },

  applyAspectRatioLock(ratio) {
    if (!this.overlay || this.overlay.style.display === 'none') return;
    const [rw, rh] = ratio.split(':').map(Number);
    const maxW = this.overlay.offsetWidth;
    const maxH = this.overlay.offsetHeight;

    let w = this.boxW || Math.round(maxW * 0.8);
    let h = w * (rh / rw);

    if (h > maxH) {
      h = maxH * 0.8;
      w = h * (rw / rh);
    }
    if (w > maxW) {
      w = maxW * 0.8;
      h = w * (rh / rw);
    }

    this.boxW = Math.round(w);
    this.boxH = Math.round(h);
    this.boxX = Math.round((maxW - this.boxW) / 2);
    this.boxY = Math.round((maxH - this.boxH) / 2);
    this.updateBox();
  }
};

// ============================================================
// COLOR TOOLS
// ============================================================
const ColorTools = {
  baseSnap: null,
  applyTimer: null,

  async applyAll() {
    if (!this.baseSnap) return;
    const img = await imageFromSrc(this.baseSnap);
    const ctx = CM.x;
    const canvas = CM.c;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const f = State.filters;

    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      v += f.brightness * 2.55;
      v *= Math.pow(2, f.exposure / 100);
      const totalContrast = f.contrast + (f.sharpness || 0) * 1.5;
      v = ((v - 128) * (1 + totalContrast / 100)) + 128;
      lut[i] = Math.min(255, Math.max(0, v));
    }

    for (let i = 0; i < data.length; i += 4) {
      let r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];
      const a = data[i + 3];
      if (a === 0) continue;

      // Saturation & Hue
      const [h, s, l] = rgbToHsl(r, g, b);
      const ns = Math.min(1, Math.max(0, s + f.saturation / 100));
      const [nr, ng, nb] = hslToRgb(h + f.hue / 360, ns, l);
      r = nr; g = ng; b = nb;

      // Temperature
      if (f.temperature > 0) { r = Math.min(255, r + f.temperature * 0.5); b = Math.max(0, b - f.temperature * 0.3); }
      else if (f.temperature < 0) { b = Math.min(255, b - f.temperature * 0.5); r = Math.max(0, r + f.temperature * 0.3); }

      // Vibrance
      const avg = (r + g + b) / 3;
      const maxC = Math.max(r, g, b);
      const vf = 1 + (f.vibrance / 100) * (1 - (maxC - avg) / 128);
      r = Math.min(255, Math.max(0, avg + (r - avg) * vf));
      g = Math.min(255, Math.max(0, avg + (g - avg) * vf));
      b = Math.min(255, Math.max(0, avg + (b - avg) * vf));

      // Highlights / Shadows
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 128 && f.highlights !== 0) {
        const boost = f.highlights * (lum - 128) / 127 * 0.5;
        r = Math.min(255, Math.max(0, r + boost));
        g = Math.min(255, Math.max(0, g + boost));
        b = Math.min(255, Math.max(0, b + boost));
      } else if (lum <= 128 && f.shadows !== 0) {
        const boost = f.shadows * (128 - lum) / 128 * 0.5;
        r = Math.min(255, Math.max(0, r + boost));
        g = Math.min(255, Math.max(0, g + boost));
        b = Math.min(255, Math.max(0, b + boost));
      }

      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    ctx.putImageData(imageData, 0, 0);
  },

  scheduleApply() {
    clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => this.applyAll(), 60);
  },

  applyPreset(name) {
    const presets = {
      vivid: { brightness: 5, contrast: 20, saturation: 30, vibrance: 25 },
      cinematic: { brightness: -5, contrast: 30, saturation: -10, temperature: -20, highlights: -20, shadows: 20 },
      vintage: { brightness: -5, contrast: 10, saturation: -20, temperature: 30 },
      cool: { temperature: -40, saturation: 10, brightness: 5 },
      warm: { temperature: 40, saturation: 15, brightness: 3 },
      bw: { saturation: -100, contrast: 25 },
      dramatic: { contrast: 50, saturation: 20, highlights: -30, shadows: 30 },
    };
    if (!presets[name]) return;
    for (const k of Object.keys(State.filters)) { State.filters[k] = 0; updateSliderUI(k, 0); }
    Object.assign(State.filters, presets[name]);
    for (const [k, v] of Object.entries(presets[name])) updateSliderUI(k, v);
    this.applyAll().then(() => History.push(`فلتر: ${name}`, CM.snapshot()));
  },

  async autoEnhance() {
    if (!State.currentDataURL) { showToast('ارفع صورة أولاً', 'warning'); return; }
    const vals = { brightness: 5, contrast: 15, saturation: 10, exposure: 3, vibrance: 20, highlights: -10, shadows: 15 };
    Object.assign(State.filters, vals);
    for (const [k, v] of Object.entries(vals)) updateSliderUI(k, v);
    await this.applyAll();
    History.push('تحسين تلقائي', CM.snapshot());
    showToast('تم التحسين التلقائي الذكي ✨', 'success');
  },

  reset() {
    for (const k of Object.keys(State.filters)) { State.filters[k] = 0; updateSliderUI(k, 0); }
    if (this.baseSnap) {
      imageFromSrc(this.baseSnap).then(img => {
        CM.x.clearRect(0, 0, CM.c.width, CM.c.height);
        CM.x.drawImage(img, 0, 0);
      });
    }
    showToast('تم إعادة ضبط الألوان', 'info');
  }
};

// ============================================================
// ENHANCER
// ============================================================
const Enhancer = {
  async upscale(factor) {
    if (!State.currentDataURL) { showToast('ارفع صورة أولاً', 'warning'); return; }
    if (State.isProcessing) return;
    State.isProcessing = true;
    showLoading(`رفع الجودة ×${factor}...`);
    $('progressContainer').classList.add('active');
    setProgress(0);

    try {
      setProgress(20, 'تحليل الصورة...');
      await delay(250);
      setProgress(55, 'تكبير وتحسين الحدة...');

      const src = CM.c;
      const nw = Math.round(src.width * factor);
      const nh = Math.round(src.height * factor);
      const tmp = document.createElement('canvas');
      tmp.width = nw; tmp.height = nh;
      const tx = tmp.getContext('2d');
      tx.imageSmoothingEnabled = true;
      tx.imageSmoothingQuality = 'high';
      tx.drawImage(src, 0, 0, nw, nh);

      // Sharpening pass
      const id = tx.getImageData(0, 0, nw, nh);
      const d = id.data, dc = new Uint8ClampedArray(d);
      const k = [-0.5, -1, -0.5, -1, 7, -1, -0.5, -1, -0.5];
      for (let y = 1; y < nh - 1; y++) {
        for (let x = 1; x < nw - 1; x++) {
          for (let c = 0; c < 3; c++) {
            let val = 0, ki = 0;
            for (let ky = -1; ky <= 1; ky++)
              for (let kx = -1; kx <= 1; kx++)
                val += dc[((y + ky) * nw + (x + kx)) * 4 + c] * k[ki++];
            d[(y * nw + x) * 4 + c] = Math.min(255, Math.max(0, val));
          }
        }
      }
      tx.putImageData(id, 0, 0);

      CM.c.width = nw; CM.c.height = nh;
      CM.x.drawImage(tmp, 0, 0);

      State.imageWidth = nw; State.imageHeight = nh;
      $('infoWidth').textContent = nw + ' px';
      $('infoHeight').textContent = nh + ' px';
      State.currentDataURL = CM.snapshot();
      ColorTools.baseSnap = CM.snapshot();
      setProgress(100);
      History.push(`رفع جودة ×${factor}`, CM.snapshot());
      showToast(`تم رفع الجودة إلى ${nw}×${nh} px ✓`, 'success');
    } finally {
      await delay(300);
      hideLoading();
      $('progressContainer').classList.remove('active');
      State.isProcessing = false;
    }
  },

  async reduceNoise() {
    if (!State.currentDataURL) { showToast('ارفع صورة أولاً', 'warning'); return; }
    showLoading('إزالة التشويش...');
    $('progressContainer').classList.add('active');
    setProgress(0, 'تطبيق مرشح التنعيم...');

    try {
      await delay(200);
      setProgress(60);
      const id = CM.getImageData();
      const d = id.data, dc = new Uint8ClampedArray(d);
      const w = CM.c.width, h = CM.c.height;
      const kw = [1, 2, 1, 2, 4, 2, 1, 2, 1], ks = 16;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          for (let c = 0; c < 3; c++) {
            let val = 0, ki = 0;
            for (let ky = -1; ky <= 1; ky++)
              for (let kx = -1; kx <= 1; kx++)
                val += dc[((y + ky) * w + (x + kx)) * 4 + c] * kw[ki++];
            d[(y * w + x) * 4 + c] = val / ks;
          }
        }
      }
      CM.putImageData(id);
      setProgress(100);
      ColorTools.baseSnap = CM.snapshot();
      History.push('إزالة التشويش', CM.snapshot());
      showToast('تمت إزالة التشويش بنجاح ✓', 'success');
    } finally {
      await delay(300);
      hideLoading();
      $('progressContainer').classList.remove('active');
    }
  }
};

// ============================================================
// EXPORT
// ============================================================
const Exporter = {
  fmt: 'png',

  select(f) {
    this.fmt = f;
    $$('.export-list .export-card').forEach(e => e.classList.toggle('selected', e.id === 'exp-' + f));
    const qGroup = $('exportQualityGroup');
    if (qGroup) {
      qGroup.style.display = f === 'jpeg' ? 'flex' : 'none';
    }
  },

  download() {
    if (!State.currentDataURL) { showToast('لا توجد صورة', 'warning'); return; }
    const canvas = CM.c;
    const q = parseInt($('exportQuality')?.value || 95) / 100;

    if (this.fmt === 'pdf') {
      // For PDF: open print dialog with PDF save option
      showToast('يتم فتح نافذة الطباعة — اختر "حفظ بتنسيق PDF"', 'info');
      setTimeout(() => printCurrentDocument(), 600);
      return;
    }

    const link = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    link.download = `doccropper_${ts}.${this.fmt === 'jpeg' ? 'jpg' : this.fmt}`;

    if (this.fmt === 'png') {
      link.href = canvas.toDataURL('image/png');
    } else if (this.fmt === 'jpeg') {
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width; tmp.height = canvas.height;
      const tx = tmp.getContext('2d');
      tx.fillStyle = '#ffffff';
      tx.fillRect(0, 0, tmp.width, tmp.height);
      tx.drawImage(canvas, 0, 0);
      link.href = tmp.toDataURL('image/jpeg', q);
    } else {
      showToast('صيغة غير مدعومة للتنزيل', 'error');
      return;
    }

    // Trigger download
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`تم تصدير الصورة (${this.fmt.toUpperCase()}) ✓`, 'success');
  },

  copyToClipboard() {
    CM.c.toBlob(blob => {
      try {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('تم النسخ إلى الحافظة ✓', 'success');
      } catch { showToast('المتصفح لا يدعم النسخ المباشر', 'warning'); }
    });
  }
};

// ============================================================
// HSL HELPERS
// ============================================================
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue2 = (t) => {
      if (t < 0) t++; if (t > 1) t--;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue2(h + 1 / 3); g = hue2(h); b = hue2(h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ============================================================
// SLIDER UI HELPERS
// ============================================================
function updateSliderUI(key, val) {
  const slider = $('slider_' + key);
  const display = $('val_' + key);
  if (slider) slider.value = val;
  if (display) display.textContent = (val > 0 ? '+' : '') + val;
}

function initSlider(id, min, max, def = 0) {
  const slider = $('slider_' + id);
  const display = $('val_' + id);
  if (!slider) return;
  slider.min = min; slider.max = max; slider.value = def;
  if (display) display.textContent = def;

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value);
    State.filters[id] = v;
    if (display) display.textContent = (v > 0 ? '+' : '') + v;
    ColorTools.scheduleApply();
  });
  slider.addEventListener('change', () => {
    History.push(`تعديل ${id}`, CM.snapshot());
  });
}

// ============================================================
// ZOOM
// ============================================================
const Zoom = {
  v: 1,
  set(val) {
    this.v = Math.min(4, Math.max(0.2, val));
    const c = $('mainCanvas');
    if (c) { c.style.transform = `scale(${this.v})`; c.style.transformOrigin = 'center center'; }
    const d = $('zoomDisplay');
    if (d) d.textContent = Math.round(this.v * 100) + '%';
    CropTool.syncOverlaySize();
  },
  in() { this.set(this.v + 0.1); },
  out() { this.set(this.v - 0.1); },
  reset() { this.set(1); },
};

// ============================================================
// PANEL MANAGER
// ============================================================
function togglePanel(el) {
  el.closest('.panel-card').classList.toggle('open');
}

// ============================================================
// MAIN APP
// ============================================================
const App = {
  init() {
    CM.init();
    Upload.init();

    this.initSliders();
    this.initPanels();
    this.initTabNav();
    this.initKeyboard();
    this.initZoom();
    this.disableTools();
    History.render();

    // Set initial tab
    this.switchTab('crop');
  },

  initSliders() {
    initSlider('brightness', -100, 100);
    initSlider('contrast', -100, 100);
    initSlider('exposure', -100, 100);
    // Initialize export quality group visibility (PNG default = hide quality slider)
    Exporter.select('png');
  },

  initPanels() {
    // Initial open states are managed directly in the HTML markup via class="panel-card open".
  },

  initTabNav() {
    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        this.switchTab(btn.dataset.tab);
      });
    });
  },

  switchTab(tab) {
    $$('.tab-content').forEach(c => c.style.display = 'none');
    const el = $('tab_' + tab);
    if (el) { el.style.display = 'flex'; el.style.flexDirection = 'column'; el.style.gap = '8px'; }
    State.activeTab = tab;

    // Manage crop overlay display per tab
    if (tab === 'crop') {
      if (CropTool.overlay && State.originalImage) {
        CropTool.overlay.style.display = 'block';
        CropTool.updateBox();
      }
    } else {
      if (CropTool.overlay) {
        CropTool.overlay.style.display = 'none';
      }
    }
  },

  initKeyboard() {
    document.addEventListener('keydown', e => {
      // Don't intercept shortcuts when focus is in a text field
      const tag = document.activeElement?.tagName?.toLowerCase();
      const isTyping = ['input', 'textarea', 'select'].includes(tag);

      if (!isTyping) {
        if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); History.undo(); }
        if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) { e.preventDefault(); History.redo(); }
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); Exporter.download(); }
        if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); Zoom.in(); }
        if (e.ctrlKey && e.key === '-') { e.preventDefault(); Zoom.out(); }
        if (e.key === 'Escape' && CropTool.overlay?.style.display !== 'none') CropTool.cancel();
        if (e.key === 'Enter' && CropTool.overlay?.style.display !== 'none') {
          e.preventDefault(); // prevent form submission
          CropTool.apply();
        }
      }
    });
  },

  initZoom() {
    let zoomThrottle = null;
    $('canvasArea')?.addEventListener('wheel', e => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (zoomThrottle) return; // throttle to prevent excessive zoom events
        zoomThrottle = setTimeout(() => { zoomThrottle = null; }, 80);
        e.deltaY < 0 ? Zoom.in() : Zoom.out();
      }
    }, { passive: false });
  },

  enableTools() {
    $$('[data-requires-image]').forEach(el => el.disabled = false);
  },

  disableTools() {
    $$('[data-requires-image]').forEach(el => el.disabled = true);
  }
};

// ============================================================
// GLOBAL HELPERS (called from HTML)
// ============================================================
function newFile() {
  State.originalImage = null;
  State.currentDataURL = null;
  State.activeScanFilter = 'original';
  State.aspectRatioLock = null;
  State.isAutoCropMode = true;
  ColorTools.baseSnap = null;
  History.stack = []; History.ptr = -1;
  History.render();
  $('uploadZone').style.display = 'flex';
  $('canvasContainer').style.display = 'none';
  $('fileInput').value = '';
  CropTool.clearOverlay();
  App.disableTools();
  Exporter.select('png');
  // Reset status badge
  const badge = $('statusBadge');
  if (badge) { setStatusBadge('جاهز'); }
  // Reset info panel
  $('infoWidth').textContent = '—';
  $('infoHeight').textContent = '—';
  $('infoSize').textContent = '—';
  $('infoType').textContent = '—';
  $('infoFileName').textContent = 'لم يتم تحميل صورة';
  $('cropDimDisplay').textContent = '— × — px';
  // Reset scan filter selection UI
  $$('.export-option[id^="filter-"]').forEach(el => el.classList.remove('selected'));
  $('filter-orig')?.classList.add('selected');
  // Reset ratio buttons
  $$('.tool-btn[id^="ratio-"]').forEach(btn => btn.classList.remove('active'));
  $('ratio-free')?.classList.add('active');
  // Re-enable auto-crop toggle
  const toggle = $('toggleCropMode');
  if (toggle) toggle.checked = true;
  $('autoCropSettings').style.display = 'flex';
  $('manualCropSettings').style.display = 'none';
  showToast('جاهز لتحميل وثيقة جديدة', 'info');
}

// Global functions for DocCropper
function toggleCropMode(checkbox) {
  const isAuto = checkbox.checked;
  State.isAutoCropMode = isAuto;
  if (isAuto) {
    $('autoCropSettings').style.display = 'flex';
    $('manualCropSettings').style.display = 'none';
    redetect();
  } else {
    $('autoCropSettings').style.display = 'none';
    $('manualCropSettings').style.display = 'block';
    setStatusBadge('وضع يدوي حر');
  }
}

function redetect() {
  if (State.isAutoCropMode) {
    AutoCrop.detectAndShow();
  }
}

function setAspectRatioLock(ratio, btnId) {
  State.aspectRatioLock = ratio;
  $$('.tool-btn').forEach(btn => {
    if (btn.id && btn.id.startsWith('ratio-')) {
      btn.classList.toggle('active', btn.id === btnId);
    }
  });
  if (CropTool.overlay && CropTool.overlay.style.display !== 'none') {
    if (ratio) {
      CropTool.applyAspectRatioLock(ratio);
    } else {
      CropTool.updateBox();
    }
  }
}

function applyDocCrop() {
  CropTool.apply();
}

function cancelDocCrop() {
  CropTool.cancel();
}

async function rotateImage(deg) {
  if (!State.currentDataURL) return;
  showLoading('تدوير المستند...');
  await delay(100);

  try {
    const canvas = CM.c;
    const ctx = CM.x;
    const w = canvas.width, h = canvas.height;

    const tmp = document.createElement('canvas');
    if (Math.abs(deg) === 90) {
      tmp.width = h;
      tmp.height = w;
    } else {
      tmp.width = w;
      tmp.height = h;
    }

    const tx = tmp.getContext('2d');
    tx.translate(tmp.width / 2, tmp.height / 2);
    tx.rotate((deg * Math.PI) / 180);
    tx.drawImage(canvas, -w / 2, -h / 2);

    canvas.width = tmp.width;
    canvas.height = tmp.height;
    ctx.drawImage(tmp, 0, 0);

    State.imageWidth = canvas.width;
    State.imageHeight = canvas.height;
    $('infoWidth').textContent = canvas.width + ' px';
    $('infoHeight').textContent = canvas.height + ' px';

    State.currentDataURL = CM.snapshot();
    ColorTools.baseSnap = CM.snapshot();
    History.push(deg > 0 ? 'تدوير 90° لليمين' : 'تدوير 90° لليسار', CM.snapshot());

    if (State.isAutoCropMode) {
      AutoCrop.detectAndShow();
    } else {
      CropTool.activate();
    }
    showToast('تم تدوير المستند ✓', 'success');
  } catch (e) {
    showToast('حدث خطأ أثناء التدوير', 'error');
    console.error(e);
  } finally {
    hideLoading();
  }
}

async function flipImage(dir) {
  if (!State.currentDataURL) return;
  showLoading('عكس الصورة...');
  await delay(100);

  try {
    const canvas = CM.c;
    const ctx = CM.x;
    const w = canvas.width, h = canvas.height;

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tx = tmp.getContext('2d');

    if (dir === 'h') {
      tx.translate(w, 0);
      tx.scale(-1, 1);
    } else {
      tx.translate(0, h);
      tx.scale(1, -1);
    }
    tx.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp, 0, 0);

    State.currentDataURL = CM.snapshot();
    ColorTools.baseSnap = CM.snapshot();
    History.push(dir === 'h' ? 'عكس أفقي' : 'عكس رأسي', CM.snapshot());

    if (State.isAutoCropMode) {
      AutoCrop.detectAndShow();
    } else {
      CropTool.activate();
    }
    showToast('تم عكس المستند ✓', 'success');
  } catch (e) {
    showToast('حدث خطأ أثناء المعالجة', 'error');
    console.error(e);
  } finally {
    hideLoading();
  }
}

function updateSharpnessUI(val) {
  $('val_sharpness').textContent = val;
  State.filters.sharpness = parseInt(val);
  ColorTools.scheduleApply();
}

function applySharpnessChange() {
  History.push('تعديل حدة النصوص', CM.snapshot());
}

async function applyScanFilter(name) {
  if (!State.currentDataURL) { showToast('ارفع وثيقة أولاً', 'warning'); return; }
  State.activeScanFilter = name;

  const filterIds = { original: 'filter-orig', enhance: 'filter-enhance', bw: 'filter-bw', gray: 'filter-gray' };
  Object.entries(filterIds).forEach(([k, id]) => {
    $(id)?.classList.toggle('selected', k === name);
  });

  showLoading('تطبيق الفلتر...');
  await delay(100);

  try {
    const base = ColorTools.baseSnap;
    if (!base) throw new Error('لا توجد صورة أساسية');
    await CM.restoreFrom(base);

    if (name !== 'original') {
      const canvas = CM.c;
      const ctx = CM.x;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      if (name === 'enhance') {
        enhanceDocScan(data);
      } else if (name === 'bw') {
        binaryThreshold(data);
      } else if (name === 'gray') {
        makeGrayscale(data);
      }

      ctx.putImageData(imageData, 0, 0);
      // Only apply color adjustments for non-original filters
      await ColorTools.applyAll();
    }

    State.currentDataURL = CM.snapshot();
    const filterLabel = name === 'enhance' ? 'تحسين المسح' : name === 'bw' ? 'أبيض وأسود' : name === 'gray' ? 'رمادي' : 'الأصل';
    History.push(`فلتر: ${filterLabel}`, CM.snapshot());
    showToast('تم تطبيق الفلتر بنجاح ✓', 'success');
  } catch (e) {
    showToast('حدث خطأ أثناء معالجة الصورة', 'error');
    console.error(e);
  } finally {
    hideLoading();
  }
}

function enhanceDocScan(data) {
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    const v = 0.299 * r + 0.587 * g + 0.114 * b;
    if (v > 175) {
      r = Math.min(255, r + (255 - v) * 0.85);
      g = Math.min(255, g + (255 - v) * 0.85);
      b = Math.min(255, b + (255 - v) * 0.85);
    } else {
      r = Math.max(0, r * 0.85);
      g = Math.max(0, g * 0.85);
      b = Math.max(0, b * 0.85);
    }
    r = ((r - 128) * 1.35) + 128;
    g = ((g - 128) * 1.35) + 128;
    b = ((b - 128) * 1.35) + 128;

    data[i] = Math.min(255, Math.max(0, r));
    data[i + 1] = Math.min(255, Math.max(0, g));
    data[i + 2] = Math.min(255, Math.max(0, b));
  }
}

function binaryThreshold(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const v = 0.299 * r + 0.587 * g + 0.114 * b;
    const val = v > 130 ? 255 : 0;
    data[i] = val;
    data[i + 1] = val;
    data[i + 2] = val;
  }
}

function makeGrayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const v = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

function printCurrentDocument() {
  if (!State.currentDataURL) { showToast('لا توجد وثيقة لطباعتها', 'warning'); return; }
  const imgUrl = CM.c.toDataURL('image/png');
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('يبدو أن المتصفح حجب النافذة المنبثقة. يرجى السماح بالنوافذ المنبثقة لهذا الموقع.', 'warning');
    return;
  }
  printWindow.document.write(`
    <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8" />
        <title>DocCropper - طباعة الوثيقة</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: #fff;
          }
          img {
            max-width: 100%;
            max-height: 100vh;
            object-fit: contain;
          }
          @page { size: auto; margin: 10mm; }
          @media print {
            body { background: white; }
            img { max-width: 100%; max-height: 100%; }
          }
        </style>
      </head>
      <body>
        <img src="${imgUrl}" onload="window.print();" onerror="document.body.innerHTML='<p>خطأ في تحميل الصورة</p>';" />
      </body>
    </html>
  `);
  printWindow.document.close();
}

function downloadCurrentDocument() {
  if (!State.currentDataURL) { showToast('ارفع وثيقة أولاً', 'warning'); return; }
  Exporter.download();
}

// ============================================================
// AI DEEP AUTO CROP — يدير دورة كاملة من خوارزميات CV
//   Gaussian Blur → Otsu/Adaptive → Canny → Morphological
//   → findContours → Convex Hull → RDP → Euclidean → Homography
// ============================================================
const DeepAutoCrop = {
  lastResult: null,    // آخر نتيجة كشف: { corners, pw, ph, scale }
  busy: false,         // منع التشغيل المتكرر

  /* — واجهة تحديث الشريط — */
  showProgress() {
    const w = $('cvProgressWrap');
    const a = $('cvActionBar');
    if (w) w.style.display = 'flex';
    if (a) a.style.display = 'none';
  },
  hideProgress() {
    const w = $('cvProgressWrap');
    if (w) w.style.display = 'none';
  },
  showActionBar() {
    const a = $('cvActionBar');
    if (a) a.style.display = 'flex';
  },
  setProgress(pct, msg) {
    const bar = $('cvProgressBar');
    const pctEl = $('cvProgressPct');
    const msgEl = $('cvProgressMsg');
    if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    if (msgEl) msgEl.textContent = msg || '';
  },

  /* — محاذاة overlay canvas فوق mainCanvas بالأبعاد المرئية — */
  syncOverlaySize() {
    const overlay = $('autoCropOverlay');
    const main = $('mainCanvas');
    if (!overlay || !main) return;
    const w = main.offsetWidth;
    const h = main.offsetHeight;
    overlay.width = w;
    overlay.height = h;
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
  },

  /* — رسم إطار الزوايا الأربع على overlay — */
  drawCorners(corners) {
    const overlay = $('autoCropOverlay');
    const main = $('mainCanvas');
    if (!overlay || !main || !corners) return;
    this.syncOverlaySize();
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const sx = overlay.width / main.width;
    const sy = overlay.height / main.height;
    const pts = corners.map(p => ({ x: p.x * sx, y: p.y * sy }));

    // ظل خارجي للمضلّع
    ctx.save();
    ctx.shadowColor = 'rgba(99,102,241,0.85)';
    ctx.shadowBlur = 18;
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // تعتيم الخلفية خارج المضلّع
    ctx.save();
    ctx.fillStyle = 'rgba(10,11,15,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, overlay.width, overlay.height);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    // رسم الزوايا بألوان مميّزة
    const labels = ['TL', 'TR', 'BR', 'BL'];
    const colors = ['#10b981', '#06b6d4', '#f59e0b', '#ec4899'];
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.fillStyle = colors[i];
      ctx.shadowColor = colors[i];
      ctx.shadowBlur = 14;
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors[i];
      ctx.font = 'bold 11px monospace';
      ctx.fillText(labels[i], p.x + 14, p.y + 4);
    });
  },

  clearOverlay() {
    const overlay = $('autoCropOverlay');
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  },

  /* — المنطق الأساسي: يبدأ دورة كاملة من الخوارزميات — */
  async run() {
    if (this.busy) return;
    if (!State.currentDataURL) {
      showToast('ارفع صورة أولاً', 'warning');
      return;
    }
    if (typeof AutoCropCV === 'undefined') {
      showToast('محرك الرؤية الحاسوبية غير محمّل', 'error');
      return;
    }

    this.busy = true;
    this.showProgress();
    this.setProgress(0, 'بدء المعالجة...');
    setStatusBadge('جارٍ التحليل بالذكاء الاصطناعي...', 'badge-processing');

    // سنعود للصورة الأساسية قبل كل تشغيل للحصول على نتيجة نقية
    const originalSrc = State.originalImage;
    try {
      if (originalSrc) {
        await CM.restoreFrom(originalSrc);
        State.currentDataURL = CM.snapshot();
      }

      // خوارزمية الكشف الكاملة:
      //   1) Grayscale
      //   2) Gaussian Blur
      //   3) Otsu + Adaptive Threshold → Canny Edge
      //   4) Morphological Dilate + Close
      //   5) findContours  (Suzuki-Abe مبسّط)
      //   6) Convex Hull
      //   7) approxPolyDP (Ramer-Douglas-Peucker) → 4 زوايا
      //   8) Euclidean Distance
      //   9) Homography / warpPerspective (يُستخدم في apply)
      const result = await AutoCropCV.detect(CM.c, (pct, msg) => {
        this.setProgress(pct, msg);
      });

      if (!result || !result.corners || result.corners.length !== 4) {
        this.hideProgress();
        setStatusBadge('تعذّر الكشف — أعد المحاولة', 'badge-error');
        showToast('لم يتم العثور على زوايا واضحة. جرّب صورة بإضاءة أفضل.', 'warning');
        this.busy = false;
        return;
      }

      this.lastResult = result;
      this.setProgress(100, 'تم الكشف بنجاح ✓');
      this.drawCorners(result.corners);
      setStatusBadge('تم الكشف — راجع الإطار البنفسجي', 'badge-ready');
      this.showActionBar();
      showToast('تم كشف زوايا الوثيقة. اضغط "تطبيق وتصحيح المنظور" للقص النهائي.', 'success');
    } catch (err) {
      console.error(err);
      this.hideProgress();
      setStatusBadge('فشل الكشف', 'badge-error');
      showToast('حدث خطأ أثناء المعالجة: ' + (err.message || err), 'error');
    } finally {
      this.busy = false;
    }
  },

  /* — تطبيق warpPerspective لقص وتصحيح المنظور — */
  async apply() {
    if (!this.lastResult) {
      showToast('لم يتم الكشف بعد — اضغط "ابدأ القص التلقائي" أولاً', 'warning');
      return;
    }

    showLoading('تطبيق تصحيح المنظور...');
    try {
      // التحقق من الزوايا قبل الإرسال
      const cs = this.lastResult.corners;
      if (!cs || cs.length !== 4) throw new Error('زوايا غير صالحة');
      
      // حساب أبعاد الصندوق المحيط (Bounding Box) كخطة بديلة (Fallback)
      const xs = cs.map(p => p.x), ys = cs.map(p => p.y);
      const minX = Math.max(0, Math.min(...xs));
      const maxX = Math.min(CM.c.width, Math.max(...xs));
      const minY = Math.max(0, Math.min(...ys));
      const maxY = Math.min(CM.c.height, Math.max(...ys));
      const cw = maxX - minX;
      const ch = maxY - minY;

      console.log('[AI Crop] corners =', cs, 'bbox =', { minX, minY, maxX, maxY });

      let success = false;
      let methodLabel = 'قص ذكي AI + تصحيح منظور';

      try {
        // المحاولة الأساسية: تصحيح المنظور (Warp Perspective)
        const ok = await AutoCropCV.applyWarp(CM.c, cs);
        if (ok) {
          success = true;
          console.log('[AI Crop] Perspective warp success:', ok);
        }
      } catch (warpErr) {
        console.warn('[AI Crop] Perspective warp failed, switching to Normal Crop fallback:', warpErr);
      }

      if (!success) {
        // خطة بديلة (Fallback): إجراء قص مستطيل عادي بناءً على إحداثيات YOLO المكتشفة
        console.log('[AI Crop] Executing fallback Normal Crop...');
        
        // التحقق من أن حجم الصندوق منطقي للقص
        if (cw < 10 || ch < 10) throw new Error('منطقة الكشف صغيرة جداً للمعالجة');
        
        AutoCrop.applyCrop({ x: minX, y: minY, w: cw, h: ch });
        methodLabel = 'قص تلقائي (تعديل المستطيل)';
      }

      // تحديث الحالة والقيم المرتبطة
      State.imageWidth = CM.c.width;
      State.imageHeight = CM.c.height;
      $('infoWidth').textContent = CM.c.width + ' px';
      $('infoHeight').textContent = CM.c.height + ' px';
      State.currentDataURL = CM.snapshot();
      ColorTools.baseSnap = CM.snapshot();
      History.push(methodLabel, CM.snapshot());

      // تنظيف الواجهة
      this.clearOverlay();
      this.hideProgress();
      this.lastResult = null;
      const ab = $('cvActionBar');
      if (ab) ab.style.display = 'none';

      // إعادة ضبط overlay القص اليدوي
      if (State.isAutoCropMode) {
        setTimeout(() => AutoCrop.detectAndShow(), 100);
      } else {
        CropTool.activate();
      }

      setStatusBadge('تم القص بنجاح ✓', 'badge-ready');
      showToast(`تم القص بنجاح: ${CM.c.width}×${CM.c.height} px`, 'success');
    } catch (err) {
      console.error(err);
      showToast('فشل تطبيق القص: ' + (err.message || err), 'error');
    } finally {
      hideLoading();
    }
  },

  /* — إلغاء والعودة للحالة الأصلية — */
  cancel() {
    this.clearOverlay();
    this.hideProgress();
    this.lastResult = null;
    const ab = $('cvActionBar');
    if (ab) ab.style.display = 'none';
    setStatusBadge('تم الإلغاء');
  }
};

// ربط الدوال بنطاق عام (لأن onclick في HTML يشير لها مباشرة)
function runDeepAutoCrop() { DeepAutoCrop.run(); }
function applyDeepCrop() { DeepAutoCrop.apply(); }
function cancelDeepCrop() { DeepAutoCrop.cancel(); }

// عند تغيير حجم النافذة: أعِد مزامنة overlay إن كان فيه زوايا مرسومة
window.addEventListener('resize', () => {
  if (DeepAutoCrop.lastResult) DeepAutoCrop.drawCorners(DeepAutoCrop.lastResult.corners);
});

// ============================================================
// AI (ONNX Runtime Web) - YOLOv8 integration
// ============================================================
// تم إضافة ?download=true لضمان الوصول المباشر للملف وتجنب قيود الحماية في بعض المتصفحات
const modelPath = 'https://huggingface.co/AreebSiddiqui/yolov8n-document-scanner/resolve/main/model.onnx?download=true';

const YOLOv8AI = {
  session: null,
  modelUrl: modelPath,

  inputSize: 640,
  inputNames: null,
  outputNames: null,
  ready: false,

  async ensureSession() {
    if (this.ready) return;
    if (!window.ort) throw new Error('ORT لم يتم تحميله');

    try {
      const wasmBaseUrl = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/';
      if (window.ort?.env) {
        window.ort.env.wasm = window.ort.env.wasm || {};
        window.ort.env.wasm.wasmPaths = wasmBaseUrl;
        window.ort.env.wasm.numThreads = 1;
      }
    } catch (e) {
      console.warn('Failed to configure ort.env.wasm:', e);
    }

    try {
      // إضافة إعدادات CORS وتجاوز الكاش لضمان التحميل من الرابط الجديد
      this.session = await window.ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ['wasm'],
      });
    } catch (e) {
      console.error('[YOLOv8AI] Model load error:', e);
      showToast('فشل تحميل موديل الذكاء الاصطناعي من الرابط الخارجي. تأكد من اتصال الإنترنت.', 'error');
      throw e;
    }

    this.inputNames = this.session.inputNames;
    this.outputNames = this.session.outputNames;
    this.ready = true;
  },

  // Preprocess: canvas -> float32 tensor [1,3,H,W] normalized to [0,1]
  preprocessForYOLO(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const srcW = canvas.width;
    const srcH = canvas.height;

    // Letterbox resize to inputSize while keeping aspect ratio
    const inputW = this.inputSize;
    const inputH = this.inputSize;
    const scale = Math.min(inputW / srcW, inputH / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = Math.floor((inputW - newW) / 2);
    const padY = Math.floor((inputH - newH) / 2);

    const tmp = document.createElement('canvas');
    tmp.width = inputW;
    tmp.height = inputH;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = 'black';
    tctx.fillRect(0, 0, inputW, inputH);
    tctx.drawImage(canvas, 0, 0, srcW, srcH, padX, padY, newW, newH);

    const imageData = tctx.getImageData(0, 0, inputW, inputH);
    const data = imageData.data;

    // Convert to CHW float32
    const chw = new Float32Array(1 * 3 * inputH * inputW);
    // normalize 0..1
    for (let y = 0; y < inputH; y++) {
      for (let x = 0; x < inputW; x++) {
        const i = (y * inputW + x) * 4;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const idxR = (0 * inputH * inputW) + y * inputW + x;
        const idxG = (1 * inputH * inputW) + y * inputW + x;
        const idxB = (2 * inputH * inputW) + y * inputW + x;
        chw[idxR] = r;
        chw[idxG] = g;
        chw[idxB] = b;
      }
    }

    return {
      tensor: new Float32Array(chw),
      tensorDims: [1, 3, inputH, inputW],
      letterbox: { scale, padX, padY, newW, newH, srcW, srcH, inputW, inputH }
    };
  },

  // IMPORTANT:
  // YOLOv8 output decoding differs per exported model.
  // We need correct output tensor interpretation.
  // For now, this function tries common formats:
  postprocessYOLOResults(outputs, letterbox, scoreThreshold = 0.3) {
    // استخراج الـ Tensor الأول
    const outTensor = Array.isArray(outputs) ? outputs[0] : (outputs[this.outputNames[0]] || outputs[Object.keys(outputs)[0]]);
    if (!outTensor || !outTensor.dims || !outTensor.data) throw new Error('مخرجات النموذج غير صالحة');

    const dims = Array.from(outTensor.dims);
    const data = outTensor.data;
    const numBoxes = dims[2]; // 8400
    const numElements = dims[1]; // 84

    const toOriginal = (x, y) => {
      return {
        x: (x - letterbox.padX) / letterbox.scale,
        y: (y - letterbox.padY) / letterbox.scale
      };
    };

    let bestBox = null;
    let maxScore = 0; // سنعتمد على أعلى نسبة ثقة لاختيار الإطار

    // مخرجات YOLOv8 تكون بصيغة [1, 84, 8400] (Column-major)
    // حيث أول 4 صفوف هي cx, cy, w, h والصفوف الباقية هي احتمالات الفئات
    for (let i = 0; i < numBoxes; i++) {
      // نفترض أن الفئة الأولى (index 4) هي "Document" في هذا الموديل المخصص
      const score = data[4 * numBoxes + i];
      
      if (score > scoreThreshold && score > maxScore) {
        maxScore = score;
        
        // استخراج الإحداثيات من الـ Column-major format
        const cx = data[0 * numBoxes + i];
        const cy = data[1 * numBoxes + i];
        const w = data[2 * numBoxes + i];
        const h = data[3 * numBoxes + i];

        // تحويل من (مركز، عرض، طول) إلى (أعلى-يسار، أسفل-يمين)
        const p1 = toOriginal(cx - w / 2, cy - h / 2);
        const p2 = toOriginal(cx + w / 2, cy + h / 2);

        // حساب الأبعاد النهائية مع المطابقة لأبعاد الصورة الأصلية
        const x = Math.max(0, p1.x);
        const y = Math.max(0, p1.y);
        const width = Math.min(letterbox.srcW - x, p2.x - p1.x);
        const height = Math.min(letterbox.srcH - y, p2.y - p1.y);

        bestBox = { x, y, width, height, score };
      }
    }

    if (bestBox) {
      console.log(`[YOLOv8AI] تم كشف المستند بنسبة ثقة: ${(bestBox.score * 100).toFixed(1)}%`);
      // تحويل الصندوق المحيط إلى 4 زوايا لدعم دالة apply/warp
      const corners = [
        { x: Math.round(bestBox.x), y: Math.round(bestBox.y) },
        { x: Math.round(bestBox.x + bestBox.width), y: Math.round(bestBox.y) },
        { x: Math.round(bestBox.x + bestBox.width), y: Math.round(bestBox.y + bestBox.height) },
        { x: Math.round(bestBox.x), y: Math.round(bestBox.y + bestBox.height) }
      ];
      return { corners, score: bestBox.score };
    }

    console.warn('[YOLOv8AI] لم يتم العثور على مستند بحد ثقة أعلى من:', scoreThreshold);
    return null;
  },

  async runDeepCropUsingYOLO() {
    await this.ensureSession();

    const prep = this.preprocessForYOLO(CM.c);

    const inputName = this.inputNames?.[0];
    if (!inputName) throw new Error('ماكو inputName للموديل');

    const tensor = new ort.Tensor('float32', prep.tensor, prep.tensorDims);

    const outputs = await this.session.run({ [inputName]: tensor });

    // Log outputs structure once for debugging
    try {
      console.log('[YOLOv8AI] outputs keys:', Object.keys(outputs || {}));
      const firstOut = Array.isArray(outputs) ? outputs[0] : outputs[this.outputNames?.[0]];
      console.log('[YOLOv8AI] first output dims:', firstOut?.dims, 'dataLen:', firstOut?.data?.length);
    } catch (_) {}

    // decode -> corners in original canvas coords
    const decoded = this.postprocessYOLOResults(outputs, prep.letterbox);

    if (!decoded?.corners || decoded.corners.length !== 4) {
      // Hard fail so caller fallback won't happen silently.
      throw new Error('YOLO لم ينتج corners صحيحة. راجع Console لفهم شكل output.');
    }

    // Clamp corners inside image bounds
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const corners = decoded.corners.map(p => ({
      x: clamp(p.x, 0, prep.letterbox.srcW - 1),
      y: clamp(p.y, 0, prep.letterbox.srcH - 1)
    }));

    return { corners };
  }

};

// Replace DeepAutoCrop.run to try YOLO first, then fallback to AutoCropCV
const _oldDeepRun = DeepAutoCrop.run.bind(DeepAutoCrop);
DeepAutoCrop.run = async function () {
  if (this.busy) return;
  if (!State.currentDataURL) {
    showToast('ارفع صورة أولاً', 'warning');
    return;
  }

  this.busy = true;
  this.showProgress();
  this.setProgress(0, 'بدء المعالجة...');
  setStatusBadge('جارٍ التحليل (YOLO) ...', 'badge-processing');

  const originalSrc = State.originalImage;
  try {
    if (originalSrc) {
      await CM.restoreFrom(originalSrc);
      State.currentDataURL = CM.snapshot();
    }

    // try YOLO first
    try {
      const yoloRes = await YOLOv8AI.runDeepCropUsingYOLO();
      if (yoloRes?.corners?.length === 4) {
        this.lastResult = { corners: yoloRes.corners };
        this.setProgress(80, 'تم الكشف بالذكاء الاصطناعي ✓');
        this.drawCorners(yoloRes.corners);
        setStatusBadge('تم الكشف — جارٍ تطبيق القص...', 'badge-processing'); // Update status
        showToast('تم الكشف عبر YOLO. جارٍ تطبيق القص وتصحيح المنظور تلقائياً.', 'info'); // Inform user
        await this.apply(); // Immediately apply the crop after successful YOLO detection
        return;
      }
    } catch (e) {
      console.warn('[YOLO fallback] ', e);
    }

    // fallback to CV engine
    await _oldDeepRun();
  } catch (err) {
    console.error(err);
    this.hideProgress();
    setStatusBadge('فشل الكشف', 'badge-error');
    showToast('حدث خطأ أثناء المعالجة: ' + (err.message || err), 'error');
  } finally {
    this.busy = false;
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
