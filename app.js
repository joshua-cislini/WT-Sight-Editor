/**
 * WT Reticle Studio Pro - Interactive Vector & Art Editor for War Thunder .blk Custom Sights
 */
(function () {
  'use strict';

  const MIL_TO_UNIT = 0.0025;
  const BASE_SCALE = 700;
  const MAX_HISTORY = 50;
  const WT_RECOMMENDED_LIMIT = 8000;
  const MOTION_COLORS = {
    static: '#e5e5e5',
    vertical: '#38bdf8',
    radial: '#f59e0b'
  };
  const LAYER_COLORS = {
    base: '#38bdf8',
    draw: '#34d399'
  };

  function syncThemeColorsFromCss() {
    if (typeof window === 'undefined' || !window.getComputedStyle) return;
    const cs = window.getComputedStyle(document.documentElement);
    const getVar = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    MOTION_COLORS.static = getVar('--motion-static-color', '#e5e5e5');
    MOTION_COLORS.vertical = getVar('--motion-vertical-color', '#38bdf8');
    MOTION_COLORS.radial = getVar('--motion-radial-color', '#f59e0b');
    LAYER_COLORS.base = getVar('--base-color', '#38bdf8');
    LAYER_COLORS.draw = getVar('--draw-color', '#34d399');
  }

  // =========================================================================
  // Application State
  // =========================================================================
  const state = {
    fileName: '3.blk',
    fileHandle: null,
    sightsDirHandle: null,
    sightsCatalog: {}, // { [name]: rawBlkString }
    lastPresetsStamp: window.WT_PRESETS_STAMP || 0,

    doc: BlkParser.createEmptyDoc(),
    previewMode: 'day', // 'day' | 'light' | 'thermal' | 'nvg' | 'blueprint' | 'motion'
    tool: 'select',
    spacePanning: false,

    cam: {
      x: 0,
      y: 0,
      scale: BASE_SCALE
    },

    layers: {
      base: { visible: true, locked: false },
      draw: { visible: true, locked: false }
    },

    options: {
      mirrorX: false,
      mirrorY: false,
      snapGrid: false,
      snapVertex: true,
      showGrid: true,
      showTicks: true,
      colorLayers: false,
      colorMotion: false,
      showHudOverlay: true,
      exportBase: true,
      overlayMode: 'append', // 'append' | 'replace'
      gridStep: 0.025,
      defaultMove: false,
      defaultThousandth: false,
      defaultMoveRadial: false,
      brushMode: 'lines', // 'lines' | 'quadRibbon' | 'closedFill'
      simplifyTol: 0.0012,
      brushWidth: 0.004,
      brushStabilizer: 0.35,
      brushTaper: false,
      splineMode: 'lines', // 'lines' | 'quadRibbon'
      splineSegs: 12,
      shapeMode: 'lines', // 'lines' | 'quads' | 'nativeCircle'
      circleSegs: 36,
      arcStart: 0,
      arcEnd: 360,
      stampType: 'chevron', // 'chevron' | 'star' | 'ngon' | 'cross'
      stampPoints: 5,
      stampInner: 0.45,
      eraserRadius: 16
    },

    refImage: {
      img: null,
      name: '',
      visible: true,
      editOnCanvas: false,
      opacity: 0.45,
      scale: 0.45,
      x: 0,
      y: 0,
      rotation: 0
    },

    traceCrop: {
      active: false,
      editing: false,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1
    },

    tracePreview: {
      lines: [],
      quads: [],
      maskCanvas: null,
      dirty: false,
      timer: null
    },
    lastTraceIds: new Set(),
    optimizerBaseline: null,
    selOptimizerBaseline: null,

    selection: new Set(),
    clipboard: [],
    history: [],
    historyIndex: -1,

    pointer: {
      screenX: 0,
      screenY: 0,
      worldX: 0,
      worldY: 0,
      snappedX: 0,
      snappedY: 0,
      snapHit: false,
      inside: false
    },
    drag: null,
    polyPoints: [],
    pendingLineStart: null,
    editingTextTarget: null,

    radialTarget: 'main',
    rangePreview: {
      active: false,
      playing: false,
      distance: 0,
      maxDistance: 3200,
      speed: 935,
      dragK: 0.00011,
      zoomMult: 1.0,
      shellKey: 'auto',
      showGuides: true,
      playDir: 1,
      pauseUntil: 0,
      lastTs: 0
    },
    hudEditor: {
      editOnCanvas: false,
      selectedWidget: 'rangefinder',
      colorMode: 'day',
      snapGuides: [],
      widgetScreenBoxes: {}
    },
    hudBackdrop: {
      key: '',
      customName: '',
      customText: '',
      doc: null,
      source: 'builtin'
    },
    hudSim: {
      active: false,
      startTs: 0,
      rfDuration: 2.2,
      reloadDuration: 5.0
    }
  };

  // =========================================================================
  // DOM References
  // =========================================================================
  const $ = (id) => document.getElementById(id);
  const canvas = $('reticleCanvas');
  const ctx = canvas.getContext('2d');
  const stage = $('canvasStage');

  let canvasW = 800;
  let canvasH = 600;
  let dpr = window.devicePixelRatio || 1;
  let needsRender = true;

  // =========================================================================
  // Utility & Coordinate Math
  // =========================================================================
  function worldToScreen(wx, wy) {
    return {
      x: canvasW / 2 + (wx - state.cam.x) * state.cam.scale,
      y: canvasH / 2 + (wy - state.cam.y) * state.cam.scale
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - canvasW / 2) / state.cam.scale + state.cam.x,
      y: (sy - canvasH / 2) / state.cam.scale + state.cam.y
    };
  }

  function getMilUnitScale() {
    const mode = state.doc?.header?.thousandthMode || 'ussr';
    if (mode === 'nato') return MIL_TO_UNIT * (6000 / 6400);
    if (mode === 'real') return MIL_TO_UNIT * (6000 / 6283.1853);
    return MIL_TO_UNIT;
  }

  function getActiveMilUnitScale() {
    const base = getMilUnitScale();
    const zoom = state.rangePreview.active ? (state.rangePreview.zoomMult || 1) : 1;
    return base * zoom;
  }

  function inferDragK(bulletType, speed) {
    const bt = String(bulletType || '').toLowerCase();
    if (bt.includes('apds_fs') || bt.includes('apfsds') || speed > 1300) return 0.000045;
    if (bt.includes('he_') || bt.includes('heat') || bt.includes('smoke') || speed < 780) return 0.00016;
    return 0.00011;
  }

  function computeBallisticDropMrad(distMeters, speedMps, dragK = 0.00011) {
    if (!Number.isFinite(distMeters) || distMeters <= 0 || !Number.isFinite(speedMps) || speedMps <= 10) return 0;
    const g = 9.81;
    if (!dragK || dragK < 1e-7) {
      return (1000 * g * distMeters) / (2 * speedMps * speedMps);
    }
    const ekd = Math.exp(dragK * distMeters) - 1;
    const t = ekd / (dragK * speedMps);
    const dropMeters = 0.5 * g * t * t;
    return (1000 * dropMeters) / distMeters;
  }

  function getPreviewDropMrad() {
    if (!state.rangePreview.active || state.rangePreview.distance <= 0) return 0;
    return computeBallisticDropMrad(
      state.rangePreview.distance,
      state.rangePreview.speed || 935,
      state.rangePreview.dragK
    );
  }

  function getPreviewDropCanvas() {
    const dropMrad = getPreviewDropMrad();
    return dropMrad === 0 ? 0 : dropMrad * getActiveMilUnitScale();
  }

  function toCanvasUnit(val, isThousandth, milScale = getActiveMilUnitScale()) {
    return isThousandth ? val * milScale : val;
  }

  function fromCanvasUnit(val, isThousandth, milScale = getActiveMilUnitScale()) {
    return isThousandth ? val / milScale : val;
  }

  function rotatePointCCW(px, py, cx, cy, rad) {
    if (!rad) return { x: px, y: py };
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    return {
      x: cx + dx * cos + dy * sin,
      y: cy - dx * sin + dy * cos
    };
  }

  function getElementBaseRefCanvas(kind, item, milScale) {
    const th = !!item.thousandth;
    if (kind === 'line') {
      return {
        x: toCanvasUnit((item.x1 + item.x2) * 0.5, th, milScale),
        y: toCanvasUnit((item.y1 + item.y2) * 0.5, th, milScale)
      };
    }
    if (kind === 'quad') {
      return {
        x: toCanvasUnit((item.tl.x + item.tr.x + item.br.x + item.bl.x) * 0.25, th, milScale),
        y: toCanvasUnit((item.tl.y + item.tr.y + item.br.y + item.bl.y) * 0.25, th, milScale)
      };
    }
    return {
      x: toCanvasUnit(item.x || 0, th, milScale),
      y: toCanvasUnit(item.y || 0, th, milScale)
    };
  }

  function getElementRadialTransform(kind, item, milScale = getActiveMilUnitScale(), dropCanvas = 0) {
    const th = !!item.thousandth;
    const hasAngle = Number.isFinite(item.radialAngle) && Math.abs(item.radialAngle) > 1e-6;
    const hasDynRadial = !!(item.moveRadial && dropCanvas !== 0);

    let shiftY = 0;
    if (!item.moveRadial && item.move && dropCanvas !== 0) {
      shiftY = state.doc?.header?.applyCorrectionToGun === false ? dropCanvas : -dropCanvas;
    }

    if (!hasAngle && !hasDynRadial) {
      return { totalRad: 0, rcx: 0, rcy: 0, shiftY };
    }

    const rc = Array.isArray(item.radialCenter) && item.radialCenter.length >= 2 ? item.radialCenter : [0, 0];
    const rcx = toCanvasUnit(rc[0], th, milScale);
    const rcy = toCanvasUnit(rc[1], th, milScale);
    let totalRad = hasAngle ? (item.radialAngle * Math.PI) / 180 : 0;

    if (hasDynRadial) {
      const ref = getElementBaseRefCanvas(kind, item, milScale);
      const rCanvas = Math.max(0.01, Math.hypot(ref.x - rcx, ref.y - rcy));
      const speed = Number.isFinite(item.radialMoveSpeed) ? item.radialMoveSpeed : 1;
      totalRad += (speed * dropCanvas) / rCanvas;
    }

    return { totalRad, rcx, rcy, shiftY };
  }

  function formatCoord(n) {
    return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
  }

  function showToast(msg, type = 'success') {
    const container = $('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3400);
  }

  function showTaskProgress(title, detail = '', pct = null) {
    const overlay = $('taskProgressOverlay');
    if (!overlay) return;
    $('taskProgressTitle').textContent = title || 'Processing...';
    updateTaskProgress(detail, pct);
    overlay.hidden = false;
  }

  function updateTaskProgress(detail = '', pct = null) {
    const detailEl = $('taskProgressDetail');
    const barEl = $('taskProgressBar');
    const pctEl = $('taskProgressPct');
    if (detailEl) detailEl.textContent = detail || '';
    if (!barEl || !pctEl) return;
    if (pct === null || pct === undefined || !Number.isFinite(pct)) {
      barEl.classList.add('indeterminate');
      pctEl.textContent = '...';
    } else {
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      barEl.classList.remove('indeterminate');
      barEl.style.width = `${clamped}%`;
      pctEl.textContent = `${clamped}%`;
    }
  }

  function hideTaskProgress() {
    const overlay = $('taskProgressOverlay');
    if (overlay) overlay.hidden = true;
  }

  function nextPaintFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  function requestRender() {
    needsRender = true;
  }

  // =========================================================================
  // Shape Helpers & Iteration
  // =========================================================================
  function allShapes() {
    const d = state.doc;
    const out = [];
    for (const s of d.quads) out.push({ kind: 'quad', item: s });
    for (const s of d.lines) out.push({ kind: 'line', item: s });
    for (const s of d.circles) out.push({ kind: 'circle', item: s });
    for (const s of d.texts) out.push({ kind: 'text', item: s });
    return out;
  }

  function isLayerVisible(layer) {
    return state.layers[layer]?.visible !== false;
  }

  function isLayerLocked(layer) {
    return state.layers[layer]?.locked === true;
  }

  function getShapePointsCanvas(kind, item, usePreview = true) {
    const milScale = getActiveMilUnitScale();
    const dropCanvas = usePreview ? getPreviewDropCanvas() : 0;
    const th = !!item.thousandth;
    const xf = getElementRadialTransform(kind, item, milScale, dropCanvas);
    const xform = (wx, wy) => {
      const p = xf.totalRad ? rotatePointCCW(wx, wy, xf.rcx, xf.rcy, xf.totalRad) : { x: wx, y: wy };
      if (xf.shiftY) p.y += xf.shiftY;
      return p;
    };

    if (kind === 'line') {
      return [
        xform(toCanvasUnit(item.x1, th, milScale), toCanvasUnit(item.y1, th, milScale)),
        xform(toCanvasUnit(item.x2, th, milScale), toCanvasUnit(item.y2, th, milScale))
      ];
    }
    if (kind === 'quad') {
      return [
        xform(toCanvasUnit(item.tl.x, th, milScale), toCanvasUnit(item.tl.y, th, milScale)),
        xform(toCanvasUnit(item.tr.x, th, milScale), toCanvasUnit(item.tr.y, th, milScale)),
        xform(toCanvasUnit(item.br.x, th, milScale), toCanvasUnit(item.br.y, th, milScale)),
        xform(toCanvasUnit(item.bl.x, th, milScale), toCanvasUnit(item.bl.y, th, milScale))
      ];
    }
    if (kind === 'circle') {
      const c = xform(toCanvasUnit(item.x, th, milScale), toCanvasUnit(item.y, th, milScale));
      const r = toCanvasUnit(item.diameter / 2, th, milScale);
      return [
        { x: c.x - r, y: c.y - r },
        { x: c.x + r, y: c.y + r },
        { x: c.x, y: c.y }
      ];
    }
    if (kind === 'text') {
      return [xform(toCanvasUnit(item.x, th, milScale), toCanvasUnit(item.y, th, milScale))];
    }
    return [];
  }

  function getShapeBoundsCanvas(kind, item) {
    if (kind === 'text') {
      const pts = getShapePointsCanvas('text', item);
      const x = pts[0].x;
      const y = pts[0].y;
      const halfW = Math.max(0.015, ((item.text || '').length || 1) * 0.008 * (item.size || 1));
      const halfH = Math.max(0.012, 0.012 * (item.size || 1));
      return { minX: x - halfW, minY: y - halfH, maxX: x + halfW, maxY: y + halfH };
    }
    const pts = getShapePointsCanvas(kind, item);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function getEntriesBoundsCanvas(entries) {
    if (!entries || entries.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { kind, item } of entries) {
      const b = getShapeBoundsCanvas(kind, item);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function getSelectionBoundsCanvas() {
    if (state.selection.size === 0) return null;
    return getEntriesBoundsCanvas(getSelectedEntries());
  }

  function getSelectedEntries() {
    return allShapes().filter(({ item }) => state.selection.has(item.id));
  }

  // =========================================================================
  // History (Undo / Redo)
  // =========================================================================
  function cloneItemArrayProps(item) {
    const out = { ...item };
    if (Array.isArray(item.radialCenter)) out.radialCenter = [...item.radialCenter];
    if (Array.isArray(item.radialRadius)) out.radialRadius = [...item.radialRadius];
    if (Array.isArray(item.centerPos)) out.centerPos = [...item.centerPos];
    return out;
  }

  function cloneBulletItem(b) {
    return {
      ...b,
      radialRadius: [...(b.radialRadius || [70, 1])],
      distancePos: [...(b.distancePos || [0, 0])],
      crosshairDistHorSizeMain: [...(b.crosshairDistHorSizeMain || [0.001, 0.001])],
      crosshairDistHorSizeAdditional: [...(b.crosshairDistHorSizeAdditional || [0.005, 0.003])],
      textPos: [...(b.textPos || [0.015, 0])],
      distanceCorrectionPos: [...(b.distanceCorrectionPos || [-0.2, -0.05])],
      distances: (b.distances || []).map((d) => ({ ...d }))
    };
  }

  function cloneHudWidget(w) {
    if (!w) return null;
    const out = { ...w };
    if (Array.isArray(w.position)) out.position = [...w.position];
    for (const k of ['textColor', 'bgColor', 'nightVisionTextColor', 'nightVisionBgColor', 'lightTextColor', 'lightBgColor', 'thermalTextColor', 'thermalBgColor', 'progressColor', 'progressBackgroundColor', 'color', 'lightColor', 'nvColor', 'thermalColor']) {
      if (w[k] && typeof w[k] === 'object') out[k] = { ...w[k] };
    }
    return out;
  }

  function cloneHudWidgetsMap(hw) {
    const base = BlkParser.createDefaultHudWidgets();
    const out = {};
    for (const key of BlkParser.HUD_WIDGET_ORDER) {
      out[key] = cloneHudWidget((hw && hw[key]) ? hw[key] : base[key]);
    }
    return out;
  }

  function cloneDocDrawState(doc) {
    const h = doc.header || {};
    return {
      docType: doc.docType || 'sight',
      lines: doc.lines.map((l) => cloneItemArrayProps(l)),
      quads: doc.quads.map((q) => ({
        ...cloneItemArrayProps(q),
        tl: { ...q.tl },
        tr: { ...q.tr },
        br: { ...q.br },
        bl: { ...q.bl }
      })),
      circles: doc.circles.map((c) => cloneItemArrayProps(c)),
      texts: doc.texts.map((t) => cloneItemArrayProps(t)),
      distances: (doc.distances || []).map((d) => ({ ...d })),
      ballistics: (doc.ballistics || []).map(cloneBulletItem),
      hudWidgets: cloneHudWidgetsMap(doc.hudWidgets),
      header: {
        ...h,
        crosshairColor: { ...h.crosshairColor },
        crosshairLightColor: { ...h.crosshairLightColor },
        crosshairNvColor: { ...(h.crosshairNvColor || { r: 110, g: 255, b: 145, a: 255 }) },
        crosshairThermalColor: { ...(h.crosshairThermalColor || { r: 242, g: 248, b: 255, a: 255 }) },
        reticle: { ...(h.reticle || { included: false, overridden: false, lineWidth: 0, fontSize: 0.7 }) },
        crosshairHorVertSize: [...(h.crosshairHorVertSize || [3, 2])],
        crosshairDistHorSizeMain: [...(h.crosshairDistHorSizeMain || [0.03, 0.02])],
        crosshairDistHorSizeAdditional: [...(h.crosshairDistHorSizeAdditional || [0.005, 0.003])],
        distanceCorrectionPos: [...(h.distanceCorrectionPos || [-0.26, -0.05])],
        radialRadius: [...(h.radialRadius || [70, 1])],
        distancePos: [...(h.distancePos || [0, 0])],
        textPos: [...(h.textPos || [0.015, 0])],
        matchExpClass: { ...(h.matchExpClass || { exp_tank: true, exp_heavy_tank: true, exp_tank_destroyer: true, exp_SPAA: true }) }
      },
      modifiedHeaderKeys: new Set(doc.modifiedHeaderKeys || [])
    };
  }

  function pushHistory() {
    const snap = cloneDocDrawState(state.doc);
    if (state.historyIndex < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyIndex + 1);
    }
    state.history.push(snap);
    if (state.history.length > MAX_HISTORY) {
      state.history.shift();
    } else {
      state.historyIndex++;
    }
    updateUndoRedoUI();
    updateStatsUI();
  }

  function resetHistory() {
    state.history = [cloneDocDrawState(state.doc)];
    state.historyIndex = 0;
    state.optimizerBaseline = null;
    state.selOptimizerBaseline = null;
    if ($('btnUndoOptimize')) $('btnUndoOptimize').disabled = true;
    if ($('btnUndoSelOptimize')) $('btnUndoSelOptimize').disabled = true;
    if ($('btnUndoTrace')) $('btnUndoTrace').disabled = state.lastTraceIds.size === 0;
    updateUndoRedoUI();
    updateStatsUI();
  }

  function restoreSnapshot(snap) {
    const cloned = cloneDocDrawState(snap);
    state.doc.docType = cloned.docType || 'sight';
    state.doc.lines = cloned.lines;
    state.doc.quads = cloned.quads;
    state.doc.circles = cloned.circles;
    state.doc.texts = cloned.texts;
    state.doc.distances = cloned.distances;
    state.doc.ballistics = cloned.ballistics;
    state.doc.hudWidgets = cloned.hudWidgets;
    state.doc.header = cloned.header;
    state.doc.modifiedHeaderKeys = cloned.modifiedHeaderKeys;
    const validIds = new Set(allShapes().map((s) => s.item.id));
    for (const id of Array.from(state.selection)) {
      if (!validIds.has(id)) state.selection.delete(id);
    }
    syncHeaderUIFromDoc();
    syncRadialPanelUIFromDoc();
    if (typeof syncHudPresetUIFromDoc === 'function') syncHudPresetUIFromDoc();
    if (typeof refreshHudBackdropDoc === 'function') refreshHudBackdropDoc();
    syncPreviewShellOptions();
    updateSelectionUI();
    updateStatsUI();
    requestRender();
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    restoreSnapshot(state.history[state.historyIndex]);
    updateUndoRedoUI();
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    restoreSnapshot(state.history[state.historyIndex]);
    updateUndoRedoUI();
  }

  function updateUndoRedoUI() {
    $('btnUndo').disabled = state.historyIndex <= 0;
    $('btnRedo').disabled = state.historyIndex >= state.history.length - 1;
  }

  // =========================================================================
  // Snapping & Geometry Algorithms
  // =========================================================================
  function snapWorldPoint(wx, wy, ignoreSnap = false) {
    if (ignoreSnap) return { x: wx, y: wy, hit: false };

    const shouldSnapVertex =
      state.options.snapVertex &&
      state.tool !== 'freehand' &&
      state.tool !== 'eraser' &&
      state.tool !== 'pan' &&
      (state.tool !== 'select' || (state.drag && state.drag.type === 'vertex'));

    if (shouldSnapVertex) {
      const thresholdWorld = 10 / state.cam.scale;
      let bestDist = thresholdWorld;
      let bestPt = null;

      const originDist = Math.hypot(wx, wy);
      if (originDist < bestDist) {
        bestDist = originDist;
        bestPt = { x: 0, y: 0 };
      }

      const excludeId = state.drag && state.drag.type === 'vertex' ? state.drag.item.id : null;
      const shapes = allShapes();
      // Only scan vertex snap if shape count is reasonable or zoomed in
      if (shapes.length <= 12000) {
        for (let i = 0; i < shapes.length; i++) {
          const { kind, item } = shapes[i];
          if (!isLayerVisible(item.layer)) continue;
          if (excludeId && item.id === excludeId) continue;
          const th = !!item.thousandth;
          if (kind === 'line') {
            const x1 = toCanvasUnit(item.x1, th), y1 = toCanvasUnit(item.y1, th);
            const d1 = Math.hypot(x1 - wx, y1 - wy);
            if (d1 < bestDist) { bestDist = d1; bestPt = { x: x1, y: y1 }; }
            const x2 = toCanvasUnit(item.x2, th), y2 = toCanvasUnit(item.y2, th);
            const d2 = Math.hypot(x2 - wx, y2 - wy);
            if (d2 < bestDist) { bestDist = d2; bestPt = { x: x2, y: y2 }; }
          } else if (kind === 'quad') {
            const pts = getShapePointsCanvas('quad', item);
            for (const p of pts) {
              const d = Math.hypot(p.x - wx, p.y - wy);
              if (d < bestDist) { bestDist = d; bestPt = p; }
            }
          }
        }
      }
      if (bestPt) {
        return { x: bestPt.x, y: bestPt.y, hit: true };
      }
    }

    if (state.options.snapGrid) {
      const step = Math.max(0.0005, state.options.gridStep || 0.025);
      return {
        x: Math.round(wx / step) * step,
        y: Math.round(wy / step) * step,
        hit: true
      };
    }

    return { x: wx, y: wy, hit: false };
  }

  function snapAngle(x1, y1, x2, y2, stepDeg = 15) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return { x: x2, y: y2 };
    const angle = Math.atan2(dy, dx);
    const stepRad = (stepDeg * Math.PI) / 180;
    const snapped = Math.round(angle / stepRad) * stepRad;
    return {
      x: x1 + Math.cos(snapped) * len,
      y: y1 + Math.sin(snapped) * len
    };
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function pointInPolygon(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function rdpSimplify(points, epsilon) {
    if (points.length <= 2) return points.slice();
    let maxDist = 0;
    let idx = 0;
    const start = points[0];
    const end = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = distToSegment(points[i].x, points[i].y, start.x, start.y, end.x, end.y);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > epsilon) {
      const left = rdpSimplify(points.slice(0, idx + 1), epsilon);
      const right = rdpSimplify(points.slice(idx), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  }

  /**
   * Catmull-Rom Spline interpolation through control points (open or closed loop).
   */
  function evaluateCatmullRomSpline(ctrlPts, segsPerSpan = 12, closed = false) {
    const clean = [];
    for (const p of ctrlPts) {
      if (!clean.length || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 1e-7) {
        clean.push(p);
      }
    }
    if (clean.length < 2) return clean;
    if (clean.length === 2) return closed ? [clean[0], clean[1], clean[0]] : clean.slice();
    const out = [];
    const n = clean.length;
    const spanCount = closed ? n : n - 1;

    for (let i = 0; i < spanCount; i++) {
      const p0 = closed ? clean[(i - 1 + n) % n] : clean[Math.max(0, i - 1)];
      const p1 = clean[i];
      const p2 = closed ? clean[(i + 1) % n] : clean[i + 1];
      const p3 = closed ? clean[(i + 2) % n] : clean[Math.min(n - 1, i + 2)];

      for (let s = 0; s < segsPerSpan; s++) {
        const t = s / segsPerSpan;
        const t2 = t * t;
        const t3 = t2 * t;
        const x =
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
        const y =
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
        out.push({ x, y });
      }
    }
    out.push(closed ? { x: clean[0].x, y: clean[0].y } : { x: clean[n - 1].x, y: clean[n - 1].y });
    return out;
  }

  function polySignedArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area * 0.5;
  }

  function triangulatePolygon(pts) {
    if (pts.length < 3) return [];
    if (pts.length === 3) return [[pts[0], pts[1], pts[2]]];

    const poly = [];
    for (const p of pts) {
      if (!poly.length || Math.hypot(p.x - poly[poly.length - 1].x, p.y - poly[poly.length - 1].y) > 1e-8) {
        poly.push({ x: p.x, y: p.y });
      }
    }
    if (poly.length > 3 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y) <= 1e-8) {
      poly.pop();
    }
    if (poly.length < 3) return [];
    if (poly.length === 3) return [[poly[0], poly[1], poly[2]]];

    if (polySignedArea(poly) < 0) poly.reverse();

    function cross(a, b, c) {
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }

    function ptInTri(p, a, b, c) {
      const c1 = cross(a, b, p);
      const c2 = cross(b, c, p);
      const c3 = cross(c, a, p);
      return c1 >= -1e-9 && c2 >= -1e-9 && c3 >= -1e-9;
    }

    const tris = [];
    let guard = 0;
    const maxGuard = Math.max(800, poly.length * 4);
    while (poly.length > 3 && guard++ < maxGuard) {
      let earFound = false;
      for (let i = 0; i < poly.length; i++) {
        const prev = poly[(i - 1 + poly.length) % poly.length];
        const curr = poly[i];
        const next = poly[(i + 1) % poly.length];
        if (cross(prev, curr, next) <= 1e-10) continue;

        let containsOther = false;
        for (let j = 0; j < poly.length; j++) {
          if (j === i || j === (i - 1 + poly.length) % poly.length || j === (i + 1) % poly.length) continue;
          if (ptInTri(poly[j], prev, curr, next)) {
            containsOther = true;
            break;
          }
        }
        if (!containsOther) {
          tris.push([prev, curr, next]);
          poly.splice(i, 1);
          earFound = true;
          break;
        }
      }
      if (!earFound) {
        // Fallback for self-touching or near-degenerate polygons so remaining triangles are never dropped
        let bestIdx = 0;
        let bestCross = -Infinity;
        for (let i = 0; i < poly.length; i++) {
          const prev = poly[(i - 1 + poly.length) % poly.length];
          const curr = poly[i];
          const next = poly[(i + 1) % poly.length];
          const c = cross(prev, curr, next);
          if (c > bestCross) {
            bestCross = c;
            bestIdx = i;
          }
        }
        const prev = poly[(bestIdx - 1 + poly.length) % poly.length];
        const curr = poly[bestIdx];
        const next = poly[(bestIdx + 1) % poly.length];
        if (Math.abs(bestCross) > 1e-14) {
          tris.push([prev, curr, next]);
        }
        poly.splice(bestIdx, 1);
      }
    }
    if (poly.length === 3) {
      tris.push([poly[0], poly[1], poly[2]]);
    }
    return tris;
  }

  /**
   * Splice CW hole loops into a CCW outer loop using mutually-visible bridge edges.
   */
  function bridgeHolesIntoOuter(outerPts, holeLists) {
    if (!outerPts || outerPts.length < 3) return [];
    let outer = outerPts.map((p) => ({ x: p.x, y: p.y }));
    if (polySignedArea(outer) < 0) outer.reverse();
    if (!holeLists || !holeLists.length) return outer;

    const preparedHoles = holeLists
      .filter((h) => h && h.length >= 3)
      .map((h) => {
        const copy = h.map((p) => ({ x: p.x, y: p.y }));
        if (polySignedArea(copy) > 0) copy.reverse(); // CW hole inside CCW outer
        let maxIdx = 0;
        for (let i = 1; i < copy.length; i++) {
          if (copy[i].x > copy[maxIdx].x) maxIdx = i;
        }
        return { pts: copy, maxIdx, maxX: copy[maxIdx].x };
      })
      .sort((a, b) => b.maxX - a.maxX);

    function ptInTriSigned(p, a, b, c) {
      const c1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const c2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
      const c3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
      return (c1 >= -1e-9 && c2 >= -1e-9 && c3 >= -1e-9) || (c1 <= 1e-9 && c2 <= 1e-9 && c3 <= 1e-9);
    }

    for (const h of preparedHoles) {
      const M = h.pts[h.maxIdx];
      let bestIx = Infinity;
      let bestA = -1;
      let bestB = -1;
      const n = outer.length;

      for (let i = 0; i < n; i++) {
        const a = outer[i];
        const b = outer[(i + 1) % n];
        if ((a.y <= M.y && b.y > M.y) || (b.y <= M.y && a.y > M.y)) {
          const t = (M.y - a.y) / (b.y - a.y);
          const ix = a.x + t * (b.x - a.x);
          if (ix >= M.x - 1e-7 && ix < bestIx) {
            bestIx = ix;
            bestA = i;
            bestB = (i + 1) % n;
          }
        }
      }

      if (bestA < 0) continue;

      let pIdx = outer[bestA].x >= outer[bestB].x ? bestA : bestB;
      const I = { x: bestIx, y: M.y };
      const P = outer[pIdx];
      let bestReflex = -1;
      let bestDot = -Infinity;

      for (let i = 0; i < n; i++) {
        const R = outer[i];
        if (R.x < M.x - 1e-7) continue;
        if (i === bestA || i === bestB) continue;
        const prev = outer[(i - 1 + n) % n];
        const next = outer[(i + 1) % n];
        const turn = (R.x - prev.x) * (next.y - R.y) - (R.y - prev.y) * (next.x - R.x);
        if (turn > 1e-9) continue; // only check reflex vertices inside triangle (M, I, P)
        if (!ptInTriSigned(R, M, I, P)) continue;
        const dx = R.x - M.x, dy = R.y - M.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-8) continue;
        const cosA = dx / dist;
        if (cosA > bestDot + 1e-7) {
          bestDot = cosA;
          bestReflex = i;
        }
      }
      if (bestReflex >= 0) pIdx = bestReflex;

      const rotHole = [];
      for (let k = 0; k < h.pts.length; k++) {
        rotHole.push({ x: h.pts[(h.maxIdx + k) % h.pts.length].x, y: h.pts[(h.maxIdx + k) % h.pts.length].y });
      }
      rotHole.push({ x: M.x, y: M.y });
      rotHole.push({ x: outer[pIdx].x, y: outer[pIdx].y });

      outer.splice(pIdx + 1, 0, ...rotHole);
    }

    return outer;
  }

  /**
   * Ear-clip triangulate a polygon and greedily merge adjacent triangle pairs into strictly convex quads.
   * Returns 4-point quad tuples [v0, v1, v2, v3] (triangles become [a, b, c, c]).
   */
  function triangulatePolygonToQuads(pts) {
    const tris = triangulatePolygon(pts);
    if (!tris.length) return [];

    // Quantize vertices to reliably match shared triangle edges after bridge splicing
    const ptMap = new Map();
    const verts = [];
    function vId(p) {
      const key = `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
      let id = ptMap.get(key);
      if (id === undefined) {
        id = verts.length;
        verts.push({ x: p.x, y: p.y });
        ptMap.set(key, id);
      }
      return id;
    }

    const triIds = tris.map((t) => [vId(t[0]), vId(t[1]), vId(t[2])]);
    const edgeToTris = new Map();
    for (let ti = 0; ti < triIds.length; ti++) {
      const t = triIds[ti];
      for (let e = 0; e < 3; e++) {
        const u = t[e];
        const v = t[(e + 1) % 3];
        if (u === v) continue;
        const eKey = u < v ? `${u}_${v}` : `${v}_${u}`;
        let list = edgeToTris.get(eKey);
        if (!list) {
          list = [];
          edgeToTris.set(eKey, list);
        }
        list.push({ ti, u, v, opp: t[(e + 2) % 3] });
      }
    }

    function isConvexQuadIds(q0, q1, q2, q3) {
      const ps = [verts[q0], verts[q1], verts[q2], verts[q3]];
      let pos = 0, neg = 0;
      for (let i = 0; i < 4; i++) {
        const a = ps[i], b = ps[(i + 1) % 4], c = ps[(i + 2) % 4];
        const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (cr > 1e-10) pos++;
        else if (cr < -1e-10) neg++;
        else return false;
      }
      return pos === 4 || neg === 4;
    }

    const merged = new Uint8Array(triIds.length);
    const outQuads = [];

    for (const pair of edgeToTris.values()) {
      if (pair.length !== 2) continue;
      const e1 = pair[0], e2 = pair[1];
      if (merged[e1.ti] || merged[e2.ti]) continue;
      if (e1.opp === e2.opp) continue;
      // Order around shared diagonal (e1.u, e1.v): [e1.u, e2.opp, e1.v, e1.opp] or [e1.u, e1.opp, e1.v, e2.opp]
      if (isConvexQuadIds(e1.u, e2.opp, e1.v, e1.opp)) {
        outQuads.push([verts[e1.u], verts[e2.opp], verts[e1.v], verts[e1.opp]]);
        merged[e1.ti] = 1;
        merged[e2.ti] = 1;
      } else if (isConvexQuadIds(e1.u, e1.opp, e1.v, e2.opp)) {
        outQuads.push([verts[e1.u], verts[e1.opp], verts[e1.v], verts[e2.opp]]);
        merged[e1.ti] = 1;
        merged[e2.ti] = 1;
      }
    }

    for (let ti = 0; ti < triIds.length; ti++) {
      if (!merged[ti]) {
        const t = triIds[ti];
        outQuads.push([verts[t[0]], verts[t[1]], verts[t[2]], verts[t[2]]]);
      }
    }
    return outQuads;
  }

  /**
   * Exact 2D Euclidean Distance Transform (Felzenszwalb-Huttenlocher O(w*h) squared parabola envelope).
   * Returns Float32Array of Euclidean distance in pixels from each foreground pixel (bin[i]=1) to nearest background (0).
   */
  function computeExactEDT(bin, w, h) {
    const N = w * h;
    const INF = 1e9;
    const sqBuf = new Float32Array(N);
    const maxDim = Math.max(w, h) + 1;
    const f = new Float32Array(maxDim);
    const v = new Int32Array(maxDim);
    const z = new Float32Array(maxDim + 1);
    const dOut = new Float32Array(maxDim);

    function edt1d(len) {
      let k = 0;
      v[0] = 0;
      z[0] = -1e18;
      z[1] = 1e18;
      for (let q = 1; q < len; q++) {
        let vk = v[k];
        let s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
        while (k > 0 && s <= z[k]) {
          k--;
          vk = v[k];
          s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = 1e18;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        const diff = q - v[k];
        dOut[q] = diff * diff + f[v[k]];
      }
    }

    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = bin[y * w + x] ? INF : 0;
      edt1d(h);
      for (let y = 0; y < h; y++) sqBuf[y * w + x] = dOut[y];
    }

    const edt = new Float32Array(N);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[x] = sqBuf[row + x];
      edt1d(w);
      for (let x = 0; x < w; x++) {
        edt[row + x] = bin[row + x] ? Math.sqrt(Math.max(0, dOut[x])) : 0;
      }
    }
    return edt;
  }

  /**
   * Corner-preserving non-shrinking Taubin smoothing (lambda / mu passes).
   * Uses multi-pixel chord angle detection so 45-degree pixel staircases are NOT mistaken for sharp corners.
   */
  function smoothPolylineTaubin(chain, passes = 4, options = {}) {
    const closed = !!options.closed;
    let src = chain;
    if (closed && chain.length >= 4 && Math.hypot(chain[0].x - chain[chain.length - 1].x, chain[0].y - chain[chain.length - 1].y) < 1e-4) {
      src = chain.slice(0, -1);
    }
    const n = src.length;
    if (n < 3) return { pts: src.map((p) => ({ ...p })), corners: new Set([0, Math.max(0, n - 1)]) };

    const cornerCos = options.cornerCos ?? 0.52; // ~58 deg bend over multi-pixel chord
    const look = Math.max(2, Math.min(5, Math.floor(n / 4)));
    const rawCorners = new Set();

    if (!closed) {
      rawCorners.add(0);
      rawCorners.add(n - 1);
    }

    if (n >= 5) {
      const cosArr = new Float64Array(n).fill(1);
      for (let i = 0; i < n; i++) {
        if (!closed && (i < look || i >= n - look)) continue;
        const pPrev = src[(i - look + n) % n];
        const pCurr = src[i];
        const pNext = src[(i + look) % n];
        const v1x = pCurr.x - pPrev.x, v1y = pCurr.y - pPrev.y;
        const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 > 1e-6 && l2 > 1e-6) {
          cosArr[i] = (v1x * v2x + v1y * v2y) / (l1 * l2);
        }
      }
      // Non-maximum sharpness selection so only true corner apexes pin
      const nmsRad = Math.max(1, Math.floor(look * 0.6));
      for (let i = 0; i < n; i++) {
        if (cosArr[i] >= cornerCos) continue;
        let isBest = true;
        for (let k = -nmsRad; k <= nmsRad; k++) {
          if (k === 0) continue;
          const j = closed ? (i + k + n) % n : i + k;
          if (j >= 0 && j < n && cosArr[j] < cosArr[i]) {
            isBest = false;
            break;
          }
        }
        if (isBest) rawCorners.add(i);
      }
    }

    if (options.pinnedIndices) {
      for (const idx of options.pinnedIndices) {
        if (idx >= 0 && idx < n) rawCorners.add(idx);
      }
    }

    let cur = src.map((p) => ({ ...p }));
    const lambda = 0.5;
    const mu = -0.53;

    function taubinStep(weight) {
      const next = cur.map((p) => ({ ...p }));
      for (let i = 0; i < n; i++) {
        if (rawCorners.has(i)) continue;
        const prevIdx = closed ? (i - 1 + n) % n : i - 1;
        const nextIdx = closed ? (i + 1) % n : i + 1;
        if (prevIdx < 0 || nextIdx >= n) continue;
        const mx = 0.5 * (cur[prevIdx].x + cur[nextIdx].x);
        const my = 0.5 * (cur[prevIdx].y + cur[nextIdx].y);
        next[i].x = cur[i].x + weight * (mx - cur[i].x);
        next[i].y = cur[i].y + weight * (my - cur[i].y);
      }
      cur = next;
    }

    for (let pass = 0; pass < passes; pass++) {
      taubinStep(lambda);
      taubinStep(mu);
    }

    return { pts: cur, corners: rawCorners };
  }

  /**
   * Run Douglas-Peucker simplification piecewise between pinned corner indices so crisp corners are preserved.
   */
  function piecewiseRdpSimplify(pts, cornersSet, epsilon, closed = false) {
    if (pts.length <= 2 || epsilon <= 0) return pts.slice();
    if (closed && pts.length >= 3) {
      const loopPts = pts.concat([pts[0]]);
      const sorted = Array.from(cornersSet || [])
        .filter((idx) => idx >= 0 && idx < pts.length)
        .sort((a, b) => a - b);
      if (sorted.length < 2) {
        const half = Math.max(1, Math.floor(pts.length / 2));
        sorted.length = 0;
        sorted.push(0, half, pts.length);
      } else {
        if (sorted[0] !== 0) sorted.unshift(0);
        sorted.push(pts.length);
      }
      const out = [];
      for (let k = 0; k < sorted.length - 1; k++) {
        const a = sorted[k], b = sorted[k + 1];
        if (b <= a) continue;
        const seg = rdpSimplify(loopPts.slice(a, b + 1), epsilon);
        if (out.length > 0) seg.shift();
        for (const pt of seg) out.push(pt);
      }
      if (out.length > 3 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) {
        out.pop();
      }
      return out.length >= 3 ? out : pts.slice();
    }

    const sorted = Array.from(cornersSet || [])
      .filter((idx) => idx >= 0 && idx < pts.length)
      .sort((a, b) => a - b);
    if (!sorted.length || sorted[0] !== 0) sorted.unshift(0);
    if (sorted[sorted.length - 1] !== pts.length - 1) sorted.push(pts.length - 1);

    const out = [];
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k];
      const b = sorted[k + 1];
      if (b <= a) continue;
      const seg = rdpSimplify(pts.slice(a, b + 1), epsilon);
      if (out.length > 0) seg.shift();
      for (const pt of seg) out.push(pt);
    }
    return out.length >= 2 ? out : pts.slice();
  }

  /**
   * Snap smoothed interior chain points onto the exact sub-pixel ink darkness ridge using quadratic peak fitting.
   */
  function snapChainToDarkRidge(pts, lumField, w, h, cornersSet, closed = false) {
    const n = pts.length;
    if (n < 3 || !lumField) return pts;
    const step = 0.72;

    function sampleField(fx, fy) {
      const cx = Math.max(0, Math.min(w - 1.001, fx - 0.5));
      const cy = Math.max(0, Math.min(h - 1.001, fy - 0.5));
      const x0 = Math.floor(cx), y0 = Math.floor(cy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const tx = cx - x0, ty = cy - y0;
      const v00 = lumField[y0 * w + x0];
      const v10 = lumField[y0 * w + x1];
      const v01 = lumField[y1 * w + x0];
      const v11 = lumField[y1 * w + x1];
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }

    return pts.map((p, i) => {
      if (cornersSet && cornersSet.has(i)) return p;
      if (!closed && (i === 0 || i === n - 1)) return p;
      // Do not shift pixels belonging to wide solid fills
      if (p.halfWidthPx !== undefined && p.halfWidthPx > 2.2) return p;

      const pPrev = pts[(i - 1 + n) % n];
      const pNext = pts[(i + 1) % n];
      const tx = pNext.x - pPrev.x;
      const ty = pNext.y - pPrev.y;
      const tLen = Math.hypot(tx, ty);
      if (tLen < 1e-4) return p;
      const nx = -ty / tLen;
      const ny = tx / tLen;

      const a = sampleField(p.x - nx * step, p.y - ny * step);
      const b = sampleField(p.x, p.y);
      const c = sampleField(p.x + nx * step, p.y + ny * step);
      const denom = a - 2 * b + c;
      if (denom >= -0.02) return p; // not a distinct dark ridge
      const delta = Math.max(-0.85, Math.min(0.85, (a - c) / (2 * denom)));
      return { ...p, x: p.x + nx * delta * step, y: p.y + ny * delta * step };
    });
  }

  /**
   * Build clean miter-joined quads (with automatic beveling at acute bends and optional variable half-widths).
   */
  function buildMiterRibbonQuads(worldPts, halfWidths, options = {}) {
    if (!worldPts || worldPts.length < 2) return [];
    const pts = [];
    for (const p of worldPts) {
      if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > 1e-7) {
        pts.push(p);
      }
    }
    const closed = !!options.closed && pts.length >= 3;
    if (closed && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-7) {
      pts.pop();
    }
    const n = pts.length;
    if (n < 2) return [];

    const miterLimit = options.miterLimit ?? 2.3;
    function getHw(i) {
      return Array.isArray(halfWidths) ? (halfWidths[i] ?? halfWidths[0] ?? 0.002) : (halfWidths || 0.002);
    }

    const segCount = closed ? n : n - 1;
    const segNorms = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      segNorms.push({ nx: -dy / len, ny: dx / len, dx: dx / len, dy: dy / len });
    }

    const endCaps = [];
    for (let i = 0; i < n; i++) {
      const hw = getHw(i);
      const hasPrev = closed || i > 0;
      const hasNext = closed || i < n - 1;
      const n1 = hasPrev ? segNorms[(i - 1 + segCount) % segCount] : segNorms[0];
      const n2 = hasNext ? segNorms[i % segCount] : segNorms[segCount - 1];

      if (!hasPrev || !hasNext) {
        const refN = hasNext ? n2 : n1;
        const L = { x: pts[i].x + refN.nx * hw, y: pts[i].y + refN.ny * hw };
        const R = { x: pts[i].x - refN.nx * hw, y: pts[i].y - refN.ny * hw };
        endCaps.push({ inL: L, inR: R, outL: L, outR: R, bevel: null });
        continue;
      }

      const bx = n1.nx + n2.nx, by = n1.ny + n2.ny;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-5) {
        const L1 = { x: pts[i].x + n1.nx * hw, y: pts[i].y + n1.ny * hw };
        const R1 = { x: pts[i].x - n1.nx * hw, y: pts[i].y - n1.ny * hw };
        const L2 = { x: pts[i].x + n2.nx * hw, y: pts[i].y + n2.ny * hw };
        const R2 = { x: pts[i].x - n2.nx * hw, y: pts[i].y - n2.ny * hw };
        endCaps.push({ inL: L1, inR: R1, outL: L2, outR: R2, bevel: { tl: L1, tr: L2, br: R2, bl: R1 } });
        continue;
      }

      const bnx = bx / bl, bny = by / bl;
      const dot = bnx * n1.nx + bny * n1.ny;
      const miterRatio = 1 / Math.max(0.08, dot);

      if (miterRatio <= miterLimit) {
        const m = hw * miterRatio;
        const L = { x: pts[i].x + bnx * m, y: pts[i].y + bny * m };
        const R = { x: pts[i].x - bnx * m, y: pts[i].y - bny * m };
        endCaps.push({ inL: L, inR: R, outL: L, outR: R, bevel: null });
      } else {
        // Bevel outer corner and clamp inner miter to prevent spikes
        const crossTurn = n1.dx * n2.dy - n1.dy * n2.dx;
        const clampM = hw * Math.min(1.35, 1 / Math.max(0.45, dot));
        if (crossTurn >= 0) {
          // Turning left -> Right side is outer, Left side is inner
          const inL = { x: pts[i].x + bnx * clampM, y: pts[i].y + bny * clampM };
          const r1 = { x: pts[i].x - n1.nx * hw, y: pts[i].y - n1.ny * hw };
          const r2 = { x: pts[i].x - n2.nx * hw, y: pts[i].y - n2.ny * hw };
          endCaps.push({ inL, inR: r1, outL: inL, outR: r2, bevel: { tl: r1, tr: r2, br: inL, bl: inL } });
        } else {
          // Turning right -> Left side is outer, Right side is inner
          const inR = { x: pts[i].x - bnx * clampM, y: pts[i].y - bny * clampM };
          const l1 = { x: pts[i].x + n1.nx * hw, y: pts[i].y + n1.ny * hw };
          const l2 = { x: pts[i].x + n2.nx * hw, y: pts[i].y + n2.ny * hw };
          endCaps.push({ inL: l1, inR, outL: l2, outR: inR, bevel: { tl: l1, tr: l2, br: inR, bl: inR } });
        }
      }
    }

    const quads = [];
    for (let i = 0; i < segCount; i++) {
      const a = endCaps[i];
      const b = endCaps[(i + 1) % n];
      quads.push({ tl: a.outL, tr: b.inL, br: b.inR, bl: a.outR });
      if (b.bevel && (closed || i + 1 < n - 1)) {
        quads.push(b.bevel);
      }
    }
    return quads;
  }

  // =========================================================================
  // Symmetry & Shape Creation Helpers
  // =========================================================================
  function getMirrorTransforms() {
    const list = [{ sx: 1, sy: 1 }];
    if (state.options.mirrorX) list.push({ sx: -1, sy: 1 });
    if (state.options.mirrorY) {
      const len = list.length;
      for (let i = 0; i < len; i++) {
        list.push({ sx: list[i].sx, sy: -1 });
      }
    }
    return list;
  }

  function makeDefaultRadialFields(refX, refY) {
    if (!state.options.defaultMoveRadial) return {};
    const mult = parseFloat($('numSelRadMult')?.value) || 20.64;
    const r = Math.max(0.01, Math.hypot(refX, refY));
    return {
      moveRadial: true,
      radialCenter: [0, 0],
      radialAngle: 0,
      radialMoveSpeed: Number((mult * r).toFixed(6))
    };
  }

  function isMotionColorActive() {
    return state.previewMode === 'motion' || !!state.options.colorMotion;
  }

  function getElementMotionType(item) {
    if (item.moveRadial) return 'radial';
    if (item.move) return 'vertical';
    return 'static';
  }

  function updateMotionLegend() {
    const legend = $('motionLegend');
    if (!legend) return;
    const active = isMotionColorActive();
    legend.hidden = !active;
    if (!active) return;

    let staticCnt = 0;
    let vertCnt = 0;
    let radialCnt = 0;
    for (const { item } of allShapes()) {
      if (!isLayerVisible(item.layer)) continue;
      const m = getElementMotionType(item);
      if (m === 'radial') radialCnt++;
      else if (m === 'vertical') vertCnt++;
      else staticCnt++;
    }

    const h = state.doc?.header;
    if (h?.radial && state.doc.distances?.length) {
      radialCnt += state.doc.distances.length;
    }
    for (const b of (state.doc?.ballistics || [])) {
      const cnt = b.distances?.length || 0;
      if (b.radial) radialCnt += cnt;
      else vertCnt += cnt;
    }

    if ($('cntMotionStatic')) $('cntMotionStatic').textContent = String(staticCnt);
    if ($('cntMotionVert')) $('cntMotionVert').textContent = String(vertCnt);
    if ($('cntMotionRadial')) $('cntMotionRadial').textContent = String(radialCnt);
  }

  function updateLayerLegend() {
    const legend = $('layerLegend');
    if (!legend) return;
    const active = !isMotionColorActive() && !!state.options.colorLayers;
    legend.hidden = !active;
    if (!active) return;

    let baseCnt = 0;
    let drawCnt = 0;
    for (const { item } of allShapes()) {
      if (!isLayerVisible(item.layer)) continue;
      if (item.layer === 'base') baseCnt++;
      else drawCnt++;
    }
    if ($('cntLayerBase')) $('cntLayerBase').textContent = String(baseCnt);
    if ($('cntLayerDraw')) $('cntLayerDraw').textContent = String(drawCnt);
  }

  function addLineSymmetric(x1, y1, x2, y2, layer = 'draw') {
    const th = state.options.defaultThousandth;
    const mv = state.options.defaultMoveRadial ? false : state.options.defaultMove;
    for (const { sx, sy } of getMirrorTransforms()) {
      const rx1 = x1 * sx, ry1 = y1 * sy;
      const rx2 = x2 * sx, ry2 = y2 * sy;
      state.doc.lines.push({
        id: BlkParser.nextId('line'),
        layer,
        x1: fromCanvasUnit(rx1, th),
        y1: fromCanvasUnit(ry1, th),
        x2: fromCanvasUnit(rx2, th),
        y2: fromCanvasUnit(ry2, th),
        move: mv,
        thousandth: th,
        ...makeDefaultRadialFields((rx1 + rx2) * 0.5, (ry1 + ry2) * 0.5)
      });
    }
  }

  function addQuadSymmetric(tl, tr, br, bl, layer = 'draw') {
    const th = state.options.defaultThousandth;
    const mv = state.options.defaultMoveRadial ? false : state.options.defaultMove;
    for (const { sx, sy } of getMirrorTransforms()) {
      const cx = (tl.x + tr.x + br.x + bl.x) * 0.25 * sx;
      const cy = (tl.y + tr.y + br.y + bl.y) * 0.25 * sy;
      state.doc.quads.push({
        id: BlkParser.nextId('quad'),
        layer,
        tl: { x: fromCanvasUnit(tl.x * sx, th), y: fromCanvasUnit(tl.y * sy, th) },
        tr: { x: fromCanvasUnit(tr.x * sx, th), y: fromCanvasUnit(tr.y * sy, th) },
        br: { x: fromCanvasUnit(br.x * sx, th), y: fromCanvasUnit(br.y * sy, th) },
        bl: { x: fromCanvasUnit(bl.x * sx, th), y: fromCanvasUnit(bl.y * sy, th) },
        move: mv,
        thousandth: th,
        ...makeDefaultRadialFields(cx, cy)
      });
    }
  }

  function addPolylineSymmetric(pts, mode = 'lines', width = 0.004, layer = 'draw', options = {}) {
    if (pts.length < 2) return;
    if (mode === 'closedFill') {
      if (pts.length >= 3) addPolygonSymmetric(pts, layer);
      return;
    }
    if (mode === 'lines') {
      for (let i = 0; i < pts.length - 1; i++) {
        if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) < 1e-6) continue;
        addLineSymmetric(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, layer);
      }
      if (options.closed && pts.length >= 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) >= 1e-6) {
        addLineSymmetric(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y, layer);
      }
      return;
    }

    const baseHalfW = width / 2;
    let halfWidths = baseHalfW;
    if (options.taper && pts.length >= 4 && !options.closed) {
      // Smooth arc-length cosine taper at both ends
      const cumLen = [0];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        cumLen.push(total);
      }
      const taperDist = Math.min(total * 0.28, Math.max(width * 3.5, 0.018));
      halfWidths = pts.map((_, i) => {
        if (total < 1e-6) return baseHalfW;
        const dStart = cumLen[i];
        const dEnd = total - cumLen[i];
        const d = Math.min(dStart, dEnd);
        const factor = d >= taperDist ? 1 : 0.16 + 0.84 * Math.sin((Math.PI * 0.5 * d) / Math.max(1e-6, taperDist));
        return baseHalfW * factor;
      });
    }

    const quads = buildMiterRibbonQuads(pts, halfWidths, { closed: !!options.closed });
    for (const q of quads) {
      addQuadSymmetric(q.tl, q.tr, q.br, q.bl, layer);
    }
  }

  function addPolygonSymmetric(pts, layer = 'draw') {
    if (pts.length < 3) return;
    if (pts.length === 3) {
      addQuadSymmetric(pts[0], pts[1], pts[2], pts[2], layer);
      return;
    }
    if (pts.length === 4) {
      addQuadSymmetric(pts[0], pts[1], pts[2], pts[3], layer);
      return;
    }
    const quads = triangulatePolygonToQuads(pts);
    for (const q of quads) {
      addQuadSymmetric(q[0], q[1], q[2], q[3], layer);
    }
  }

  function addCircleSymmetric(cx, cy, radius) {
    const mode = state.options.shapeMode;
    const segs = Math.max(6, Math.min(180, Math.round(state.options.circleSegs || 36)));
    const aStart = state.options.arcStart || 0;
    const aEnd = state.options.arcEnd ?? 360;
    const th = state.options.defaultThousandth;
    const mv = state.options.defaultMoveRadial ? false : state.options.defaultMove;

    if (mode === 'nativeCircle') {
      for (const { sx, sy } of getMirrorTransforms()) {
        let sAng = aStart;
        let eAng = aEnd;
        if (sx < 0) {
          const ns = 180 - eAng;
          const ne = 180 - sAng;
          sAng = ns; eAng = ne;
        }
        if (sy < 0) {
          const ns = -eAng;
          const ne = -sAng;
          sAng = ns; eAng = ne;
        }
        state.doc.circles.push({
          id: BlkParser.nextId('circle'),
          layer: 'draw',
          x: fromCanvasUnit(cx * sx, th),
          y: fromCanvasUnit(cy * sy, th),
          diameter: fromCanvasUnit(radius * 2, th),
          size: 1.5,
          startAngle: sAng,
          endAngle: eAng,
          move: mv,
          thousandth: th,
          ...makeDefaultRadialFields(cx * sx, cy * sy)
        });
      }
      return;
    }

    const rStart = ((aStart - 90) * Math.PI) / 180;
    const rEnd = ((aEnd - 90) * Math.PI) / 180;
    const span = rEnd - rStart;
    const steps = Math.max(3, Math.round((Math.abs(span) / (Math.PI * 2)) * segs));

    if (mode === 'quads') {
      const center = { x: cx, y: cy };
      for (let i = 0; i < steps; i++) {
        const t1 = rStart + (span * i) / steps;
        const t2 = rStart + (span * (i + 1)) / steps;
        const p1 = { x: cx + Math.cos(t1) * radius, y: cy + Math.sin(t1) * radius };
        const p2 = { x: cx + Math.cos(t2) * radius, y: cy + Math.sin(t2) * radius };
        addQuadSymmetric(center, p1, p2, p2, 'draw');
      }
    } else {
      for (let i = 0; i < steps; i++) {
        const t1 = rStart + (span * i) / steps;
        const t2 = rStart + (span * (i + 1)) / steps;
        addLineSymmetric(
          cx + Math.cos(t1) * radius,
          cy + Math.sin(t1) * radius,
          cx + Math.cos(t2) * radius,
          cy + Math.sin(t2) * radius,
          'draw'
        );
      }
    }
  }

  /**
   * Generate vertices for Tactical Shape Stamp tool (Chevron, Star, N-Gon, Tactical Cross).
   */
  function buildStampVertices(cx, cy, radius, rotationRad) {
    const type = state.options.stampType;
    const n = Math.max(3, Math.min(24, state.options.stampPoints || 5));
    const innerRatio = state.options.stampInner || 0.45;
    const pts = [];

    const rot = (lx, ly) => ({
      x: cx + lx * Math.cos(rotationRad) - ly * Math.sin(rotationRad),
      y: cy + lx * Math.sin(rotationRad) + ly * Math.cos(rotationRad)
    });

    if (type === 'chevron') {
      // Tactical aiming chevron (closed 6-vertex chevron polygon)
      const thick = radius * (1 - innerRatio) * 0.65;
      pts.push(
        rot(0, -radius * 0.6),
        rot(radius * 0.85, radius * 0.45),
        rot(radius * 0.85 - thick, radius * 0.45 + thick * 0.5),
        rot(0, -radius * 0.6 + thick * 1.35),
        rot(-radius * 0.85 + thick, radius * 0.45 + thick * 0.5),
        rot(-radius * 0.85, radius * 0.45)
      );
    } else if (type === 'star') {
      const total = n * 2;
      for (let i = 0; i < total; i++) {
        const r = i % 2 === 0 ? radius : radius * innerRatio;
        const a = (i * Math.PI) / n - Math.PI / 2;
        pts.push(rot(Math.cos(a) * r, Math.sin(a) * r));
      }
    } else if (type === 'ngon') {
      for (let i = 0; i < n; i++) {
        const a = (i * 2 * Math.PI) / n - Math.PI / 2;
        pts.push(rot(Math.cos(a) * radius, Math.sin(a) * radius));
      }
    } else if (type === 'cross') {
      const arm = radius;
      const w = radius * innerRatio * 0.45;
      pts.push(
        rot(-w, -arm), rot(w, -arm),
        rot(w, -w), rot(arm, -w),
        rot(arm, w), rot(w, w),
        rot(w, arm), rot(-w, arm),
        rot(-w, w), rot(-arm, w),
        rot(-arm, -w), rot(-w, -w)
      );
    }
    return pts;
  }

  function addStampSymmetric(cx, cy, radius, rotationRad) {
    const pts = buildStampVertices(cx, cy, radius, rotationRad);
    if (pts.length < 3) return;
    if (state.options.shapeMode === 'quads') {
      addPolygonSymmetric(pts, 'draw');
    } else {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        addLineSymmetric(a.x, a.y, b.x, b.y, 'draw');
      }
    }
  }

  // =========================================================================
  // Hit Testing & Selection CAD Operations
  // =========================================================================
  function hitTestPoint(wx, wy, ignoreLocks = false) {
    const tol = 8 / state.cam.scale;
    const shapes = allShapes();
    for (let i = shapes.length - 1; i >= 0; i--) {
      const { kind, item } = shapes[i];
      if (!isLayerVisible(item.layer)) continue;
      if (!ignoreLocks && isLayerLocked(item.layer)) continue;

      if (kind === 'line') {
        const pts = getShapePointsCanvas('line', item);
        const d = distToSegment(wx, wy, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        if (d <= tol) return { kind, item };
      } else if (kind === 'quad') {
        const pts = getShapePointsCanvas('quad', item);
        if (pointInPolygon(wx, wy, pts)) return { kind, item };
        for (let k = 0; k < 4; k++) {
          const p1 = pts[k], p2 = pts[(k + 1) % 4];
          if (distToSegment(wx, wy, p1.x, p1.y, p2.x, p2.y) <= tol * 0.7) {
            return { kind, item };
          }
        }
      } else if (kind === 'circle') {
        const pts = getShapePointsCanvas('circle', item);
        const c = pts[2];
        const r = Math.abs(pts[1].x - pts[0].x) * 0.5;
        const dist = Math.hypot(wx - c.x, wy - c.y);
        if (Math.abs(dist - r) <= tol) return { kind, item };
      } else if (kind === 'text') {
        const b = getShapeBoundsCanvas('text', item);
        if (wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY) {
          return { kind, item };
        }
      }
    }
    return null;
  }

  function getRefImageHandleAtScreen(sx, sy) {
    const r = state.refImage;
    if (!r.img || !r.visible || !r.editOnCanvas) return null;
    const center = worldToScreen(r.x, r.y);
    const aspect = r.img.width / (r.img.height || 1);
    const hPx = r.scale * state.cam.scale;
    const wPx = hPx * aspect;
    const rad = (r.rotation * Math.PI) / 180;
    const cos = Math.cos(-rad), sin = Math.sin(-rad);
    const dx = sx - center.x, dy = sy - center.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    // Rotation stem at (0, -hPx/2 - 22)
    if (Math.hypot(lx, ly - (-hPx / 2 - 22)) <= 10) return { type: 'ref-rotate' };
    // 4 corners
    const corners = [
      { x: -wPx / 2, y: -hPx / 2 },
      { x: wPx / 2, y: -hPx / 2 },
      { x: wPx / 2, y: hPx / 2 },
      { x: -wPx / 2, y: hPx / 2 }
    ];
    for (const c of corners) {
      if (Math.hypot(lx - c.x, ly - c.y) <= 10) return { type: 'ref-scale' };
    }
    if (Math.abs(lx) <= wPx / 2 && Math.abs(ly) <= hPx / 2) return { type: 'ref-move' };
    return null;
  }

  function refNormToWorld(u, v) {
    const r = state.refImage;
    if (!r.img) return { x: 0, y: 0 };
    const aspect = r.img.width / (r.img.height || 1);
    const worldH = r.scale;
    const worldW = worldH * aspect;
    const lx = (u - 0.5) * worldW;
    const ly = (v - 0.5) * worldH;
    const rad = (r.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return { x: r.x + lx * cos - ly * sin, y: r.y + lx * sin + ly * cos };
  }

  function worldToRefNorm(wx, wy) {
    const r = state.refImage;
    if (!r.img) return { u: 0.5, v: 0.5 };
    const aspect = r.img.width / (r.img.height || 1);
    const worldH = r.scale;
    const worldW = worldH * aspect;
    const dx = wx - r.x, dy = wy - r.y;
    const rad = (-r.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return { u: lx / (worldW || 1) + 0.5, v: ly / (worldH || 1) + 0.5 };
  }

  function getTraceCropHandleAtScreen(sx, sy) {
    const r = state.refImage;
    const crop = state.traceCrop;
    if (!r.img || !r.visible || !crop.editing) return null;

    const corners = [
      { key: 'nw', u: crop.x0, v: crop.y0 },
      { key: 'ne', u: crop.x1, v: crop.y0 },
      { key: 'se', u: crop.x1, v: crop.y1 },
      { key: 'sw', u: crop.x0, v: crop.y1 }
    ];
    for (const c of corners) {
      const sp = worldToScreen(refNormToWorld(c.u, c.v).x, refNormToWorld(c.u, c.v).y);
      if (Math.hypot(sx - sp.x, sy - sp.y) <= 11) {
        return { type: 'trace-crop-corner', key: c.key };
      }
    }

    const w = screenToWorld(sx, sy);
    const { u, v } = worldToRefNorm(w.x, w.y);
    if (crop.active && u >= crop.x0 && u <= crop.x1 && v >= crop.y0 && v <= crop.y1) {
      return { type: 'trace-crop-move', startU: u, startV: v };
    }
    if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) {
      return { type: 'trace-crop-draw', startU: Math.max(0, Math.min(1, u)), startV: Math.max(0, Math.min(1, v)) };
    }
    return null;
  }

  function getHandleAtScreenPos(sx, sy) {
    if (state.selection.size === 0) return null;

    const selected = getSelectedEntries();
    if (selected.length === 1) {
      const { kind, item } = selected[0];
      if (!isLayerLocked(item.layer)) {
        if (kind === 'line') {
          const pts = getShapePointsCanvas('line', item);
          const p1 = worldToScreen(pts[0].x, pts[0].y);
          const p2 = worldToScreen(pts[1].x, pts[1].y);
          if (Math.hypot(sx - p1.x, sy - p1.y) <= 9) return { type: 'vertex', item, key: 'p1' };
          if (Math.hypot(sx - p2.x, sy - p2.y) <= 9) return { type: 'vertex', item, key: 'p2' };
        } else if (kind === 'quad') {
          const pts = getShapePointsCanvas('quad', item);
          const keys = ['tl', 'tr', 'br', 'bl'];
          for (let i = 0; i < 4; i++) {
            const p = worldToScreen(pts[i].x, pts[i].y);
            if (Math.hypot(sx - p.x, sy - p.y) <= 8) return { type: 'vertex', item, key: keys[i] };
          }
        }
      }
    }

    const bounds = getSelectionBoundsCanvas();
    if (!bounds) return null;
    const tl = worldToScreen(bounds.minX, bounds.minY);
    const br = worldToScreen(bounds.maxX, bounds.maxY);
    const rotPos = { x: (tl.x + br.x) / 2, y: tl.y - 24 };

    if (Math.hypot(sx - rotPos.x, sy - rotPos.y) <= 9) {
      return { type: 'rotate', bounds };
    }

    const corners = [
      { id: 'nw', x: tl.x, y: tl.y },
      { id: 'ne', x: br.x, y: tl.y },
      { id: 'se', x: br.x, y: br.y },
      { id: 'sw', x: tl.x, y: br.y }
    ];
    for (const c of corners) {
      if (Math.hypot(sx - c.x, sy - c.y) <= 8) {
        return { type: 'scale', corner: c.id, bounds };
      }
    }
    return null;
  }

  function translateEntries(entries, dxCanvas, dyCanvas) {
    const milScale = getActiveMilUnitScale();
    for (const { kind, item } of entries) {
      if (isLayerLocked(item.layer)) continue;
      const th = !!item.thousandth;
      let dcx = dxCanvas;
      let dcy = dyCanvas;
      if (Number.isFinite(item.radialAngle) && Math.abs(item.radialAngle) > 1e-6) {
        const inv = rotatePointCCW(dcx, dcy, 0, 0, (-item.radialAngle * Math.PI) / 180);
        dcx = inv.x;
        dcy = inv.y;
      }
      const dx = fromCanvasUnit(dcx, th, milScale);
      const dy = fromCanvasUnit(dcy, th, milScale);
      if (kind === 'line') {
        item.x1 += dx; item.y1 += dy;
        item.x2 += dx; item.y2 += dy;
      } else if (kind === 'quad') {
        for (const k of ['tl', 'tr', 'br', 'bl']) {
          item[k].x += dx; item[k].y += dy;
        }
      } else if (kind === 'circle' || kind === 'text') {
        item.x += dx; item.y += dy;
      }
    }
  }

  function translateSelected(dxCanvas, dyCanvas) {
    translateEntries(getSelectedEntries(), dxCanvas, dyCanvas);
  }

  function transformShapes(entries, cx, cy, sx, sy, angleRad) {
    const milScale = getActiveMilUnitScale();
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    function xf(px, py, th, item) {
      let wx = toCanvasUnit(px, th, milScale);
      let wy = toCanvasUnit(py, th, milScale);
      const hasAngle = Number.isFinite(item.radialAngle) && Math.abs(item.radialAngle) > 1e-6;
      let rcx = 0, rcy = 0, phi = 0;
      if (hasAngle) {
        const rc = Array.isArray(item.radialCenter) && item.radialCenter.length >= 2 ? item.radialCenter : [0, 0];
        rcx = toCanvasUnit(rc[0], th, milScale);
        rcy = toCanvasUnit(rc[1], th, milScale);
        phi = (item.radialAngle * Math.PI) / 180;
        const rotP = rotatePointCCW(wx, wy, rcx, rcy, phi);
        wx = rotP.x;
        wy = rotP.y;
      }
      const dx = wx - cx;
      const dy = wy - cy;
      const rx = dx * sx;
      const ry = dy * sy;
      let nx = cx + (rx * cos - ry * sin);
      let ny = cy + (rx * sin + ry * cos);
      if (hasAngle) {
        const inv = rotatePointCCW(nx, ny, rcx, rcy, -phi);
        nx = inv.x;
        ny = inv.y;
      }
      return {
        x: fromCanvasUnit(nx, th, milScale),
        y: fromCanvasUnit(ny, th, milScale)
      };
    }

    for (const { kind, item } of entries) {
      const th = !!item.thousandth;
      if (kind === 'line') {
        const a = xf(item.x1, item.y1, th, item);
        const b = xf(item.x2, item.y2, th, item);
        item.x1 = a.x; item.y1 = a.y;
        item.x2 = b.x; item.y2 = b.y;
      } else if (kind === 'quad') {
        for (const k of ['tl', 'tr', 'br', 'bl']) {
          const p = xf(item[k].x, item[k].y, th, item);
          item[k].x = p.x; item[k].y = p.y;
        }
      } else if (kind === 'circle') {
        const p = xf(item.x, item.y, th, item);
        item.x = p.x; item.y = p.y;
        item.diameter *= (Math.abs(sx) + Math.abs(sy)) / 2;
      } else if (kind === 'text') {
        const p = xf(item.x, item.y, th, item);
        item.x = p.x; item.y = p.y;
        item.size *= (Math.abs(sx) + Math.abs(sy)) / 2;
      }
    }
  }

  function cloneEntry(kind, item, targetLayer = null) {
    const layer = targetLayer || item.layer || 'draw';
    const base = cloneItemArrayProps(item);
    if (kind === 'line') {
      return { kind, item: { ...base, id: BlkParser.nextId('line'), layer } };
    }
    if (kind === 'quad') {
      return {
        kind,
        item: {
          ...base,
          id: BlkParser.nextId('quad'),
          layer,
          tl: { ...item.tl },
          tr: { ...item.tr },
          br: { ...item.br },
          bl: { ...item.bl }
        }
      };
    }
    if (kind === 'circle') {
      return { kind, item: { ...base, id: BlkParser.nextId('circle'), layer } };
    }
    if (kind === 'text') {
      return { kind, item: { ...base, id: BlkParser.nextId('text'), layer } };
    }
    return null;
  }

  function insertClonedEntry(cloned) {
    if (!cloned) return;
    const { kind, item } = cloned;
    if (kind === 'line') state.doc.lines.push(item);
    else if (kind === 'quad') state.doc.quads.push(item);
    else if (kind === 'circle') state.doc.circles.push(item);
    else if (kind === 'text') state.doc.texts.push(item);
  }

  function deleteSelected() {
    if (state.selection.size === 0) return;
    const delSet = new Set();
    for (const { item } of getSelectedEntries()) {
      if (!isLayerLocked(item.layer)) delSet.add(item.id);
    }
    if (delSet.size === 0) {
      showToast('Selected elements are on a locked layer', 'warn');
      return;
    }
    state.doc.lines = state.doc.lines.filter((s) => !delSet.has(s.id));
    state.doc.quads = state.doc.quads.filter((s) => !delSet.has(s.id));
    state.doc.circles = state.doc.circles.filter((s) => !delSet.has(s.id));
    state.doc.texts = state.doc.texts.filter((s) => !delSet.has(s.id));
    for (const id of delSet) state.selection.delete(id);
    pushHistory();
    updateSelectionUI();
    requestRender();
  }

  function duplicateSelected(offset = 0.015) {
    const selected = getSelectedEntries();
    if (selected.length === 0) return;
    const newEntries = [];
    for (const { kind, item } of selected) {
      const cloned = cloneEntry(kind, item, 'draw');
      insertClonedEntry(cloned);
      newEntries.push(cloned);
    }
    translateEntries(newEntries, offset, offset);
    state.selection = new Set(newEntries.map((e) => e.item.id));
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Duplicated ${newEntries.size || newEntries.length} item(s)`);
  }

  function mirrorCloneSelected(axis) {
    const selected = getSelectedEntries();
    if (selected.length === 0) return;
    const newEntries = [];
    for (const { kind, item } of selected) {
      const cloned = cloneEntry(kind, item, item.layer);
      insertClonedEntry(cloned);
      newEntries.push(cloned);
    }
    transformShapes(newEntries, 0, 0, axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, 0);
    state.selection = new Set(newEntries.map((e) => e.item.id));
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Mirror-copied ${newEntries.length} item(s) across ${axis.toUpperCase()}=0`);
  }

  function radialCloneSelected() {
    const selected = getSelectedEntries();
    if (selected.length === 0) return;
    const totalCopies = Math.max(2, Math.min(60, parseInt($('numRadialCount').value, 10) || 6));
    const pivotMode = $('selRadialPivot').value;
    const bounds = getSelectionBoundsCanvas();
    const cx = pivotMode === 'center' && bounds ? bounds.cx : 0;
    const cy = pivotMode === 'center' && bounds ? bounds.cy : 0;

    const newIds = new Set(state.selection);
    for (let k = 1; k < totalCopies; k++) {
      const angle = (k * 2 * Math.PI) / totalCopies;
      const batch = [];
      for (const { kind, item } of selected) {
        const cloned = cloneEntry(kind, item, item.layer);
        insertClonedEntry(cloned);
        batch.push(cloned);
        newIds.add(cloned.item.id);
      }
      transformShapes(batch, cx, cy, 1, 1, angle);
    }
    state.selection = newIds;
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Created ${totalCopies}x radial array`);
  }

  function flipSelected(axis) {
    const entries = getSelectedEntries().filter(({ item }) => !isLayerLocked(item.layer));
    const bounds = getSelectionBoundsCanvas();
    if (!entries.length || !bounds) return;
    transformShapes(entries, bounds.cx, bounds.cy, axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1, 0);
    pushHistory();
    updateSelectionUI();
    requestRender();
  }

  function centerEntriesAtOrigin(entries) {
    const bounds = getEntriesBoundsCanvas(entries);
    if (!bounds) return;
    translateEntries(entries, -bounds.cx, -bounds.cy);
    pushHistory();
    updateSelectionUI();
    requestRender();
  }

  /**
   * Convert a "Detail Kept" percentage (5..99) into geometric tolerances.
   * 99% = nearly lossless collinear merge; 50% = strong simplification; 10% = aggressive decimation.
   */
  function detailPctToTolerances(detailPct, allowWeld = true) {
    const removal = Math.max(0.01, Math.min(0.95, (100 - detailPct) / 100));
    // Exponential curve from 0.00008 (at 99% detail) to 0.018 (at 5% detail)
    const rdpTol = 0.00008 + Math.pow(removal, 2.15) * 0.018;
    const weldTol = allowWeld ? Math.max(0.00015, rdpTol * 0.65) : 0.00005;
    const minSegLen = Math.pow(removal, 2.3) * 0.008;
    return { rdpTol, weldTol, minSegLen };
  }

  /**
   * High-performance Bidirectional Polyline Graph Chainer + Endpoint Welder + RDP Simplifier.
   */
  function optimizeLinesCollection(targetLines, detailPct = 75, allowWeld = true) {
    if (targetLines.length < 2) return targetLines.map((l) => ({ ...l }));
    const { rdpTol, weldTol, minSegLen } = detailPctToTolerances(detailPct, allowWeld);

    // Group lines by layer|move|thousandth (keep moveRadial/radialAngle lines separate so radial vectors never corrupt!)
    const groups = new Map();
    const passthroughRadial = [];
    for (const l of targetLines) {
      if (l.moveRadial || (Number.isFinite(l.radialAngle) && Math.abs(l.radialAngle) > 1e-6)) {
        passthroughRadial.push(cloneItemArrayProps(l));
        continue;
      }
      const key = `${l.layer}|${l.move ? 1 : 0}|${l.thousandth ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }

    const result = passthroughRadial;

    for (const [, list] of groups) {
      const th = !!list[0].thousandth;
      const scaleToUnit = th ? MIL_TO_UNIT : 1;
      const tol = rdpTol / scaleToUnit;
      const joinEps = weldTol / scaleToUnit;
      const minLen = minSegLen / scaleToUnit;

      // 1. Filter out zero-length and duplicate segments
      const segs = [];
      const seenKeys = new Set();
      for (const l of list) {
        const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
        if (len < 1e-6) continue;
        // Canonical orientation hash to drop exact duplicate overlapping segments
        const q = (v) => Math.round(v * 20000);
        const k1 = `${q(l.x1)},${q(l.y1)}`, k2 = `${q(l.x2)},${q(l.y2)}`;
        const dupKey = k1 < k2 ? `${k1}:${k2}` : `${k2}:${k1}`;
        if (seenKeys.has(dupKey)) continue;
        seenKeys.add(dupKey);
        segs.push({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, len });
      }

      // 2. Spatial grid bucket index for fast bidirectional endpoint chaining
      const cellSize = Math.max(1e-4, joinEps * 2.5);
      const cellKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
      const grid = new Map();
      const addEndpointToGrid = (segIdx, endId, x, y) => {
        const ck = cellKey(x, y);
        if (!grid.has(ck)) grid.set(ck, []);
        grid.get(ck).push({ segIdx, endId });
      };

      for (let i = 0; i < segs.length; i++) {
        addEndpointToGrid(i, 1, segs[i].x1, segs[i].y1);
        addEndpointToGrid(i, 2, segs[i].x2, segs[i].y2);
      }

      const used = new Uint8Array(segs.length);

      const findBestNeighbor = (px, py, prevDx, prevDy) => {
        const cx = Math.floor(px / cellSize);
        const cy = Math.floor(py / cellSize);
        let bestIdx = -1;
        let bestEnd = 0;
        let bestScore = Infinity;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = grid.get(`${cx + dx},${cy + dy}`);
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const { segIdx, endId } = bucket[b];
              if (used[segIdx]) continue;
              const s = segs[segIdx];
              const ex = endId === 1 ? s.x1 : s.x2;
              const ey = endId === 1 ? s.y1 : s.y2;
              const dist = Math.hypot(ex - px, ey - py);
              if (dist > joinEps) continue;

              // Prefer collinear continuation
              const ox = (endId === 1 ? s.x2 : s.x1) - ex;
              const oy = (endId === 1 ? s.y2 : s.y1) - ey;
              const olen = Math.hypot(ox, oy) || 1;
              const dot = (prevDx * ox + prevDy * oy) / olen; // -1..1
              const anglePenalty = (1 - dot) * joinEps * 0.4;
              const score = dist + anglePenalty;
              if (score < bestScore) {
                bestScore = score;
                bestIdx = segIdx;
                bestEnd = endId;
              }
            }
          }
        }
        return bestIdx !== -1 ? { segIdx: bestIdx, endId: bestEnd } : null;
      };

      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        const first = segs[i];

        const forward = [{ x: first.x2, y: first.y2 }];
        const backward = [{ x: first.x1, y: first.y1 }];

        // Extend forward from tail
        let curX = first.x2, curY = first.y2;
        let dirX = (first.x2 - first.x1) / (first.len || 1);
        let dirY = (first.y2 - first.y1) / (first.len || 1);
        while (true) {
          const hit = findBestNeighbor(curX, curY, dirX, dirY);
          if (!hit) break;
          used[hit.segIdx] = 1;
          const s = segs[hit.segIdx];
          const nx = hit.endId === 1 ? s.x2 : s.x1;
          const ny = hit.endId === 1 ? s.y2 : s.y1;
          dirX = (nx - curX) / (s.len || 1);
          dirY = (ny - curY) / (s.len || 1);
          curX = nx; curY = ny;
          forward.push({ x: curX, y: curY });
        }

        // Extend backward from head
        curX = first.x1; curY = first.y1;
        dirX = (first.x1 - first.x2) / (first.len || 1);
        dirY = (first.y1 - first.y2) / (first.len || 1);
        while (true) {
          const hit = findBestNeighbor(curX, curY, dirX, dirY);
          if (!hit) break;
          used[hit.segIdx] = 1;
          const s = segs[hit.segIdx];
          const nx = hit.endId === 1 ? s.x2 : s.x1;
          const ny = hit.endId === 1 ? s.y2 : s.y1;
          dirX = (nx - curX) / (s.len || 1);
          dirY = (ny - curY) / (s.len || 1);
          curX = nx; curY = ny;
          backward.push({ x: curX, y: curY });
        }

        backward.reverse();
        const chain = backward.concat(forward);

        // Compute total chain length
        let totalChainLen = 0;
        for (let k = 0; k < chain.length - 1; k++) {
          totalChainLen += Math.hypot(chain[k + 1].x - chain[k].x, chain[k + 1].y - chain[k].y);
        }
        // Prune isolated sub-threshold dust specks when detailPct < 88%
        if (chain.length === 2 && totalChainLen < minLen * 0.65) continue;

        const simp = chain.length > 2 ? rdpSimplify(chain, tol) : chain;
        for (let k = 0; k < simp.length - 1; k++) {
          if (Math.hypot(simp[k + 1].x - simp[k].x, simp[k + 1].y - simp[k].y) < 1e-6) continue;
          result.push({
            id: BlkParser.nextId('line'),
            layer: list[0].layer,
            x1: simp[k].x,
            y1: simp[k].y,
            x2: simp[k + 1].x,
            y2: simp[k + 1].y,
            move: list[0].move,
            thousandth: list[0].thousandth
          });
        }
      }
    }
    return result;
  }

  /**
   * Optimize Quads by pruning micro-degenerate quads and merging adjacent collinear quad strips.
   */
  function optimizeQuadsCollection(targetQuads, detailPct = 75) {
    if (targetQuads.length < 2) return targetQuads.map((q) => ({ ...q, tl: { ...q.tl }, tr: { ...q.tr }, br: { ...q.br }, bl: { ...q.bl } }));
    const { rdpTol, minSegLen } = detailPctToTolerances(detailPct, true);
    const minArea = Math.pow(minSegLen * 0.35, 2);

    const out = [];
    for (let i = 0; i < targetQuads.length; i++) {
      const q = targetQuads[i];
      const th = !!q.thousandth;
      const scale = th ? MIL_TO_UNIT : 1;
      // Shoelace area check
      const x0 = q.tl.x * scale, y0 = q.tl.y * scale;
      const x1 = q.tr.x * scale, y1 = q.tr.y * scale;
      const x2 = q.br.x * scale, y2 = q.br.y * scale;
      const x3 = q.bl.x * scale, y3 = q.bl.y * scale;
      const area = 0.5 * Math.abs(x0 * y1 - x1 * y0 + x1 * y2 - x2 * y1 + x2 * y3 - x3 * y2 + x3 * y0 - x0 * y3);
      const perim = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2) + Math.hypot(x0 - x3, y0 - y3);
      if (area < minArea * 0.25 && perim < minSegLen * 1.2) continue;

      // Try merging with previous quad if they share an edge and are collinear
      if (out.length > 0) {
        const prev = out[out.length - 1];
        if (prev.layer === q.layer && prev.move === q.move && prev.thousandth === q.thousandth) {
          const joinTol = (rdpTol * 0.7) / scale;
          if (Math.hypot(prev.tr.x - q.tl.x, prev.tr.y - q.tl.y) <= joinTol &&
              Math.hypot(prev.br.x - q.bl.x, prev.br.y - q.bl.y) <= joinTol) {
            const topDist = distToSegment(prev.tr.x, prev.tr.y, prev.tl.x, prev.tl.y, q.tr.x, q.tr.y);
            const botDist = distToSegment(prev.br.x, prev.br.y, prev.bl.x, prev.bl.y, q.br.x, q.br.y);
            if (topDist <= (rdpTol / scale) && botDist <= (rdpTol / scale)) {
              prev.tr = { ...q.tr };
              prev.br = { ...q.br };
              continue;
            }
          }
        }
      }

      out.push({
        ...q,
        id: BlkParser.nextId('quad'),
        tl: { ...q.tl },
        tr: { ...q.tr },
        br: { ...q.br },
        bl: { ...q.bl }
      });
    }
    return out;
  }

  /**
   * Expand current selection to all connected line segments (flood-fill across shared endpoints).
   */
  function selectConnectedChainFromSelection() {
    const startLines = state.doc.lines.filter((l) => state.selection.has(l.id));
    if (startLines.length === 0) {
      showToast('Select at least one line segment first', 'warn');
      return;
    }

    const eps = 0.0015;
    const queue = [...startLines];
    const visited = new Set(startLines.map((l) => l.id));

    while (queue.length > 0) {
      const curr = queue.pop();
      const thC = !!curr.thousandth;
      const cx1 = toCanvasUnit(curr.x1, thC), cy1 = toCanvasUnit(curr.y1, thC);
      const cx2 = toCanvasUnit(curr.x2, thC), cy2 = toCanvasUnit(curr.y2, thC);

      for (const cand of state.doc.lines) {
        if (visited.has(cand.id) || !isLayerVisible(cand.layer) || isLayerLocked(cand.layer)) continue;
        const th = !!cand.thousandth;
        const x1 = toCanvasUnit(cand.x1, th), y1 = toCanvasUnit(cand.y1, th);
        const x2 = toCanvasUnit(cand.x2, th), y2 = toCanvasUnit(cand.y2, th);
        if (
          Math.hypot(x1 - cx1, y1 - cy1) <= eps ||
          Math.hypot(x2 - cx1, y2 - cy1) <= eps ||
          Math.hypot(x1 - cx2, y1 - cy2) <= eps ||
          Math.hypot(x2 - cx2, y2 - cy2) <= eps
        ) {
          visited.add(cand.id);
          state.selection.add(cand.id);
          queue.push(cand);
        }
      }
    }

    updateSelectionUI();
    requestRender();
    showToast(`Selected ${visited.size} connected line segments`);
  }

  function extractConnectedLineChains(linesList) {
    const groups = new Map();
    for (const l of linesList) {
      const gKey = `${l.layer}|${l.move ? 1 : 0}|${l.moveRadial ? 1 : 0}|${l.thousandth ? 1 : 0}`;
      if (!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey).push(l);
    }

    const results = [];
    for (const groupLines of groups.values()) {
      const eps = 1e-4;
      const ptMap = new Map();
      const verts = [];
      function vIdx(x, y) {
        const key = `${Math.round(x / eps)}_${Math.round(y / eps)}`;
        let idx = ptMap.get(key);
        if (idx === undefined) {
          idx = verts.length;
          verts.push({ x, y, edges: [] });
          ptMap.set(key, idx);
        }
        return idx;
      }

      const edges = groupLines.map((l, ei) => {
        const u = vIdx(l.x1, l.y1);
        const v = vIdx(l.x2, l.y2);
        verts[u].edges.push(ei);
        verts[v].edges.push(ei);
        return { l, u, v, used: false };
      });

      function walkFrom(startV, startEdge) {
        const pts = [{ x: verts[startV].x, y: verts[startV].y }];
        const lineIds = [];
        let curV = startV;
        let curE = startEdge;
        while (curE >= 0 && !edges[curE].used) {
          edges[curE].used = true;
          lineIds.push(edges[curE].l.id);
          const nextV = edges[curE].u === curV ? edges[curE].v : edges[curE].u;
          pts.push({ x: verts[nextV].x, y: verts[nextV].y });
          curV = nextV;
          if (verts[curV].edges.length !== 2) break;
          const nxt = verts[curV].edges.find((ei) => !edges[ei].used);
          if (nxt === undefined) break;
          curE = nxt;
        }
        return { pts, lineIds };
      }

      // First walk from non-degree-2 vertices (endpoints & junctions)
      for (let vi = 0; vi < verts.length; vi++) {
        if (verts[vi].edges.length === 2) continue;
        for (const ei of verts[vi].edges) {
          if (edges[ei].used) continue;
          const walked = walkFrom(vi, ei);
          if (walked.pts.length >= 2) {
            results.push({ pts: walked.pts, lineIds: walked.lineIds, closed: false, template: edges[ei].l });
          }
        }
      }
      // Then closed degree-2 cycles
      for (let ei = 0; ei < edges.length; ei++) {
        if (edges[ei].used) continue;
        const walked = walkFrom(edges[ei].u, ei);
        const pts = walked.pts;
        const closed = pts.length >= 4 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= eps * 2;
        if (closed) pts.pop();
        if (pts.length >= 2) results.push({ pts, lineIds: walked.lineIds, closed, template: edges[ei].l });
      }
    }
    return results;
  }

  function convertSelectedLinesToQuads() {
    const selLines = state.doc.lines.filter((l) => state.selection.has(l.id) && !isLayerLocked(l.layer));
    if (selLines.length === 0) {
      showToast('Select one or more lines first', 'warn');
      return;
    }
    const halfW = (state.options.brushWidth || 0.004) / 2;
    const removeIds = new Set(selLines.map((l) => l.id));
    const newIds = new Set();

    const chains = extractConnectedLineChains(selLines);
    for (const ch of chains) {
      const tpl = ch.template;
      const th = !!tpl.thousandth;
      const w = fromCanvasUnit(halfW, th);
      const ribbonQuads = buildMiterRibbonQuads(ch.pts, w, { closed: ch.closed });
      for (const rq of ribbonQuads) {
        const q = {
          ...cloneItemArrayProps(tpl),
          id: BlkParser.nextId('quad'),
          layer: tpl.layer,
          tl: rq.tl,
          tr: rq.tr,
          br: rq.br,
          bl: rq.bl,
          move: tpl.move,
          thousandth: tpl.thousandth
        };
        delete q.x1; delete q.y1; delete q.x2; delete q.y2;
        state.doc.quads.push(q);
        newIds.add(q.id);
      }
    }

    state.doc.lines = state.doc.lines.filter((l) => !removeIds.has(l.id));
    for (const id of removeIds) state.selection.delete(id);
    for (const id of newIds) state.selection.add(id);
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Converted ${selLines.length} line(s) into ${newIds.size} miter-joined quads`);
  }

  function convertSelectedQuadsToLines() {
    const selQuads = state.doc.quads.filter((q) => state.selection.has(q.id) && !isLayerLocked(q.layer));
    if (selQuads.length === 0) {
      showToast('Select one or more quads first', 'warn');
      return;
    }
    const removeIds = new Set(selQuads.map((q) => q.id));
    const newIds = new Set();

    for (const q of selQuads) {
      const corners = [q.tl, q.tr, q.br, q.bl];
      const baseProps = cloneItemArrayProps(q);
      delete baseProps.tl; delete baseProps.tr; delete baseProps.br; delete baseProps.bl;
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
        const ln = {
          ...baseProps,
          id: BlkParser.nextId('line'),
          layer: q.layer,
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          move: q.move,
          thousandth: q.thousandth
        };
        state.doc.lines.push(ln);
        newIds.add(ln.id);
      }
    }

    state.doc.quads = state.doc.quads.filter((q) => !removeIds.has(q.id));
    for (const id of removeIds) state.selection.delete(id);
    for (const id of newIds) state.selection.add(id);
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Converted ${selQuads.length} quad(s) to wireframe lines`);
  }

  function smoothSelectedLines() {
    const selLines = state.doc.lines.filter((l) => state.selection.has(l.id) && !isLayerLocked(l.layer));
    if (selLines.length < 2) {
      showToast('Select 2 or more connected lines to smooth curves', 'warn');
      return;
    }

    const chains = extractConnectedLineChains(selLines);
    const removeIds = new Set();
    const newIds = new Set();
    let smoothedCount = 0;

    // Identify chains we can genuinely smooth (len >= 4 pts)
    for (const ch of chains) {
      if (ch.pts.length < 4) continue;
      smoothedCount++;
      for (const lid of ch.lineIds) removeIds.add(lid);
      const tpl = ch.template;
      const th = !!tpl.thousandth;
      const milScale = getActiveMilUnitScale();

      // Work in canvas-uniform units for accurate chord angle corner detection
      const cPts = ch.pts.map((p) => ({ x: toCanvasUnit(p.x, th, milScale), y: toCanvasUnit(p.y, th, milScale) }));
      const { pts: sm, corners } = smoothPolylineTaubin(cPts, 3, { closed: ch.closed, cornerCos: 0.52 });
      const refined = piecewiseRdpSimplify(sm, corners, 0.00018, ch.closed);

      for (let i = 0; i < refined.length - 1; i++) {
        const a = refined[i], b = refined[i + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
        const ln = {
          ...cloneItemArrayProps(tpl),
          id: BlkParser.nextId('line'),
          layer: tpl.layer,
          x1: fromCanvasUnit(a.x, th, milScale),
          y1: fromCanvasUnit(a.y, th, milScale),
          x2: fromCanvasUnit(b.x, th, milScale),
          y2: fromCanvasUnit(b.y, th, milScale),
          move: tpl.move,
          thousandth: tpl.thousandth
        };
        state.doc.lines.push(ln);
        newIds.add(ln.id);
      }
      if (ch.closed && refined.length >= 3) {
        const a = refined[refined.length - 1], b = refined[0];
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 1e-6) {
          const ln = {
            ...cloneItemArrayProps(tpl),
            id: BlkParser.nextId('line'),
            layer: tpl.layer,
            x1: fromCanvasUnit(a.x, th, milScale),
            y1: fromCanvasUnit(a.y, th, milScale),
            x2: fromCanvasUnit(b.x, th, milScale),
            y2: fromCanvasUnit(b.y, th, milScale),
            move: tpl.move,
            thousandth: tpl.thousandth
          };
          state.doc.lines.push(ln);
          newIds.add(ln.id);
        }
      }
    }

    if (smoothedCount === 0) {
      showToast('Select connected chains of 3+ segments to smooth', 'warn');
      return;
    }

    state.doc.lines = state.doc.lines.filter((l) => !removeIds.has(l.id));
    for (const id of removeIds) state.selection.delete(id);
    for (const id of newIds) state.selection.add(id);
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Smoothed ${smoothedCount} curve chain(s) while preserving sharp corners`);
  }

  function weldSelectedLineGaps() {
    const selLines = state.doc.lines.filter((l) => state.selection.has(l.id) && !isLayerLocked(l.layer));
    if (selLines.length < 2) {
      showToast('Select 2 or more lines to weld gaps', 'warn');
      return;
    }

    const milScale = getActiveMilUnitScale();
    const keyCount = new Map();
    const eps = 1e-4;
    function endKey(l, which) {
      const th = !!l.thousandth;
      const cx = toCanvasUnit(which === 1 ? l.x1 : l.x2, th, milScale);
      const cy = toCanvasUnit(which === 1 ? l.y1 : l.y2, th, milScale);
      return `${l.layer}|${Math.round(cx / eps)}_${Math.round(cy / eps)}`;
    }

    for (const l of selLines) {
      const k1 = endKey(l, 1), k2 = endKey(l, 2);
      keyCount.set(k1, (keyCount.get(k1) || 0) + 1);
      keyCount.set(k2, (keyCount.get(k2) || 0) + 1);
    }

    // Only weld genuine degree-1 loose endpoints
    const loose = [];
    for (const l of selLines) {
      const th = !!l.thousandth;
      if (keyCount.get(endKey(l, 1)) === 1) {
        loose.push({ line: l, end: 1, x: toCanvasUnit(l.x1, th, milScale), y: toCanvasUnit(l.y1, th, milScale), used: false });
      }
      if (keyCount.get(endKey(l, 2)) === 1) {
        loose.push({ line: l, end: 2, x: toCanvasUnit(l.x2, th, milScale), y: toCanvasUnit(l.y2, th, milScale), used: false });
      }
    }

    const maxWeldCanvas = Math.max(0.004, Math.min(0.035, 16 / state.cam.scale));
    let welded = 0;

    for (let i = 0; i < loose.length; i++) {
      if (loose[i].used) continue;
      let bestJ = -1;
      let bestD = maxWeldCanvas;
      for (let j = i + 1; j < loose.length; j++) {
        if (loose[j].used || loose[i].line === loose[j].line) continue;
        if (loose[i].line.layer !== loose[j].line.layer) continue;
        const d = Math.hypot(loose[j].x - loose[i].x, loose[j].y - loose[i].y);
        if (d > 1e-6 && d <= bestD) {
          bestD = d;
          bestJ = j;
        }
      }
      if (bestJ >= 0) {
        const a = loose[i], b = loose[bestJ];
        a.used = true;
        b.used = true;
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const thA = !!a.line.thousandth, thB = !!b.line.thousandth;
        const nxA = fromCanvasUnit(mx, thA, milScale), nyA = fromCanvasUnit(my, thA, milScale);
        const nxB = fromCanvasUnit(mx, thB, milScale), nyB = fromCanvasUnit(my, thB, milScale);
        if (a.end === 1) { a.line.x1 = nxA; a.line.y1 = nyA; } else { a.line.x2 = nxA; a.line.y2 = nyA; }
        if (b.end === 1) { b.line.x1 = nxB; b.line.y1 = nyB; } else { b.line.x2 = nxB; b.line.y2 = nyB; }
        welded++;
      }
    }

    if (welded === 0) {
      showToast('No loose endpoint gaps found within weld tolerance', 'warn');
      return;
    }

    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Welded ${welded} endpoint gap(s)`);
  }

  function distToSegmentSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      const ex = px - x1, ey = py - y1;
      return ex * ex + ey * ey;
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const nx = x1 + t * dx - px;
    const ny = y1 + t * dy - py;
    return nx * nx + ny * ny;
  }

  function eraseAtPoint(wx, wy) {
    const r = state.options.eraserRadius / state.cam.scale;
    const rSq = r * r;
    const minBoxX = wx - r, maxBoxX = wx + r;
    const minBoxY = wy - r, maxBoxY = wy + r;
    const visBase = state.layers.base.visible !== false && !state.layers.base.locked;
    const visDraw = state.layers.draw.visible !== false && !state.layers.draw.locked;
    let changed = false;

    // 1. In-place AABB-culled Line Eraser (zero allocations for static shapes, radial-aware when rotated)
    const milScale = getActiveMilUnitScale();
    const dropCanvas = getPreviewDropCanvas();
    const lines = state.doc.lines;
    let wLine = 0;
    for (let i = 0, len = lines.length; i < len; i++) {
      const l = lines[i];
      const editable = l.layer === 'base' ? visBase : visDraw;
      if (!editable) {
        lines[wLine++] = l;
        continue;
      }
      const scale = l.thousandth ? milScale : 1;
      let x1 = l.x1 * scale, y1 = l.y1 * scale;
      let x2 = l.x2 * scale, y2 = l.y2 * scale;
      if ((Number.isFinite(l.radialAngle) && Math.abs(l.radialAngle) > 1e-6) || (l.moveRadial && dropCanvas !== 0)) {
        const xf = getElementRadialTransform('line', l, milScale, dropCanvas);
        const p1 = rotatePointCCW(x1, y1, xf.rcx, xf.rcy, xf.totalRad);
        const p2 = rotatePointCCW(x2, y2, xf.rcx, xf.rcy, xf.totalRad);
        x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
      }

      // Fast AABB rejection
      const lMinX = x1 < x2 ? x1 : x2;
      if (maxBoxX < lMinX) { lines[wLine++] = l; continue; }
      const lMaxX = x1 > x2 ? x1 : x2;
      if (minBoxX > lMaxX) { lines[wLine++] = l; continue; }
      const lMinY = y1 < y2 ? y1 : y2;
      if (maxBoxY < lMinY) { lines[wLine++] = l; continue; }
      const lMaxY = y1 > y2 ? y1 : y2;
      if (minBoxY > lMaxY) { lines[wLine++] = l; continue; }

      if (distToSegmentSq(wx, wy, x1, y1, x2, y2) <= rSq) {
        if (state.selection.size > 0) state.selection.delete(l.id);
        changed = true;
      } else {
        lines[wLine++] = l;
      }
    }
    if (wLine !== lines.length) lines.length = wLine;

    // 2. In-place AABB-culled Quad Eraser
    const quads = state.doc.quads;
    let wQuad = 0;
    for (let i = 0, len = quads.length; i < len; i++) {
      const q = quads[i];
      const editable = q.layer === 'base' ? visBase : visDraw;
      if (!editable) {
        quads[wQuad++] = q;
        continue;
      }
      const scale = q.thousandth ? milScale : 1;
      let x0 = q.tl.x * scale, y0 = q.tl.y * scale;
      let x1 = q.tr.x * scale, y1 = q.tr.y * scale;
      let x2 = q.br.x * scale, y2 = q.br.y * scale;
      let x3 = q.bl.x * scale, y3 = q.bl.y * scale;
      if ((Number.isFinite(q.radialAngle) && Math.abs(q.radialAngle) > 1e-6) || (q.moveRadial && dropCanvas !== 0)) {
        const xf = getElementRadialTransform('quad', q, milScale, dropCanvas);
        const p0 = rotatePointCCW(x0, y0, xf.rcx, xf.rcy, xf.totalRad);
        const p1 = rotatePointCCW(x1, y1, xf.rcx, xf.rcy, xf.totalRad);
        const p2 = rotatePointCCW(x2, y2, xf.rcx, xf.rcy, xf.totalRad);
        const p3 = rotatePointCCW(x3, y3, xf.rcx, xf.rcy, xf.totalRad);
        x0 = p0.x; y0 = p0.y; x1 = p1.x; y1 = p1.y;
        x2 = p2.x; y2 = p2.y; x3 = p3.x; y3 = p3.y;
      }

      const qMinX = Math.min(x0, x1, x2, x3);
      if (maxBoxX < qMinX) { quads[wQuad++] = q; continue; }
      const qMaxX = Math.max(x0, x1, x2, x3);
      if (minBoxX > qMaxX) { quads[wQuad++] = q; continue; }
      const qMinY = Math.min(y0, y1, y2, y3);
      if (maxBoxY < qMinY) { quads[wQuad++] = q; continue; }
      const qMaxY = Math.max(y0, y1, y2, y3);
      if (minBoxY > qMaxY) { quads[wQuad++] = q; continue; }

      let hit =
        distToSegmentSq(wx, wy, x0, y0, x1, y1) <= rSq ||
        distToSegmentSq(wx, wy, x1, y1, x2, y2) <= rSq ||
        distToSegmentSq(wx, wy, x2, y2, x3, y3) <= rSq ||
        distToSegmentSq(wx, wy, x3, y3, x0, y0) <= rSq;

      if (!hit) {
        // Inline ray-cast point-in-quad without allocating array
        let inside = false;
        if ((y0 > wy) !== (y3 > wy) && wx < ((x3 - x0) * (wy - y0)) / (y3 - y0 + 1e-12) + x0) inside = !inside;
        if ((y1 > wy) !== (y0 > wy) && wx < ((x0 - x1) * (wy - y1)) / (y0 - y1 + 1e-12) + x1) inside = !inside;
        if ((y2 > wy) !== (y1 > wy) && wx < ((x1 - x2) * (wy - y2)) / (y1 - y2 + 1e-12) + x2) inside = !inside;
        if ((y3 > wy) !== (y2 > wy) && wx < ((x2 - x3) * (wy - y3)) / (y2 - y3 + 1e-12) + x3) inside = !inside;
        hit = inside;
      }

      if (hit) {
        if (state.selection.size > 0) state.selection.delete(q.id);
        changed = true;
      } else {
        quads[wQuad++] = q;
      }
    }
    if (wQuad !== quads.length) quads.length = wQuad;

    // 3. In-place Circle Eraser
    const circles = state.doc.circles;
    if (circles.length > 0) {
      let wCirc = 0;
      for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        const editable = c.layer === 'base' ? visBase : visDraw;
        if (!editable) { circles[wCirc++] = c; continue; }
        const pts = getShapePointsCanvas('circle', c);
        const cc = pts[2];
        const rad = Math.abs(pts[1].x - pts[0].x) * 0.5;
        const d = Math.abs(Math.hypot(wx - cc.x, wy - cc.y) - rad);
        if (d <= r) {
          if (state.selection.size > 0) state.selection.delete(c.id);
          changed = true;
        } else {
          circles[wCirc++] = c;
        }
      }
      if (wCirc !== circles.length) circles.length = wCirc;
    }

    // 4. In-place Text Eraser
    const texts = state.doc.texts;
    if (texts.length > 0) {
      let wTxt = 0;
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        const editable = t.layer === 'base' ? visBase : visDraw;
        if (!editable) { texts[wTxt++] = t; continue; }
        const b = getShapeBoundsCanvas('text', t);
        if (wx >= b.minX - r && wx <= b.maxX + r && wy >= b.minY - r && wy <= b.maxY + r) {
          if (state.selection.size > 0) state.selection.delete(t.id);
          changed = true;
        } else {
          texts[wTxt++] = t;
        }
      }
      if (wTxt !== texts.length) texts.length = wTxt;
    }

    if (changed) {
      if (state.drag) state.drag.erasedSomething = true;
      requestRender();
    }
  }

  function eraseAlongSweep(x0, y0, x1, y1) {
    const r = state.options.eraserRadius / state.cam.scale;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1e-5, r * 0.65);
    const steps = Math.min(24, Math.max(1, Math.ceil(dist / step)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      eraseAtPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }

  // =========================================================================
  // Camera & Fit View
  // =========================================================================
  function fitView() {
    const shapes = allShapes();
    if (shapes.length === 0) {
      state.cam.x = 0;
      state.cam.y = 0;
      if (state.doc?.docType === 'hud_preset') {
        state.cam.scale = Math.max(80, Math.min(canvasW / (16 / 9), canvasH) * 0.90);
      } else {
        state.cam.scale = Math.min(canvasW, canvasH) * 0.85;
      }
      updateZoomUI();
      requestRender();
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { kind, item } of shapes) {
      const b = getShapeBoundsCanvas(kind, item);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    if (minX > -0.65 && maxX < 0.65 && minY > -0.65 && maxY < 0.65) {
      minX = Math.min(minX, -0.04);
      minY = Math.min(minY, -0.04);
      maxX = Math.max(maxX, 0.04);
      maxY = Math.max(maxY, 0.04);
    }

    const w = Math.max(0.05, maxX - minX);
    const h = Math.max(0.05, maxY - minY);
    state.cam.x = (minX + maxX) / 2;
    state.cam.y = (minY + maxY) / 2;
    state.cam.scale = Math.min((canvasW * 0.78) / w, (canvasH * 0.78) / h);
    state.cam.scale = Math.max(80, Math.min(25000, state.cam.scale));
    updateZoomUI();
    requestRender();
  }

  function centerOrigin() {
    state.cam.x = 0;
    state.cam.y = 0;
    state.cam.scale = Math.min(canvasW, canvasH) * 0.85;
    updateZoomUI();
    requestRender();
  }

  function zoomBy(factor, pivotSx = canvasW / 2, pivotSy = canvasH / 2) {
    const before = screenToWorld(pivotSx, pivotSy);
    const nextScale = Math.max(60, Math.min(40000, state.cam.scale * factor));
    state.cam.scale = nextScale;
    const after = screenToWorld(pivotSx, pivotSy);
    state.cam.x += before.x - after.x;
    state.cam.y += before.y - after.y;
    updateZoomUI();
    requestRender();
  }

  // =========================================================================
  // High-Speed Batched Canvas Renderer
  // =========================================================================
  function getThemeColors() {
    const h = state.doc.header;
    const mode = state.previewMode;
    if (mode === 'blueprint' || mode === 'motion') {
      return {
        bgOuter: '#090d14',
        bgScope: '#0e1520',
        bgScopeEdge: '#0a0f18',
        reticle: '#e2e8f0',
        glow: null,
        grid: 'rgba(56, 189, 248, 0.08)',
        axis: 'rgba(56, 189, 248, 0.28)',
        crosshair: 'rgba(148, 163, 184, 0.35)'
      };
    }
    if (mode === 'light') {
      const c = h.crosshairLightColor;
      const stroke = c.a > 15 ? `rgba(${c.r},${c.g},${c.b},${c.a / 255})` : 'rgba(255, 56, 56, 0.95)';
      return {
        bgOuter: '#06080b',
        bgScope: '#1a201b',
        bgScopeEdge: '#101411',
        reticle: stroke,
        glow: c.a > 15 ? `rgba(${c.r},${c.g},${c.b},0.65)` : 'rgba(255, 56, 56, 0.65)',
        grid: 'rgba(255, 255, 255, 0.06)',
        axis: 'rgba(255, 110, 110, 0.25)',
        crosshair: stroke
      };
    }
    if (mode === 'thermal') {
      const c = h.crosshairThermalColor;
      const hasC = c && Number.isFinite(c.r) && c.a > 15;
      const stroke = hasC ? `rgba(${c.r},${c.g},${c.b},${c.a / 255})` : 'rgba(242, 248, 255, 0.96)';
      const lum = hasC ? (c.r + c.g + c.b) : 745;
      return {
        bgOuter: '#050608',
        bgScope: '#3a414a',
        bgScopeEdge: '#20252b',
        reticle: stroke,
        glow: lum > 60 ? `rgba(${hasC ? c.r : 200},${hasC ? c.g : 230},${hasC ? c.b : 255},0.35)` : null,
        grid: 'rgba(255, 255, 255, 0.06)',
        axis: 'rgba(220, 240, 255, 0.25)',
        crosshair: stroke
      };
    }
    if (mode === 'nvg') {
      const c = h.crosshairNvColor;
      const hasC = c && Number.isFinite(c.r) && c.a > 15;
      const stroke = hasC ? `rgba(${c.r},${c.g},${c.b},${c.a / 255})` : 'rgba(110, 255, 145, 0.95)';
      const lum = hasC ? (c.r + c.g + c.b) : 510;
      return {
        bgOuter: '#030804',
        bgScope: '#11381b',
        bgScopeEdge: '#071a0c',
        reticle: stroke,
        glow: lum > 60 ? `rgba(${hasC ? c.r : 74},${hasC ? c.g : 222},${hasC ? c.b : 128},0.48)` : null,
        grid: 'rgba(74, 222, 128, 0.07)',
        axis: 'rgba(74, 222, 128, 0.25)',
        crosshair: stroke
      };
    }
    // Day mode
    const c = h.crosshairColor;
    const reticleColor = c.a > 20 ? `rgba(${c.r},${c.g},${c.b},${c.a / 255})` : 'rgba(12, 14, 18, 0.95)';
    const chColor = c.a > 0 ? `rgba(${c.r},${c.g},${c.b},${c.a / 255})` : 'rgba(12, 14, 18, 0.28)';
    return {
      bgOuter: '#2b333b',
      bgScope: '#6d7c64',
      bgScopeEdge: '#4b5744',
      reticle: reticleColor,
      glow: null,
      grid: 'rgba(255, 255, 255, 0.1)',
      axis: 'rgba(245, 158, 11, 0.3)',
      crosshair: chColor
    };
  }

  function render() {
    needsRender = false;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const theme = getThemeColors();
    ctx.fillStyle = theme.bgOuter;
    ctx.fillRect(0, 0, canvasW, canvasH);

    const origin = worldToScreen(0, 0);
    const vpHalfX = 0.5 * (16 / 9);
    const vpHalfY = 0.5;
    const vpTL = worldToScreen(-vpHalfX, -vpHalfY);
    const vpW = vpHalfX * 2 * state.cam.scale;
    const vpH = vpHalfY * 2 * state.cam.scale;
    const vpDiagRadius = Math.hypot(vpW * 0.5, vpH * 0.5);

    // 1. In-Game 16:9 Screen Viewport Backdrop (Y: -0.5..0.5, X: -0.8889..0.8889)
    if (state.doc.header.drawSightMask) {
      const grad = ctx.createRadialGradient(origin.x, origin.y, vpDiagRadius * 0.25, origin.x, origin.y, vpDiagRadius);
      grad.addColorStop(0, theme.bgScope);
      grad.addColorStop(1, theme.bgScopeEdge);

      ctx.fillStyle = grad;
      ctx.fillRect(vpTL.x, vpTL.y, vpW, vpH);

      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.strokeRect(vpTL.x, vpTL.y, vpW, vpH);
    } else {
      ctx.fillStyle = theme.bgScope;
      ctx.fillRect(0, 0, canvasW, canvasH);

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.strokeRect(vpTL.x, vpTL.y, vpW, vpH);
    }

    // 2. Reference Image Overlay + Live Edge Preview
    if (state.refImage.img && state.refImage.visible) {
      const r = state.refImage;
      const center = worldToScreen(r.x, r.y);
      const aspect = r.img.width / (r.img.height || 1);
      const targetH = r.scale * state.cam.scale;
      const targetW = targetH * aspect;

      ctx.save();
      ctx.globalAlpha = r.opacity;
      ctx.translate(center.x, center.y);
      ctx.rotate((r.rotation * Math.PI) / 180);
      ctx.drawImage(r.img, -targetW / 2, -targetH / 2, targetW, targetH);

      const previewStyle = $('selTracePreviewStyle')?.value || 'cyan';
      if ($('chkTraceLivePreview').checked && previewStyle === 'mask' && state.tracePreview.maskCanvas) {
        const crop = state.traceCrop;
        const cx0 = crop.active ? crop.x0 : 0;
        const cy0 = crop.active ? crop.y0 : 0;
        const cx1 = crop.active ? crop.x1 : 1;
        const cy1 = crop.active ? crop.y1 : 1;
        ctx.globalAlpha = 0.88;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          state.tracePreview.maskCanvas,
          -targetW / 2 + cx0 * targetW,
          -targetH / 2 + cy0 * targetH,
          (cx1 - cx0) * targetW,
          (cy1 - cy0) * targetH
        );
        ctx.imageSmoothingEnabled = true;
      }
      ctx.restore();

      if (r.editOnCanvas) {
        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate((r.rotation * Math.PI) / 180);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(-targetW / 2, -targetH / 2, targetW, targetH);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, -targetH / 2);
        ctx.lineTo(0, -targetH / 2 - 22);
        ctx.stroke();
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(0, -targetH / 2 - 22, 5, 0, Math.PI * 2);
        ctx.fill();
        for (const [cx, cy] of [[-targetW / 2, -targetH / 2], [targetW / 2, -targetH / 2], [targetW / 2, targetH / 2], [-targetW / 2, targetH / 2]]) {
          ctx.fillRect(cx - 4.5, cy - 4.5, 9, 9);
        }
        ctx.restore();
      }

      // Crop Trace ROI Box Overlay
      if (state.traceCrop.active || state.traceCrop.editing) {
        const crop = state.traceCrop;
        const corners = [
          worldToScreen(refNormToWorld(crop.x0, crop.y0).x, refNormToWorld(crop.x0, crop.y0).y),
          worldToScreen(refNormToWorld(crop.x1, crop.y0).x, refNormToWorld(crop.x1, crop.y0).y),
          worldToScreen(refNormToWorld(crop.x1, crop.y1).x, refNormToWorld(crop.x1, crop.y1).y),
          worldToScreen(refNormToWorld(crop.x0, crop.y1).x, refNormToWorld(crop.x0, crop.y1).y)
        ];
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = state.traceCrop.editing ? 2 : 1.3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        ctx.lineTo(corners[1].x, corners[1].y);
        ctx.lineTo(corners[2].x, corners[2].y);
        ctx.lineTo(corners[3].x, corners[3].y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        if (state.traceCrop.editing) {
          ctx.fillStyle = '#f59e0b';
          for (const cp of corners) {
            ctx.fillRect(cp.x - 4.5, cp.y - 4.5, 9, 9);
          }
        }
        ctx.restore();
      }

      // Live Auto-Trace Preview Overlay
      if ($('chkTraceLivePreview').checked && (state.tracePreview.lines.length > 0 || state.tracePreview.quads.length > 0)) {
        const isContrast = previewStyle === 'contrast';
        const isMask = previewStyle === 'mask';
        ctx.save();
        if (state.tracePreview.quads.length > 0) {
          ctx.fillStyle = isContrast ? 'rgba(250, 204, 21, 0.42)' : (isMask ? 'rgba(34, 211, 238, 0.45)' : 'rgba(56, 189, 248, 0.35)');
          ctx.beginPath();
          for (const q of state.tracePreview.quads) {
            const tl = worldToScreen(q.tl.x, q.tl.y);
            const tr = worldToScreen(q.tr.x, q.tr.y);
            const br = worldToScreen(q.br.x, q.br.y);
            const bl = worldToScreen(q.bl.x, q.bl.y);
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            ctx.lineTo(bl.x, bl.y);
            ctx.closePath();
          }
          ctx.fill();
        }
        if (state.tracePreview.lines.length > 0) {
          ctx.beginPath();
          for (const l of state.tracePreview.lines) {
            const a = worldToScreen(l.x1, l.y1);
            const b = worldToScreen(l.x2, l.y2);
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
          if (isContrast) {
            ctx.strokeStyle = 'rgba(10, 14, 20, 0.85)';
            ctx.lineWidth = 3.2;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            ctx.strokeStyle = isMask ? 'rgba(34, 211, 238, 0.96)' : 'rgba(56, 189, 248, 0.88)';
            ctx.lineWidth = 1.25;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    // 3. Coordinate Grid & Symmetry Axes
    if (state.options.showGrid) {
      drawGrid(theme);
    }
    drawSymmetryGuides();

    // 4. Built-in War Thunder Central Lines, Range Ticks & HUD Preset Backdrop
    const ownPrimitives = state.doc.lines.length + state.doc.quads.length + state.doc.circles.length + state.doc.texts.length;
    if ((state.doc.docType === 'hud_preset' || state.doc.docType === 'both') && ownPrimitives === 0) {
      renderHudBackdrop(theme);
    } else {
      drawCentralSightOverlay(theme);
    }

    // 5. Batched Render of Vector Elements (Quads -> Lines -> Circles -> Texts)
    const baseLineWidth = getEffectiveLineWidth(state.doc.header);
    const effFontMult = getEffectiveFontMult(state.doc.header);
    const totalCount = state.doc.lines.length + state.doc.quads.length;

    if (theme.glow && totalCount < 6000) {
      ctx.shadowColor = theme.glow;
      ctx.shadowBlur = 7;
    } else {
      ctx.shadowBlur = 0;
    }

    const colorByMotion = isMotionColorActive();
    const colorByLayer = !colorByMotion && state.options.colorLayers;
    const groupColorStyle = (grp) => {
      if (colorByMotion) return MOTION_COLORS[grp] || theme.reticle;
      if (colorByLayer) return grp === 'base' ? LAYER_COLORS.base : LAYER_COLORS.draw;
      return theme.reticle;
    };
    const itemColorStyle = (item) => {
      if (colorByMotion) return MOTION_COLORS[getElementMotionType(item)];
      if (colorByLayer) return item.layer === 'base' ? LAYER_COLORS.base : LAYER_COLORS.draw;
      return theme.reticle;
    };

    // --- Batch Quads (Zero object allocation fast path for static, radial-aware transform when needed) ---
    const batchGroups = colorByMotion ? ['static', 'vertical', 'radial'] : (colorByLayer ? ['base', 'draw'] : ['all']);
    const selectedQuads = [];
    const halfCW = canvasW * 0.5;
    const halfCH = canvasH * 0.5;
    const camX = state.cam.x;
    const camY = state.cam.y;
    const camS = state.cam.scale;
    const hasSel = state.selection.size > 0;
    const milScale = getActiveMilUnitScale();
    const dropCanvas = getPreviewDropCanvas();

    const drawQuadPath = (q, sc) => {
      const hasAng = Number.isFinite(q.radialAngle) && Math.abs(q.radialAngle) > 1e-6;
      const hasDyn = !!(q.moveRadial && dropCanvas !== 0);
      const hasMove = !q.moveRadial && q.move && dropCanvas !== 0;

      if (!hasAng && !hasDyn && !hasMove) {
        ctx.moveTo(halfCW + (q.tl.x * sc - camX) * camS, halfCH + (q.tl.y * sc - camY) * camS);
        ctx.lineTo(halfCW + (q.tr.x * sc - camX) * camS, halfCH + (q.tr.y * sc - camY) * camS);
        ctx.lineTo(halfCW + (q.br.x * sc - camX) * camS, halfCH + (q.br.y * sc - camY) * camS);
        ctx.lineTo(halfCW + (q.bl.x * sc - camX) * camS, halfCH + (q.bl.y * sc - camY) * camS);
        ctx.closePath();
        return;
      }
      const xf = getElementRadialTransform('quad', q, milScale, dropCanvas);
      const pts = [q.tl, q.tr, q.br, q.bl];
      for (let k = 0; k < 4; k++) {
        let px = pts[k].x * sc, py = pts[k].y * sc;
        if (xf.totalRad) {
          const r = rotatePointCCW(px, py, xf.rcx, xf.rcy, xf.totalRad);
          px = r.x; py = r.y;
        }
        py += xf.shiftY;
        const sx = halfCW + (px - camX) * camS;
        const sy = halfCH + (py - camY) * camS;
        if (k === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
    };

    for (const grp of batchGroups) {
      ctx.fillStyle = groupColorStyle(grp);
      ctx.beginPath();
      let hasAny = false;
      for (let i = 0, len = state.doc.quads.length; i < len; i++) {
        const q = state.doc.quads[i];
        if (!isLayerVisible(q.layer)) continue;
        if (colorByMotion ? getElementMotionType(q) !== grp : (colorByLayer && q.layer !== grp)) continue;
        if (hasSel && state.selection.has(q.id)) selectedQuads.push(q);
        drawQuadPath(q, q.thousandth ? milScale : 1);
        hasAny = true;
      }
      if (hasAny) ctx.fill();
    }

    if (selectedQuads.length > 0) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const q of selectedQuads) {
        drawQuadPath(q, q.thousandth ? milScale : 1);
      }
      ctx.stroke();
      ctx.restore();
    }

    // --- Batch Lines (Zero object allocation fast path for static, radial-aware transform when needed) ---
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const selectedLines = [];

    const drawLinePath = (l, sc) => {
      const hasAng = Number.isFinite(l.radialAngle) && Math.abs(l.radialAngle) > 1e-6;
      const hasDyn = !!(l.moveRadial && dropCanvas !== 0);
      const hasMove = !l.moveRadial && l.move && dropCanvas !== 0;

      if (!hasAng && !hasDyn && !hasMove) {
        ctx.moveTo(halfCW + (l.x1 * sc - camX) * camS, halfCH + (l.y1 * sc - camY) * camS);
        ctx.lineTo(halfCW + (l.x2 * sc - camX) * camS, halfCH + (l.y2 * sc - camY) * camS);
        return;
      }
      const xf = getElementRadialTransform('line', l, milScale, dropCanvas);
      let x1 = l.x1 * sc, y1 = l.y1 * sc;
      let x2 = l.x2 * sc, y2 = l.y2 * sc;
      if (xf.totalRad) {
        const p1 = rotatePointCCW(x1, y1, xf.rcx, xf.rcy, xf.totalRad);
        const p2 = rotatePointCCW(x2, y2, xf.rcx, xf.rcy, xf.totalRad);
        x1 = p1.x; y1 = p1.y;
        x2 = p2.x; y2 = p2.y;
      }
      y1 += xf.shiftY;
      y2 += xf.shiftY;
      ctx.moveTo(halfCW + (x1 - camX) * camS, halfCH + (y1 - camY) * camS);
      ctx.lineTo(halfCW + (x2 - camX) * camS, halfCH + (y2 - camY) * camS);
    };

    for (const grp of batchGroups) {
      ctx.strokeStyle = groupColorStyle(grp);
      ctx.lineWidth = baseLineWidth;
      ctx.beginPath();
      let hasAny = false;
      for (let i = 0, len = state.doc.lines.length; i < len; i++) {
        const l = state.doc.lines[i];
        if (!isLayerVisible(l.layer)) continue;
        if (colorByMotion ? getElementMotionType(l) !== grp : (colorByLayer && l.layer !== grp)) continue;
        if (hasSel && state.selection.has(l.id)) {
          selectedLines.push(l);
          continue;
        }
        drawLinePath(l, l.thousandth ? milScale : 1);
        hasAny = true;
      }
      if (hasAny) ctx.stroke();
    }

    if (selectedLines.length > 0) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = baseLineWidth + 1.4;
      ctx.beginPath();
      for (const l of selectedLines) {
        drawLinePath(l, l.thousandth ? milScale : 1);
      }
      ctx.stroke();
    }

    // --- Circles ---
    for (const c of state.doc.circles) {
      if (!isLayerVisible(c.layer)) continue;
      const th = !!c.thousandth;
      const xf = getElementRadialTransform('circle', c, milScale, dropCanvas);
      let wx = toCanvasUnit(c.x, th, milScale);
      let wy = toCanvasUnit(c.y, th, milScale);
      if (xf.totalRad) {
        const p = rotatePointCCW(wx, wy, xf.rcx, xf.rcy, xf.totalRad);
        wx = p.x; wy = p.y;
      }
      wy += xf.shiftY;
      const center = worldToScreen(wx, wy);
      const rPx = Math.max(0.5, toCanvasUnit(c.diameter / 2, th, milScale) * state.cam.scale);
      const isSel = state.selection.has(c.id);

      const sRad = ((c.startAngle - 90) * Math.PI) / 180 - xf.totalRad;
      const eRad = ((c.endAngle - 90) * Math.PI) / 180 - xf.totalRad;
      ctx.beginPath();
      if (Math.abs((c.endAngle - c.startAngle) % 360) < 0.01 && Math.abs(c.endAngle - c.startAngle) >= 359.9) {
        ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
      } else {
        ctx.arc(center.x, center.y, rPx, sRad, eRad);
      }
      ctx.strokeStyle = isSel ? '#f59e0b' : itemColorStyle(c);
      const lineScaleFactor = (state.doc.header?.reticle?.included && state.doc.header?.reticle?.overridden)
        ? Math.max(0.75, 0.8 + Math.max(0, state.doc.header.reticle.lineWidth || 0) * 0.9)
        : (state.doc.header.lineSizeMult || 1);
      ctx.lineWidth = Math.max(1, (c.size || 1.5) * lineScaleFactor);
      ctx.stroke();
    }

    // --- Texts ---
    for (const t of state.doc.texts) {
      if (!isLayerVisible(t.layer)) continue;
      const th = !!t.thousandth;
      const xf = getElementRadialTransform('text', t, milScale, dropCanvas);
      let wx = toCanvasUnit(t.x, th, milScale);
      let wy = toCanvasUnit(t.y, th, milScale);
      if (xf.totalRad) {
        const p = rotatePointCCW(wx, wy, xf.rcx, xf.rcy, xf.totalRad);
        wx = p.x; wy = p.y;
      }
      wy += xf.shiftY;
      const pos = worldToScreen(wx, wy);
      const fontPx = Math.max(9, 13 * (t.size || 1) * effFontMult * (state.cam.scale / BASE_SCALE));
      const isSel = state.selection.has(t.id);

      ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = t.align === 1 ? 'left' : t.align === -1 ? 'right' : 'center';
      ctx.fillStyle = isSel ? '#f59e0b' : itemColorStyle(t);
      ctx.fillText(t.text || '', pos.x, pos.y);
    }

    ctx.shadowBlur = 0;

    // 6. Tank Sight HUD Widgets Overlay (rangefinder, turret, fov, gunReady, bulletType)
    renderHudWidgetsOverlay(theme);

    // 7. Selection Bounding Box & Handles
    renderSelectionOverlay();

    // 8. Live Tool Preview & Cursor Guides
    renderToolPreview();

    ctx.restore();
  }

  function drawGrid(theme) {
    const step = Math.max(0.001, state.options.gridStep || 0.025);
    let drawStep = step;
    while (drawStep * state.cam.scale < 14) drawStep *= 2;

    const tl = screenToWorld(0, 0);
    const br = screenToWorld(canvasW, canvasH);
    const startX = Math.floor(tl.x / drawStep) * drawStep;
    const startY = Math.floor(tl.y / drawStep) * drawStep;

    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let wx = startX; wx <= br.x; wx += drawStep) {
      const sx = worldToScreen(wx, 0).x;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, canvasH);
    }
    for (let wy = startY; wy <= br.y; wy += drawStep) {
      const sy = worldToScreen(0, wy).y;
      ctx.moveTo(0, sy);
      ctx.lineTo(canvasW, sy);
    }
    ctx.stroke();

    const origin = worldToScreen(0, 0);
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    ctx.moveTo(origin.x, 0);
    ctx.lineTo(origin.x, canvasH);
    ctx.moveTo(0, origin.y);
    ctx.lineTo(canvasW, origin.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawSymmetryGuides() {
    if (!state.options.mirrorX && !state.options.mirrorY) return;
    const origin = worldToScreen(0, 0);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (state.options.mirrorX) {
      ctx.moveTo(origin.x, 0);
      ctx.lineTo(origin.x, canvasH);
    }
    if (state.options.mirrorY) {
      ctx.moveTo(0, origin.y);
      ctx.lineTo(canvasW, origin.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function getEffectiveLineWidth(header = state.doc.header) {
    const r = header?.reticle;
    if (r && r.included && r.overridden) {
      return Math.max(1.0, 1.15 + Math.max(0, r.lineWidth || 0) * 1.4);
    }
    return Math.max(1.1, (header?.lineSizeMult || 1) * 1.4);
  }

  function getEffectiveFontMult(header = state.doc.header) {
    const r = header?.reticle;
    if (r && r.included && r.overridden) {
      return Math.max(0.1, r.fontSize || 0.7);
    }
    return Math.max(0.1, header?.fontSizeMult || 1);
  }

  function drawSingleBallisticScale(cfg, theme, activeMilScale, previewGunDropMrad, isMainScale = false, docHeader = state.doc.header) {
    const h = docHeader || state.doc.header;
    const distances = cfg.distances || [];
    if (distances.length === 0) return;

    const speed = cfg.speed || state.rangePreview.speed || 935;
    const dragK = inferDragK(cfg.bulletType, speed);
    const stretch = (cfg.radialStretch ?? 1) * (cfg.distanceStretch ?? 1);
    const effFontMult = getEffectiveFontMult(state.doc.header);
    const effLineW = getEffectiveLineWidth(state.doc.header);

    if (cfg.radial) {
      const rr = cfg.radialRadius || [70, 1];
      const R = rr[1] ? rr[0] * activeMilScale : rr[0];
      const center = cfg.distancePos || [0, 0];
      const cx = center[0] || 0;
      const cy = center[1] || 0;
      const baseRad = ((cfg.radialAngle ?? 180) * Math.PI) / 180;
      const upward = cfg.drawUpward !== false;

      const deltaTheta = rr[1]
        ? (previewGunDropMrad * stretch) / Math.max(0.01, rr[0])
        : (previewGunDropMrad * activeMilScale * stretch) / Math.max(0.01, rr[0]);

      if (state.rangePreview.active && state.rangePreview.showGuides) {
        const sc = worldToScreen(cx, cy);
        ctx.save();
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.32)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, Math.max(2, R * state.cam.scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const textOff = cfg.textPos || [0.015, 0];
      const fontMult = cfg.fontSizeMult || effFontMult || 1;
      const fontPx = Math.max(8, 12.5 * fontMult * (state.cam.scale / BASE_SCALE));
      const radialColor = isMotionColorActive() ? MOTION_COLORS.radial : theme.reticle;

      ctx.save();
      ctx.strokeStyle = radialColor;
      ctx.fillStyle = radialColor;
      ctx.lineWidth = effLineW;
      ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = cfg.textAlign === 1 ? 'left' : cfg.textAlign === -1 ? 'right' : 'center';

      const mainW = cfg.crosshairDistHorSizeMain?.[0] ?? 0.014;
      const addW = cfg.crosshairDistHorSizeAdditional?.[0] ?? 0.007;

      for (const d of distances) {
        const dropM = computeBallisticDropMrad(d.dist, speed, dragK);
        const theta = rr[1]
          ? (dropM * stretch) / Math.max(0.01, rr[0])
          : (dropM * activeMilScale * stretch) / Math.max(0.01, rr[0]);
        const phi = upward
          ? baseRad - theta + deltaTheta
          : baseRad + theta - deltaTheta;

        const ux = Math.sin(phi);
        const uy = Math.cos(phi);
        const tx = -uy;
        const ty = ux;

        if (cfg.circleMode) {
          const dotWorldR = d.minor > 0
            ? d.minor * 0.5
            : (d.major > 0 ? 0.0025 : 0.002);
          const sp = worldToScreen(cx + ux * R, cy + uy * R);
          const rPx = Math.max(1.4, dotWorldR * state.cam.scale);
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, rPx, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const tickLen = d.major > 0 ? Math.max(0.008, mainW) : Math.max(0.004, addW);
          const pA = worldToScreen(cx + ux * R, cy + uy * R);
          const pB = worldToScreen(cx + ux * (R + tickLen), cy + uy * (R + tickLen));
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.stroke();
        }

        if (d.major > 0) {
          const lx = cx + ux * (R + textOff[0]) + tx * (textOff[1] || 0);
          const ly = cy + uy * (R + textOff[0]) + ty * (textOff[1] || 0);
          const lp = worldToScreen(lx, ly);
          ctx.fillText(String(d.major), lp.x, lp.y);
        }
      }
      ctx.restore();
      return;
    }

    // Linear scale mode
    if (isMainScale && !state.options.showTicks) return;
    const mainSize = ((cfg.crosshairDistHorSizeMain?.[0] || h.crosshairDistHorSizeMain?.[0] || 0.03)) * state.cam.scale;
    const addSize = ((cfg.crosshairDistHorSizeAdditional?.[0] || h.crosshairDistHorSizeAdditional?.[0] || 0.005)) * state.cam.scale;
    const signY = h.applyCorrectionToGun === false ? 1 : -1;
    const gunShiftCanvas = previewGunDropMrad * activeMilScale * signY;
    const dStretch = cfg.distanceStretch ?? 1;
    const distScaleOffsetX = ((state.doc.header?.shotDistScaleOffset || 0) * 0.002);
    const linearColor = isMotionColorActive() ? MOTION_COLORS.vertical : theme.crosshair;

    ctx.save();
    ctx.strokeStyle = linearColor;
    ctx.fillStyle = linearColor;
    ctx.lineWidth = Math.max(1, effLineW * 0.85);
    const linFontPx = Math.max(8, 10 * effFontMult * (state.cam.scale / BASE_SCALE));
    ctx.font = `600 ${linFontPx}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const d of distances) {
      const dropY = (computeBallisticDropMrad(d.dist, speed, dragK) * activeMilScale * dStretch) + gunShiftCanvas;
      const p = worldToScreen((cfg.distancePos?.[0] || 0) + distScaleOffsetX, dropY + (cfg.distancePos?.[1] || 0));
      const w = d.major > 0 ? mainSize : addSize;
      if (w > 0.5) {
        ctx.beginPath();
        ctx.moveTo(p.x - w, p.y);
        ctx.lineTo(p.x + w, p.y);
        ctx.stroke();
      }
      if (d.major > 0) {
        ctx.fillText(String(d.major), p.x + w + 4, p.y);
      }
    }
    ctx.restore();
  }

  function drawBallisticScales(theme) {
    const h = state.doc.header;
    const activeMilScale = getActiveMilUnitScale();
    const previewGunDropMrad = getPreviewDropMrad();

    if (state.doc.distances && state.doc.distances.length > 0 && (h.radial || state.options.showTicks)) {
      drawSingleBallisticScale(h, theme, activeMilScale, previewGunDropMrad, true);
    }

    if (state.doc.ballistics && state.doc.ballistics.length > 0) {
      for (const b of state.doc.ballistics) {
        drawSingleBallisticScale(b, theme, activeMilScale, previewGunDropMrad, false);
      }
    }

    if (state.rangePreview.active) {
      if (h.drawDistanceCorrection) {
        const dcp = h.distanceCorrectionPos || [-0.26, -0.05];
        const pos = worldToScreen(dcp[0], dcp[1]);
        const fontPx = Math.max(10, 13 * getEffectiveFontMult(h) * (state.cam.scale / BASE_SCALE));
        ctx.save();
        ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
        ctx.fillStyle = theme.reticle;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(state.rangePreview.distance)} m`, pos.x, pos.y);
        ctx.restore();
      }

      if (state.rangePreview.showGuides) {
        drawPreviewRadialGuides(activeMilScale);
      }
    }
  }

  function drawPreviewRadialGuides(activeMilScale) {
    const pivots = new Map();
    for (const { kind, item } of allShapes()) {
      if (!isLayerVisible(item.layer) || !item.moveRadial) continue;
      const th = !!item.thousandth;
      const rc = Array.isArray(item.radialCenter) && item.radialCenter.length >= 2 ? item.radialCenter : [0, 0];
      const rcx = toCanvasUnit(rc[0], th, activeMilScale);
      const rcy = toCanvasUnit(rc[1], th, activeMilScale);
      const ref = getElementBaseRefCanvas(kind, item, activeMilScale);
      const rad = Math.hypot(ref.x - rcx, ref.y - rcy);
      const key = `${rcx.toFixed(4)},${rcy.toFixed(4)}`;
      if (!pivots.has(key)) pivots.set(key, { x: rcx, y: rcy, radii: [] });
      if (rad > 0.02) pivots.get(key).radii.push(rad);
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1;
    for (const p of pivots.values()) {
      const sp = worldToScreen(p.x, p.y);
      ctx.beginPath();
      ctx.moveTo(sp.x - 6, sp.y); ctx.lineTo(sp.x + 6, sp.y);
      ctx.moveTo(sp.x, sp.y - 6); ctx.lineTo(sp.x, sp.y + 6);
      ctx.stroke();
      if (p.radii.length > 0) {
        p.radii.sort((a, b) => a - b);
        const medianR = p.radii[Math.floor(p.radii.length * 0.5)];
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, medianR * state.cam.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  function drawCentralSightOverlay(theme) {
    const h = state.doc.header;
    const origin = worldToScreen(0, 0);
    const maskR = 0.6 * state.cam.scale;

    if (!(state.doc.hasSynthesizedStatic && isLayerVisible('base'))) {
      const staticColor = isMotionColorActive()
        ? MOTION_COLORS.static
        : (state.options.colorLayers ? LAYER_COLORS.base : theme.crosshair);
      ctx.save();
      ctx.strokeStyle = staticColor;
      ctx.fillStyle = staticColor;
      ctx.lineWidth = Math.max(1, getEffectiveLineWidth(h) * 0.85);

      if (h.drawCentralLineVert) {
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y - maskR);
        ctx.lineTo(origin.x, origin.y + maskR);
        ctx.stroke();
      }
      if (h.drawCentralLineHorz) {
        ctx.beginPath();
        ctx.moveTo(origin.x - maskR, origin.y);
        ctx.lineTo(origin.x + maskR, origin.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBallisticScales(theme);
  }

  // =========================================================================
  // Tank Sight HUD Preset Backdrop & Live 1920x1080 Widget Overlay
  // =========================================================================
  function hudToWorld(hx, hy) {
    return {
      x: ((hx ?? 960) - 960) / 1080,
      y: ((hy ?? 540) - 540) / 1080
    };
  }

  function worldToHud(wx, wy) {
    return {
      x: 960 + wx * 1080,
      y: 540 + wy * 1080
    };
  }

  function rgbaToCss(c, fallback = 'rgba(0, 255, 60, 1)') {
    if (!c || typeof c !== 'object') return fallback;
    const r = Math.max(0, Math.min(255, Math.round(c.r ?? 0)));
    const g = Math.max(0, Math.min(255, Math.round(c.g ?? 0)));
    const b = Math.max(0, Math.min(255, Math.round(c.b ?? 0)));
    const a = Math.max(0, Math.min(255, Math.round(c.a ?? 255))) / 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function getHudColorKeyMap(widgetName, colorMode) {
    const mode = (colorMode === 'light' || colorMode === 'nvg' || colorMode === 'thermal') ? colorMode : 'day';
    const isTextBg = widgetName === 'rangefinder' || widgetName === 'bulletType';
    if (isTextBg) {
      if (mode === 'light') return { fg: 'lightTextColor', bg: 'lightBgColor' };
      if (mode === 'nvg') return { fg: 'nightVisionTextColor', bg: 'nightVisionBgColor' };
      if (mode === 'thermal') return { fg: 'thermalTextColor', bg: 'thermalBgColor' };
      return { fg: 'textColor', bg: 'bgColor' };
    }
    if (mode === 'light') return { fg: 'lightColor', bg: null };
    if (mode === 'nvg') return { fg: 'nvColor', bg: null };
    if (mode === 'thermal') return { fg: 'thermalColor', bg: null };
    return { fg: 'color', bg: null };
  }

  function resolveHudWidgetColorsForRender(widgetName, w) {
    const pMode = state.previewMode;
    const mode = (pMode === 'light' || pMode === 'nvg' || pMode === 'thermal') ? pMode : 'day';
    const keys = getHudColorKeyMap(widgetName, mode);
    const fgObj = w[keys.fg] || { r: 0, g: 255, b: 60, a: 255 };
    const bgObj = keys.bg ? (w[keys.bg] || { r: 0, g: 0, b: 0, a: 0 }) : { r: 0, g: 0, b: 0, a: 0 };

    let fgCss = rgbaToCss(fgObj);
    if (isMotionColorActive()) {
      fgCss = MOTION_COLORS.static;
    } else if (pMode === 'blueprint' && (fgObj.r + fgObj.g + fgObj.b) < 75 && fgObj.a > 100) {
      fgCss = '#cbd5e1';
    }
    const bgCss = rgbaToCss(bgObj, 'rgba(0,0,0,0)');
    return { fgCss, bgCss, fgAlpha: fgObj.a ?? 255, bgAlpha: bgObj.a ?? 0 };
  }

  function getShellDisplayLabel(isShort) {
    const key = state.rangePreview.shellKey || 'auto';
    if (key.startsWith('doc_bullet:')) {
      const idx = parseInt(key.split(':')[1], 10);
      const bt = state.doc.ballistics?.[idx]?.bulletType || 'apcbc_tank';
      const lbt = bt.toLowerCase();
      if (lbt.includes('apds_fs')) return isShort ? 'APFSDS' : 'DM53 (APFSDS)';
      if (lbt.includes('apds')) return isShort ? 'APDS' : 'L28A1 (APDS)';
      if (lbt.includes('apcr')) return isShort ? 'APCR' : 'PzGr 40/42 (APCR)';
      if (lbt.includes('apcbc')) return isShort ? 'APCBC' : 'PzGr 39/42 (APCBC)';
      if (lbt.includes('aphe')) return isShort ? 'APHE' : 'PzGr 39 (APHE)';
      if (lbt.includes('heat')) return isShort ? 'HEATFS' : 'M456 (HEATFS)';
      if (lbt.includes('he_')) return isShort ? 'HE' : 'Sprgr. 42 (HE)';
      if (lbt.includes('smoke')) return isShort ? 'SMK' : 'NbGr. (Smoke)';
      return isShort ? 'AP' : bt;
    }
    const map = {
      panther_apcbc: isShort ? 'APCBC' : 'PzGr 39/42 (APCBC)',
      tiger_aphe: isShort ? 'APHEBC' : 'PzGr 39 (APHEBC)',
      he_700: isShort ? 'HE' : 'HE-Frag',
      apcr_1120: isShort ? 'APCR' : 'PzGr 40 (APCR)',
      apfsds_1650: isShort ? 'APFSDS' : 'DM53 (APFSDS)'
    };
    return map[key] || (isShort ? 'APFSDS' : 'M829A2 (APFSDS)');
  }

  function renderHudBackdrop(theme) {
    const h = state.doc.header;
    const bDoc = state.hudBackdrop.doc;
    const effLineW = getEffectiveLineWidth(h);
    const effFontMult = getEffectiveFontMult(h);
    const staticColor = isMotionColorActive() ? MOTION_COLORS.static : theme.crosshair;
    const reticleColor = isMotionColorActive() ? MOTION_COLORS.static : theme.reticle;
    const dropMrad = getPreviewDropMrad();
    const dropCanvas = getPreviewDropCanvas();
    const distOffX = (h.shotDistScaleOffset || 0) * 0.002;
    const signY = h.applyCorrectionToGun === false ? 1 : -1;
    const gunShiftY = dropCanvas * signY;

    ctx.save();
    if (theme.glow) {
      ctx.shadowColor = theme.glow;
      ctx.shadowBlur = 7;
    }

    if (bDoc) {
      const bh = bDoc.header || {};
      const tMode = bh.thousandthMode || 'ussr';
      const baseMil = tMode === 'nato' ? MIL_TO_UNIT * (6000 / 6400) : tMode === 'real' ? MIL_TO_UNIT * (6000 / 6283.1853) : MIL_TO_UNIT;
      const bMilScale = baseMil * (state.rangePreview.active ? (state.rangePreview.zoomMult || 1) : 1);
      const origin = worldToScreen(0, 0);
      const maskR = 0.6 * state.cam.scale;

      ctx.strokeStyle = staticColor;
      ctx.fillStyle = staticColor;
      ctx.lineWidth = Math.max(1, effLineW * 0.85);
      if (bh.drawCentralLineVert) {
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y - maskR);
        ctx.lineTo(origin.x, origin.y + maskR);
        ctx.stroke();
      }
      if (bh.drawCentralLineHorz) {
        ctx.beginPath();
        ctx.moveTo(origin.x - maskR, origin.y);
        ctx.lineTo(origin.x + maskR, origin.y);
        ctx.stroke();
      }

      if (bDoc.distances && bDoc.distances.length > 0 && (bh.radial || state.options.showTicks)) {
        drawSingleBallisticScale(bh, theme, bMilScale, dropMrad, true, bh);
      }
      if (bDoc.ballistics && bDoc.ballistics.length > 0) {
        for (const b of bDoc.ballistics) {
          drawSingleBallisticScale(b, theme, bMilScale, dropMrad, false, bh);
        }
      }

      const itemStyle = (item) => (isMotionColorActive() ? MOTION_COLORS[getElementMotionType(item)] : reticleColor);

      for (const q of bDoc.quads) {
        const sc = q.thousandth ? bMilScale : 1;
        const xf = getElementRadialTransform('quad', q, bMilScale, dropCanvas);
        const pts = [q.tl, q.tr, q.br, q.bl];
        ctx.fillStyle = itemStyle(q);
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          let px = pts[k].x * sc, py = pts[k].y * sc;
          if (xf.totalRad) {
            const r = rotatePointCCW(px, py, xf.rcx, xf.rcy, xf.totalRad);
            px = r.x; py = r.y;
          }
          py += xf.shiftY;
          const sp = worldToScreen(px, py);
          if (k === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();
        ctx.fill();
      }

      ctx.lineWidth = effLineW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const l of bDoc.lines) {
        const sc = l.thousandth ? bMilScale : 1;
        const xf = getElementRadialTransform('line', l, bMilScale, dropCanvas);
        let x1 = l.x1 * sc, y1 = l.y1 * sc;
        let x2 = l.x2 * sc, y2 = l.y2 * sc;
        if (xf.totalRad) {
          const p1 = rotatePointCCW(x1, y1, xf.rcx, xf.rcy, xf.totalRad);
          const p2 = rotatePointCCW(x2, y2, xf.rcx, xf.rcy, xf.totalRad);
          x1 = p1.x; y1 = p1.y;
          x2 = p2.x; y2 = p2.y;
        }
        const sp1 = worldToScreen(x1, y1 + xf.shiftY);
        const sp2 = worldToScreen(x2, y2 + xf.shiftY);
        ctx.strokeStyle = itemStyle(l);
        ctx.beginPath();
        ctx.moveTo(sp1.x, sp1.y);
        ctx.lineTo(sp2.x, sp2.y);
        ctx.stroke();
      }

      for (const c of bDoc.circles) {
        const th = !!c.thousandth;
        const xf = getElementRadialTransform('circle', c, bMilScale, dropCanvas);
        let wx = toCanvasUnit(c.x, th, bMilScale);
        let wy = toCanvasUnit(c.y, th, bMilScale);
        if (xf.totalRad) {
          const p = rotatePointCCW(wx, wy, xf.rcx, xf.rcy, xf.totalRad);
          wx = p.x; wy = p.y;
        }
        wy += xf.shiftY;
        const center = worldToScreen(wx, wy);
        const rPx = Math.max(0.5, toCanvasUnit(c.diameter / 2, th, bMilScale) * state.cam.scale);
        const sRad = ((c.startAngle - 90) * Math.PI) / 180 - xf.totalRad;
        const eRad = ((c.endAngle - 90) * Math.PI) / 180 - xf.totalRad;
        ctx.beginPath();
        if (Math.abs((c.endAngle - c.startAngle) % 360) < 0.01 && Math.abs(c.endAngle - c.startAngle) >= 359.9) {
          ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
        } else {
          ctx.arc(center.x, center.y, rPx, sRad, eRad);
        }
        ctx.strokeStyle = itemStyle(c);
        ctx.lineWidth = Math.max(1, (c.size || 1.5) * Math.max(0.75, effLineW * 0.7));
        ctx.stroke();
      }

      for (const t of bDoc.texts) {
        const th = !!t.thousandth;
        const xf = getElementRadialTransform('text', t, bMilScale, dropCanvas);
        let wx = toCanvasUnit(t.x, th, bMilScale);
        let wy = toCanvasUnit(t.y, th, bMilScale);
        if (xf.totalRad) {
          const p = rotatePointCCW(wx, wy, xf.rcx, xf.rcy, xf.totalRad);
          wx = p.x; wy = p.y;
        }
        wy += xf.shiftY;
        const pos = worldToScreen(wx, wy);
        const fontPx = Math.max(9, 13 * (t.size || 1) * effFontMult * (state.cam.scale / BASE_SCALE));
        ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = t.align === 1 ? 'left' : t.align === -1 ? 'right' : 'center';
        ctx.fillStyle = itemStyle(t);
        ctx.fillText(t.text || '', pos.x, pos.y);
      }

      ctx.restore();
      return;
    }

    // Built-in War Thunder reticle backdrop (Default_Sight / Standard / ariete)
    const preset = (h.crosshairPreset || '').toLowerCase();
    const zoomScale = state.rangePreview.active ? (state.rangePreview.zoomMult || 1) : 1;
    const drawSeg = (x1, y1, x2, y2) => {
      const a = worldToScreen(x1, y1);
      const b = worldToScreen(x2, y2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    const drawTxt = (txt, x, y, sizeMult = 0.65, align = 'center') => {
      const sp = worldToScreen(x, y);
      const fontPx = Math.max(8, 13 * sizeMult * effFontMult * (state.cam.scale / BASE_SCALE));
      ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = align;
      ctx.fillText(txt, sp.x, sp.y);
    };

    ctx.strokeStyle = reticleColor;
    ctx.fillStyle = reticleColor;
    ctx.lineWidth = Math.max(1, effLineW * 0.85);

    if (preset === 'ariete') {
      drawSeg(-0.011 * zoomScale, 0.013 * zoomScale, 0, 0);
      drawSeg(0, 0, 0.011 * zoomScale, 0.013 * zoomScale);
      drawSeg(-0.007 * zoomScale, 0.022 * zoomScale, 0, 0.012 * zoomScale);
      drawSeg(0, 0.012 * zoomScale, 0.007 * zoomScale, 0.022 * zoomScale);
      const oc = worldToScreen(0, 0);
      ctx.beginPath();
      ctx.arc(oc.x, oc.y, Math.max(2, 0.018 * zoomScale * state.cam.scale), 0, Math.PI * 2);
      ctx.stroke();

      drawSeg(-0.38, 0, -0.024 * zoomScale, 0);
      drawSeg(0.024 * zoomScale, 0, 0.38, 0);
      drawSeg(0, -0.34, 0, -0.024 * zoomScale);
      drawSeg(0, 0.032 * zoomScale, 0, 0.36);

      for (let mil = 4; mil <= 32; mil += 4) {
        const x = mil * 0.0095 * zoomScale;
        const isMaj = mil % 8 === 0;
        const th = (isMaj ? 0.015 : 0.008) * zoomScale;
        drawSeg(-x, 0, -x, th);
        drawSeg(x, 0, x, th);
        if (isMaj) {
          drawTxt(String(mil), -x, th + 0.016 * zoomScale, 0.65);
          drawTxt(String(mil), x, th + 0.016 * zoomScale, 0.65);
        }
      }

      ctx.strokeStyle = isMotionColorActive() ? MOTION_COLORS.vertical : reticleColor;
      ctx.fillStyle = isMotionColorActive() ? MOTION_COLORS.vertical : reticleColor;
      for (let hm = 4; hm <= 28; hm += 4) {
        const y = (hm * 0.0115 + 0.015) * zoomScale + gunShiftY;
        const isMaj = hm % 8 === 0 || hm === 4;
        const w = (isMaj ? 0.018 : 0.01) * zoomScale;
        drawSeg(distOffX - w, y, distOffX + w, y);
        drawTxt(String(hm), distOffX - w - 0.01, y, 0.62, 'right');
      }
    } else {
      // Standard War Thunder Tank Crosshair
      drawSeg(-0.48, 0, -0.008, 0);
      drawSeg(0.008, 0, 0.48, 0);
      drawSeg(-0.004, 0, 0.004, 0);
      drawSeg(0, -0.48, 0, -0.008);
      drawSeg(0, 0.008, 0, 0.48);
      drawSeg(0, -0.004, 0, 0.004);

      for (let mil = 4; mil <= 32; mil += 4) {
        const x = mil * 0.009 * zoomScale;
        const isMaj = mil % 8 === 0;
        const th = (isMaj ? 0.014 : 0.007) * zoomScale;
        drawSeg(-x, -th * 0.3, -x, th);
        drawSeg(x, -th * 0.3, x, th);
        if (isMaj) {
          drawTxt(String(mil), -x, th + 0.015 * zoomScale, 0.65);
          drawTxt(String(mil), x, th + 0.015 * zoomScale, 0.65);
        }
      }

      ctx.strokeStyle = isMotionColorActive() ? MOTION_COLORS.vertical : reticleColor;
      ctx.fillStyle = isMotionColorActive() ? MOTION_COLORS.vertical : reticleColor;
      const stdDists = [
        { dist: 200, major: 0 }, { dist: 400, major: 4 }, { dist: 600, major: 0 }, { dist: 800, major: 8 },
        { dist: 1000, major: 0 }, { dist: 1200, major: 12 }, { dist: 1400, major: 0 }, { dist: 1600, major: 16 },
        { dist: 1800, major: 0 }, { dist: 2000, major: 20 }, { dist: 2400, major: 24 }, { dist: 2800, major: 28 }
      ];
      for (const d of stdDists) {
        const y = ((d.dist / 2000) * 0.25) * zoomScale + gunShiftY;
        const isMaj = d.major > 0;
        const w = (isMaj ? 0.02 : 0.009) * zoomScale;
        drawSeg(distOffX - w, y, distOffX + w, y);
        if (isMaj) {
          drawTxt(String(d.major), distOffX - w - 0.01, y, 0.62, 'right');
        }
      }
    }

    ctx.restore();
  }

  function renderHudWidgetsOverlay(theme) {
    state.hudEditor.widgetScreenBoxes = {};
    if (!state.options.showHudOverlay) return;

    const widgets = state.doc.hudWidgets;
    if (!widgets) return;

    const hudPxScale = state.cam.scale / 1080;
    const now = performance.now();
    const simActive = state.hudSim.active;
    const simElapsed = simActive ? (now - state.hudSim.startTs) / 1000 : 0;
    const rfProg = simActive ? Math.min(1, simElapsed / state.hudSim.rfDuration) : 0;
    const reloadRem = simActive ? Math.max(0, state.hudSim.reloadDuration - simElapsed) : 0;

    ctx.save();
    ctx.shadowBlur = 0;

    // 1. FOV Brackets (zoom-responsive corner markers around center)
    const fovW = widgets.fov;
    if (fovW && fovW.included && fovW.visible) {
      const { fgCss } = resolveHudWidgetColorsForRender('fov', fovW);
      const zoom = state.rangePreview.active ? (state.rangePreview.zoomMult || 1) : 1;
      const bx = 0.28 / Math.sqrt(zoom);
      const by = 0.19 / Math.sqrt(zoom);
      const bl = 0.028;
      ctx.strokeStyle = fgCss;
      ctx.lineWidth = Math.max(1.3, 1.8 * hudPxScale);
      const corners = [
        [-bx, -by, 1, 1],
        [bx, -by, -1, 1],
        [-bx, by, 1, -1],
        [bx, by, -1, -1]
      ];
      ctx.beginPath();
      for (const [cx, cy, sxDir, syDir] of corners) {
        const p = worldToScreen(cx, cy);
        const hEnd = worldToScreen(cx + bl * sxDir, cy);
        const vEnd = worldToScreen(cx, cy + bl * syDir);
        ctx.moveTo(hEnd.x, hEnd.y);
        ctx.lineTo(p.x, p.y);
        ctx.lineTo(vEnd.x, vEnd.y);
      }
      ctx.stroke();
    }

    // 2. Turret Orientation Silhouette Indicator
    const turretW = widgets.turret;
    if (turretW && turretW.included && turretW.visible) {
      const pos = Array.isArray(turretW.position) ? turretW.position : [489.75, 726.75];
      const wp = hudToWorld(pos[0], pos[1]);
      const sp = worldToScreen(wp.x, wp.y);
      const { fgCss } = resolveHudWidgetColorsForRender('turret', turretW);
      const s = Math.max(0.35, hudPxScale);
      const hullW = 28 * s;
      const hullH = 44 * s;
      const trackW = 5 * s;

      ctx.strokeStyle = fgCss;
      ctx.lineWidth = Math.max(1.2, 1.6 * s);
      // Hull & Tracks
      ctx.strokeRect(sp.x - hullW * 0.5, sp.y - hullH * 0.5, hullW, hullH);
      ctx.strokeRect(sp.x - hullW * 0.5 - trackW, sp.y - hullH * 0.5, trackW, hullH);
      ctx.strokeRect(sp.x + hullW * 0.5, sp.y - hullH * 0.5, trackW, hullH);
      // Front hull chevron
      ctx.beginPath();
      ctx.moveTo(sp.x - hullW * 0.35, sp.y - hullH * 0.36);
      ctx.lineTo(sp.x, sp.y - hullH * 0.48);
      ctx.lineTo(sp.x + hullW * 0.35, sp.y - hullH * 0.36);
      // Turret ring & barrel
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y + 3 * s, 10 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y - 7 * s);
      ctx.lineTo(sp.x, sp.y - hullH * 0.5 - 16 * s);
      ctx.stroke();

      state.hudEditor.widgetScreenBoxes.turret = {
        x: sp.x - hullW * 0.5 - trackW - 4,
        y: sp.y - hullH * 0.5 - 18 * s,
        w: hullW + trackW * 2 + 8,
        h: hullH + 22 * s,
        cx: sp.x,
        cy: sp.y
      };
    }

    // 3. Rangefinder Readout + Progress Bar
    const rfW = widgets.rangefinder;
    if (rfW && rfW.included && rfW.visible) {
      const pos = Array.isArray(rfW.position) ? rfW.position : [1024.5, 549.75];
      const wp = hudToWorld(pos[0], pos[1]);
      const sp = worldToScreen(wp.x, wp.y);
      const { fgCss, bgCss, bgAlpha } = resolveHudWidgetColorsForRender('rangefinder', rfW);
      const fontPx = Math.max(9, (rfW.textSize || 20) * hudPxScale);
      const fontFamily = rfW.font && rfW.font !== 'hud' ? rfW.font : '"Segoe UI", sans-serif';
      ctx.font = `700 ${fontPx}px ${fontFamily}`;

      const labelText = (simActive && rfProg < 1)
        ? 'RANGING...'
        : (state.rangePreview.active ? `${Math.round(state.rangePreview.distance)} m` : '1250 m');

      const tm = ctx.measureText(labelText);
      const padX = Math.max(4, fontPx * 0.35);
      const padY = Math.max(2, fontPx * 0.2);
      const barH = Math.max(3, fontPx * 0.22);
      const showBar = simActive || state.rangePreview.active || state.hudEditor.selectedWidget === 'rangefinder';
      const boxW = Math.max(54 * hudPxScale, tm.width + padX * 2);
      const boxH = fontPx + padY * 2 + (showBar ? barH + 3 : 0);
      const boxX = sp.x - boxW * 0.5;
      const boxY = sp.y - boxH * 0.5;

      if (bgAlpha > 0) {
        ctx.fillStyle = bgCss;
        ctx.fillRect(boxX, boxY, boxW, boxH);
      }

      ctx.fillStyle = fgCss;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, sp.x, boxY + padY + fontPx * 0.52);

      if (showBar) {
        const bx = boxX + padX * 0.5;
        const by = boxY + fontPx + padY + 2;
        const bw = boxW - padX;
        const pct = simActive ? rfProg : 0.68;
        const pbg = rfW.progressBackgroundColor;
        if (pbg && pbg.a > 0) {
          ctx.fillStyle = rgbaToCss(pbg);
          ctx.fillRect(bx, by, bw, barH);
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
          ctx.fillRect(bx, by, bw, barH);
        }
        ctx.fillStyle = rgbaToCss(rfW.progressColor, 'rgba(255, 255, 0, 1)');
        ctx.fillRect(bx, by, bw * pct, barH);
      }

      state.hudEditor.widgetScreenBoxes.rangefinder = { x: boxX, y: boxY, w: boxW, h: boxH, cx: sp.x, cy: sp.y };
    }

    // 4. GunReady Mark & Reload Countdown
    const readyW = widgets.gunReady;
    if (readyW && readyW.included && readyW.visible) {
      const pos = Array.isArray(readyW.position) ? readyW.position : [831, 549.75];
      const wp = hudToWorld(pos[0], pos[1]);
      const sp = worldToScreen(wp.x, wp.y);
      const { fgCss } = resolveHudWidgetColorsForRender('gunReady', readyW);
      const isReloading = simActive && reloadRem > 0;
      const drawColor = isReloading ? 'rgba(248, 113, 113, 0.96)' : fgCss;
      const fontPx = Math.max(9, (readyW.textSize || 20) * hudPxScale);
      const fontFamily = readyW.font && readyW.font !== 'hud' ? readyW.font : '"Segoe UI", sans-serif';
      ctx.font = `700 ${fontPx}px ${fontFamily}`;

      const showMark = readyW.gunReadyMarkVisible !== false;
      const showCd = readyW.gunReadyReloadCountdownVisible !== false;
      const cdText = showCd ? (isReloading ? `${reloadRem.toFixed(1)}s` : 'READY') : '';
      const tmW = cdText ? ctx.measureText(cdText).width : 0;
      const markSz = showMark ? Math.max(7, fontPx * 0.56) : 0;
      const gap = (showMark && showCd) ? Math.max(4, fontPx * 0.3) : 0;
      const contentW = Math.max(18, markSz + gap + tmW);
      const boxW = contentW + 10;
      const boxH = Math.max(18, fontPx + 6);
      const boxX = sp.x - boxW * 0.5;
      const boxY = sp.y - boxH * 0.5;

      let curX = sp.x - contentW * 0.5;
      if (showMark) {
        ctx.strokeStyle = drawColor;
        ctx.fillStyle = drawColor;
        ctx.lineWidth = Math.max(1.2, fontPx * 0.09);
        const mx = curX;
        const my = sp.y - markSz * 0.5;
        ctx.strokeRect(mx, my, markSz, markSz);
        if (!isReloading) {
          ctx.fillRect(mx + markSz * 0.25, my + markSz * 0.25, markSz * 0.5, markSz * 0.5);
        }
        curX += markSz + gap;
      }
      if (showCd && cdText) {
        ctx.fillStyle = drawColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(cdText, curX, sp.y + 0.5);
      }

      state.hudEditor.widgetScreenBoxes.gunReady = { x: boxX, y: boxY, w: boxW, h: boxH, cx: sp.x, cy: sp.y };
    }

    // 5. BulletType Readout
    const btW = widgets.bulletType;
    if (btW && btW.included && btW.visible) {
      const pos = Array.isArray(btW.position) ? btW.position : [483.75, 273.75];
      const wp = hudToWorld(pos[0], pos[1]);
      const sp = worldToScreen(wp.x, wp.y);
      const { fgCss, bgCss, bgAlpha } = resolveHudWidgetColorsForRender('bulletType', btW);
      const fontPx = Math.max(10, (btW.textSize || 30) * hudPxScale);
      const fontFamily = btW.font && btW.font !== 'hud' ? btW.font : '"Segoe UI", sans-serif';
      ctx.font = `700 ${fontPx}px ${fontFamily}`;

      const labelText = getShellDisplayLabel(!!btW.isShortName);
      const tm = ctx.measureText(labelText);
      const padX = Math.max(5, fontPx * 0.32);
      const padY = Math.max(2, fontPx * 0.16);
      const boxW = tm.width + padX * 2;
      const boxH = fontPx + padY * 2;
      const boxX = sp.x - boxW * 0.5;
      const boxY = sp.y - boxH * 0.5;

      if (bgAlpha > 0) {
        ctx.fillStyle = bgCss;
        ctx.fillRect(boxX, boxY, boxW, boxH);
      }
      ctx.fillStyle = fgCss;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, sp.x, sp.y + 0.5);

      state.hudEditor.widgetScreenBoxes.bulletType = { x: boxX, y: boxY, w: boxW, h: boxH, cx: sp.x, cy: sp.y };
    }

    // 6. Direct-Drag Edit Outlines, Coordinates & Snap Alignment Guides
    if (state.hudEditor.editOnCanvas) {
      const selName = state.hudEditor.selectedWidget;
      for (const [wName, box] of Object.entries(state.hudEditor.widgetScreenBoxes)) {
        const isSel = wName === selName;
        ctx.strokeStyle = isSel ? '#38bdf8' : 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = isSel ? 1.4 : 1;
        ctx.setLineDash(isSel ? [4, 3] : [2, 3]);
        ctx.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
        ctx.setLineDash([]);

        if (isSel) {
          const wObj = widgets[wName];
          const p = wObj?.position || [960, 540];
          const tag = `${wName} (${Math.round(p[0] * 100) / 100}, ${Math.round(p[1] * 100) / 100})`;
          ctx.font = '600 10.5px "Segoe UI", sans-serif';
          const tw = ctx.measureText(tag).width + 8;
          ctx.fillStyle = 'rgba(13, 14, 17, 0.88)';
          ctx.fillRect(box.x - 3, box.y - 20, tw, 15);
          ctx.fillStyle = '#38bdf8';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, box.x + 1, box.y - 12.5);
        }
      }

      if (state.hudEditor.snapGuides && state.hudEditor.snapGuides.length > 0) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.78)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        for (const g of state.hudEditor.snapGuides) {
          if (g.axis === 'x') {
            const sx = worldToScreen(hudToWorld(g.val, 540).x, 0).x;
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, canvasH);
          } else {
            const sy = worldToScreen(0, hudToWorld(960, g.val).y).y;
            ctx.moveTo(0, sy);
            ctx.lineTo(canvasW, sy);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }

  function hitTestHudWidgetScreen(sx, sy) {
    if (!state.options.showHudOverlay || !state.hudEditor.editOnCanvas) return null;
    const order = ['bulletType', 'gunReady', 'rangefinder', 'turret'];
    for (const name of order) {
      const box = state.hudEditor.widgetScreenBoxes[name];
      if (!box) continue;
      if (sx >= box.x - 4 && sx <= box.x + box.w + 4 && sy >= box.y - 4 && sy <= box.y + box.h + 4) {
        return name;
      }
    }
    return null;
  }

  function drawCentralSightOverlay(theme) {
    const h = state.doc.header;
    const origin = worldToScreen(0, 0);
    const maskR = 0.6 * state.cam.scale;

    if (!(state.doc.hasSynthesizedStatic && isLayerVisible('base'))) {
      const staticColor = isMotionColorActive()
        ? MOTION_COLORS.static
        : (state.options.colorLayers ? LAYER_COLORS.base : theme.crosshair);
      ctx.save();
      ctx.strokeStyle = staticColor;
      ctx.fillStyle = staticColor;
      ctx.lineWidth = Math.max(1, getEffectiveLineWidth(h) * 0.85);

      if (h.drawCentralLineVert) {
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y - maskR);
        ctx.lineTo(origin.x, origin.y + maskR);
        ctx.stroke();
      }
      if (h.drawCentralLineHorz) {
        ctx.beginPath();
        ctx.moveTo(origin.x - maskR, origin.y);
        ctx.lineTo(origin.x + maskR, origin.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBallisticScales(theme);
  }

  function renderSelectionOverlay() {
    if (state.selection.size === 0) return;
    const bounds = getSelectionBoundsCanvas();
    if (!bounds) return;

    const tl = worldToScreen(bounds.minX, bounds.minY);
    const br = worldToScreen(bounds.maxX, bounds.maxY);

    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.setLineDash([]);

    const topMidX = (tl.x + br.x) / 2;
    ctx.beginPath();
    ctx.moveTo(topMidX, tl.y);
    ctx.lineTo(topMidX, tl.y - 24);
    ctx.stroke();
    ctx.fillStyle = '#0d1014';
    ctx.beginPath();
    ctx.arc(topMidX, tl.y - 24, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const corners = [
      { x: tl.x, y: tl.y },
      { x: br.x, y: tl.y },
      { x: br.x, y: br.y },
      { x: tl.x, y: br.y }
    ];
    for (const c of corners) {
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(c.x - 4, c.y - 4, 8, 8);
    }

    const selected = getSelectedEntries();
    const activeMilScale = getActiveMilUnitScale();
    const dropCanvas = getPreviewDropCanvas();

    // Draw pivot crosshair for selected moveRadial items
    for (const { kind, item } of selected) {
      if (!item.moveRadial) continue;
      const th = !!item.thousandth;
      const rc = Array.isArray(item.radialCenter) && item.radialCenter.length >= 2 ? item.radialCenter : [0, 0];
      const rcx = toCanvasUnit(rc[0], th, activeMilScale);
      const rcy = toCanvasUnit(rc[1], th, activeMilScale);
      const sp = worldToScreen(rcx, rcy);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(sp.x - 7, sp.y); ctx.lineTo(sp.x + 7, sp.y);
      ctx.moveTo(sp.x, sp.y - 7); ctx.lineTo(sp.x, sp.y + 7);
      ctx.stroke();
      if (selected.length === 1) {
        const pts = getShapePointsCanvas(kind, item);
        const ref = pts[0] || { x: rcx, y: rcy };
        const rp = worldToScreen(ref.x, ref.y);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(rp.x, rp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      break;
    }

    if (selected.length === 1) {
      const { kind, item } = selected[0];
      if (kind === 'line') {
        const pts = getShapePointsCanvas('line', item);
        for (const pt of [worldToScreen(pts[0].x, pts[0].y), worldToScreen(pts[1].x, pts[1].y)]) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#38bdf8';
          ctx.fill();
          ctx.strokeStyle = '#0d1014';
          ctx.stroke();
        }
      } else if (kind === 'quad') {
        const pts = getShapePointsCanvas('quad', item);
        for (let i = 0; i < 4; i++) {
          const pt = worldToScreen(pts[i].x, pts[i].y);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = '#38bdf8';
          ctx.fill();
          ctx.strokeStyle = '#0d1014';
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  function renderToolPreview() {
    ctx.save();

    if (state.pointer.inside && state.pointer.snapHit && state.tool !== 'select' && state.tool !== 'pan' && state.tool !== 'eraser') {
      const sp = worldToScreen(state.pointer.snappedX, state.pointer.snappedY);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (state.drag && state.drag.type === 'marquee') {
      const a = worldToScreen(state.drag.startX, state.drag.startY);
      const b = worldToScreen(state.drag.currX, state.drag.currY);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    if (state.tool === 'line') {
      const start = state.drag?.type === 'line' ? { x: state.drag.x1, y: state.drag.y1 } : state.pendingLineStart;
      const end = state.drag?.type === 'line' ? { x: state.drag.x2, y: state.drag.y2 } : (state.pendingLineStart ? { x: state.pointer.snappedX, y: state.pointer.snappedY } : null);
      if (start && end) {
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 2;
        for (const { sx, sy } of getMirrorTransforms()) {
          const p1 = worldToScreen(start.x * sx, start.y * sy);
          const p2 = worldToScreen(end.x * sx, end.y * sy);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    }

    if (state.drag && state.drag.type === 'freehand' && state.drag.points.length > 1) {
      ctx.strokeStyle = '#34d399';
      ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
      ctx.lineWidth = state.options.brushMode === 'quadRibbon'
        ? Math.max(2, state.options.brushWidth * state.cam.scale)
        : 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const { sx, sy } of getMirrorTransforms()) {
        ctx.beginPath();
        state.drag.points.forEach((pt, idx) => {
          const sp = worldToScreen(pt.x * sx, pt.y * sy);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        if (state.options.brushMode === 'closedFill') {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
      }
      if (state.options.brushStabilizer > 0.05 && state.drag.stabilizerPt) {
        const sPos = worldToScreen(state.drag.stabilizerPt.x, state.drag.stabilizerPt.y);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sPos.x, sPos.y);
        ctx.lineTo(state.pointer.screenX, state.pointer.screenY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if ((state.tool === 'polyline' || state.tool === 'polygon' || state.tool === 'spline') && state.polyPoints.length > 0) {
      const firstSp = worldToScreen(state.polyPoints[0].x, state.polyPoints[0].y);
      const nearStartClose = state.polyPoints.length >= 3 && Math.hypot(state.pointer.screenX - firstSp.x, state.pointer.screenY - firstSp.y) <= 10;
      const rawPts = nearStartClose
        ? state.polyPoints.slice()
        : state.polyPoints.concat([{ x: state.pointer.snappedX, y: state.pointer.snappedY }]);
      const previewPts = state.tool === 'spline'
        ? evaluateCatmullRomSpline(rawPts, state.options.splineSegs, nearStartClose)
        : rawPts;
      ctx.strokeStyle = '#34d399';
      ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
      ctx.lineWidth = state.tool === 'spline' && state.options.splineMode === 'quadRibbon'
        ? Math.max(2, state.options.brushWidth * state.cam.scale)
        : 2;
      for (const { sx, sy } of getMirrorTransforms()) {
        ctx.beginPath();
        previewPts.forEach((pt, idx) => {
          const sp = worldToScreen(pt.x * sx, pt.y * sy);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        if (state.tool === 'polygon' && previewPts.length >= 3) {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
      }
      for (let i = 0; i < state.polyPoints.length; i++) {
        const sp = worldToScreen(state.polyPoints[i].x, state.polyPoints[i].y);
        ctx.beginPath();
        const isStartAnchor = i === 0 && (state.tool === 'polygon' || state.tool === 'spline');
        ctx.arc(sp.x, sp.y, isStartAnchor && nearStartClose ? 7 : (i === 0 ? 5 : 3.5), 0, Math.PI * 2);
        ctx.fillStyle = isStartAnchor ? '#f59e0b' : '#34d399';
        ctx.fill();
      }
    }

    if (state.drag && state.drag.type === 'rect') {
      const { x1, y1, x2, y2 } = state.drag;
      ctx.strokeStyle = '#34d399';
      ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
      ctx.lineWidth = 2;
      for (const { sx, sy } of getMirrorTransforms()) {
        const a = worldToScreen(x1 * sx, y1 * sy);
        const b = worldToScreen(x2 * sx, y2 * sy);
        const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y);
        const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
        if (state.options.shapeMode === 'quads') ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }

    if (state.drag && state.drag.type === 'circle') {
      const { cx, cy, r } = state.drag;
      const rPx = r * state.cam.scale;
      const sRad = ((state.options.arcStart - 90) * Math.PI) / 180;
      const eRad = ((state.options.arcEnd - 90) * Math.PI) / 180;
      const full = Math.abs(state.options.arcEnd - state.options.arcStart) >= 359.9;
      ctx.strokeStyle = '#34d399';
      ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
      ctx.lineWidth = 2;
      for (const { sx, sy } of getMirrorTransforms()) {
        const sc = worldToScreen(cx * sx, cy * sy);
        ctx.beginPath();
        if (full) {
          ctx.arc(sc.x, sc.y, rPx, 0, Math.PI * 2);
        } else {
          if (state.options.shapeMode === 'quads') ctx.moveTo(sc.x, sc.y);
          ctx.arc(sc.x, sc.y, rPx, sRad, eRad);
          if (state.options.shapeMode === 'quads') ctx.closePath();
        }
        if (state.options.shapeMode === 'quads') ctx.fill();
        ctx.stroke();
      }
    }

    if (state.drag && state.drag.type === 'shape' && state.drag.r > 1e-5) {
      const pts = buildStampVertices(state.drag.cx, state.drag.cy, state.drag.r, state.drag.rot);
      ctx.strokeStyle = '#34d399';
      ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
      ctx.lineWidth = 2;
      for (const { sx, sy } of getMirrorTransforms()) {
        ctx.beginPath();
        pts.forEach((p, idx) => {
          const sp = worldToScreen(p.x * sx, p.y * sy);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
        if (state.options.shapeMode === 'quads') ctx.fill();
        ctx.stroke();
      }
    }

    if (state.tool === 'eraser' && state.pointer.inside) {
      ctx.strokeStyle = '#ef4444';
      ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(state.pointer.screenX, state.pointer.screenY, state.options.eraserRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  // =========================================================================
  // Pointer Interaction Handling
  // =========================================================================
  function getCanvasMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top
    };
  }

  function updatePointer(sx, sy, shiftKey) {
    const w = screenToWorld(sx, sy);
    const snapped = snapWorldPoint(w.x, w.y, shiftKey && state.tool === 'line');
    state.pointer.screenX = sx;
    state.pointer.screenY = sy;
    state.pointer.worldX = w.x;
    state.pointer.worldY = w.y;
    state.pointer.snappedX = snapped.x;
    state.pointer.snappedY = snapped.y;
    state.pointer.snapHit = snapped.hit;
    state.pointer.inside = true;
    $('hudCoords').textContent = `X: ${formatCoord(snapped.x)}  Y: ${formatCoord(snapped.y)}`;
  }

  function finishPoly(commit, closed = false) {
    if (commit && state.polyPoints.length >= 2) {
      if (state.tool === 'polyline') {
        addPolylineSymmetric(state.polyPoints, 'lines', state.options.brushWidth, 'draw');
        pushHistory();
      } else if (state.tool === 'spline') {
        const curvePts = evaluateCatmullRomSpline(state.polyPoints, state.options.splineSegs, closed && state.polyPoints.length >= 3);
        addPolylineSymmetric(curvePts, state.options.splineMode, state.options.brushWidth, 'draw', { closed: closed && state.polyPoints.length >= 3 });
        pushHistory();
      } else if (state.tool === 'polygon' && state.polyPoints.length >= 3) {
        addPolygonSymmetric(state.polyPoints, 'draw');
        pushHistory();
      }
    }
    state.polyPoints = [];
    requestRender();
  }

  canvas.addEventListener('mousedown', (e) => {
    const { sx, sy } = getCanvasMousePos(e);
    updatePointer(sx, sy, e.shiftKey);

    if (e.button === 1 || state.tool === 'pan' || state.spacePanning) {
      state.drag = {
        type: 'pan',
        startSx: sx,
        startSy: sy,
        origCamX: state.cam.x,
        origCamY: state.cam.y
      };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;

    const wx = state.pointer.worldX;
    const wy = state.pointer.worldY;
    const px = state.pointer.snappedX;
    const py = state.pointer.snappedY;

    // Crop ROI box manipulation takes priority when Crop Trace Area mode is toggled
    const cropH = getTraceCropHandleAtScreen(sx, sy);
    if (cropH) {
      const c = state.traceCrop;
      if (cropH.type === 'trace-crop-draw') {
        c.active = true;
        c.x0 = cropH.startU;
        c.y0 = cropH.startV;
        c.x1 = cropH.startU;
        c.y1 = cropH.startV;
      }
      state.drag = {
        ...cropH,
        orig: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }
      };
      return;
    }

    // Direct Reference Image manipulation on canvas when active
    const refHandle = getRefImageHandleAtScreen(sx, sy);
    if (refHandle) {
      const r = state.refImage;
      state.drag = {
        type: refHandle.type,
        startX: wx,
        startY: wy,
        origX: r.x,
        origY: r.y,
        origScale: r.scale,
        origRot: r.rotation,
        origDist: Math.max(0.01, Math.hypot(wx - r.x, wy - r.y)),
        startAngle: Math.atan2(wy - r.y, wx - r.x)
      };
      return;
    }

    // Direct HUD Widget dragging on canvas when Drag HUD is active
    if (state.tool === 'select') {
      const hudHit = hitTestHudWidgetScreen(sx, sy);
      if (hudHit) {
        const wObj = state.doc.hudWidgets?.[hudHit];
        state.hudEditor.selectedWidget = hudHit;
        syncHudPresetUIFromDoc();
        const curPos = Array.isArray(wObj?.position) ? wObj.position : [960, 540];
        state.drag = {
          type: 'hud-widget',
          name: hudHit,
          startWx: wx,
          startWy: wy,
          origPos: [curPos[0] ?? 960, curPos[1] ?? 540],
          moved: false
        };
        canvas.style.cursor = 'grabbing';
        requestRender();
        return;
      }
    }

    // Reset rangefinder simulation back to 0m before committing edits so coordinates remain unskewed
    if (state.rangePreview.active && (state.rangePreview.distance > 0 || state.rangePreview.playing)) {
      state.rangePreview.playing = false;
      setPreviewDistance(0);
      syncRangePreviewUI();
      showToast('Range Preview reset to 0 m for editing', 'warn');
    }

    switch (state.tool) {
      case 'select': {
        const handle = getHandleAtScreenPos(sx, sy);
        if (handle) {
          if (handle.type === 'vertex') {
            state.drag = {
              type: 'vertex',
              item: handle.item,
              key: handle.key,
              moved: false
            };
          } else if (handle.type === 'rotate') {
            const b = handle.bounds;
            state.drag = {
              type: 'rotate',
              cx: b.cx,
              cy: b.cy,
              startAngle: Math.atan2(wy - b.cy, wx - b.cx),
              snapshot: cloneDocDrawState(state.doc),
              moved: false
            };
          } else if (handle.type === 'scale') {
            const b = handle.bounds;
            const anchor = {
              x: handle.corner.includes('w') ? b.maxX : b.minX,
              y: handle.corner.includes('n') ? b.maxY : b.minY
            };
            state.drag = {
              type: 'scale',
              anchor,
              origW: Math.max(1e-5, b.maxX - b.minX),
              origH: Math.max(1e-5, b.maxY - b.minY),
              corner: handle.corner,
              snapshot: cloneDocDrawState(state.doc),
              moved: false
            };
          }
          return;
        }

        const hit = hitTestPoint(wx, wy);
        if (hit) {
          if (e.shiftKey) {
            if (state.selection.has(hit.item.id)) state.selection.delete(hit.item.id);
            else state.selection.add(hit.item.id);
          } else if (!state.selection.has(hit.item.id)) {
            state.selection.clear();
            state.selection.add(hit.item.id);
          }
          updateSelectionUI();
          state.drag = {
            type: 'move',
            lastX: wx,
            lastY: wy,
            moved: false
          };
          requestRender();
        } else {
          if (!e.shiftKey) {
            state.selection.clear();
            updateSelectionUI();
          }
          state.drag = {
            type: 'marquee',
            startX: wx,
            startY: wy,
            currX: wx,
            currY: wy,
            additive: e.shiftKey
          };
          requestRender();
        }
        break;
      }

      case 'line': {
        if (state.pendingLineStart) {
          let endPt = { x: px, y: py };
          if (e.shiftKey) {
            endPt = snapAngle(state.pendingLineStart.x, state.pendingLineStart.y, wx, wy, 15);
          }
          if (Math.hypot(endPt.x - state.pendingLineStart.x, endPt.y - state.pendingLineStart.y) > 1e-5) {
            addLineSymmetric(state.pendingLineStart.x, state.pendingLineStart.y, endPt.x, endPt.y, 'draw');
            pushHistory();
          }
          state.pendingLineStart = null;
          requestRender();
        } else {
          state.drag = {
            type: 'line',
            startSx: sx,
            startSy: sy,
            x1: px,
            y1: py,
            x2: px,
            y2: py
          };
        }
        break;
      }

      case 'polyline':
        {
          let pt = { x: px, y: py };
          if (e.shiftKey && state.polyPoints.length > 0) {
            const prev = state.polyPoints[state.polyPoints.length - 1];
            pt = snapAngle(prev.x, prev.y, wx, wy, 15);
          }
          state.polyPoints.push(pt);
          requestRender();
          break;
        }

      case 'spline': {
        if (state.polyPoints.length >= 3) {
          const first = worldToScreen(state.polyPoints[0].x, state.polyPoints[0].y);
          if (Math.hypot(sx - first.x, sy - first.y) <= 10) {
            finishPoly(true, true);
            return;
          }
        }
        let pt = { x: px, y: py };
        if (e.shiftKey && state.polyPoints.length > 0) {
          const prev = state.polyPoints[state.polyPoints.length - 1];
          pt = snapAngle(prev.x, prev.y, wx, wy, 15);
        }
        state.polyPoints.push(pt);
        requestRender();
        break;
      }

      case 'polygon': {
        if (state.polyPoints.length >= 3) {
          const first = worldToScreen(state.polyPoints[0].x, state.polyPoints[0].y);
          if (Math.hypot(sx - first.x, sy - first.y) <= 10) {
            finishPoly(true);
            return;
          }
        }
        state.polyPoints.push({ x: px, y: py });
        requestRender();
        break;
      }

      case 'freehand': {
        state.drag = {
          type: 'freehand',
          points: [{ x: wx, y: wy }],
          stabilizerPt: { x: wx, y: wy }
        };
        requestRender();
        break;
      }

      case 'rect': {
        state.drag = {
          type: 'rect',
          x1: px,
          y1: py,
          x2: px,
          y2: py
        };
        requestRender();
        break;
      }

      case 'circle': {
        state.drag = {
          type: 'circle',
          cx: px,
          cy: py,
          r: 0
        };
        requestRender();
        break;
      }

      case 'shape': {
        state.drag = {
          type: 'shape',
          cx: px,
          cy: py,
          r: 0,
          rot: 0
        };
        requestRender();
        break;
      }

      case 'text': {
        openTextPopover(sx, sy, px, py, null);
        break;
      }

      case 'eraser': {
        state.drag = { type: 'eraser', erasedSomething: false, lastX: wx, lastY: wy };
        eraseAtPoint(wx, wy);
        requestRender();
        break;
      }
    }
  });

  window.addEventListener('mousemove', (e) => {
    const { sx, sy } = getCanvasMousePos(e);
    const inside = sx >= 0 && sy >= 0 && sx <= canvasW && sy <= canvasH;
    state.pointer.inside = inside || !!state.drag;
    updatePointer(sx, sy, e.shiftKey);

    if (!state.drag) {
      if (inside) {
        const cropH = getTraceCropHandleAtScreen(sx, sy);
        if (cropH) {
          canvas.style.cursor = cropH.type === 'trace-crop-move' ? 'move' : 'crosshair';
        } else {
          const refH = getRefImageHandleAtScreen(sx, sy);
          if (refH) {
            canvas.style.cursor = refH.type === 'ref-move' ? 'move' : 'pointer';
          } else if (state.tool === 'select') {
            if (hitTestHudWidgetScreen(sx, sy)) {
              canvas.style.cursor = 'move';
            } else {
              const handle = getHandleAtScreenPos(sx, sy);
              if (handle) {
                canvas.style.cursor = handle.type === 'rotate' ? 'grab' : 'pointer';
              } else if (hitTestPoint(state.pointer.worldX, state.pointer.worldY)) {
                canvas.style.cursor = 'move';
              } else {
                canvas.style.cursor = 'default';
              }
            }
          }
        }
      }
      if (state.pendingLineStart || state.polyPoints.length > 0 || state.tool === 'eraser' || state.pointer.snapHit) {
        requestRender();
      }
      return;
    }

    const wx = state.pointer.worldX;
    const wy = state.pointer.worldY;
    const px = state.pointer.snappedX;
    const py = state.pointer.snappedY;

    switch (state.drag.type) {
      case 'pan': {
        state.cam.x = state.drag.origCamX - (sx - state.drag.startSx) / state.cam.scale;
        state.cam.y = state.drag.origCamY - (sy - state.drag.startSy) / state.cam.scale;
        requestRender();
        break;
      }

      case 'trace-crop-corner': {
        const { u, v } = worldToRefNorm(wx, wy);
        const c = state.traceCrop;
        const cu = Math.max(0, Math.min(1, u)), cv = Math.max(0, Math.min(1, v));
        const key = state.drag.key;
        if (key.includes('w')) c.x0 = Math.min(c.x1 - 0.04, cu);
        if (key.includes('e')) c.x1 = Math.max(c.x0 + 0.04, cu);
        if (key.includes('n')) c.y0 = Math.min(c.y1 - 0.04, cv);
        if (key.includes('s')) c.y1 = Math.max(c.y0 + 0.04, cv);
        c.active = true;
        requestRender();
        break;
      }

      case 'trace-crop-move': {
        const { u, v } = worldToRefNorm(wx, wy);
        const c = state.traceCrop;
        const o = state.drag.orig;
        const wSpan = o.x1 - o.x0, hSpan = o.y1 - o.y0;
        const du = Math.max(-o.x0, Math.min(1 - o.x1, u - state.drag.startU));
        const dv = Math.max(-o.y0, Math.min(1 - o.y1, v - state.drag.startV));
        c.x0 = o.x0 + du; c.x1 = c.x0 + wSpan;
        c.y0 = o.y0 + dv; c.y1 = c.y0 + hSpan;
        c.active = true;
        requestRender();
        break;
      }

      case 'trace-crop-draw': {
        const { u, v } = worldToRefNorm(wx, wy);
        const c = state.traceCrop;
        const cu = Math.max(0, Math.min(1, u)), cv = Math.max(0, Math.min(1, v));
        c.x0 = Math.min(state.drag.startU, cu);
        c.x1 = Math.max(state.drag.startU, cu);
        c.y0 = Math.min(state.drag.startV, cv);
        c.y1 = Math.max(state.drag.startV, cv);
        c.active = true;
        requestRender();
        break;
      }

      case 'ref-move': {
        state.refImage.x = Number((state.drag.origX + (wx - state.drag.startX)).toFixed(4));
        state.refImage.y = Number((state.drag.origY + (wy - state.drag.startY)).toFixed(4));
        $('numRefX').value = state.refImage.x;
        $('numRefY').value = state.refImage.y;
        scheduleLiveTracePreview();
        requestRender();
        break;
      }

      case 'ref-scale': {
        const dist = Math.hypot(wx - state.refImage.x, wy - state.refImage.y);
        const factor = dist / state.drag.origDist;
        state.refImage.scale = Number(Math.max(0.02, Math.min(4, state.drag.origScale * factor)).toFixed(3));
        $('numRefScale').value = state.refImage.scale;
        $('rngRefScale').value = Math.min(1.6, state.refImage.scale);
        scheduleLiveTracePreview();
        requestRender();
        break;
      }

      case 'ref-rotate': {
        const ang = Math.atan2(wy - state.refImage.y, wx - state.refImage.x) - state.drag.startAngle;
        let deg = Math.round(state.drag.origRot + (ang * 180) / Math.PI);
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        while (deg > 180) deg -= 360;
        while (deg < -180) deg += 360;
        state.refImage.rotation = deg;
        $('rngRefRot').value = deg;
        $('lblRefRot').textContent = `${deg}°`;
        scheduleLiveTracePreview();
        requestRender();
        break;
      }

      case 'move': {
        const dx = wx - state.drag.lastX;
        const dy = wy - state.drag.lastY;
        if (Math.hypot(dx, dy) > 1e-7) {
          translateSelected(dx, dy);
          state.drag.lastX = wx;
          state.drag.lastY = wy;
          state.drag.moved = true;
          requestRender();
        }
        break;
      }

      case 'vertex': {
        const item = state.drag.item;
        const th = !!item.thousandth;
        const milScale = getActiveMilUnitScale();
        let vx = px, vy = py;
        if (Number.isFinite(item.radialAngle) && Math.abs(item.radialAngle) > 1e-6) {
          const rc = Array.isArray(item.radialCenter) && item.radialCenter.length >= 2 ? item.radialCenter : [0, 0];
          const rcx = toCanvasUnit(rc[0], th, milScale);
          const rcy = toCanvasUnit(rc[1], th, milScale);
          const inv = rotatePointCCW(px, py, rcx, rcy, (-item.radialAngle * Math.PI) / 180);
          vx = inv.x;
          vy = inv.y;
        }
        const nx = fromCanvasUnit(vx, th, milScale);
        const ny = fromCanvasUnit(vy, th, milScale);
        if (state.drag.key === 'p1') {
          item.x1 = nx; item.y1 = ny;
        } else if (state.drag.key === 'p2') {
          item.x2 = nx; item.y2 = ny;
        } else {
          item[state.drag.key].x = nx;
          item[state.drag.key].y = ny;
        }
        state.drag.moved = true;
        requestRender();
        break;
      }

      case 'rotate': {
        let ang = Math.atan2(wy - state.drag.cy, wx - state.drag.cx) - state.drag.startAngle;
        if (e.shiftKey) {
          const step = (15 * Math.PI) / 180;
          ang = Math.round(ang / step) * step;
        }
        restoreFromDragSnapshot(state.drag.snapshot);
        const entries = getSelectedEntries().filter(({ item }) => !isLayerLocked(item.layer));
        transformShapes(entries, state.drag.cx, state.drag.cy, 1, 1, ang);
        state.drag.moved = true;
        requestRender();
        break;
      }

      case 'scale': {
        const d = state.drag;
        let sxFactor = (wx - d.anchor.x) / (d.corner.includes('w') ? -d.origW : d.origW);
        let syFactor = (wy - d.anchor.y) / (d.corner.includes('n') ? -d.origH : d.origH);
        if (Math.abs(sxFactor) < 0.05) sxFactor = sxFactor < 0 ? -0.05 : 0.05;
        if (Math.abs(syFactor) < 0.05) syFactor = syFactor < 0 ? -0.05 : 0.05;
        if (e.shiftKey) {
          const uni = Math.max(Math.abs(sxFactor), Math.abs(syFactor));
          sxFactor = Math.sign(sxFactor || 1) * uni;
          syFactor = Math.sign(syFactor || 1) * uni;
        }
        restoreFromDragSnapshot(d.snapshot);
        const entries = getSelectedEntries().filter(({ item }) => !isLayerLocked(item.layer));
        transformShapes(entries, d.anchor.x, d.anchor.y, sxFactor, syFactor, 0);
        d.moved = true;
        requestRender();
        break;
      }

      case 'marquee': {
        state.drag.currX = wx;
        state.drag.currY = wy;
        requestRender();
        break;
      }

      case 'line': {
        if (e.shiftKey) {
          const snapped = snapAngle(state.drag.x1, state.drag.y1, wx, wy, 15);
          state.drag.x2 = snapped.x;
          state.drag.y2 = snapped.y;
        } else {
          state.drag.x2 = px;
          state.drag.y2 = py;
        }
        requestRender();
        break;
      }

      case 'freehand': {
        const pts = state.drag.points;
        const last = pts[pts.length - 1];
        const minStep = 2.0 / state.cam.scale;
        const stab = state.options.brushStabilizer || 0;
        const alpha = 1 - stab * 0.88;
        const st = state.drag.stabilizerPt || (state.drag.stabilizerPt = { x: wx, y: wy });
        st.x += (wx - st.x) * alpha;
        st.y += (wy - st.y) * alpha;
        if (Math.hypot(st.x - last.x, st.y - last.y) >= minStep) {
          pts.push({ x: st.x, y: st.y });
        }
        requestRender();
        break;
      }

      case 'rect': {
        let rx = px, ry = py;
        if (e.shiftKey) {
          const dx = rx - state.drag.x1;
          const dy = ry - state.drag.y1;
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          rx = state.drag.x1 + Math.sign(dx || 1) * side;
          ry = state.drag.y1 + Math.sign(dy || 1) * side;
        }
        state.drag.x2 = rx;
        state.drag.y2 = ry;
        requestRender();
        break;
      }

      case 'circle': {
        state.drag.r = Math.hypot(px - state.drag.cx, py - state.drag.cy);
        requestRender();
        break;
      }

      case 'shape': {
        state.drag.r = Math.hypot(wx - state.drag.cx, wy - state.drag.cy);
        let rot = e.shiftKey ? Math.atan2(wy - state.drag.cy, wx - state.drag.cx) + Math.PI / 2 : 0;
        state.drag.rot = rot;
        requestRender();
        break;
      }

      case 'eraser': {
        eraseAlongSweep(state.drag.lastX, state.drag.lastY, wx, wy);
        state.drag.lastX = wx;
        state.drag.lastY = wy;
        requestRender();
        break;
      }

      case 'hud-widget': {
        const wObj = state.doc.hudWidgets?.[state.drag.name];
        if (!wObj) break;
        let dxHud = (wx - state.drag.startWx) * 1080;
        let dyHud = (wy - state.drag.startWy) * 1080;
        if (e.shiftKey) {
          if (Math.abs(dxHud) >= Math.abs(dyHud)) dyHud = 0;
          else dxHud = 0;
        }
        let nx = Math.max(0, Math.min(1920, state.drag.origPos[0] + dxHud));
        let ny = Math.max(0, Math.min(1080, state.drag.origPos[1] + dyHud));

        const guides = [];
        if (!e.altKey) {
          const thresh = Math.max(2, 6 / Math.max(0.25, state.cam.scale / 1080));
          const xCands = [960];
          const yCands = [540];
          for (const k of BlkParser.HUD_WIDGET_ORDER) {
            if (k === state.drag.name) continue;
            const other = state.doc.hudWidgets?.[k];
            if (other && other.included && other.visible && Array.isArray(other.position)) {
              xCands.push(other.position[0]);
              yCands.push(other.position[1]);
            }
          }
          let bestDx = thresh + 1, snapX = null;
          for (const cx of xCands) {
            const d = Math.abs(nx - cx);
            if (d < bestDx) { bestDx = d; snapX = cx; }
          }
          if (snapX !== null) {
            nx = snapX;
            guides.push({ axis: 'x', val: snapX });
          }
          let bestDy = thresh + 1, snapY = null;
          for (const cy of yCands) {
            const d = Math.abs(ny - cy);
            if (d < bestDy) { bestDy = d; snapY = cy; }
          }
          if (snapY !== null) {
            ny = snapY;
            guides.push({ axis: 'y', val: snapY });
          }
        }

        nx = Math.round(nx * 4) / 4;
        ny = Math.round(ny * 4) / 4;
        wObj.position = [nx, ny];
        wObj.wx = (nx - 960) / 1080;
        wObj.wy = (ny - 540) / 1080;
        state.hudEditor.snapGuides = guides;
        if ($('numHudPosX') && state.hudEditor.selectedWidget === state.drag.name) $('numHudPosX').value = String(nx);
        if ($('numHudPosY') && state.hudEditor.selectedWidget === state.drag.name) $('numHudPosY').value = String(ny);
        state.drag.moved = true;
        requestRender();
        break;
      }
    }
  });

  function restoreFromDragSnapshot(snap) {
    const cloned = cloneDocDrawState(snap);
    state.doc.lines = cloned.lines;
    state.doc.quads = cloned.quads;
    state.doc.circles = cloned.circles;
    state.doc.texts = cloned.texts;
  }

  window.addEventListener('mouseup', (e) => {
    if (!state.drag) return;
    const d = state.drag;
    const { sx, sy } = getCanvasMousePos(e);
    state.drag = null;
    updateCursorForTool();

    if (d.type === 'hud-widget') {
      state.hudEditor.snapGuides = [];
      if (d.moved) {
        pushHistory();
        syncHudPresetUIFromDoc();
      }
    } else if (d.type === 'move' || d.type === 'vertex' || d.type === 'rotate' || d.type === 'scale') {
      if (d.moved) {
        pushHistory();
        updateSelectionUI();
      }
    } else if (d.type === 'marquee') {
      const minX = Math.min(d.startX, d.currX);
      const maxX = Math.max(d.startX, d.currX);
      const minY = Math.min(d.startY, d.currY);
      const maxY = Math.max(d.startY, d.currY);
      if (Math.hypot(maxX - minX, maxY - minY) > 4 / state.cam.scale) {
        if (!d.additive) state.selection.clear();
        for (const { kind, item } of allShapes()) {
          if (!isLayerVisible(item.layer) || isLayerLocked(item.layer)) continue;
          const b = getShapeBoundsCanvas(kind, item);
          if (b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY) {
            state.selection.add(item.id);
          }
        }
        updateSelectionUI();
      }
    } else if (d.type === 'line') {
      const dragPx = Math.hypot(sx - d.startSx, sy - d.startSy);
      if (dragPx < 5) {
        state.pendingLineStart = { x: d.x1, y: d.y1 };
      } else if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 1e-5) {
        addLineSymmetric(d.x1, d.y1, d.x2, d.y2, 'draw');
        pushHistory();
      }
    } else if (d.type === 'trace-crop-corner' || d.type === 'trace-crop-move' || d.type === 'trace-crop-draw') {
      const c = state.traceCrop;
      if (c.x1 - c.x0 < 0.04 || c.y1 - c.y0 < 0.04) {
        c.active = false;
        c.x0 = 0; c.y0 = 0; c.x1 = 1; c.y1 = 1;
      }
      if ($('btnTraceCropReset')) $('btnTraceCropReset').disabled = !c.active;
      scheduleLiveTracePreview();
    } else if (d.type === 'freehand') {
      if (d.stabilizerPt && d.points.length >= 1) {
        const tail = d.points[d.points.length - 1];
        if (Math.hypot(d.stabilizerPt.x - tail.x, d.stabilizerPt.y - tail.y) > 1e-5) {
          d.points.push({ x: d.stabilizerPt.x, y: d.stabilizerPt.y });
        }
      }
      if (d.points.length >= 2) {
        const simplified = rdpSimplify(d.points, state.options.simplifyTol);
        if (simplified.length >= 2) {
          addPolylineSymmetric(simplified, state.options.brushMode, state.options.brushWidth, 'draw', { taper: !!state.options.brushTaper });
          pushHistory();
        }
      }
    } else if (d.type === 'rect') {
      const minX = Math.min(d.x1, d.x2), maxX = Math.max(d.x1, d.x2);
      const minY = Math.min(d.y1, d.y2), maxY = Math.max(d.y1, d.y2);
      if (maxX - minX > 1e-5 && maxY - minY > 1e-5) {
        if (state.options.shapeMode === 'quads') {
          addQuadSymmetric({ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }, 'draw');
        } else {
          addLineSymmetric(minX, minY, maxX, minY, 'draw');
          addLineSymmetric(maxX, minY, maxX, maxY, 'draw');
          addLineSymmetric(maxX, maxY, minX, maxY, 'draw');
          addLineSymmetric(minX, maxY, minX, minY, 'draw');
        }
        pushHistory();
      }
    } else if (d.type === 'circle') {
      if (d.r > 1e-5) {
        addCircleSymmetric(d.cx, d.cy, d.r);
        pushHistory();
      }
    } else if (d.type === 'shape') {
      if (d.r > 1e-5) {
        addStampSymmetric(d.cx, d.cy, d.r, d.rot);
        pushHistory();
      }
    } else if (d.type === 'eraser') {
      if (d.erasedSomething) {
        pushHistory();
        updateSelectionUI();
      }
    }

    requestRender();
  });

  canvas.addEventListener('dblclick', (e) => {
    if (state.tool === 'polyline' || state.tool === 'polygon' || state.tool === 'spline') {
      if (state.polyPoints.length > 2) state.polyPoints.pop();
      finishPoly(true);
    } else if (state.tool === 'select') {
      const { sx, sy } = getCanvasMousePos(e);
      const w = screenToWorld(sx, sy);
      const hit = hitTestPoint(w.x, w.y);
      if (hit && hit.kind === 'text') {
        openTextPopover(sx, sy, hit.item.x, hit.item.y, hit.item);
      } else if (hit && hit.kind === 'line') {
        state.selection.add(hit.item.id);
        selectConnectedChainFromSelection();
      }
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    if ((state.tool === 'polyline' || state.tool === 'polygon' || state.tool === 'spline') && state.polyPoints.length > 0) {
      e.preventDefault();
      state.polyPoints.pop();
      requestRender();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { sx, sy } = getCanvasMousePos(e);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomBy(factor, sx, sy);
  }, { passive: false });

  canvas.addEventListener('mouseleave', () => {
    state.pointer.inside = false;
    requestRender();
  });

  // =========================================================================
  // Text Input Popover
  // =========================================================================
  function openTextPopover(sx, sy, wx, wy, existingTextItem) {
    const pop = $('textInputPopover');
    state.editingTextTarget = existingTextItem ? { item: existingTextItem } : { x: wx, y: wy };
    $('textPopoverInput').value = existingTextItem ? existingTextItem.text : '';
    $('textPopoverSize').value = existingTextItem ? existingTextItem.size : 1;
    $('textPopoverAlign').value = String(existingTextItem ? existingTextItem.align : 0);
    $('btnTextConfirm').textContent = existingTextItem ? 'Update Text' : 'Place Text';

    pop.style.left = `${Math.min(canvasW - 245, Math.max(10, sx + 8))}px`;
    pop.style.top = `${Math.min(canvasH - 160, Math.max(10, sy + 8))}px`;
    pop.hidden = false;
    $('textPopoverInput').focus();
  }

  function closeTextPopover() {
    $('textInputPopover').hidden = true;
    state.editingTextTarget = null;
  }

  $('btnTextCancel').addEventListener('click', closeTextPopover);
  $('btnTextConfirm').addEventListener('click', () => {
    const target = state.editingTextTarget;
    if (!target) return;
    const textVal = $('textPopoverInput').value.trim();
    const sizeVal = parseFloat($('textPopoverSize').value) || 1;
    const alignVal = parseInt($('textPopoverAlign').value, 10) || 0;

    if (!textVal) {
      closeTextPopover();
      return;
    }

    if (target.item) {
      target.item.text = textVal;
      target.item.size = sizeVal;
      target.item.align = alignVal;
    } else {
      const th = state.options.defaultThousandth;
      const mv = state.options.defaultMove;
      for (const { sx, sy } of getMirrorTransforms()) {
        state.doc.texts.push({
          id: BlkParser.nextId('text'),
          layer: 'draw',
          text: textVal,
          x: fromCanvasUnit(target.x * sx, th),
          y: fromCanvasUnit(target.y * sy, th),
          size: sizeVal,
          align: alignVal,
          move: mv,
          thousandth: th,
          highlight: false,
          ...makeDefaultRadialFields(target.x * sx, target.y * sy)
        });
      }
    }
    pushHistory();
    closeTextPopover();
    updateSelectionUI();
    requestRender();
  });

  $('textPopoverInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btnTextConfirm').click();
    } else if (e.key === 'Escape') {
      closeTextPopover();
    }
  });

  // =========================================================================
  // Studio-Grade Sub-Pixel & Topology-Aware Auto-Draw Vectorizer + SVG Import
  // =========================================================================

  /**
   * Eight-connected Zhang-Suen thinning on a 1px-padded binary canvas so edges touching crop borders stay intact.
   */
  function thinMaskZhangSuen(srcBin, w, h) {
    const pw = w + 2;
    const ph = h + 2;
    const buf = new Uint8Array(pw * ph);
    for (let y = 0; y < h; y++) {
      const sOff = y * w;
      const dOff = (y + 1) * pw + 1;
      for (let x = 0; x < w; x++) buf[dOff + x] = srcBin[sOff + x] ? 1 : 0;
    }

    const toClear = [];
    for (let iter = 0; iter < 96; iter++) {
      let changed = false;
      for (let step = 0; step < 2; step++) {
        toClear.length = 0;
        for (let y = 1; y <= h; y++) {
          for (let x = 1; x <= w; x++) {
            const i = y * pw + x;
            if (!buf[i]) continue;
            const p2 = buf[i - pw], p3 = buf[i - pw + 1], p4 = buf[i + 1], p5 = buf[i + pw + 1];
            const p6 = buf[i + pw], p7 = buf[i + pw - 1], p8 = buf[i - 1], p9 = buf[i - pw - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const A =
              (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
              (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
            if (A !== 1) continue;
            if (step === 0) {
              if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
            } else {
              if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
            }
            toClear.push(i);
          }
        }
        if (toClear.length > 0) {
          changed = true;
          for (let k = 0; k < toClear.length; k++) buf[toClear[k]] = 0;
        }
      }
      if (!changed) break;
    }

    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sOff = (y + 1) * pw + 1;
      const dOff = y * w;
      for (let x = 0; x < w; x++) out[dOff + x] = buf[sOff + x];
    }
    return out;
  }

  /**
   * Prune short dead-end twig spurs attached to junctions (leaves true open curves & isolated strokes untouched).
   */
  function pruneSkeletonSpurs(edges, w, h, maxSpurLen) {
    if (!maxSpurLen || maxSpurLen <= 0) return;
    const dirs = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    const deg = new Uint8Array(w * h);

    function computeDeg(i) {
      if (!edges[i]) return 0;
      const x = i % w, y = (i / w) | 0;
      let d = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + dirs[k][0], ny = y + dirs[k][1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && edges[ny * w + nx]) d++;
      }
      return d;
    }

    let prunedAny = true;
    let passes = 0;
    while (prunedAny && passes++ < 16) {
      prunedAny = false;
      for (let i = 0; i < w * h; i++) deg[i] = edges[i] ? computeDeg(i) : 0;

      for (let i = 0; i < w * h; i++) {
        if (!edges[i] || deg[i] !== 1) continue;
        const twig = [i];
        let prev = -1;
        let curr = i;
        let hitJunction = false;

        for (let step = 0; step < maxSpurLen; step++) {
          const x = curr % w, y = (curr / w) | 0;
          let next = -1;
          for (let k = 0; k < 8; k++) {
            const nx = x + dirs[k][0], ny = y + dirs[k][1];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (ni !== prev && edges[ni]) {
              next = ni;
              break;
            }
          }
          if (next < 0) break;
          if (deg[next] >= 3) {
            hitJunction = true;
            break;
          }
          if (deg[next] !== 2) break;
          twig.push(next);
          prev = curr;
          curr = next;
        }

        if (hitJunction && twig.length <= maxSpurLen) {
          for (const px of twig) edges[px] = 0;
          prunedAny = true;
        }
      }
    }
  }

  /**
   * Extract a topological skeleton graph with clustered Junction Super-Nodes,
   * then merge tangent-aligned crossing branches across X-junctions and T-crossbars.
   */
  function extractSkeletonGraphAndMerge(edges, w, h) {
    const N = w * h;
    const dirs = [
      [1, 0], [0, 1], [-1, 0], [0, -1],
      [1, 1], [-1, 1], [-1, -1], [1, -1]
    ];
    const deg = new Uint8Array(N);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!edges[i]) continue;
        let d = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + dirs[k][0], ny = y + dirs[k][1];
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && edges[ny * w + nx]) d++;
        }
        deg[i] = d;
      }
    }

    const nodeOfPixel = new Int32Array(N).fill(-1);
    const nodes = [];

    // 1. Cluster adjacent degree >= 3 junction pixels into single Junction Super-Nodes
    for (let i = 0; i < N; i++) {
      if (!edges[i] || deg[i] < 3 || nodeOfPixel[i] >= 0) continue;
      const nodeId = nodes.length;
      const queue = [i];
      nodeOfPixel[i] = nodeId;
      let sx = 0, sy = 0;
      const pixels = [];
      while (queue.length > 0) {
        const curr = queue.pop();
        pixels.push(curr);
        const cx = curr % w, cy = (curr / w) | 0;
        sx += cx + 0.5;
        sy += cy + 0.5;
        for (let k = 0; k < 8; k++) {
          const nx = cx + dirs[k][0], ny = cy + dirs[k][1];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (edges[ni] && deg[ni] >= 3 && nodeOfPixel[ni] < 0) {
            nodeOfPixel[ni] = nodeId;
            queue.push(ni);
          }
        }
      }
      nodes.push({
        id: nodeId,
        isJunction: true,
        centroid: { x: sx / pixels.length, y: sy / pixels.length },
        pixels
      });
    }

    // 2. Register degree-1 pixels as Endpoint Nodes
    for (let i = 0; i < N; i++) {
      if (!edges[i] || deg[i] !== 1 || nodeOfPixel[i] >= 0) continue;
      const nodeId = nodes.length;
      nodeOfPixel[i] = nodeId;
      nodes.push({
        id: nodeId,
        isJunction: false,
        centroid: { x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5 },
        pixels: [i]
      });
    }

    const visitedChain = new Uint8Array(N);
    const seenDirect = new Set();
    const rawEdges = [];

    // 3. Walk all non-junction pixel chains between nodes (guarantees shared exact node centroids!)
    for (const node of nodes) {
      for (const pIdx of node.pixels) {
        const px = pIdx % w, py = (pIdx / w) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = px + dirs[k][0], ny = py + dirs[k][1];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (!edges[ni]) continue;

          if (nodeOfPixel[ni] >= 0) {
            const otherNode = nodeOfPixel[ni];
            if (otherNode === node.id) continue;
            const pairKey = `${Math.min(node.id, otherNode)}_${Math.max(node.id, otherNode)}`;
            if (seenDirect.has(pairKey)) continue;
            seenDirect.add(pairKey);
            rawEdges.push({
              pts: [{ ...node.centroid }, { ...nodes[otherNode].centroid }],
              startNode: node.id,
              endNode: otherNode,
              closed: false
            });
            continue;
          }

          if (visitedChain[ni]) continue;
          const pts = [{ ...node.centroid }];
          let prev = pIdx;
          let curr = ni;
          visitedChain[curr] = 1;
          pts.push({ x: (curr % w) + 0.5, y: ((curr / w) | 0) + 0.5 });

          let endNode = -1;
          let guard = 0;
          while (guard++ < N) {
            const cx = curr % w, cy = (curr / w) | 0;
            let nextPx = -1;
            let nextIsNode = false;

            for (let m = 0; m < 8; m++) {
              const mx = cx + dirs[m][0], my = cy + dirs[m][1];
              if (mx < 0 || mx >= w || my < 0 || my >= h) continue;
              const mi = my * w + mx;
              if (!edges[mi] || mi === prev) continue;
              if (nodeOfPixel[mi] >= 0) {
                // Only count junction node if it isn't the starting node within the first step unless it's a valid return loop
                if (nodeOfPixel[mi] === node.id && pts.length <= 2) continue;
                nextPx = mi;
                nextIsNode = true;
                break;
              }
              if (!visitedChain[mi]) {
                nextPx = mi;
                break;
              }
            }

            if (nextPx < 0) break;
            if (nextIsNode) {
              endNode = nodeOfPixel[nextPx];
              pts.push({ ...nodes[endNode].centroid });
              break;
            }
            visitedChain[nextPx] = 1;
            pts.push({ x: (nextPx % w) + 0.5, y: ((nextPx / w) | 0) + 0.5 });
            prev = curr;
            curr = nextPx;
          }

          if (pts.length >= 2) {
            rawEdges.push({
              pts,
              startNode: node.id,
              endNode,
              closed: false
            });
          }
        }
      }
    }

    // 4. Walk isolated closed loops (all pixels deg === 2, no nodes)
    for (let i = 0; i < N; i++) {
      if (!edges[i] || deg[i] < 2 || nodeOfPixel[i] >= 0 || visitedChain[i]) continue;
      const loopPts = [];
      let prev = -1;
      let curr = i;
      let guard = 0;
      while (guard++ < N) {
        visitedChain[curr] = 1;
        loopPts.push({ x: (curr % w) + 0.5, y: ((curr / w) | 0) + 0.5 });
        const cx = curr % w, cy = (curr / w) | 0;
        let nextPx = -1;
        for (let m = 0; m < 8; m++) {
          const mx = cx + dirs[m][0], my = cy + dirs[m][1];
          if (mx < 0 || mx >= w || my < 0 || my >= h) continue;
          const mi = my * w + mx;
          if (mi !== prev && edges[mi] && nodeOfPixel[mi] < 0 && !visitedChain[mi]) {
            nextPx = mi;
            break;
          }
        }
        if (nextPx < 0) break;
        prev = curr;
        curr = nextPx;
      }
      if (loopPts.length >= 3) {
        const first = loopPts[0], last = loopPts[loopPts.length - 1];
        const isClosed = Math.hypot(first.x - last.x, first.y - last.y) <= 2.2;
        if (isClosed) loopPts.push({ x: first.x, y: first.y });
        rawEdges.push({ pts: loopPts, startNode: -1, endNode: -1, closed: isClosed });
      }
    }

    // 5. Merge collinear / smooth X-crossing & T-crossbar branches across Junction Super-Nodes
    const nodeInc = new Map();
    function addInc(nodeId, edgeIdx, atStart) {
      if (nodeId < 0 || !nodes[nodeId].isJunction) return;
      if (!nodeInc.has(nodeId)) nodeInc.set(nodeId, []);
      nodeInc.get(nodeId).push({ edgeIdx, atStart });
    }
    rawEdges.forEach((e, idx) => {
      addInc(e.startNode, idx, true);
      addInc(e.endNode, idx, false);
    });

    function edgeOutwardDir(edgeIdx, atStart) {
      const pts = rawEdges[edgeIdx].pts;
      if (pts.length < 2) return { x: 1, y: 0 };
      const p0 = atStart ? pts[0] : pts[pts.length - 1];
      let target = atStart ? pts[pts.length - 1] : pts[0];
      const maxSteps = Math.min(pts.length - 1, 8);
      for (let k = 1; k <= maxSteps; k++) {
        const pt = atStart ? pts[k] : pts[pts.length - 1 - k];
        target = pt;
        if (Math.hypot(pt.x - p0.x, pt.y - p0.y) >= 4.0) break;
      }
      const dx = target.x - p0.x, dy = target.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    }

    // endMatch.get("edgeIdx:0|1") => partner "edgeIdx:0|1"
    const endMatch = new Map();
    const unmergedTStems = []; // { edgeIdx, atStart, junctionNodeId }
    const consumedEdge = new Uint8Array(rawEdges.length);

    // 5a. Collapse short fused bridges between pairs of degree-3 Y-junctions (acute < 45-deg X-crossings)
    for (let bi = 0; bi < rawEdges.length; bi++) {
      if (consumedEdge[bi]) continue;
      const be = rawEdges[bi];
      const n1 = be.startNode, n2 = be.endNode;
      if (n1 < 0 || n2 < 0 || n1 === n2) continue;
      if (!nodes[n1].isJunction || !nodes[n2].isJunction) continue;
      const list1 = nodeInc.get(n1) || [];
      const list2 = nodeInc.get(n2) || [];
      if (list1.length !== 3 || list2.length !== 3) continue;
      if (be.pts.length > 18) continue;
      const spanDist = Math.hypot(nodes[n1].centroid.x - nodes[n2].centroid.x, nodes[n1].centroid.y - nodes[n2].centroid.y);
      if (spanDist > 16) continue;

      const arms1 = list1.filter((inc) => inc.edgeIdx !== bi);
      const arms2 = list2.filter((inc) => inc.edgeIdx !== bi);
      if (arms1.length !== 2 || arms2.length !== 2) continue;

      const d10 = edgeOutwardDir(arms1[0].edgeIdx, arms1[0].atStart);
      const d11 = edgeOutwardDir(arms1[1].edgeIdx, arms1[1].atStart);
      const d20 = edgeOutwardDir(arms2[0].edgeIdx, arms2[0].atStart);
      const d21 = edgeOutwardDir(arms2[1].edgeIdx, arms2[1].atStart);

      const sA1 = -(d10.x * d20.x + d10.y * d20.y);
      const sA2 = -(d11.x * d21.x + d11.y * d21.y);
      const sB1 = -(d10.x * d21.x + d10.y * d21.y);
      const sB2 = -(d11.x * d20.x + d11.y * d20.y);

      const validA = sA1 >= 0.72 && sA2 >= 0.72;
      const validB = sB1 >= 0.72 && sB2 >= 0.72;
      if (!validA && !validB) continue;

      const useB = validB && (!validA || (sB1 + sB2 > sA1 + sA2));
      const p1 = { a: arms1[0], b: useB ? arms2[1] : arms2[0] };
      const p2 = { a: arms1[1], b: useB ? arms2[0] : arms2[1] };

      const ka1 = `${p1.a.edgeIdx}:${p1.a.atStart ? 0 : 1}`;
      const kb1 = `${p1.b.edgeIdx}:${p1.b.atStart ? 0 : 1}`;
      const ka2 = `${p2.a.edgeIdx}:${p2.a.atStart ? 0 : 1}`;
      const kb2 = `${p2.b.edgeIdx}:${p2.b.atStart ? 0 : 1}`;
      if (endMatch.has(ka1) || endMatch.has(kb1) || endMatch.has(ka2) || endMatch.has(kb2)) continue;

      const mid = {
        x: (nodes[n1].centroid.x + nodes[n2].centroid.x) * 0.5,
        y: (nodes[n1].centroid.y + nodes[n2].centroid.y) * 0.5
      };
      const snapEnd = (inc) => {
        const pts = rawEdges[inc.edgeIdx].pts;
        if (inc.atStart) pts[0] = { x: mid.x, y: mid.y };
        else pts[pts.length - 1] = { x: mid.x, y: mid.y };
      };
      snapEnd(p1.a); snapEnd(p1.b); snapEnd(p2.a); snapEnd(p2.b);

      endMatch.set(ka1, kb1); endMatch.set(kb1, ka1);
      endMatch.set(ka2, kb2); endMatch.set(kb2, ka2);
      consumedEdge[bi] = 1;
    }

    for (const [nodeId, list] of nodeInc.entries()) {
      const activeList = list.filter((inc) => !consumedEdge[inc.edgeIdx]);
      const dirsList = activeList.map((inc) => ({ ...inc, dir: edgeOutwardDir(inc.edgeIdx, inc.atStart) }));
      const pairs = [];
      for (let a = 0; a < dirsList.length; a++) {
        for (let b = a + 1; b < dirsList.length; b++) {
          const ia = dirsList[a], ib = dirsList[b];
          if (ia.edgeIdx === ib.edgeIdx) continue;
          const align = -(ia.dir.x * ib.dir.x + ia.dir.y * ib.dir.y); // 1.0 = straight 180 deg across junction
          if (align >= 0.72) {
            pairs.push({ a: ia, b: ib, align });
          }
        }
      }
      pairs.sort((u, v) => v.align - u.align);
      const usedEnd = new Set();
      for (const p of pairs) {
        const ka = `${p.a.edgeIdx}:${p.a.atStart ? 0 : 1}`;
        const kb = `${p.b.edgeIdx}:${p.b.atStart ? 0 : 1}`;
        if (endMatch.has(ka) || endMatch.has(kb) || usedEnd.has(ka) || usedEnd.has(kb)) continue;
        usedEnd.add(ka);
        usedEnd.add(kb);
        endMatch.set(ka, kb);
        endMatch.set(kb, ka);
      }
      for (const inc of activeList) {
        const k = `${inc.edgeIdx}:${inc.atStart ? 0 : 1}`;
        if (!usedEnd.has(k) && !endMatch.has(k)) {
          unmergedTStems.push({ edgeIdx: inc.edgeIdx, atStart: inc.atStart, junctionNodeId: nodeId });
        }
      }
    }

    // Stitch paired edges into long unbroken strokes
    const outChains = [];

    function appendEdgePts(targetPts, edgeIdx, forward) {
      const src = rawEdges[edgeIdx].pts;
      if (forward) {
        for (let k = targetPts.length ? 1 : 0; k < src.length; k++) targetPts.push({ ...src[k] });
      } else {
        for (let k = targetPts.length ? src.length - 2 : src.length - 1; k >= 0; k--) targetPts.push({ ...src[k] });
      }
    }

    function walkMatchedChain(startEdge, forwardInit) {
      // Trace backwards to find true open chain start if possible
      let curEdge = startEdge;
      let curEnterSide = forwardInit ? 0 : 1; // 0 = entering at start, going to 1 (end)
      const visitedLocal = new Set([startEdge]);

      while (true) {
        const prevPartner = endMatch.get(`${curEdge}:${curEnterSide}`);
        if (!prevPartner) break;
        const [pEdgeStr, pSideStr] = prevPartner.split(':');
        const pEdge = parseInt(pEdgeStr, 10);
        const pSide = parseInt(pSideStr, 10);
        if (visitedLocal.has(pEdge) || consumedEdge[pEdge]) break;
        visitedLocal.add(pEdge);
        curEdge = pEdge;
        curEnterSide = pSide === 0 ? 1 : 0; // enter other side of partner
      }

      const combinedPts = [];
      const edgeIdsInChain = [];
      let walkEdge = curEdge;
      let walkForward = curEnterSide === 0;
      let closedLoop = false;

      while (true) {
        if (consumedEdge[walkEdge]) {
          if (walkEdge === curEdge && edgeIdsInChain.length >= 2) closedLoop = true;
          break;
        }
        consumedEdge[walkEdge] = 1;
        edgeIdsInChain.push(walkEdge);
        appendEdgePts(combinedPts, walkEdge, walkForward);

        const exitSide = walkForward ? 1 : 0;
        const nextPartner = endMatch.get(`${walkEdge}:${exitSide}`);
        if (!nextPartner) break;
        const [nEdgeStr, nSideStr] = nextPartner.split(':');
        const nEdge = parseInt(nEdgeStr, 10);
        const nSide = parseInt(nSideStr, 10);
        if (nEdge === curEdge && edgeIdsInChain.length >= 1) {
          closedLoop = true;
          break;
        }
        walkEdge = nEdge;
        walkForward = nSide === 0;
      }

      const baseEdge = rawEdges[curEdge];
      const lastEdge = rawEdges[walkEdge];
      const startNodeId = curEnterSide === 0 ? baseEdge.startNode : baseEdge.endNode;
      const exitSideFinal = walkForward ? 1 : 0;
      const endNodeId = exitSideFinal === 1 ? lastEdge.endNode : lastEdge.startNode;
      const isClosedOut = rawEdges.length === 1 ? baseEdge.closed : (baseEdge.closed || closedLoop);
      return {
        pts: combinedPts,
        closed: isClosedOut,
        startJunction: !isClosedOut && startNodeId >= 0 && nodes[startNodeId]?.isJunction ? startNodeId : -1,
        endJunction: !isClosedOut && endNodeId >= 0 && nodes[endNodeId]?.isJunction ? endNodeId : -1,
        mergedCount: edgeIdsInChain.length
      };
    }

    // Walk unmerged-start chains first, then any remaining closed crossing rings
    for (let ei = 0; ei < rawEdges.length; ei++) {
      if (consumedEdge[ei]) continue;
      if (!endMatch.has(`${ei}:0`) || !endMatch.has(`${ei}:1`)) {
        outChains.push(walkMatchedChain(ei, true));
      }
    }
    for (let ei = 0; ei < rawEdges.length; ei++) {
      if (!consumedEdge[ei]) {
        outChains.push(walkMatchedChain(ei, true));
      }
    }

    return outChains;
  }

  /**
   * Extract smooth sub-pixel Marching Squares contours as pixel-space closed or open chains.
   * Field samples sit at pixel centers (x + 0.5, y + 0.5).
   */
  function extractMarchingContours(field, w, h) {
    const table = [
      [], [[3, 2]], [[2, 1]], [[3, 1]],
      [[0, 1]], [[0, 3], [2, 1]], [[0, 2]], [[3, 0]],
      [[3, 0]], [[0, 2]], [[0, 1], [3, 2]], [[0, 1]],
      [[3, 1]], [[2, 1]], [[3, 2]], []
    ];
    const adj = new Map();
    const ptPool = [];
    const keyToId = new Map();

    function getVertexId(px, py) {
      const k = `${Math.round(px * 60)},${Math.round(py * 60)}`;
      let id = keyToId.get(k);
      if (id === undefined) {
        id = ptPool.length;
        ptPool.push({ x: px, y: py });
        keyToId.set(k, id);
        adj.set(id, []);
      }
      return id;
    }

    function interp(x1, y1, v1, x2, y2, v2) {
      const denom = v1 - v2;
      const t = Math.abs(denom) < 1e-5 ? 0.5 : Math.max(0, Math.min(1, v1 / denom));
      return { x: x1 + (x2 - x1) * t + 0.5, y: y1 + (y2 - y1) * t + 0.5 };
    }

    const rawSegs = [];
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        const v0 = field[i], v1 = field[i + 1], v2 = field[i + w + 1], v3 = field[i + w];
        const idx = (v0 > 0 ? 8 : 0) | (v1 > 0 ? 4 : 0) | (v2 > 0 ? 2 : 0) | (v3 > 0 ? 1 : 0);
        const pairs = table[idx];
        if (!pairs || pairs.length === 0) continue;

        const edgePt = (e) => {
          if (e === 0) return interp(x, y, v0, x + 1, y, v1);
          if (e === 1) return interp(x + 1, y, v1, x + 1, y + 1, v2);
          if (e === 2) return interp(x, y + 1, v3, x + 1, y + 1, v2);
          return interp(x, y, v0, x, y + 1, v3);
        };

        for (const [eA, eB] of pairs) {
          const pA = edgePt(eA);
          const pB = edgePt(eB);
          const u = getVertexId(pA.x, pA.y);
          const v = getVertexId(pB.x, pB.y);
          if (u !== v) {
            const segId = rawSegs.length;
            rawSegs.push({ u, v, used: false });
            adj.get(u).push({ to: v, segId });
            adj.get(v).push({ to: u, segId });
          }
        }
      }
    }

    const chains = [];
    for (let s = 0; s < rawSegs.length; s++) {
      if (rawSegs[s].used) continue;
      rawSegs[s].used = true;
      const forward = [ptPool[rawSegs[s].v]];
      const backward = [ptPool[rawSegs[s].u]];

      let curr = rawSegs[s].v;
      while (true) {
        const list = adj.get(curr) || [];
        const nextEdge = list.find((e) => !rawSegs[e.segId].used);
        if (!nextEdge) break;
        rawSegs[nextEdge.segId].used = true;
        curr = nextEdge.to;
        forward.push(ptPool[curr]);
      }

      curr = rawSegs[s].u;
      while (true) {
        const list = adj.get(curr) || [];
        const nextEdge = list.find((e) => !rawSegs[e.segId].used);
        if (!nextEdge) break;
        rawSegs[nextEdge.segId].used = true;
        curr = nextEdge.to;
        backward.push(ptPool[curr]);
      }

      backward.reverse();
      const chain = backward.concat(forward);
      if (chain.length >= 2) {
        const closed = chain.length >= 4 && Math.hypot(chain[0].x - chain[chain.length - 1].x, chain[0].y - chain[chain.length - 1].y) <= 0.8;
        chains.push({ pts: chain, closed });
      }
    }
    return chains;
  }

  /**
   * Organize closed pixel-space contours into outer shapes and their directly enclosed holes (e.g. eye glints).
   */
  function nestClosedContoursWithHoles(closedLoops) {
    const items = closedLoops.map((loop, idx) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of loop) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return {
        idx,
        pts: loop,
        area: Math.abs(polySignedArea(loop)),
        minX, maxX, minY, maxY,
        testPt: loop[0],
        parent: -1,
        depth: 0,
        holes: []
      };
    });

    items.sort((a, b) => b.area - a.area);
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      let parentIdx = -1;
      let depth = 0;
      for (let j = i - 1; j >= 0; j--) {
        const p = items[j];
        if (c.minX < p.minX || c.maxX > p.maxX || c.minY < p.minY || c.maxY > p.maxY) continue;
        if (pointInPolygon(c.testPt.x, c.testPt.y, p.pts)) {
          depth++;
          if (parentIdx === -1) parentIdx = j;
        }
      }
      c.parent = parentIdx;
      c.depth = depth;
    }

    const outers = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].depth % 2 === 0) {
        outers.push(items[i]);
      } else if (items[i].parent >= 0) {
        items[items[i].parent].holes.push(items[i].pts);
      }
    }
    return outers;
  }

  function computeImageVectorTrace() {
    const r = state.refImage;
    if (!r.img) return { lines: [], quads: [], maskCanvas: null };

    const mode = $('selTraceMode').value; // 'centerline' | 'hybrid' | 'marching' | 'canny'
    const sens = parseFloat($('rngTraceSens').value) || 72; // 5..99
    const contrastBoost = parseFloat($('rngTraceContrast').value) || 1.6; // 1..4
    const maxDim = parseInt($('rngTraceRes').value, 10) || 640;
    const simplifyPx = parseFloat($('rngTraceSimplify').value) || 0.65;
    const minChainLen = parseInt($('rngTraceMinLen').value, 10) || 3;
    const spurMaxLen = parseInt($('rngTraceSpur')?.value, 10);
    const spurLimit = Number.isNaN(spurMaxLen) ? 3 : spurMaxLen;
    const solidRadPx = parseFloat($('rngTraceSolidRad')?.value) || 4.5;
    const solidStyle = $('selTraceSolidStyle')?.value || 'fill'; // 'fill' | 'outline'
    const strokeOutput = $('selTraceOutput')?.value || 'lines'; // 'lines' | 'quadRibbon' | 'variableInk'
    const previewStyle = $('selTracePreviewStyle')?.value || 'cyan';
    const invert = $('chkTraceInvert').checked;
    const weldGaps = !!$('chkTraceWeldGaps')?.checked;

    const crop = state.traceCrop;
    const cx0 = crop.active ? Math.max(0, Math.min(0.95, crop.x0)) : 0;
    const cy0 = crop.active ? Math.max(0, Math.min(0.95, crop.y0)) : 0;
    const cx1 = crop.active ? Math.max(cx0 + 0.04, Math.min(1, crop.x1)) : 1;
    const cy1 = crop.active ? Math.max(cy0 + 0.04, Math.min(1, crop.y1)) : 1;
    const cropWFrac = cx1 - cx0;
    const cropHFrac = cy1 - cy0;

    const sx = cx0 * r.img.width;
    const sy = cy0 * r.img.height;
    const sw = Math.max(4, cropWFrac * r.img.width);
    const sh = Math.max(4, cropHFrac * r.img.height);

    const cropAspect = sw / sh;
    let w, h;
    if (sw >= sh) {
      w = Math.max(32, Math.min(maxDim, Math.round(maxDim)));
      h = Math.max(16, Math.round(w / cropAspect));
    } else {
      h = Math.max(32, Math.min(maxDim, Math.round(maxDim)));
      w = Math.max(16, Math.round(h * cropAspect));
    }

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(r.img, sx, sy, sw, sh, 0, 0, w, h);
    const imgData = octx.getImageData(0, 0, w, h).data;

    const N = w * h;
    const rawLum = new Float32Array(N);
    const alpha = new Float32Array(N);
    const hist = new Uint32Array(256);
    let sumLum = 0;

    for (let i = 0; i < N; i++) {
      const idx = i * 4;
      const a = imgData[idx + 3] / 255;
      alpha[i] = imgData[idx + 3];
      const bg = invert ? 0 : 255;
      const rC = imgData[idx] * a + bg * (1 - a);
      const gC = imgData[idx + 1] * a + bg * (1 - a);
      const bC = imgData[idx + 2] * a + bg * (1 - a);
      const stdLum = 0.299 * rC + 0.587 * gC + 0.114 * bC;
      const chromaDark = invert ? Math.max(rC, gC, bC) : Math.min(rC, gC, bC);
      let l = 0.5 * stdLum + 0.5 * chromaDark;
      if (invert) l = 255 - l;
      rawLum[i] = l;
      sumLum += l;
      hist[Math.max(0, Math.min(255, Math.round(l)))]++;
    }

    const meanLum = sumLum / (N || 1);
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, otsuThresh = 160;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = N - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) {
        maxVar = between;
        otsuThresh = t;
      }
    }

    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      lum[i] = Math.max(0, Math.min(255, (rawLum[i] - meanLum) * contrastBoost + meanLum));
    }

    const smooth = new Float32Array(N);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
          smooth[i] = lum[i];
        } else {
          smooth[i] =
            (lum[i - w - 1] + 2 * lum[i - w] + lum[i - w + 1] +
             2 * lum[i - 1] + 4 * lum[i] + 2 * lum[i + 1] +
             lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1]) / 16;
        }
      }
    }

    const stride = w + 1;
    const bgSumIntegral = new Float64Array((w + 1) * (h + 1));
    const bgCntIntegral = new Uint32Array((w + 1) * (h + 1));
    let globalBgSum = 0, globalBgCnt = 0;

    for (let y = 1; y <= h; y++) {
      let rSum = 0, rCnt = 0;
      for (let x = 1; x <= w; x++) {
        const v = smooth[(y - 1) * w + (x - 1)];
        if (v >= otsuThresh) {
          rSum += v;
          rCnt++;
          globalBgSum += v;
          globalBgCnt++;
        }
        const idx = y * stride + x;
        bgSumIntegral[idx] = bgSumIntegral[idx - stride] + rSum;
        bgCntIntegral[idx] = bgCntIntegral[idx - stride] + rCnt;
      }
    }
    const globalBgMean = globalBgCnt > 0 ? globalBgSum / globalBgCnt : 240;

    function getLocalBgLevel(cx, cy, rad) {
      const x0 = Math.max(0, cx - rad);
      const y0 = Math.max(0, cy - rad);
      const x1 = Math.min(w, cx + rad + 1);
      const y1 = Math.min(h, cy + rad + 1);
      const cnt =
        bgCntIntegral[y1 * stride + x1] -
        bgCntIntegral[y0 * stride + x1] -
        bgCntIntegral[y1 * stride + x0] +
        bgCntIntegral[y0 * stride + x0];
      if (cnt < 8) return globalBgMean;
      const sum =
        bgSumIntegral[y1 * stride + x1] -
        bgSumIntegral[y0 * stride + x1] -
        bgSumIntegral[y1 * stride + x0] +
        bgSumIntegral[y0 * stride + x0];
      return Math.max(globalBgMean * 0.88, sum / cnt);
    }

    const imgAspect = r.img.width / (r.img.height || 1);
    const worldH = r.scale;
    const worldW = worldH * imgAspect;
    const rotRad = (r.rotation * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);

    function pixelToWorld(px, py) {
      const u = cx0 + (px / w) * cropWFrac;
      const v = cy0 + (py / h) * cropHFrac;
      const lx = (u - 0.5) * worldW;
      const ly = (v - 0.5) * worldH;
      return {
        x: r.x + lx * cosR - ly * sinR,
        y: r.y + lx * sinR + ly * cosR
      };
    }

    const pxWorldSize = (cropWFrac * worldW) / w;
    const winRad = Math.max(12, Math.round(Math.min(w, h) / 20));
    const localMargin = Math.max(4, 68 * Math.pow(1 - sens / 100, 1.35));

    const bin = new Uint8Array(N);
    const field = new Float32Array(N);
    const inkRidgeField = new Float32Array(N);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (alpha[i] < 40) {
          field[i] = -50;
          continue;
        }
        const bgLevel = getLocalBgLevel(x, y, winRad);
        const cut = bgLevel - localMargin;
        const diff = cut - smooth[i];
        field[i] = diff;
        if (diff > 0) bin[i] = 1;
        inkRidgeField[i] = Math.max(0, Math.min(1, (bgLevel - smooth[i]) / Math.max(18, localMargin * 2.2)));
      }
    }

    // Bridge single isolated 1px pinholes without bridging genuine parallel strokes
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!bin[i]) {
          if ((bin[i - 1] && bin[i + 1]) && (bin[i - w] && bin[i + w])) bin[i] = 1;
        }
      }
    }

    const outLines = [];
    const outQuads = [];
    const solidMask = new Uint8Array(N);

    function emitWorldPolyline(worldPts, closed = false, pixelPtsForEdt = null, edt = null) {
      if (worldPts.length < 2) return;
      if (strokeOutput === 'variableInk' && edt && pixelPtsForEdt) {
        const halfWidths = pixelPtsForEdt.map((p) => {
          const ix = Math.max(0, Math.min(w - 1, Math.round(p.x - 0.5)));
          const iy = Math.max(0, Math.min(h - 1, Math.round(p.y - 0.5)));
          const rPx = Math.max(0.55, edt[iy * w + ix] - 0.45);
          return Math.max((state.options.brushWidth || 0.004) * 0.2, rPx * pxWorldSize);
        });
        const quads = buildMiterRibbonQuads(worldPts, halfWidths, { closed });
        for (const q of quads) outQuads.push(q);
      } else if (strokeOutput === 'quadRibbon') {
        const halfW = (state.options.brushWidth || 0.004) / 2;
        const quads = buildMiterRibbonQuads(worldPts, halfW, { closed });
        for (const q of quads) outQuads.push(q);
      } else {
        for (let i = 0; i < worldPts.length - 1; i++) {
          const a = worldPts[i], b = worldPts[i + 1];
          if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
          outLines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
        if (closed && worldPts.length >= 3) {
          const a = worldPts[worldPts.length - 1], b = worldPts[0];
          if (Math.hypot(b.x - a.x, b.y - a.y) >= 1e-6) {
            outLines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        }
      }
    }

    function buildDebugMaskCanvas(thinBin) {
      if (previewStyle !== 'mask') return null;
      const mc = document.createElement('canvas');
      mc.width = w;
      mc.height = h;
      const mctx = mc.getContext('2d');
      const md = mctx.createImageData(w, h);
      const d = md.data;
      for (let i = 0; i < N; i++) {
        const p = i * 4;
        if (solidMask[i]) {
          d[p] = 255; d[p + 1] = 175; d[p + 2] = 40; d[p + 3] = 155;
        } else if (thinBin[i]) {
          d[p] = 255; d[p + 1] = 60; d[p + 2] = 150; d[p + 3] = 135;
        }
      }
      mctx.putImageData(md, 0, 0);
      return mc;
    }

    // -----------------------------------------------------------------------
    // MODE A: Sub-Pixel Marching Squares Contour Vectorizer ('marching')
    // -----------------------------------------------------------------------
    if (mode === 'marching') {
      const contours = extractMarchingContours(field, w, h);
      const closedLoops = [];
      const openChains = [];

      for (const ch of contours) {
        if (ch.pts.length < Math.max(2, minChainLen)) continue;
        const { pts: sm, corners } = smoothPolylineTaubin(ch.pts, 3, { closed: ch.closed });
        const simp = piecewiseRdpSimplify(sm, corners, simplifyPx, ch.closed);
        if (ch.closed && simp.length >= 3) {
          closedLoops.push(simp);
        } else if (simp.length >= 2) {
          openChains.push({ pts: simp, closed: false });
        }
      }

      if (solidStyle === 'fill' && closedLoops.length > 0) {
        const outers = nestClosedContoursWithHoles(closedLoops);
        for (const item of outers) {
          const outerWorld = item.pts.map((p) => pixelToWorld(p.x, p.y));
          const holesWorld = item.holes.map((hPts) => hPts.map((p) => pixelToWorld(p.x, p.y)));
          const bridged = bridgeHolesIntoOuter(outerWorld, holesWorld);
          const mergedQuads = triangulatePolygonToQuads(bridged);
          for (const q of mergedQuads) {
            outQuads.push({ tl: q[0], tr: q[1], br: q[2], bl: q[3] });
          }
        }
        for (const oc of openChains) {
          emitWorldPolyline(oc.pts.map((p) => pixelToWorld(p.x, p.y)), false);
        }
      } else {
        for (const cl of closedLoops) {
          const wp = cl.map((p) => pixelToWorld(p.x, p.y));
          emitWorldPolyline(wp, true);
        }
        for (const oc of openChains) {
          emitWorldPolyline(oc.pts.map((p) => pixelToWorld(p.x, p.y)), false);
        }
      }

      return { lines: outLines, quads: outQuads, maskCanvas: buildDebugMaskCanvas(bin) };
    }

    // -----------------------------------------------------------------------
    // MODE B & D: Exact EDT + Topology Graph Centerline ('centerline' & 'hybrid')
    // MODE C: Canny + Skeleton Topology Graph ('canny')
    // -----------------------------------------------------------------------
    const edt = computeExactEDT(bin, w, h);
    let skeletonSource = bin;

    if (mode === 'hybrid') {
      // Exact circular morphological opening separates genuine solid shaded shapes from strokes & X-crossings
      const coreBin = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (bin[i] && edt[i] >= solidRadPx) coreBin[i] = 1;
      }

      // Discard tiny isolated crossing-diamond core fragments
      const visitedCore = new Uint8Array(N);
      const minCoreArea = Math.max(8, Math.round(solidRadPx * solidRadPx * 0.4));
      const cDirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
      for (let i = 0; i < N; i++) {
        if (!coreBin[i] || visitedCore[i]) continue;
        const comp = [];
        const q = [i];
        visitedCore[i] = 1;
        while (q.length > 0) {
          const c = q.pop();
          comp.push(c);
          const cx = c % w, cy = (c / w) | 0;
          for (let k = 0; k < 8; k++) {
            const nx = cx + cDirs[k][0], ny = cy + cDirs[k][1];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (coreBin[ni] && !visitedCore[ni]) {
              visitedCore[ni] = 1;
              q.push(ni);
            }
          }
        }
        if (comp.length < minCoreArea) {
          for (const px of comp) coreBin[px] = 0;
        }
      }

      // Reconstruct exact opened solid regions via inverse EDT in O(w*h) while preserving bright interior holes!
      const invCore = new Uint8Array(N);
      for (let i = 0; i < N; i++) invCore[i] = coreBin[i] ? 0 : 1;
      const distFromCore = computeExactEDT(invCore, w, h);

      const strokeThinMask = new Uint8Array(N);
      const solidField = new Float32Array(N);

      for (let i = 0; i < N; i++) {
        const isOpened = bin[i] && distFromCore[i] <= solidRadPx + 1.2;
        if (isOpened) {
          solidMask[i] = 1;
        } else if (bin[i]) {
          strokeThinMask[i] = 1;
        }
        solidField[i] = isOpened ? Math.max(0.5, field[i]) : -Math.max(0.5, -field[i]);
      }

      // Extend thin strokes 1px into solid shapes ONLY at stroke-attachment ports (avoids double rings on isolated eyes!)
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!solidMask[i]) continue;
          for (let k = 0; k < 8; k++) {
            const nx = x + cDirs[k][0], ny = y + cDirs[k][1];
            const ni = ny * w + nx;
            if (bin[ni] && !solidMask[ni]) {
              strokeThinMask[i] = 1;
              break;
            }
          }
        }
      }

      // Extract & emit hole-preserved solid filled regions
      const solidContours = extractMarchingContours(solidField, w, h);
      const solidClosed = [];
      for (const sc of solidContours) {
        if (sc.pts.length < Math.max(4, minChainLen)) continue;
        const { pts: sm, corners } = smoothPolylineTaubin(sc.pts, 3, { closed: true });
        const simp = piecewiseRdpSimplify(sm, corners, Math.max(0.45, simplifyPx), true);
        if (simp.length >= 3) solidClosed.push(simp);
      }

      if (solidClosed.length > 0) {
        if (solidStyle === 'fill') {
          const outers = nestClosedContoursWithHoles(solidClosed);
          for (const item of outers) {
            const outerWorld = item.pts.map((p) => pixelToWorld(p.x, p.y));
            const holesWorld = item.holes.map((hPts) => hPts.map((p) => pixelToWorld(p.x, p.y)));
            const bridged = bridgeHolesIntoOuter(outerWorld, holesWorld);
            const mergedQuads = triangulatePolygonToQuads(bridged);
            for (const q of mergedQuads) {
              outQuads.push({ tl: q[0], tr: q[1], br: q[2], bl: q[3] });
            }
          }
        } else {
          for (const scPts of solidClosed) {
            emitWorldPolyline(scPts.map((p) => pixelToWorld(p.x, p.y)), true);
          }
        }
      }

      skeletonSource = strokeThinMask;
    }

    let edges;
    if (mode === 'canny') {
      edges = new Uint8Array(N);
      const mag = new Float32Array(N);
      const dir = new Uint8Array(N);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gxL = -smooth[i - w - 1] + smooth[i - w + 1] - 2 * smooth[i - 1] + 2 * smooth[i + 1] - smooth[i + w - 1] + smooth[i + w + 1];
          const gyL = -smooth[i - w - 1] - 2 * smooth[i - w] - smooth[i - w + 1] + smooth[i + w - 1] + 2 * smooth[i + w] + smooth[i + w + 1];
          const gxA = -alpha[i - w - 1] + alpha[i - w + 1] - 2 * alpha[i - 1] + 2 * alpha[i + 1] - alpha[i + w - 1] + alpha[i + w + 1];
          const gyA = -alpha[i - w - 1] - 2 * alpha[i - w] - alpha[i - w + 1] + alpha[i + w - 1] + 2 * alpha[i + w] + alpha[i + w + 1];
          const mL = Math.hypot(gxL, gyL) * 0.25;
          const mA = Math.hypot(gxA, gyA) * 0.25;
          mag[i] = Math.max(mL, mA);
          const gx = mL >= mA ? gxL : gxA;
          const gy = mL >= mA ? gyL : gyA;
          let ang = (Math.atan2(gy, gx) * 180) / Math.PI;
          if (ang < 0) ang += 180;
          if (ang < 22.5 || ang >= 157.5) dir[i] = 0;
          else if (ang < 67.5) dir[i] = 1;
          else if (ang < 112.5) dir[i] = 2;
          else dir[i] = 3;
        }
      }

      const highThresh = Math.max(1.5, 140 * Math.pow(1 - sens / 100, 1.8));
      const lowThresh = highThresh * 0.38;
      const nms = new Uint8Array(N);
      const strongQueue = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const m = mag[i];
          if (m < lowThresh) continue;
          const d = dir[i];
          const n1 = d === 0 ? mag[i - 1] : d === 1 ? mag[i - w + 1] : d === 2 ? mag[i - w] : mag[i - w - 1];
          const n2 = d === 0 ? mag[i + 1] : d === 1 ? mag[i + w - 1] : d === 2 ? mag[i + w] : mag[i + w + 1];
          if (m >= n1 && m >= n2) {
            if (m >= highThresh) {
              nms[i] = 2;
              strongQueue.push(i);
            } else {
              nms[i] = 1;
            }
          }
        }
      }
      const neighbors = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
      while (strongQueue.length > 0) {
        const curr = strongQueue.pop();
        edges[curr] = 1;
        for (let k = 0; k < 8; k++) {
          const ni = curr + neighbors[k];
          if (nms[ni] === 1) {
            nms[ni] = 2;
            strongQueue.push(ni);
          }
        }
      }
    } else {
      edges = thinMaskZhangSuen(skeletonSource, w, h);
    }

    // Prune short whisker spurs cleanly while preserving junctions & crossings
    pruneSkeletonSpurs(edges, w, h, spurLimit);

    // Extract topology graph with clustered Junction Super-Nodes & tangent X-crossing merges
    const chains = extractSkeletonGraphAndMerge(edges, w, h);

    // Smooth with Taubin non-shrinking filter + sub-pixel darkness ridge snapping
    const preSimpChains = [];
    for (const ch of chains) {
      if (ch.pts.length < Math.max(2, minChainLen)) continue;

      const ptsWithEdt = ch.pts.map((p) => {
        const ix = Math.max(0, Math.min(w - 1, Math.round(p.x - 0.5)));
        const iy = Math.max(0, Math.min(h - 1, Math.round(p.y - 0.5)));
        return { x: p.x, y: p.y, halfWidthPx: Math.max(0.5, edt[iy * w + ix] - 0.45) };
      });

      const { pts: taubinPts, corners } = smoothPolylineTaubin(ptsWithEdt, 4, { closed: ch.closed });
      const ridgePts = mode === 'canny'
        ? taubinPts
        : snapChainToDarkRidge(taubinPts, inkRidgeField, w, h, corners, ch.closed);
      if (ridgePts.length >= 2) {
        preSimpChains.push({
          pts: ridgePts,
          corners,
          closed: ch.closed,
          startJunction: ch.startJunction,
          endJunction: ch.endJunction
        });
      }
    }

    // Snap any unmerged T-junction / Y-junction stem endpoint cleanly onto the closest smoothed crossing segment
    if (preSimpChains.length > 1) {
      const snapMaxPx = 3.0;
      const snapEndToClosestChain = (chainIdx, ptIdx) => {
        const pt = preSimpChains[chainIdx].pts[ptIdx];
        let bestDist = snapMaxPx;
        let bestX = pt.x, bestY = pt.y;
        let found = false;
        for (let oi = 0; oi < preSimpChains.length; oi++) {
          if (oi === chainIdx) continue;
          const opts = preSimpChains[oi].pts;
          const segMax = preSimpChains[oi].closed ? opts.length : opts.length - 1;
          for (let s = 0; s < segMax; s++) {
            const a = opts[s], b = opts[(s + 1) % opts.length];
            const dx = b.x - a.x, dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            if (lenSq < 1e-8) continue;
            const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
            const px = a.x + dx * t, py = a.y + dy * t;
            const d = Math.hypot(pt.x - px, pt.y - py);
            if (d < bestDist) {
              bestDist = d;
              bestX = px;
              bestY = py;
              found = true;
            }
          }
        }
        if (found) {
          pt.x = bestX;
          pt.y = bestY;
        }
      };

      for (let ci = 0; ci < preSimpChains.length; ci++) {
        const item = preSimpChains[ci];
        if (item.closed || item.pts.length < 2) continue;
        if (item.startJunction >= 0) snapEndToClosestChain(ci, 0);
        if (item.endJunction >= 0) snapEndToClosestChain(ci, item.pts.length - 1);
      }
    }

    const processedChains = [];
    for (const item of preSimpChains) {
      const simpPts = piecewiseRdpSimplify(item.pts, item.corners, simplifyPx, item.closed);
      if (simpPts.length >= 2) {
        processedChains.push({ pts: simpPts, closed: item.closed });
      }
    }

    // Optional post-trace endpoint gap bridging (connects tiny 1–3.5px hairline breaks between opposing endpoints)
    if (weldGaps && processedChains.length > 1) {
      const gapThresh = 3.5;
      const openEnds = [];
      for (let ci = 0; ci < processedChains.length; ci++) {
        const c = processedChains[ci];
        if (c.closed || c.pts.length < 2) continue;
        openEnds.push({ ci, atStart: true, pt: c.pts[0] });
        openEnds.push({ ci, atStart: false, pt: c.pts[c.pts.length - 1] });
      }
      for (let a = 0; a < openEnds.length; a++) {
        for (let b = a + 1; b < openEnds.length; b++) {
          const ea = openEnds[a], eb = openEnds[b];
          if (ea.ci === eb.ci) continue;
          const d = Math.hypot(ea.pt.x - eb.pt.x, ea.pt.y - eb.pt.y);
          if (d > 1e-4 && d <= gapThresh) {
            const mx = (ea.pt.x + eb.pt.x) * 0.5;
            const my = (ea.pt.y + eb.pt.y) * 0.5;
            const pa = processedChains[ea.ci].pts;
            const pb = processedChains[eb.ci].pts;
            if (ea.atStart) { pa[0].x = mx; pa[0].y = my; } else { pa[pa.length - 1].x = mx; pa[pa.length - 1].y = my; }
            if (eb.atStart) { pb[0].x = mx; pb[0].y = my; } else { pb[pb.length - 1].x = mx; pb[pb.length - 1].y = my; }
          }
        }
      }
    }

    for (const ch of processedChains) {
      const worldPts = ch.pts.map((p) => pixelToWorld(p.x, p.y));
      emitWorldPolyline(worldPts, ch.closed, ch.pts, edt);
    }

    return {
      lines: outLines,
      quads: outQuads,
      maskCanvas: buildDebugMaskCanvas(skeletonSource)
    };
  }

  function scheduleLiveTracePreview() {
    if (!state.refImage.img) return;
    if ($('chkTraceLivePreview')?.checked && $('tracePreviewStats')) {
      $('tracePreviewStats').textContent = 'Tracing...';
    }
    if (state.tracePreview.timer) clearTimeout(state.tracePreview.timer);
    state.tracePreview.timer = setTimeout(() => {
      const res = computeImageVectorTrace();
      state.tracePreview.lines = res.lines;
      state.tracePreview.quads = res.quads;
      state.tracePreview.maskCanvas = res.maskCanvas;
      const qTxt = res.quads.length > 0 ? ` + ${res.quads.length}Q` : '';
      $('tracePreviewStats').textContent = `${res.lines.length}L${qTxt}`;
      requestRender();
    }, 36);
  }

  function askImportAdvisory({
    title = 'Drawing Import Advisory',
    subtitle = 'Review before continuing',
    alertText = '',
    bullets = [],
    canAutoFit = false,
    canChop = false
  }) {
    const modal = $('importAdvisoryModal');
    if (!modal) return Promise.resolve('all');

    const progressOverlay = $('taskProgressOverlay');
    const wasProgressVisible = progressOverlay && !progressOverlay.hidden;
    if (wasProgressVisible) progressOverlay.hidden = true;

    $('importAdvisoryTitle').textContent = title;
    $('importAdvisorySubtitle').textContent = subtitle;

    const body = $('importAdvisoryBody');
    body.innerHTML = '';
    if (alertText) {
      const alertDiv = document.createElement('div');
      alertDiv.className = 'advisory-alert';
      alertDiv.textContent = alertText;
      body.appendChild(alertDiv);
    }
    if (bullets.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'advisory-list';
      for (const b of bullets) {
        const li = document.createElement('li');
        li.textContent = b;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    const promptP = document.createElement('p');
    promptP.style.margin = '4px 0 0';
    promptP.style.fontWeight = '500';
    promptP.textContent = 'Would you like to continue?';
    body.appendChild(promptP);

    const btnCancel = $('btnAdvisoryCancel');
    const btnClose = $('btnCloseAdvisory');
    const btnChop = $('btnAdvisoryChop');
    const btnAll = $('btnAdvisoryImportAll');
    const btnAutoFit = $('btnAdvisoryAutoFit');

    btnAutoFit.hidden = !canAutoFit;
    btnChop.hidden = !canChop;

    modal.hidden = false;

    return new Promise((resolve) => {
      function cleanup(choice) {
        btnCancel.removeEventListener('click', onCancel);
        btnClose.removeEventListener('click', onCancel);
        btnChop.removeEventListener('click', onChop);
        btnAll.removeEventListener('click', onAll);
        btnAutoFit.removeEventListener('click', onAutoFit);
        modal.hidden = true;
        if (wasProgressVisible && choice !== 'cancel') {
          progressOverlay.hidden = false;
        }
        resolve(choice);
      }
      function onCancel() { cleanup('cancel'); }
      function onChop() { cleanup('chop'); }
      function onAll() { cleanup('all'); }
      function onAutoFit() { cleanup('autofit'); }

      btnCancel.addEventListener('click', onCancel);
      btnClose.addEventListener('click', onCancel);
      btnChop.addEventListener('click', onChop);
      btnAll.addEventListener('click', onAll);
      btnAutoFit.addEventListener('click', onAutoFit);
    });
  }

  async function commitAutoTraceToDocument() {
    if (!state.refImage.img) return;
    showTaskProgress('Auto-Drawing Image...', state.refImage.name || 'Vectorizing strokes', 15);
    try {
      await nextPaintFrame();
      let res = computeImageVectorTrace();
      if (res.lines.length === 0 && res.quads.length === 0) {
        showToast('No strokes detected. Try raising Sensitivity or toggling Invert B/W', 'warn');
        return;
      }

      const replacePrev = $('chkTraceReplace').checked && state.lastTraceIds.size > 0;
      const baseExisting =
        (replacePrev ? state.doc.lines.filter((l) => !state.lastTraceIds.has(l.id)).length : state.doc.lines.length) +
        (replacePrev ? state.doc.quads.filter((q) => !state.lastTraceIds.has(q.id)).length : state.doc.quads.length) +
        state.doc.circles.length +
        state.doc.texts.length;
      const totalNew = res.lines.length + res.quads.length;

      if (baseExisting + totalNew > WT_RECOMMENDED_LIMIT) {
        const budget = Math.max(200, WT_RECOMMENDED_LIMIT - baseExisting);
        const choice = await askImportAdvisory({
          title: 'High Complexity Auto-Draw Advisory',
          subtitle: `${state.refImage.name || 'Reference Image'} (${totalNew} primitives)`,
          alertText: `This trace generates ${totalNew} primitives (total sight complexity: ${baseExisting + totalNew} / ${WT_RECOMMENDED_LIMIT}). War Thunder may chop or fail to render sights above ${WT_RECOMMENDED_LIMIT} primitives in-game.`,
          bullets: [
            `Auto-Simplify to Fit: Increases curve smoothing so the entire drawing fits within ${WT_RECOMMENDED_LIMIT} primitives without chopping off shapes.`,
            `Chop to ${WT_RECOMMENDED_LIMIT} Limit: Keeps full detail on the first ${budget} primitives and truncates the remaining ${Math.max(0, totalNew - budget)} primitives.`,
            `Continue & Import All: Imports all ${totalNew} primitives without chopping.`
          ],
          canAutoFit: true,
          canChop: true
        });
        if (choice === 'cancel') {
          showToast('Auto-Draw canceled', 'warn');
          return;
        }
        if (choice === 'autofit') {
          const origSimp = parseFloat($('rngTraceSimplify').value) || 0.65;
          for (const trySimp of [1.2, 1.8, 2.5, 3.5]) {
            if (trySimp <= origSimp) continue;
            $('rngTraceSimplify').value = String(trySimp);
            $('lblTraceSimplify').textContent = `${trySimp.toFixed(2)}px`;
            res = computeImageVectorTrace();
            if (baseExisting + res.lines.length + res.quads.length <= WT_RECOMMENDED_LIMIT) break;
          }
        } else if (choice === 'chop') {
          let rem = budget;
          if (res.quads.length > rem) {
            res.quads = res.quads.slice(0, rem);
            res.lines = [];
          } else {
            rem -= res.quads.length;
            if (res.lines.length > rem) res.lines = res.lines.slice(0, rem);
          }
        }
      }

      updateTaskProgress(`Adding ${res.lines.length} lines & ${res.quads.length} quads...`, 70);
      await nextPaintFrame();

      if (replacePrev) {
        state.doc.lines = state.doc.lines.filter((l) => !state.lastTraceIds.has(l.id));
        state.doc.quads = state.doc.quads.filter((q) => !state.lastTraceIds.has(q.id));
        state.doc.texts = state.doc.texts.filter((t) => !state.lastTraceIds.has(t.id));
        state.lastTraceIds.clear();
      }

      const targetLayer = $('selTraceLayer').value || 'draw';
      const th = state.options.defaultThousandth;
      const mv = state.options.defaultMoveRadial ? false : state.options.defaultMove;
      const newBatchIds = new Set();

      for (const l of res.lines) {
        const id = BlkParser.nextId('line');
        newBatchIds.add(id);
        state.doc.lines.push({
          id,
          layer: targetLayer,
          x1: fromCanvasUnit(l.x1, th),
          y1: fromCanvasUnit(l.y1, th),
          x2: fromCanvasUnit(l.x2, th),
          y2: fromCanvasUnit(l.y2, th),
          move: mv,
          thousandth: th,
          ...makeDefaultRadialFields((l.x1 + l.x2) * 0.5, (l.y1 + l.y2) * 0.5)
        });
      }

      for (const q of res.quads) {
        const id = BlkParser.nextId('quad');
        newBatchIds.add(id);
        state.doc.quads.push({
          id,
          layer: targetLayer,
          tl: { x: fromCanvasUnit(q.tl.x, th), y: fromCanvasUnit(q.tl.y, th) },
          tr: { x: fromCanvasUnit(q.tr.x, th), y: fromCanvasUnit(q.tr.y, th) },
          br: { x: fromCanvasUnit(q.br.x, th), y: fromCanvasUnit(q.br.y, th) },
          bl: { x: fromCanvasUnit(q.bl.x, th), y: fromCanvasUnit(q.bl.y, th) },
          move: mv,
          thousandth: th,
          ...makeDefaultRadialFields(
            (q.tl.x + q.tr.x + q.br.x + q.bl.x) * 0.25,
            (q.tl.y + q.tr.y + q.br.y + q.bl.y) * 0.25
          )
        });
      }

      updateTaskProgress('Done', 100);
      state.lastTraceIds = newBatchIds;
      $('btnUndoTrace').disabled = false;
      $('chkTraceLivePreview').checked = false;
      pushHistory();
      requestRender();
      showToast(`Auto-drew ${res.lines.length} lines${res.quads.length ? ` & ${res.quads.length} quads` : ''} into ${targetLayer === 'base' ? 'Base' : 'Drawn'} layer`);
    } finally {
      hideTaskProgress();
    }
  }

  function undoLastAutoTrace() {
    if (state.lastTraceIds.size === 0) return;
    const removedCount = state.lastTraceIds.size;
    state.doc.lines = state.doc.lines.filter((l) => !state.lastTraceIds.has(l.id));
    state.doc.quads = state.doc.quads.filter((q) => !state.lastTraceIds.has(q.id));
    state.doc.texts = state.doc.texts.filter((t) => !state.lastTraceIds.has(t.id));
    for (const id of state.lastTraceIds) state.selection.delete(id);
    state.lastTraceIds.clear();
    $('btnUndoTrace').disabled = true;
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Removed ${removedCount} auto-drawn element(s)`);
  }

  /**
   * Vectorize extracted SVG text labels into crisp single-stroke letterform polylines via an offscreen canvas.
   */
  function vectorizeSvgTextLabels(textItems, svgPtToWorld) {
    const outPolylines = [];
    const fallbackNativeTexts = [];

    for (const item of textItems) {
      const textStr = item.text.trim();
      if (!textStr) continue;
      if (item.svgW <= 1e-4 || item.svgH <= 1e-4) {
        fallbackNativeTexts.push(item);
        continue;
      }

      // Render this text label at high resolution (~56px cap height) for clean centerline skeletonization
      const lines = textStr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) continue;

      const pxPerLine = 54;
      const pad = 14;
      const estCharW = pxPerLine * 0.65;
      const maxChars = Math.max(...lines.map((l) => l.length), 1);
      const cw = Math.max(96, Math.min(2048, Math.ceil(maxChars * estCharW + pad * 3)));
      const ch = Math.max(72, Math.min(1024, Math.ceil(lines.length * pxPerLine * 1.28 + pad * 2)));

      const tc = document.createElement('canvas');
      tc.width = cw;
      tc.height = ch;
      const tctx = tc.getContext('2d');
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, cw, ch);

      tctx.fillStyle = '#000000';
      const weight = item.fontWeight && item.fontWeight !== 'normal' && item.fontWeight !== '400' ? '600' : '500';
      const style = item.fontStyle === 'italic' ? 'italic' : 'normal';
      const family = item.fontFamily || 'sans-serif';
      tctx.font = `${style} ${weight} ${pxPerLine}px ${family}`;
      tctx.textAlign = 'center';
      tctx.textBaseline = 'middle';

      const totalBlockH = lines.length * pxPerLine * 1.2;
      const startY = ch * 0.5 - totalBlockH * 0.5 + pxPerLine * 0.6;
      for (let li = 0; li < lines.length; li++) {
        tctx.fillText(lines[li], cw * 0.5, startY + li * pxPerLine * 1.2);
      }

      const imgD = tctx.getImageData(0, 0, cw, ch).data;
      const bin = new Uint8Array(cw * ch);
      let minX = cw, maxX = 0, minY = ch, maxY = 0, inkCount = 0;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = y * cw + x;
          if (imgD[i * 4] < 150) {
            bin[i] = 1;
            inkCount++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (inkCount < 6 || maxX <= minX || maxY <= minY) {
        fallbackNativeTexts.push(item);
        continue;
      }

      const thinned = thinMaskZhangSuen(bin, cw, ch);
      pruneSkeletonSpurs(thinned, cw, ch, 2);
      const chains = extractSkeletonGraphAndMerge(thinned, cw, ch);
      if (!chains.length) {
        fallbackNativeTexts.push(item);
        continue;
      }

      const inkW = Math.max(1, maxX - minX);
      const inkH = Math.max(1, maxY - minY);
      const inkAspect = inkW / inkH;
      const boxAspect = item.svgW / item.svgH;

      // Fit rendered ink bounds proportionally inside the measured SVG text bounding box
      let fitW = item.svgW;
      let fitH = item.svgH;
      if (inkAspect > boxAspect) {
        fitH = fitW / inkAspect;
      } else {
        fitW = fitH * inkAspect;
      }
      const boxCx = item.svgX + item.svgW * 0.5;
      const boxCy = item.svgY + item.svgH * 0.5;
      const targetX0 = boxCx - fitW * 0.5;
      const targetY0 = boxCy - fitH * 0.5;

      for (const chItem of chains) {
        if (chItem.pts.length < 2) continue;
        const { pts: sm, corners } = smoothPolylineTaubin(chItem.pts, 2, { closed: chItem.closed });
        const simp = piecewiseRdpSimplify(sm, corners, 0.55, chItem.closed);
        const worldPts = simp.map((p) => {
          const sx = targetX0 + ((p.x - minX) / inkW) * fitW;
          const sy = targetY0 + ((p.y - minY) / inkH) * fitH;
          return svgPtToWorld(sx, sy);
        });
        if (worldPts.length >= 2) {
          outPolylines.push({ pts: worldPts, closed: chItem.closed });
        }
      }
    }

    return { textPolylines: outPolylines, fallbackNativeTexts };
  }

  /**
   * Direct SVG vector importer: flattens SVG shapes, compound paths, <use> instances,
   * and <text> / <foreignObject> labels directly using native DOM geometry APIs.
   */
  async function importSvgFile(svgText, fileName = 'artwork.svg') {
    showTaskProgress(`Importing SVG: ${fileName}`, 'Parsing vector DOM...', 5);
    try {
      await nextPaintFrame();
      const parser = new DOMParser();
      let xml = parser.parseFromString(svgText, 'image/svg+xml');
      let svgEl = xml.querySelector('svg');
      if (!svgEl || xml.querySelector('parsererror')) {
        const htmlFallback = parser.parseFromString(svgText, 'text/html');
        const fallbackSvg = htmlFallback.querySelector('svg');
        if (fallbackSvg) svgEl = fallbackSvg;
      }
      if (!svgEl) {
        showToast('Invalid SVG file', 'error');
        return;
      }

      const ns = 'http://www.w3.org/2000/svg';
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1024px;height:1024px;overflow:visible;opacity:0;pointer-events:none;';
      const cloned = document.importNode(svgEl, true);
      host.appendChild(cloned);
      document.body.appendChild(host);

      // Per-element compound fill groups:Array<Array<Array<{x,y}>>> (each element is an array of closed loops for ONE SVG shape)
      const elementFillGroups = [];
      let openPolylines = [];
      let extractedTextItems = [];
      let fallbackNativeTexts = [];
      let skippedRasterCount = 0;
      let skippedUnsupportedCount = 0;
      let embeddedRasterDataUrl = null;
      let vbW = 100, vbH = 100, targetW = 0.45, targetH = 0.45;
      let simpWorldEps = 0.0004;

      try {
        // 1. Expand <use href="#id"> / <use xlink:href="#id"> instances (up to 3 nesting levels)
        for (let pass = 0; pass < 3; pass++) {
          const uses = Array.from(cloned.querySelectorAll('use')).filter(
            (u) => !u.closest('defs, clipPath, mask, marker, pattern, symbol')
          );
          if (!uses.length) break;
          for (const u of uses) {
            const href = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').trim();
            if (!href.startsWith('#')) {
              u.remove();
              continue;
            }
            const refId = href.slice(1);
            const target = cloned.getElementById ? cloned.getElementById(refId) : cloned.querySelector(`[id="${CSS.escape(refId)}"]`);
            if (!target) {
              u.remove();
              continue;
            }
            const g = document.createElementNS(ns, 'g');
            const ux = parseFloat(u.getAttribute('x')) || 0;
            const uy = parseFloat(u.getAttribute('y')) || 0;
            const uTrans = u.getAttribute('transform') || '';
            const translateStr = (ux !== 0 || uy !== 0) ? `translate(${ux}, ${uy})` : '';
            const fullTrans = [uTrans, translateStr].filter(Boolean).join(' ');
            if (fullTrans) g.setAttribute('transform', fullTrans);
            for (const attr of ['fill', 'stroke', 'stroke-width', 'style', 'class', 'opacity']) {
              if (u.hasAttribute(attr)) g.setAttribute(attr, u.getAttribute(attr));
            }
            if (target.tagName.toLowerCase() === 'symbol') {
              for (const child of Array.from(target.childNodes)) {
                g.appendChild(child.cloneNode(true));
              }
            } else {
              const copy = target.cloneNode(true);
              copy.removeAttribute('id');
              g.appendChild(copy);
            }
            u.replaceWith(g);
          }
        }

        // 2. Deduplicate <switch> elements (draw.io / diagrams.net wraps both <foreignObject> and fallback <text>)
        for (const sw of Array.from(cloned.querySelectorAll('switch'))) {
          const children = Array.from(sw.children);
          let keptBranch = null;
          for (const ch of children) {
            const txt = (ch.textContent || '').trim();
            if (/text is not supported|viewer does not support/i.test(txt)) {
              ch.setAttribute('data-wt-skip', '1');
              continue;
            }
            if (!keptBranch && (txt.length > 0 || ch.querySelector('path, rect, circle, ellipse, polygon, polyline, line, text, foreignObject'))) {
              keptBranch = ch;
            } else {
              ch.setAttribute('data-wt-skip', '1');
            }
          }
        }

        const vb = cloned.viewBox && cloned.viewBox.baseVal && cloned.viewBox.baseVal.width > 0
          ? cloned.viewBox.baseVal
          : null;
        let bbox;
        try { bbox = cloned.getBBox(); } catch (_) { bbox = null; }
        const vbX = vb ? vb.x : (bbox && bbox.width > 0 ? bbox.x : 0);
        const vbY = vb ? vb.y : (bbox && bbox.height > 0 ? bbox.y : 0);
        vbW = vb ? vb.width : (parseFloat(cloned.getAttribute('width')) || (bbox && bbox.width > 0 ? bbox.width : 100));
        vbH = vb ? vb.height : (parseFloat(cloned.getAttribute('height')) || (bbox && bbox.height > 0 ? bbox.height : 100));

        // Ensure cloned SVG has explicit pixel width/height matching viewBox so <foreignObject> HTML flex/table layouts measure accurately
        cloned.setAttribute('width', `${vbW}px`);
        cloned.setAttribute('height', `${vbH}px`);
        if (!vb) cloned.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);

        const svgAspect = vbW / (vbH || 1);
        targetH = state.refImage.scale || 0.45;
        targetW = targetH * svgAspect;
        const cx = state.refImage.x || 0;
        const cy = state.refImage.y || 0;
        const rotRad = ((state.refImage.rotation || 0) * Math.PI) / 180;
        const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
        const svgRootCtm = cloned.getCTM();
        const invRootCtm = svgRootCtm ? svgRootCtm.inverse() : null;
        const svgClientRect = cloned.getBoundingClientRect();

        function svgPtToWorld(sx, sy) {
          const lx = ((sx - vbX) / (vbW || 1) - 0.5) * targetW;
          const ly = ((sy - vbY) / (vbH || 1) - 0.5) * targetH;
          return {
            x: cx + lx * cosR - ly * sinR,
            y: cy + lx * sinR + ly * cosR
          };
        }

        simpWorldEps = Math.max(0.00018, ((parseFloat($('rngTraceSimplify')?.value) || 0.65) / 640) * Math.max(targetW, targetH));

        // 3. Check for embedded <image> elements
        for (const imgEl of Array.from(cloned.querySelectorAll('image'))) {
          if (imgEl.closest('defs, clipPath, mask, marker, pattern, symbol, [data-wt-skip="1"]')) continue;
          const href = (imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href') || '').trim();
          if (href.startsWith('data:image/')) {
            embeddedRasterDataUrl = href;
          }
          skippedRasterCount++;
        }

        // 4. Extract visible text labels from both SVG <text>/<tspan> and HTML <foreignObject>
        const walker = document.createTreeWalker(cloned, NodeFilter.SHOW_TEXT, null);
        let tNode;
        while ((tNode = walker.nextNode())) {
          const rawStr = (tNode.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (!rawStr) continue;
          if (/^text is not supported|viewer does not support/i.test(rawStr)) continue;
          const pEl = tNode.parentElement;
          if (!pEl) continue;
          if (pEl.closest('defs, clipPath, mask, marker, pattern, symbol, style, script, title, desc, metadata, [data-wt-skip="1"]')) continue;
          const cs = window.getComputedStyle(pEl);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;

          const range = document.createRange();
          range.selectNodeContents(tNode);
          const r = range.getBoundingClientRect();
          if (r.width > 0.5 && r.height > 0.5 && svgClientRect.width > 0 && svgClientRect.height > 0) {
            const svgX = vbX + ((r.left - svgClientRect.left) / svgClientRect.width) * vbW;
            const svgY = vbY + ((r.top - svgClientRect.top) / svgClientRect.height) * vbH;
            const svgBoxW = (r.width / svgClientRect.width) * vbW;
            const svgBoxH = (r.height / svgClientRect.height) * vbH;
            extractedTextItems.push({
              text: rawStr,
              svgX,
              svgY,
              svgW: svgBoxW,
              svgH: svgBoxH,
              fontFamily: cs.fontFamily,
              fontWeight: cs.fontWeight,
              fontStyle: cs.fontStyle
            });
          } else {
            // Fallback for SVG <text> where range bounding rect is 0
            const textOwner = pEl.closest('text') || pEl;
            let tb = null;
            try { tb = textOwner.getBBox(); } catch (_) { tb = null; }
            if (tb && tb.width > 0 && tb.height > 0) {
              const tCtm = textOwner.getCTM();
              const relM = tCtm && invRootCtm ? invRootCtm.multiply(tCtm) : tCtm;
              const p0 = relM ? { x: tb.x * relM.a + tb.y * relM.c + relM.e, y: tb.x * relM.b + tb.y * relM.d + relM.f } : { x: tb.x, y: tb.y };
              const p1 = relM
                ? { x: (tb.x + tb.width) * relM.a + (tb.y + tb.height) * relM.c + relM.e, y: (tb.x + tb.width) * relM.b + (tb.y + tb.height) * relM.d + relM.f }
                : { x: tb.x + tb.width, y: tb.y + tb.height };
              extractedTextItems.push({
                text: rawStr,
                svgX: Math.min(p0.x, p1.x),
                svgY: Math.min(p0.y, p1.y),
                svgW: Math.max(1, Math.abs(p1.x - p0.x)),
                svgH: Math.max(1, Math.abs(p1.y - p0.y)),
                fontFamily: cs.fontFamily,
                fontWeight: cs.fontWeight,
                fontStyle: cs.fontStyle
              });
            }
          }
        }

        // Spec-compliant multi-M <path> splitter (handles concatenated 0/1 arc flags and chained decimals like .5.5)
        function splitPathSubpaths(dStr) {
          const subpaths = [];
          let curD = '';
          let x = 0, y = 0, sx0 = 0, sy0 = 0;
          let cmd = '';
          let pos = 0;
          const len = dStr.length;

          function skipWsComma() {
            while (pos < len && /[\s,]/.test(dStr[pos])) pos++;
          }
          function readCmd() {
            skipWsComma();
            if (pos < len && /[a-zA-Z]/.test(dStr[pos])) {
              return dStr[pos++];
            }
            return '';
          }
          function readFlag() {
            skipWsComma();
            if (pos < len && (dStr[pos] === '0' || dStr[pos] === '1')) {
              return parseInt(dStr[pos++], 10);
            }
            return NaN;
          }
          function readNum() {
            skipWsComma();
            if (pos >= len) return NaN;
            const sub = dStr.slice(pos);
            const m = sub.match(/^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/);
            if (!m) return NaN;
            pos += m[0].length;
            return parseFloat(m[0]);
          }

          while (pos < len) {
            const nextC = readCmd();
            if (nextC) {
              cmd = nextC;
              if (cmd === 'Z' || cmd === 'z') {
                curD += ' Z';
                x = sx0; y = sy0;
                continue;
              }
            }
            if (!cmd) break;

            if (cmd === 'M' || cmd === 'm') {
              const nx = readNum(), ny = readNum();
              if (Number.isNaN(nx) || Number.isNaN(ny)) break;
              x = cmd === 'm' ? x + nx : nx;
              y = cmd === 'm' ? y + ny : ny;
              sx0 = x; sy0 = y;
              if (curD.trim()) subpaths.push(curD.trim());
              curD = `M ${x} ${y}`;
              cmd = cmd === 'm' ? 'l' : 'L';
            } else if (cmd === 'L' || cmd === 'l') {
              const nx = readNum(), ny = readNum();
              if (Number.isNaN(nx) || Number.isNaN(ny)) break;
              x = cmd === 'l' ? x + nx : nx;
              y = cmd === 'l' ? y + ny : ny;
              curD += ` L ${x} ${y}`;
            } else if (cmd === 'H' || cmd === 'h') {
              const nx = readNum();
              if (Number.isNaN(nx)) break;
              x = cmd === 'h' ? x + nx : nx;
              curD += ` L ${x} ${y}`;
            } else if (cmd === 'V' || cmd === 'v') {
              const ny = readNum();
              if (Number.isNaN(ny)) break;
              y = cmd === 'v' ? y + ny : ny;
              curD += ` L ${x} ${y}`;
            } else if (cmd === 'C' || cmd === 'c') {
              const a = readNum(), b = readNum(), c = readNum(), d = readNum(), e = readNum(), f = readNum();
              if ([a, b, c, d, e, f].some(Number.isNaN)) break;
              const rel = cmd === 'c';
              curD += ` C ${rel ? x + a : a} ${rel ? y + b : b} ${rel ? x + c : c} ${rel ? y + d : d} ${rel ? x + e : e} ${rel ? y + f : f}`;
              x = rel ? x + e : e; y = rel ? y + f : f;
            } else if (cmd === 'S' || cmd === 's' || cmd === 'Q' || cmd === 'q') {
              const a = readNum(), b = readNum(), c = readNum(), d = readNum();
              if ([a, b, c, d].some(Number.isNaN)) break;
              const rel = cmd === 's' || cmd === 'q';
              const op = (cmd === 'S' || cmd === 's') ? 'S' : 'Q';
              curD += ` ${op} ${rel ? x + a : a} ${rel ? y + b : b} ${rel ? x + c : c} ${rel ? y + d : d}`;
              x = rel ? x + c : c; y = rel ? y + d : d;
            } else if (cmd === 'T' || cmd === 't') {
              const a = readNum(), b = readNum();
              if ([a, b].some(Number.isNaN)) break;
              x = cmd === 't' ? x + a : a; y = cmd === 't' ? y + b : b;
              curD += ` T ${x} ${y}`;
            } else if (cmd === 'A' || cmd === 'a') {
              const rx = readNum(), ry = readNum(), rot = readNum(), la = readFlag(), swp = readFlag(), a = readNum(), b = readNum();
              if ([rx, ry, rot, la, swp, a, b].some(Number.isNaN)) break;
              const nx = cmd === 'a' ? x + a : a;
              const ny = cmd === 'a' ? y + b : b;
              curD += ` A ${rx} ${ry} ${rot} ${la} ${swp} ${nx} ${ny}`;
              x = nx; y = ny;
            } else {
              break;
            }
          }
          if (curD.trim()) subpaths.push(curD.trim());
          return subpaths;
        }

        function isNearWhiteFill(colorStr) {
          if (!colorStr) return false;
          const s = colorStr.trim().toLowerCase();
          if (s === '#fff' || s === '#ffffff' || s === 'white') return true;
          const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          if (m) {
            return parseInt(m[1], 10) > 242 && parseInt(m[2], 10) > 242 && parseInt(m[3], 10) > 242;
          }
          return false;
        }

        function loopEnclosesAnyText(worldLoopPts) {
          if (!extractedTextItems.length || worldLoopPts.length < 3) return false;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const p of worldLoopPts) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
          for (const ti of extractedTextItems) {
            const tc = svgPtToWorld(ti.svgX + ti.svgW * 0.5, ti.svgY + ti.svgH * 0.5);
            if (tc.x >= minX && tc.x <= maxX && tc.y >= minY && tc.y <= maxY) {
              if (pointInPolygon(tc.x, tc.y, worldLoopPts)) return true;
            }
          }
          return false;
        }

        const solidStyle = $('selTraceSolidStyle')?.value || 'fill';
        const shapes = cloned.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line');
        const totalShapes = shapes.length;

        for (let si = 0; si < totalShapes; si++) {
          if (si > 0 && si % 12 === 0) {
            updateTaskProgress(`Flattening vector shape ${si + 1} / ${totalShapes}...`, 10 + (si / totalShapes) * 58);
            await nextPaintFrame();
          }
          const el = shapes[si];
          if (el.closest('defs, clipPath, mask, marker, pattern, symbol, [data-wt-skip="1"]')) continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;

          const fillAttr = (el.getAttribute('fill') || '').trim().toLowerCase();
          const strokeAttr = (el.getAttribute('stroke') || '').trim().toLowerCase();
          const fillVal = (fillAttr || cs.fill || '').trim().toLowerCase();
          const strokeVal = (strokeAttr || cs.stroke || '').trim().toLowerCase();
          const fillOp = parseFloat(el.getAttribute('fill-opacity') ?? cs.fillOpacity ?? '1');
          const strokeOp = parseFloat(el.getAttribute('stroke-opacity') ?? cs.strokeOpacity ?? '1');

          const hasFill = fillVal !== 'none' && fillVal !== 'transparent' && fillOp > 0.02;
          const hasStroke = strokeVal !== '' && strokeVal !== 'none' && strokeVal !== 'transparent' && strokeOp > 0.02;
          if (!hasFill && !hasStroke) continue;
          const nearWhiteUnstroked = hasFill && !hasStroke && isNearWhiteFill(fillVal) && !$('chkTraceInvert')?.checked;

          const ctm = el.getCTM();
          const relMtx = ctm && invRootCtm ? invRootCtm.multiply(ctm) : ctm;
          const transformPt = (p) => relMtx
            ? { x: p.x * relMtx.a + p.y * relMtx.c + relMtx.e, y: p.x * relMtx.b + p.y * relMtx.d + relMtx.f }
            : { x: p.x, y: p.y };

          const fullCanvasArea = targetW * targetH;
          const classifyAndPushLoop = (simp, isClosed, targetFillBucket) => {
            if (simp.length < 2) return;
            // Skip only full-canvas white background sheets (>= 75% of SVG area); keep white foreground text/icons!
            if (nearWhiteUnstroked && isClosed && Math.abs(polySignedArea(simp)) >= fullCanvasArea * 0.75) {
              return;
            }
            if (hasFill && !hasStroke && isClosed && simp.length >= 3 && solidStyle === 'fill' && !nearWhiteUnstroked) {
              if (loopEnclosesAnyText(simp)) {
                openPolylines.push({ pts: simp, closed: true });
              } else {
                targetFillBucket.push(simp);
              }
            } else {
              openPolylines.push({ pts: simp, closed: isClosed });
            }
          };

          const sampleSingleGeometryEl = (geomEl, forceClosed = false, targetFillBucket = null) => {
            let totalLen = 0;
            try { totalLen = geomEl.getTotalLength(); } catch (_) { return false; }
            if (!(totalLen > 0)) return false;
            const samplesCount = Math.max(8, Math.min(480, Math.ceil((totalLen / Math.max(vbW, vbH, 1)) * 420)));
            const stepLen = totalLen / samplesCount;
            const maxStepJumpSvg = Math.max(vbW, vbH) * 0.04 + stepLen * 3.0;

            let curSvgPts = [];
            let prevSvgPt = null;
            const flushSegment = (closedHint) => {
              if (curSvgPts.length < 2) { curSvgPts = []; return; }
              const worldPts = curSvgPts.map((tp) => svgPtToWorld(tp.x, tp.y));
              const isClosed = closedHint || Math.hypot(worldPts[0].x - worldPts[worldPts.length - 1].x, worldPts[0].y - worldPts[worldPts.length - 1].y) < 1e-4;
              const { corners } = smoothPolylineTaubin(worldPts, 0, { closed: isClosed, cornerCos: 0.72 });
              const simp = piecewiseRdpSimplify(worldPts, corners, simpWorldEps, isClosed);
              classifyAndPushLoop(simp, isClosed, targetFillBucket || []);
              curSvgPts = [];
            };

            for (let s = 0; s <= samplesCount; s++) {
              const rawPt = geomEl.getPointAtLength((s / samplesCount) * totalLen);
              if (prevSvgPt && Math.hypot(rawPt.x - prevSvgPt.x, rawPt.y - prevSvgPt.y) > maxStepJumpSvg) {
                flushSegment(false);
              }
              prevSvgPt = rawPt;
              curSvgPts.push(transformPt(rawPt));
            }
            flushSegment(forceClosed);
            return true;
          };

          const tag = el.tagName.toLowerCase();
          const shapeFillLoops = [];
          if (tag === 'path') {
            const dStr = (el.getAttribute('d') || '').trim();
            if (!dStr) continue;
            const moveCount = (dStr.match(/[Mm]/g) || []).length;
            let nativeLen = 0;
            try { nativeLen = el.getTotalLength(); } catch (_) { nativeLen = 0; }

            if (moveCount <= 1) {
              const closedHint = /z\s*$/i.test(dStr);
              if (!sampleSingleGeometryEl(el, closedHint, shapeFillLoops)) skippedUnsupportedCount++;
            } else {
              const subs = splitPathSubpaths(dStr);
              let splitTotalLen = 0;
              const tempEls = [];
              for (const sd of subs) {
                const tmp = document.createElementNS(ns, 'path');
                tmp.setAttribute('d', sd);
                el.parentNode.appendChild(tmp);
                let tl = 0;
                try { tl = tmp.getTotalLength(); } catch (_) { tl = 0; }
                splitTotalLen += tl;
                tempEls.push({ tmp, sd, tl });
              }

              // If splitPathSubpaths preserved >= 94% of native path length, sample each subpath cleanly;
              // otherwise fall back to native element sampling with jump detection so nothing is ever lost!
              if (tempEls.length > 0 && (nativeLen <= 0 || Math.abs(splitTotalLen - nativeLen) <= nativeLen * 0.06)) {
                for (const { tmp, sd, tl } of tempEls) {
                  if (tl > 0) {
                    sampleSingleGeometryEl(tmp, /z\s*$/i.test(sd), shapeFillLoops);
                  }
                  tmp.remove();
                }
              } else {
                for (const { tmp } of tempEls) tmp.remove();
                if (!sampleSingleGeometryEl(el, false, shapeFillLoops)) skippedUnsupportedCount++;
              }
            }
          } else {
            const forceClosed = tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon';
            if (!sampleSingleGeometryEl(el, forceClosed, shapeFillLoops)) skippedUnsupportedCount++;
          }

          if (shapeFillLoops.length > 0) {
            elementFillGroups.push(shapeFillLoops);
          }
        }

        // 5. Vectorize extracted <text> / <foreignObject> labels into crisp letterform strokes
        if (extractedTextItems.length > 0) {
          updateTaskProgress(`Vectorizing ${extractedTextItems.length} text label(s)...`, 72);
          await nextPaintFrame();
          const { textPolylines, fallbackNativeTexts: fbTexts } = vectorizeSvgTextLabels(extractedTextItems, svgPtToWorld);
          for (const tp of textPolylines) openPolylines.push(tp);
          fallbackNativeTexts = fbTexts.map((ti) => ({
            text: ti.text,
            pos: svgPtToWorld(ti.svgX + ti.svgW * 0.5, ti.svgY + ti.svgH * 0.5),
            size: Math.max(0.45, Math.min(2.5, ((ti.svgH / (vbH || 1)) * targetH) / 0.018))
          }));
        }
      } finally {
        host.remove();
      }

      // If this SVG was just a wrapper around an embedded base64 raster image with 0 vectors, load it into Auto-Draw!
      if (openPolylines.length === 0 && elementFillGroups.length === 0 && fallbackNativeTexts.length === 0) {
        if (embeddedRasterDataUrl) {
          const img = new Image();
          img.onload = () => {
            state.refImage.img = img;
            state.refImage.name = fileName;
            state.refImage.visible = true;
            $('chkRefVis').checked = true;
            $('btnRefClear').disabled = false;
            $('btnAutoTrace').disabled = false;
            scheduleLiveTracePreview();
            requestRender();
            showToast(`SVG "${fileName}" contains an embedded raster bitmap — loaded into Auto-Draw Vectorizer!`);
          };
          img.src = embeddedRasterDataUrl;
          return;
        }
        showToast(`No drawable vector paths or text found inside ${fileName}`, 'warn');
        return;
      }

      const targetLayer = $('selTraceLayer')?.value || 'draw';
      const strokeOutput = $('selTraceOutput')?.value || 'lines';
      const th = state.options.defaultThousandth;
      const mv = state.options.defaultMoveRadial ? false : state.options.defaultMove;

      // Convert any single-loop filled container that encloses other vector shapes into an outline
      // so opaque single-color War Thunder quads never black out inner details (e.g. stick figure inside a filled circle)
      const finalFillGroups = [];
      for (let gi = 0; gi < elementFillGroups.length; gi++) {
        const groupLoops = elementFillGroups[gi];
        if (groupLoops.length === 1) {
          const loop = groupLoops[0];
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const p of loop) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
          let enclosesOtherShape = false;
          for (const op of openPolylines) {
            const tp = op.pts[0];
            if (tp && tp.x > minX && tp.x < maxX && tp.y > minY && tp.y < maxY && pointInPolygon(tp.x, tp.y, loop)) {
              enclosesOtherShape = true;
              break;
            }
          }
          if (!enclosesOtherShape) {
            for (let oj = 0; oj < elementFillGroups.length; oj++) {
              if (oj === gi) continue;
              const otp = elementFillGroups[oj][0]?.[0];
              if (otp && otp.x > minX && otp.x < maxX && otp.y > minY && otp.y < maxY && pointInPolygon(otp.x, otp.y, loop)) {
                enclosesOtherShape = true;
                break;
              }
            }
          }
          if (enclosesOtherShape) {
            openPolylines.push({ pts: loop, closed: true });
            continue;
          }
        }
        finalFillGroups.push(groupLoops);
      }

      // Build candidate lines & quads before committing so we can check complexity & advise the user if needed
      let candidateQuads = [];
      if (finalFillGroups.length > 0) {
        updateTaskProgress(`Triangulating ${finalFillGroups.length} filled shape(s)...`, 82);
        await nextPaintFrame();
        for (const groupLoops of finalFillGroups) {
          const nested = nestClosedContoursWithHoles(groupLoops);
          for (const item of nested) {
            const bridged = bridgeHolesIntoOuter(item.pts, item.holes);
            const quads = triangulatePolygonToQuads(bridged);
            for (const q of quads) candidateQuads.push({ tl: q[0], tr: q[1], br: q[2], bl: q[3] });
          }
        }
      }

      function buildStrokePrimitives(polylinesList) {
        const linesOut = [];
        const quadsOut = [];
        for (const poly of polylinesList) {
          if (strokeOutput === 'quadRibbon' || strokeOutput === 'variableInk') {
            const halfW = (state.options.brushWidth || 0.004) * 0.5;
            for (const q of buildMiterRibbonQuads(poly.pts, halfW, { closed: poly.closed })) {
              quadsOut.push(q);
            }
          } else {
            for (let k = 0; k < poly.pts.length - 1; k++) {
              const a = poly.pts[k], b = poly.pts[k + 1];
              if (Math.hypot(b.x - a.x, b.y - a.y) >= 1e-6) linesOut.push({ a, b });
            }
            if (poly.closed && poly.pts.length >= 3) {
              const a = poly.pts[poly.pts.length - 1], b = poly.pts[0];
              if (Math.hypot(b.x - a.x, b.y - a.y) >= 1e-6) linesOut.push({ a, b });
            }
          }
        }
        return { linesOut, quadsOut };
      }

      let { linesOut: candidateLines, quadsOut: strokeRibbonQuads } = buildStrokePrimitives(openPolylines);
      const existingCount = state.doc.lines.length + state.doc.quads.length + state.doc.circles.length + state.doc.texts.length;
      const totalNew = candidateLines.length + candidateQuads.length + strokeRibbonQuads.length + fallbackNativeTexts.length;
      const exceedsLimit = existingCount + totalNew > WT_RECOMMENDED_LIMIT;
      const hasSkipped = skippedRasterCount > 0 || skippedUnsupportedCount > 0;

      if (exceedsLimit || hasSkipped) {
        const bullets = [];
        const budget = Math.max(200, WT_RECOMMENDED_LIMIT - existingCount);
        if (exceedsLimit) {
          bullets.push(
            `Generated ${totalNew} primitives (total sight complexity: ${existingCount + totalNew} / ${WT_RECOMMENDED_LIMIT}). War Thunder may chop or fail to render sights above ${WT_RECOMMENDED_LIMIT} primitives in-game.`
          );
          bullets.push(
            `Auto-Simplify to Fit: Adaptively simplifies curves so all shapes fit within ${WT_RECOMMENDED_LIMIT} primitives without dropping parts of the drawing.`
          );
          bullets.push(
            `Chop to ${WT_RECOMMENDED_LIMIT} Limit: Imports the first ${budget} primitives at full detail and chops off the remaining ${Math.max(0, totalNew - budget)} primitives.`
          );
        }
        if (skippedRasterCount > 0) {
          bullets.push(
            `${skippedRasterCount} embedded raster <image> element(s) inside this SVG cannot be imported directly as vector paths (use "Load Image" to trace raster bitmaps).`
          );
        }
        if (skippedUnsupportedCount > 0) {
          bullets.push(
            `${skippedUnsupportedCount} empty or non-geometric SVG element(s) had no drawable vector length and were skipped.`
          );
        }

        const alertText = exceedsLimit
          ? `Importing "${fileName}" at full detail exceeds War Thunder's ${WT_RECOMMENDED_LIMIT}-primitive ceiling.`
          : `Some elements in "${fileName}" cannot be imported 1:1 as SVG vectors.`;

        const choice = await askImportAdvisory({
          title: exceedsLimit ? 'Complex SVG Import Advisory' : 'Partial SVG Import Advisory',
          subtitle: `${fileName} (${totalNew} vector primitives${extractedTextItems.length ? `, ${extractedTextItems.length} text label(s)` : ''})`,
          alertText,
          bullets,
          canAutoFit: exceedsLimit,
          canChop: exceedsLimit
        });

        if (choice === 'cancel') {
          showToast(`Canceled importing ${fileName}`, 'warn');
          return;
        }
        if (choice === 'autofit' && exceedsLimit) {
          for (const mult of [2.2, 4.0, 7.5, 14.0, 25.0]) {
            const eps = simpWorldEps * mult;
            const resimpPolys = openPolylines.map((p) => {
              const { corners } = smoothPolylineTaubin(p.pts, 0, { closed: p.closed, cornerCos: 0.65 });
              return { pts: piecewiseRdpSimplify(p.pts, corners, eps, p.closed), closed: p.closed };
            });
            const rebuilt = buildStrokePrimitives(resimpPolys);
            candidateLines = rebuilt.linesOut;
            strokeRibbonQuads = rebuilt.quadsOut;
            if (existingCount + candidateLines.length + candidateQuads.length + strokeRibbonQuads.length <= WT_RECOMMENDED_LIMIT) {
              break;
            }
          }
        } else if (choice === 'chop' && exceedsLimit) {
          let rem = budget;
          if (candidateQuads.length > rem) {
            candidateQuads = candidateQuads.slice(0, rem);
            strokeRibbonQuads = [];
            candidateLines = [];
          } else {
            rem -= candidateQuads.length;
            if (strokeRibbonQuads.length > rem) {
              strokeRibbonQuads = strokeRibbonQuads.slice(0, rem);
              candidateLines = [];
            } else {
              rem -= strokeRibbonQuads.length;
              if (candidateLines.length > rem) {
                candidateLines = candidateLines.slice(0, rem);
              }
            }
          }
        }
      }

      updateTaskProgress('Adding vector primitives to reticle...', 92);
      await nextPaintFrame();

      const batchIds = new Set();
      function pushWorldLine(a, b) {
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return;
        const id = BlkParser.nextId('line');
        batchIds.add(id);
        state.doc.lines.push({
          id,
          layer: targetLayer,
          x1: fromCanvasUnit(a.x, th),
          y1: fromCanvasUnit(a.y, th),
          x2: fromCanvasUnit(b.x, th),
          y2: fromCanvasUnit(b.y, th),
          move: mv,
          thousandth: th,
          ...makeDefaultRadialFields((a.x + b.x) * 0.5, (a.y + b.y) * 0.5)
        });
      }

      function pushWorldQuad(q) {
        const id = BlkParser.nextId('quad');
        batchIds.add(id);
        state.doc.quads.push({
          id,
          layer: targetLayer,
          tl: { x: fromCanvasUnit(q.tl.x, th), y: fromCanvasUnit(q.tl.y, th) },
          tr: { x: fromCanvasUnit(q.tr.x, th), y: fromCanvasUnit(q.tr.y, th) },
          br: { x: fromCanvasUnit(q.br.x, th), y: fromCanvasUnit(q.br.y, th) },
          bl: { x: fromCanvasUnit(q.bl.x, th), y: fromCanvasUnit(q.bl.y, th) },
          move: mv,
          thousandth: th,
          ...makeDefaultRadialFields(
            (q.tl.x + q.tr.x + q.br.x + q.bl.x) * 0.25,
            (q.tl.y + q.tr.y + q.br.y + q.bl.y) * 0.25
          )
        });
      }

      for (const q of candidateQuads) pushWorldQuad(q);
      for (const q of strokeRibbonQuads) pushWorldQuad(q);
      for (const seg of candidateLines) pushWorldLine(seg.a, seg.b);
      for (const nt of fallbackNativeTexts) {
        const id = BlkParser.nextId('text');
        batchIds.add(id);
        state.doc.texts.push({
          id,
          layer: targetLayer,
          text: nt.text,
          x: fromCanvasUnit(nt.pos.x, th),
          y: fromCanvasUnit(nt.pos.y, th),
          align: 0,
          size: Number(nt.size.toFixed(2)),
          move: mv,
          thousandth: th,
          ...makeDefaultRadialFields(nt.pos.x, nt.pos.y)
        });
      }

      updateTaskProgress('Done', 100);
      state.lastTraceIds = batchIds;
      $('btnUndoTrace').disabled = batchIds.size === 0;
      pushHistory();
      requestRender();
      const textNote = extractedTextItems.length > 0 ? ` (including ${extractedTextItems.length} text label(s))` : '';
      showToast(`Imported SVG "${fileName}": ${batchIds.size} primitives${textNote} into ${targetLayer === 'base' ? 'Base' : 'Drawn'} layer`);
    } finally {
      hideTaskProgress();
    }
  }

  /**
   * Generate a clean procedural lineart test drawing showcasing acute X-crossings, curves,
   * T-junctions, variable weights, and dark filled eyes with white highlights.
   */
  function loadSampleLineart() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 512, 512);

    g.strokeStyle = '#111111';
    g.fillStyle = '#111111';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Outer double emblem rings
    g.lineWidth = 4;
    g.beginPath();
    g.arc(256, 256, 178, 0, Math.PI * 2);
    g.stroke();

    // Inner diamond star
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(256, 56);
    g.quadraticCurveTo(286, 224, 456, 256);
    g.quadraticCurveTo(286, 286, 256, 456);
    g.quadraticCurveTo(224, 286, 56, 256);
    g.quadraticCurveTo(224, 224, 256, 56);
    g.stroke();

    // Acute ~35-deg X-crossing diagonal hair/blade curves & T-junction feathers (tests crossing fidelity!)
    g.lineWidth = 4.2;
    g.beginPath();
    g.moveTo(118, 128);
    g.quadraticCurveTo(245, 168, 392, 232);
    g.stroke();

    g.lineWidth = 3.8;
    g.beginPath();
    g.moveTo(148, 228);
    g.quadraticCurveTo(255, 165, 378, 118);
    g.stroke();

    // Flowing S-curve wing feathers meeting outer arcs at T-junctions
    for (let k = 0; k < 4; k++) {
      const yOff = 285 + k * 28;
      const span = 185 - k * 24;
      g.lineWidth = Math.max(2.2, 4.4 - k * 0.5);
      g.beginPath();
      g.moveTo(212, yOff);
      g.bezierCurveTo(256 - span * 0.45, yOff - 22, 256 - span * 0.78, yOff + 18, 256 - span, yOff - 4);
      g.moveTo(300, yOff);
      g.bezierCurveTo(256 + span * 0.45, yOff - 22, 256 + span * 0.78, yOff + 18, 256 + span, yOff - 4);
      g.stroke();
    }

    // Two solid dark stylized eyes with white interior glints (tests Smart Hybrid hole-preserving Solid Fill!)
    for (const ex of [205, 307]) {
      g.fillStyle = '#111111';
      g.beginPath();
      g.ellipse(ex, 222, 16, 20, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(ex - 5, 214, 5, 6.5, -0.25, 0, Math.PI * 2);
      g.fill();
    }

    // Center aiming reticle cross & circle
    g.strokeStyle = '#111111';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(256, 256, 44, 0, Math.PI * 2);
    g.stroke();

    const img = new Image();
    img.onload = () => {
      state.refImage.img = img;
      state.refImage.name = 'Sample_Lineart.png';
      state.refImage.visible = true;
      state.traceCrop = { active: false, editing: false, x0: 0, y0: 0, x1: 1, y1: 1 };
      if ($('chkTraceCropMode')) $('chkTraceCropMode').checked = false;
      if ($('btnTraceCropReset')) $('btnTraceCropReset').disabled = true;
      $('chkRefVis').checked = true;
      $('btnRefClear').disabled = false;
      $('btnAutoTrace').disabled = false;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
      requestRender();
      showToast('Loaded Sample Lineart. Try Pure Centerline or Smart Hybrid!');
    };
    img.src = c.toDataURL('image/png');
  }

  // =========================================================================
  // Automatic sights/ Folder Discovery & Sync
  // =========================================================================
  function naturalSortNames(names) {
    return names.slice().sort((a, b) => {
      if (a === 'Default Sight') return 1;
      if (b === 'Default Sight') return -1;
      const numA = parseInt(a.replace(/\.blk$/i, ''), 10);
      const numB = parseInt(b.replace(/\.blk$/i, ''), 10);
      const isNumA = !Number.isNaN(numA) && /^\d+(\.blk)?$/i.test(a);
      const isNumB = !Number.isNaN(numB) && /^\d+(\.blk)?$/i.test(b);
      if (isNumA && isNumB) return numA - numB;
      if (isNumA) return -1;
      if (isNumB) return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  function formatSightOptionLabel(name, rawText) {
    if (name === 'Default Sight') return 'Default Sight (Standard Template)';
    if (!rawText) return name;
    const lCount = (rawText.match(/line\s*\{/g) || []).length;
    const qCount = (rawText.match(/quad\s*\{/g) || []).length;
    if (lCount === 0 && qCount === 0) {
      const m = rawText.match(/crosshair\s*:\s*t\s*=\s*"([^"]*)"/i);
      const presetName = m && m[1] ? m[1] : 'Default_Sight';
      const isHud = /(rangefinder|gunReady|bulletType|turret|fov|reticle)\s*\{|shotDistScaleOffset|crosshairNvColor|crosshairThermalColor/i.test(rawText);
      return isHud ? `${name} (HUD Preset: ${presetName})` : `${name} (Preset: ${presetName.toUpperCase()})`;
    }
    return `${name} (${lCount}L${qCount ? `, ${qCount}Q` : ''})`;
  }

  function rebuildPresetsDropdown(preserveValue = true) {
    const sel = $('presetSelect');
    const prevVal = preserveValue ? sel.value : null;
    const names = naturalSortNames(Object.keys(state.sightsCatalog));

    sel.innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = formatSightOptionLabel(name, state.sightsCatalog[name]);
      sel.appendChild(opt);
    }

    if (prevVal && state.sightsCatalog[prevVal]) {
      sel.value = prevVal;
    } else if (names.length > 0) {
      sel.value = names[0];
    }
    if (typeof refreshHudBackdropDoc === 'function') {
      refreshHudBackdropDoc();
    }
  }

  function mergePresetsFromWindow(notifyNew = false) {
    const incoming = window.WT_PRESETS || {};
    const prevNames = new Set(Object.keys(state.sightsCatalog));
    const added = [];

    // Remove stale keys that came from presets.js if deleted in sights/
    for (const k of Object.keys(state.sightsCatalog)) {
      if (!incoming[k] && !state.sightsDirHandle) {
        delete state.sightsCatalog[k];
      }
    }

    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v === 'string') {
        if (!prevNames.has(k)) added.push(k);
        state.sightsCatalog[k] = v;
      }
    }

    rebuildPresetsDropdown(true);
    if (notifyNew && added.length > 0) {
      showToast(`Discovered sight(s) in sights/: ${added.join(', ')}`);
    }
  }

  /**
   * Reload presets.js dynamically via <script> tag (works over file:// without CORS errors).
   */
  function hotReloadPresetsJs(notifyOnChange = false) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `presets.js?t=${Date.now()}`;
      script.onload = () => {
        script.remove();
        const newStamp = window.WT_PRESETS_STAMP || 0;
        if (newStamp !== state.lastPresetsStamp || notifyOnChange) {
          const hadInitial = state.lastPresetsStamp !== 0;
          state.lastPresetsStamp = newStamp;
          mergePresetsFromWindow(hadInitial || notifyOnChange);
        }
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  async function scanLinkedSightsDirHandle(notifyNew = false) {
    if (!state.sightsDirHandle) return false;
    try {
      const prevNames = new Set(Object.keys(state.sightsCatalog));
      const foundNames = new Set(['Default Sight']);
      const added = [];

      for await (const entry of state.sightsDirHandle.values()) {
        if (entry.kind === 'file' && /\.blk$/i.test(entry.name)) {
          const file = await entry.getFile();
          const txt = await file.text();
          foundNames.add(entry.name);
          if (!prevNames.has(entry.name)) added.push(entry.name);
          state.sightsCatalog[entry.name] = txt;
        }
      }

      for (const k of Object.keys(state.sightsCatalog)) {
        if (!foundNames.has(k)) delete state.sightsCatalog[k];
      }

      rebuildPresetsDropdown(true);
      if (notifyNew && added.length > 0) {
        showToast(`Auto-discovered in sights/: ${added.join(', ')}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function linkSightsDirectory() {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        state.sightsDirHandle = dirHandle;
        $('btnLinkSightsFolder').textContent = `📁 ${dirHandle.name}/ Linked`;
        await scanLinkedSightsDirHandle(false);
        showToast(`Linked '${dirHandle.name}/' folder. Added .blk sights will appear automatically!`);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    $('dirInputSights').click();
  }

  // =========================================================================
  // File Loading & Saving
  // =========================================================================
  async function loadBlkDocument(blkText, name, asOverlay = false) {
    const isLarge = typeof blkText === 'string' && blkText.length > 80000;
    if (isLarge) {
      showTaskProgress('Parsing .blk Sight...', name, null);
      await nextPaintFrame();
    }
    try {
      const parsed = BlkParser.parse(blkText, {
        defaultLayer: 'base',
        autoSynthesizeStatic: true
      });

      if (asOverlay) {
        if (parsed.docType === 'hud_preset' && parsed.lines.length + parsed.quads.length + parsed.circles.length + parsed.texts.length === 0) {
          BlkParser.synthesizeStaticSightGeometry(parsed, 'base');
        }
        const append = state.options.overlayMode === 'append';
        const baseLines = append ? state.doc.lines : state.doc.lines.filter((s) => s.layer !== 'base');
        const baseQuads = append ? state.doc.quads : state.doc.quads.filter((s) => s.layer !== 'base');
        const baseCircles = append ? state.doc.circles : state.doc.circles.filter((s) => s.layer !== 'base');
        const baseTexts = append ? state.doc.texts : state.doc.texts.filter((s) => s.layer !== 'base');

        state.doc.lines = baseLines.concat(parsed.lines);
        state.doc.quads = baseQuads.concat(parsed.quads);
        state.doc.circles = baseCircles.concat(parsed.circles);
        state.doc.texts = baseTexts.concat(parsed.texts);
        state.selection.clear();
        pushHistory();
        updateSelectionUI();
        requestRender();
        const staticMsg = parsed.hasSynthesizedStatic ? ' (synthesized static sight elements)' : '';
        showToast(`Overlaid ${name} into Base Layer (${parsed.lines.length}L, ${parsed.quads.length}Q)${staticMsg}`);
      } else {
        state.doc = parsed;
        state.fileName = name;
        state.selection.clear();
        state.lastTraceIds.clear();
        state.hudBackdrop.customName = '';
        state.hudBackdrop.customText = '';
        state.hudBackdrop.doc = null;
        state.hudBackdrop.key = '';
        state.hudSim.active = false;
        if ($('btnRangeSimHud')) $('btnRangeSimHud').classList.remove('active');

        if (parsed.docType === 'hud_preset') {
          state.options.showHudOverlay = true;
          state.hudEditor.editOnCanvas = true;
          const firstIncluded = BlkParser.HUD_WIDGET_ORDER.find((k) => parsed.hudWidgets?.[k]?.included);
          if (firstIncluded) state.hudEditor.selectedWidget = firstIncluded;
          if ($('hudPresetPanel')) $('hudPresetPanel').open = true;
        } else {
          state.hudEditor.editOnCanvas = false;
        }

        syncHeaderUIFromDoc();
        syncRadialPanelUIFromDoc();
        if (typeof refreshHudBackdropDoc === 'function') refreshHudBackdropDoc();
        autoConfigurePreviewForDoc();
        resetHistory();
        updateSelectionUI();
        fitView();
        $('activeFileName').textContent = name;

        if (parsed.docType === 'hud_preset') {
          const cnt = BlkParser.HUD_WIDGET_ORDER.filter((k) => parsed.hudWidgets?.[k]?.included).length;
          showToast(`Loaded ${name} [HUD Preset • ${cnt} widget(s) • Reticle: ${parsed.header.crosshairPreset || 'Default_Sight'}]`);
        } else {
          const hasRad = docHasRadialFeatures();
          const staticMsg = parsed.hasSynthesizedStatic ? ' [Static Crosshair & HUD Synthesized]' : '';
          const radMsg = hasRad ? ' • Circular Rangefinder detected (try ◎ Range Preview!)' : '';
          showToast(`Loaded ${name} (${parsed.lines.length}L, ${parsed.quads.length}Q, ${parsed.circles.length}C, ${parsed.texts.length}T)${staticMsg}${radMsg}`);
        }
      }
    } catch (err) {
      console.error(err);
      showToast(`Failed to parse ${name}: ${err.message}`, 'error');
    } finally {
      if (isLarge) hideTaskProgress();
    }
  }

  function loadReferenceImageFile(file) {
    showTaskProgress('Loading Reference Image...', file.name, null);
    const reader = new FileReader();
    reader.onerror = () => {
      hideTaskProgress();
      showToast(`Failed to read ${file.name}`, 'error');
    };
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => {
        hideTaskProgress();
        showToast(`Failed to decode image: ${file.name}`, 'error');
      };
      img.onload = () => {
        hideTaskProgress();
        state.refImage.img = img;
        state.refImage.name = file.name;
        state.refImage.visible = true;
        state.traceCrop = { active: false, editing: false, x0: 0, y0: 0, x1: 1, y1: 1 };
        if ($('chkTraceCropMode')) $('chkTraceCropMode').checked = false;
        if ($('btnTraceCropReset')) $('btnTraceCropReset').disabled = true;
        $('chkRefVis').checked = true;
        $('btnRefClear').disabled = false;
        $('btnAutoTrace').disabled = false;
        scheduleLiveTracePreview();
        requestRender();
        showToast(`Loaded reference image: ${file.name}`);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function getExportFileNames(rawFileName) {
    const cleanStem = (rawFileName || 'custom_sight')
      .replace(/\.blk$/i, '')
      .replace(/_(reticle|preset)$/i, '')
      .replace(/\s+/g, '_')
      .trim() || 'custom_sight';
    return {
      base: cleanStem,
      reticleStem: `${cleanStem}_reticle`,
      reticleFile: `${cleanStem}_reticle.blk`,
      presetFile: `${cleanStem}_preset.blk`
    };
  }

  function docHasReticleThings(doc = state.doc) {
    if (!doc) return false;
    const primCount = (doc.lines?.length || 0) + (doc.quads?.length || 0) + (doc.circles?.length || 0) + (doc.texts?.length || 0);
    const hasSynth = !!doc.hasSynthesizedStatic;
    const hasBal = Array.isArray(doc.ballistics) && doc.ballistics.length > 0;
    const hasRad = (Array.isArray(doc.radialLines) && doc.radialLines.length > 0) || !!doc.header?.radial;
    return primCount > 0 || hasSynth || hasBal || hasRad;
  }

  function docHasActiveHudSettings(doc = state.doc) {
    if (!doc) return false;
    const widgets = doc.hudWidgets || {};
    const anyWidget = BlkParser.HUD_WIDGET_ORDER.some((k) => !!widgets[k]?.included);
    const hasRetOverride = !!doc.header?.reticle?.included;
    const isExplicitHudDoc = doc.docType === 'hud_preset';
    return anyWidget || hasRetOverride || isExplicitHudDoc;
  }

  function updatePrimarySaveButtonState() {
    const btn = $('btnSaveBlk');
    if (!btn) return;
    const hasReticle = docHasReticleThings(state.doc);
    const hasHud = docHasActiveHudSettings(state.doc);
    const names = getExportFileNames(state.fileName);

    if (hasReticle && hasHud) {
      btn.title = `Save Both .blk (Ctrl+S) • Auto-saves ${names.reticleFile} (all_tanks) & ${names.presetFile} (tank_sight_presets)`;
    } else if (hasReticle) {
      btn.title = `Save Reticle .blk (Ctrl+S) • Saves ${names.reticleFile} (UserSights/all_tanks)`;
    } else if (hasHud) {
      btn.title = `Save HUD Preset .blk (Ctrl+S) • Saves ${names.presetFile} (UserSights/tank_sight_presets)`;
    } else {
      btn.title = 'Save .blk (Ctrl+S)';
    }
  }

  async function saveBlkFile(forceMode = null) {
    const explicitMode = typeof forceMode === 'string' ? forceMode : null;
    const d = state.doc;
    const hasReticle = docHasReticleThings(d);
    const hasHud = docHasActiveHudSettings(d);

    let mode;
    if (explicitMode) {
      mode = explicitMode;
    } else if (hasReticle && hasHud) {
      mode = 'both';
    } else if (hasReticle && !hasHud) {
      mode = 'sight';
    } else if (!hasReticle && hasHud) {
      mode = 'hud_preset';
    } else {
      mode = 'sight';
    }

    state.doc.docType = mode;
    if ($('selDocType')) $('selDocType').value = mode;

    const names = getExportFileNames(state.fileName);

    if (mode === 'both') {
      const reticleContent = BlkParser.serialize(d, {
        forceFormat: 'sight',
        excludeBaseLayer: !state.options.exportBase
      });
      const linkedCrosshair = hasReticle ? names.reticleStem : (d.header.crosshairPreset || names.reticleStem);
      d.header.crosshairPreset = linkedCrosshair;
      if ($('inpCrosshairPreset')) $('inpCrosshairPreset').value = linkedCrosshair;

      const presetContent = BlkParser.serialize(d, {
        forceFormat: 'hud_preset',
        linkedReticleName: linkedCrosshair
      });

      state.sightsCatalog[names.reticleFile] = reticleContent;
      rebuildPresetsDropdown(true);

      downloadTextFile(names.reticleFile, reticleContent);
      downloadTextFile(names.presetFile, presetContent);

      showToast(
        `Saved both: ${names.reticleFile} (→ all_tanks) & ${names.presetFile} (→ tank_sight_presets)`
      );
      updatePrimarySaveButtonState();
      return;
    }

    const isPresetOnly = mode === 'hud_preset';
    const outName = isPresetOnly ? names.presetFile : names.reticleFile;
    const content = BlkParser.serialize(d, {
      forceFormat: isPresetOnly ? 'hud_preset' : 'sight',
      excludeBaseLayer: !state.options.exportBase
    });

    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: outName,
          types: [{ description: 'War Thunder Sight (.blk)', accept: { 'text/plain': ['.blk'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        state.fileHandle = handle;
        state.fileName = handle.name;
        $('activeFileName').textContent = handle.name;
        if (!isPresetOnly) {
          state.sightsCatalog[handle.name] = content;
          rebuildPresetsDropdown(true);
        }
        const folderHint = isPresetOnly ? 'UserSights/tank_sight_presets/' : 'UserSights/all_tanks/ or <tank-ID>/';
        showToast(`Saved ${handle.name} (Place in ${folderHint})`);
        updatePrimarySaveButtonState();
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    downloadTextFile(outName, content);
    const folderHint = isPresetOnly ? 'UserSights/tank_sight_presets/' : 'UserSights/all_tanks/ or <tank-ID>/';
    showToast(`Downloaded ${outName} (Place in ${folderHint})`);
    updatePrimarySaveButtonState();
  }

  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportPngScreenshot() {
    render();
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    const base = state.fileName.replace(/\.blk$/i, '');
    a.href = url;
    a.download = `${base}_preview.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Exported ${base}_preview.png`);
  }

  // =========================================================================
  // UI Synchronization
  // =========================================================================
  function setTool(toolName) {
    if (state.polyPoints.length > 0) finishPoly(false);
    state.pendingLineStart = null;
    state.tool = toolName;
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === toolName);
    });
    updateCursorForTool();
    updateToolHint();
    updateToolOptionsVisibility();
    requestRender();
  }

  function updateCursorForTool() {
    if (state.spacePanning || state.tool === 'pan') canvas.style.cursor = 'grab';
    else if (state.tool === 'select') canvas.style.cursor = 'default';
    else if (state.tool === 'eraser') canvas.style.cursor = 'none';
    else if (state.tool === 'text') canvas.style.cursor = 'text';
    else canvas.style.cursor = 'crosshair';
  }

  function updateToolHint() {
    const hints = {
      select: 'Click or drag marquee to select • Shift+Click multi-select • Drag handles to scale/rotate • Arrow keys nudge • Ctrl+C/V copy/paste',
      line: 'Click-drag or click two points to draw a line • Hold Shift to snap 15° angles',
      polyline: 'Click vertices • Backspace/Right-Click undoes last point • Double-click or Enter to finish',
      spline: 'Click control points • Click orange start dot to close loop • Backspace/Right-Click undoes last point • Double-click or Enter to finish',
      freehand: 'Click & drag to draw freely • Adjust Stabilizer & Taper Ends in Tool Options',
      polygon: 'Click 3+ vertices to create filled quads/polygons • Backspace/Right-Click undoes last point • Click orange start dot, double-click, or Enter to fill',
      rect: 'Click & drag to draw a rectangle • Hold Shift for a perfect square',
      circle: 'Click center and drag radius • Supports Native WT Circle, Segmented Lines, or Filled Quads',
      shape: 'Click center and drag radius to stamp Aiming Chevron (^), Star, Regular N-Gon, or Tactical Cross • Hold Shift to rotate',
      text: 'Click anywhere on the sight to place a War Thunder text label',
      eraser: 'Click or drag across lines, quads, circles, or text to erase them',
      pan: 'Drag to pan viewport • Scroll wheel to zoom • Or hold Spacebar from any tool'
    };
    $('toolHint').textContent = hints[state.tool] || '';
  }

  function updateToolOptionsVisibility() {
    const t = state.tool;
    document.querySelectorAll('[data-opt]').forEach((el) => {
      const opt = el.dataset.opt;
      let show = false;
      if (opt === 'freehand') show = t === 'freehand';
      else if (opt === 'freehand-width') {
        show = (t === 'freehand' && state.options.brushMode === 'quadRibbon') ||
               (t === 'spline' && state.options.splineMode === 'quadRibbon');
      } else if (opt === 'spline') show = t === 'spline';
      else if (opt === 'shape-mode') show = t === 'rect' || t === 'circle' || t === 'shape';
      else if (opt === 'circle') show = t === 'circle' && state.options.shapeMode !== 'nativeCircle';
      else if (opt === 'circle-arc') show = t === 'circle';
      else if (opt === 'stamp') show = t === 'shape';
      else if (opt === 'eraser') show = t === 'eraser';
      el.hidden = !show;
    });

    const nativeOpt = $('selShapeMode').querySelector('option[value="nativeCircle"]');
    if (nativeOpt) {
      nativeOpt.disabled = t !== 'circle';
      if (t !== 'circle' && state.options.shapeMode === 'nativeCircle') {
        state.options.shapeMode = 'lines';
        $('selShapeMode').value = 'lines';
      }
    }
  }

  function updateZoomUI() {
    const pct = Math.round((state.cam.scale / BASE_SCALE) * 100);
    $('zoomLabel').textContent = `${pct}%`;
  }

  function updateStatsUI() {
    const d = state.doc;
    $('hudStats').textContent = `L: ${d.lines.length} | Q: ${d.quads.length} | C: ${d.circles.length} | T: ${d.texts.length}`;

    let baseCount = 0;
    let drawCount = 0;
    for (const { item } of allShapes()) {
      if (item.layer === 'base') baseCount++;
      else drawCount++;
    }
    $('baseCount').textContent = baseCount;
    $('drawCount').textContent = drawCount;

    const totalPrimitives = d.lines.length + d.quads.length + d.circles.length + d.texts.length;
    $('limitMeterLabel').textContent = `${totalPrimitives} / ${WT_RECOMMENDED_LIMIT}`;
    const pct = Math.min(100, Math.round((totalPrimitives / WT_RECOMMENDED_LIMIT) * 100));
    const fill = $('limitMeterFill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('danger', totalPrimitives > WT_RECOMMENDED_LIMIT);
    const hasRet = docHasReticleThings(d);
    const hasHud = docHasActiveHudSettings(d);
    const hasBoth = hasRet && hasHud;
    if (hasBoth && d.docType !== 'both') {
      d.docType = 'both';
      if ($('selDocType')) $('selDocType').value = 'both';
    } else if (!hasBoth && d.docType === 'both') {
      d.docType = hasRet ? 'sight' : (hasHud ? 'hud_preset' : 'sight');
      if ($('selDocType')) $('selDocType').value = d.docType;
    }
    if ($('hudVectorExportHint')) {
      $('hudVectorExportHint').hidden = !hasBoth;
    }
    updateMotionLegend();
    updateLayerLegend();
    updatePrimarySaveButtonState();
  }

  function updateSelectionUI() {
    const entries = getSelectedEntries();
    const count = entries.length;
    $('selCountBadge').textContent = count;

    $('btnDuplicate').disabled = count === 0;
    $('btnFlipH').disabled = count === 0;
    $('btnFlipV').disabled = count === 0;
    $('btnMirrorCloneX').disabled = count === 0;
    $('btnDelete').disabled = count === 0;

    $('selEmptyMsg').hidden = count > 0;
    $('selControls').hidden = count === 0;

    if (count === 0) return;

    $('chkSelMove').checked = entries.every(({ item }) => !!item.move && !item.moveRadial);
    $('chkSelThousandth').checked = entries.every(({ item }) => !!item.thousandth);
    if ($('chkSelHighlight')) {
      $('chkSelHighlight').checked = entries.every(({ item }) => !!item.highlight);
    }

    if ($('chkSelMoveRadial')) {
      $('chkSelMoveRadial').checked = entries.every(({ item }) => !!item.moveRadial);
      const getSharedNum = (fn) => {
        const vals = entries.map(({ kind, item }) => fn(kind, item));
        const first = vals[0];
        const allSame = vals.every((v) =>
          (v === undefined && first === undefined) ||
          (Number.isFinite(v) && Number.isFinite(first) && Math.abs(v - first) < 1e-6)
        );
        return { same: allSame, val: first };
      };
      const setNumField = (id, res, ph) => {
        const el = $(id);
        if (!el) return;
        if (res.same && Number.isFinite(res.val)) {
          el.value = String(BlkParser.formatNum(res.val));
          el.placeholder = ph;
        } else {
          el.value = '';
          el.placeholder = res.same ? ph : 'Mixed';
        }
      };
      setNumField('numSelRadCx', getSharedNum((_k, it) => it.radialCenter?.[0] ?? 0), '0');
      setNumField('numSelRadCy', getSharedNum((_k, it) => it.radialCenter?.[1] ?? 0), '0');
      setNumField('numSelRadAngle', getSharedNum((_k, it) => it.radialAngle), 'deg');
      setNumField('numSelRadSpeed', getSharedNum((_k, it) => it.radialMoveSpeed), 'speed');
    }

    const editor = $('singleItemEditor');
    editor.innerHTML = '';

    if (count === 1) {
      const { kind, item } = entries[0];
      const title = document.createElement('div');
      title.className = 'sub-title';
      title.textContent = `Edit ${kind.toUpperCase()} (${item.layer})`;
      editor.appendChild(title);

      const addNumRow = (label, val, step, onChange) => {
        const row = document.createElement('div');
        row.className = 'field-row';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = String(step);
        inp.value = String(BlkParser.formatNum(val));
        inp.addEventListener('change', () => {
          const n = parseFloat(inp.value);
          if (Number.isFinite(n)) {
            onChange(n);
            pushHistory();
            requestRender();
          }
        });
        row.appendChild(lbl);
        row.appendChild(inp);
        editor.appendChild(row);
      };

      if (kind === 'line') {
        addNumRow('X1', item.x1, 0.005, (v) => (item.x1 = v));
        addNumRow('Y1', item.y1, 0.005, (v) => (item.y1 = v));
        addNumRow('X2', item.x2, 0.005, (v) => (item.x2 = v));
        addNumRow('Y2', item.y2, 0.005, (v) => (item.y2 = v));
      } else if (kind === 'quad') {
        for (const k of ['tl', 'tr', 'br', 'bl']) {
          addNumRow(`${k.toUpperCase()} X`, item[k].x, 0.005, (v) => (item[k].x = v));
          addNumRow(`${k.toUpperCase()} Y`, item[k].y, 0.005, (v) => (item[k].y = v));
        }
      } else if (kind === 'circle') {
        addNumRow('Center X', item.x, 0.005, (v) => (item.x = v));
        addNumRow('Center Y', item.y, 0.005, (v) => (item.y = v));
        addNumRow('Diameter', item.diameter, 0.005, (v) => (item.diameter = Math.max(0.0001, v)));
        addNumRow('Thickness', item.size, 0.2, (v) => (item.size = Math.max(0.1, v)));
        addNumRow('Start Deg', item.startAngle, 15, (v) => (item.startAngle = v));
        addNumRow('End Deg', item.endAngle, 15, (v) => (item.endAngle = v));
      } else if (kind === 'text') {
        const row = document.createElement('div');
        row.className = 'field-row';
        const lbl = document.createElement('label');
        lbl.textContent = 'Text';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = item.text;
        inp.addEventListener('change', () => {
          item.text = inp.value;
          pushHistory();
          requestRender();
        });
        row.appendChild(lbl);
        row.appendChild(inp);
        editor.appendChild(row);
        addNumRow('X', item.x, 0.005, (v) => (item.x = v));
        addNumRow('Y', item.y, 0.005, (v) => (item.y = v));
        addNumRow('Size', item.size, 0.1, (v) => (item.size = Math.max(0.1, v)));
      }
    }
  }

  function rgbToHex(r, g, b) {
    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    return {
      r: parseInt(clean.slice(0, 2), 16) || 0,
      g: parseInt(clean.slice(2, 4), 16) || 0,
      b: parseInt(clean.slice(4, 6), 16) || 0
    };
  }

  function formatAlphaPct(a) {
    return `${Math.round((Math.max(0, Math.min(255, Number(a) ?? 255)) / 255) * 100)}%`;
  }

  function syncAllColorIndicatorsUI() {
    const h = state.doc.header;
    const dayC = h.crosshairColor || { r: 0, g: 0, b: 0, a: 255 };
    const lightC = h.crosshairLightColor || { r: 255, g: 64, b: 64, a: 255 };
    const nvC = h.crosshairNvColor || { r: 110, g: 255, b: 145, a: 255 };
    const thC = h.crosshairThermalColor || { r: 242, g: 248, b: 255, a: 255 };

    const dayHex = rgbToHex(dayC.r, dayC.g, dayC.b);
    const lightHex = rgbToHex(lightC.r, lightC.g, lightC.b);
    const nvHex = rgbToHex(nvC.r, nvC.g, nvC.b);
    const thHex = rgbToHex(thC.r, thC.g, thC.b);

    // Panel 5: Sight Global Settings (CDK)
    if ($('colCrosshair')) $('colCrosshair').value = dayHex;
    if ($('rngCrosshairAlpha')) $('rngCrosshairAlpha').value = String(dayC.a ?? 255);
    if ($('lblCrosshairAlpha')) $('lblCrosshairAlpha').textContent = formatAlphaPct(dayC.a);

    if ($('colLight')) $('colLight').value = lightHex;
    if ($('rngLightAlpha')) $('rngLightAlpha').value = String(lightC.a ?? 255);
    if ($('lblLightAlpha')) $('lblLightAlpha').textContent = formatAlphaPct(lightC.a);

    if ($('colNv')) $('colNv').value = nvHex;
    if ($('rngNvAlpha')) $('rngNvAlpha').value = String(nvC.a ?? 255);
    if ($('lblNvAlpha')) $('lblNvAlpha').textContent = formatAlphaPct(nvC.a);

    if ($('colThermal')) $('colThermal').value = thHex;
    if ($('rngThermalAlpha')) $('rngThermalAlpha').value = String(thC.a ?? 255);
    if ($('lblThermalAlpha')) $('lblThermalAlpha').textContent = formatAlphaPct(thC.a);

    // Panel 3: Tank Sight Preset (HUD) mirrored Reticle Optic Colors
    if ($('colHudRetDay')) $('colHudRetDay').value = dayHex;
    if ($('rngHudRetDayAlpha')) $('rngHudRetDayAlpha').value = String(dayC.a ?? 255);
    if ($('lblHudRetDayAlpha')) $('lblHudRetDayAlpha').textContent = formatAlphaPct(dayC.a);

    if ($('colHudRetLight')) $('colHudRetLight').value = lightHex;
    if ($('rngHudRetLightAlpha')) $('rngHudRetLightAlpha').value = String(lightC.a ?? 255);
    if ($('lblHudRetLightAlpha')) $('lblHudRetLightAlpha').textContent = formatAlphaPct(lightC.a);

    if ($('colHudRetNv')) $('colHudRetNv').value = nvHex;
    if ($('rngHudRetNvAlpha')) $('rngHudRetNvAlpha').value = String(nvC.a ?? 255);
    if ($('lblHudRetNvAlpha')) $('lblHudRetNvAlpha').textContent = formatAlphaPct(nvC.a);

    if ($('colHudRetThermal')) $('colHudRetThermal').value = thHex;
    if ($('rngHudRetThermalAlpha')) $('rngHudRetThermalAlpha').value = String(thC.a ?? 255);
    if ($('lblHudRetThermalAlpha')) $('lblHudRetThermalAlpha').textContent = formatAlphaPct(thC.a);

    // Topbar Mode Switcher swatches (reflect configured Reticle optic colors)
    const setSwatch = (id, c, fallbackCss) => {
      const el = $(id);
      if (!el) return;
      el.style.backgroundColor = (c && c.a > 15) ? rgbToHex(c.r, c.g, c.b) : fallbackCss;
    };
    setSwatch('swatchModeDay', dayC, '#181818');
    setSwatch('swatchModeLight', lightC, '#ff4040');
    setSwatch('swatchModeNvg', nvC, '#6eff91');
    setSwatch('swatchModeThermal', thC, '#f2f8ff');

    // HUD Widget Mode Tab swatches (reflect active HUD widget's 4-mode colors)
    const widgets = state.doc.hudWidgets;
    const selName = state.hudEditor?.selectedWidget || 'rangefinder';
    const w = widgets?.[selName];
    if (w) {
      for (const [m, swId, fb] of [
        ['day', 'swatchHudModeDay', '#00ff3c'],
        ['light', 'swatchHudModeLight', '#ff4040'],
        ['nvg', 'swatchHudModeNvg', '#6eff91'],
        ['thermal', 'swatchHudModeThermal', '#f2f8ff']
      ]) {
        const keys = getHudColorKeyMap(selName, m);
        const fc = w[keys.fg];
        setSwatch(swId, fc, fb);
      }
    }

    // Active mode sync between Topbar previewMode and Color Motion checkbox
    const motionActive = isMotionColorActive();
    if ($('chkColorMotion')) $('chkColorMotion').checked = motionActive;
    if ($('chkColorLayers')) $('chkColorLayers').checked = !motionActive && !!state.options.colorLayers;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === state.previewMode);
    });
  }

  function syncHeaderUIFromDoc() {
    const h = state.doc.header;
    $('chkCentralVert').checked = !!h.drawCentralLineVert;
    $('chkCentralHorz').checked = !!h.drawCentralLineHorz;
    $('chkSightMask').checked = !!h.drawSightMask;
    $('chkSmoothEdge').checked = !!h.useSmoothEdge;
    if ($('chkDistCorr')) $('chkDistCorr').checked = h.drawDistanceCorrection !== false;
    if ($('chkApplyCorrGun')) $('chkApplyCorrGun').checked = h.applyCorrectionToGun !== false;
    if ($('selThousandthMode')) $('selThousandthMode').value = h.thousandthMode || 'ussr';
    $('numLineMult').value = h.lineSizeMult;
    $('numFontMult').value = h.fontSizeMult;
    if ($('numGlobalDistOffset')) $('numGlobalDistOffset').value = String(Math.round(h.shotDistScaleOffset || 0));
    const mc = h.matchExpClass || { exp_tank: true, exp_heavy_tank: true, exp_tank_destroyer: true, exp_SPAA: true };
    if ($('chkExpTank')) $('chkExpTank').checked = !!mc.exp_tank;
    if ($('chkExpHeavy')) $('chkExpHeavy').checked = !!mc.exp_heavy_tank;
    if ($('chkExpTD')) $('chkExpTD').checked = !!mc.exp_tank_destroyer;
    if ($('chkExpSPAA')) $('chkExpSPAA').checked = !!mc.exp_SPAA;
    syncAllColorIndicatorsUI();
    if (typeof syncHudPresetUIFromDoc === 'function') syncHudPresetUIFromDoc();
  }

  // =========================================================================
  // Wire UI Event Listeners
  // =========================================================================
  function initUI() {
    // Load initial catalog from presets.js
    mergePresetsFromWindow(false);

    const presetSel = $('presetSelect');
    presetSel.addEventListener('change', () => {
      const key = presetSel.value;
      if (state.sightsCatalog[key]) {
        state.fileHandle = null;
        loadBlkDocument(state.sightsCatalog[key], key.endsWith('.blk') ? key : `${key}.blk`, false);
      }
    });

    $('btnRefreshSights').addEventListener('click', async () => {
      if (state.sightsDirHandle) {
        await scanLinkedSightsDirHandle(true);
      }
      await hotReloadPresetsJs(true);
      showToast(`Sights catalog refreshed (${Object.keys(state.sightsCatalog).length} available)`);
    });

    $('btnLinkSightsFolder').addEventListener('click', linkSightsDirectory);
    $('dirInputSights').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []).filter((f) => /\.blk$/i.test(f.name));
      if (files.length === 0) return;
      for (const f of files) {
        state.sightsCatalog[f.name] = await f.text();
      }
      rebuildPresetsDropdown(true);
      showToast(`Imported ${files.length} sight(s) from folder into dropdown`);
      e.target.value = '';
    });

    $('btnNewBlank').addEventListener('click', () => {
      state.fileHandle = null;
      state.fileName = 'custom_sight.blk';
      state.doc = BlkParser.createEmptyDoc();
      state.selection.clear();
      state.hudEditor.editOnCanvas = false;
      state.hudBackdrop.customName = '';
      state.hudBackdrop.customText = '';
      state.hudBackdrop.doc = null;
      state.hudBackdrop.key = '';
      state.hudSim.active = false;
      if ($('btnRangeSimHud')) $('btnRangeSimHud').classList.remove('active');
      $('activeFileName').textContent = state.fileName;
      syncHeaderUIFromDoc();
      syncRadialPanelUIFromDoc();
      if (typeof refreshHudBackdropDoc === 'function') refreshHudBackdropDoc();
      autoConfigurePreviewForDoc();
      resetHistory();
      updateSelectionUI();
      centerOrigin();
      showToast('Created blank custom sight');
    });

    $('btnOpenBlk').addEventListener('click', () => $('fileOpenBlk').click());
    $('fileOpenBlk').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((txt) => {
        state.fileHandle = null;
        state.sightsCatalog[file.name] = txt;
        rebuildPresetsDropdown(false);
        $('presetSelect').value = file.name;
        loadBlkDocument(txt, file.name, false);
      });
      e.target.value = '';
    });

    $('btnImportOverlay').addEventListener('click', () => $('fileImportOverlay').click());
    $('fileImportOverlay').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((txt) => loadBlkDocument(txt, file.name, true));
      e.target.value = '';
    });

    $('btnUploadRefImg').addEventListener('click', () => $('fileRefImg').click());
    $('btnRefUpload2').addEventListener('click', () => $('fileRefImg').click());
    $('fileRefImg').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) loadReferenceImageFile(file);
      e.target.value = '';
    });
    $('btnImportSvg').addEventListener('click', () => $('fileImportSvg').click());
    $('fileImportSvg').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        file.text().then((txt) => importSvgFile(txt, file.name));
      }
      e.target.value = '';
    });

    // Drag & drop files on window
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      $('dropOverlay').hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        $('dropOverlay').hidden = true;
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      $('dropOverlay').hidden = true;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;

      const blkFiles = files.filter((f) => /\.blk$/i.test(f.name));
      if (blkFiles.length > 1) {
        Promise.all(blkFiles.map(async (f) => { state.sightsCatalog[f.name] = await f.text(); })).then(() => {
          rebuildPresetsDropdown(false);
          $('presetSelect').value = blkFiles[0].name;
          loadBlkDocument(state.sightsCatalog[blkFiles[0].name], blkFiles[0].name, false);
          showToast(`Loaded ${blkFiles.length} sights into catalog`);
        });
        return;
      }

      const file = files[0];
      if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|svg|bmp)$/i.test(file.name)) {
        loadReferenceImageFile(file);
      } else {
        file.text().then((txt) => {
          state.sightsCatalog[file.name] = txt;
          rebuildPresetsDropdown(false);
          $('presetSelect').value = file.name;
          loadBlkDocument(txt, file.name, false);
        });
      }
    });

    // Topbar actions
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnExportPng').addEventListener('click', exportPngScreenshot);
    $('btnSaveBlk').addEventListener('click', () => saveBlkFile());

    // Preview mode buttons
    let lastNonMotionMode = 'day';
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.mode.trim();
        state.previewMode = nextMode;
        if (nextMode === 'motion') {
          state.options.colorMotion = true;
          state.options.colorLayers = false;
        } else {
          lastNonMotionMode = nextMode;
          state.options.colorMotion = false;
        }
        if (['day', 'light', 'nvg', 'thermal'].includes(state.previewMode)) {
          state.hudEditor.colorMode = state.previewMode;
          if (typeof syncHudPresetUIFromDoc === 'function') syncHudPresetUIFromDoc();
        }
        syncAllColorIndicatorsUI();
        updateMotionLegend();
        updateLayerLegend();
        requestRender();
      });
    });

    // Left toolbar tools
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    $('btnDuplicate').addEventListener('click', () => duplicateSelected(0.015));
    $('btnFlipH').addEventListener('click', () => flipSelected('h'));
    $('btnFlipV').addEventListener('click', () => flipSelected('v'));
    $('btnMirrorCloneX').addEventListener('click', () => mirrorCloneSelected('x'));
    $('btnDelete').addEventListener('click', deleteSelected);

    // Viewport HUD zoom
    $('btnZoomIn').addEventListener('click', () => zoomBy(1.25));
    $('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.25));
    $('btnFitView').addEventListener('click', fitView);
    $('btnCenterOrigin').addEventListener('click', centerOrigin);

    // Drawing & symmetry controls
    $('chkMirrorX').addEventListener('change', (e) => { state.options.mirrorX = e.target.checked; requestRender(); });
    $('chkMirrorY').addEventListener('change', (e) => { state.options.mirrorY = e.target.checked; requestRender(); });
    $('chkSnapGrid').addEventListener('change', (e) => { state.options.snapGrid = e.target.checked; });
    $('chkSnapVertex').addEventListener('change', (e) => { state.options.snapVertex = e.target.checked; });
    $('chkShowGrid').addEventListener('change', (e) => { state.options.showGrid = e.target.checked; requestRender(); });
    $('chkColorLayers').addEventListener('change', (e) => {
      state.options.colorLayers = e.target.checked;
      if (e.target.checked) {
        state.options.colorMotion = false;
        if (state.previewMode === 'motion') {
          state.previewMode = lastNonMotionMode || 'blueprint';
        }
      }
      syncAllColorIndicatorsUI();
      updateMotionLegend();
      updateLayerLegend();
      requestRender();
    });
    if ($('chkColorMotion')) {
      $('chkColorMotion').addEventListener('change', (e) => {
        state.options.colorMotion = e.target.checked;
        if (e.target.checked) {
          state.options.colorLayers = false;
          if (state.previewMode !== 'motion') {
            lastNonMotionMode = state.previewMode;
            state.previewMode = 'motion';
          }
        } else if (state.previewMode === 'motion') {
          state.previewMode = lastNonMotionMode || 'day';
        }
        syncAllColorIndicatorsUI();
        updateMotionLegend();
        updateLayerLegend();
        requestRender();
      });
    }
    $('chkShowTicks').addEventListener('change', (e) => { state.options.showTicks = e.target.checked; requestRender(); });
    $('numGridStep').addEventListener('change', (e) => {
      state.options.gridStep = Math.max(0.0005, parseFloat(e.target.value) || 0.025);
      requestRender();
    });
    $('chkDefaultMove').addEventListener('change', (e) => {
      state.options.defaultMove = e.target.checked;
      if (e.target.checked && state.options.defaultMoveRadial) {
        state.options.defaultMoveRadial = false;
        if ($('chkDefaultMoveRadial')) $('chkDefaultMoveRadial').checked = false;
      }
    });
    $('chkDefaultThousandth').addEventListener('change', (e) => { state.options.defaultThousandth = e.target.checked; });
    if ($('chkDefaultMoveRadial')) {
      $('chkDefaultMoveRadial').addEventListener('change', (e) => {
        state.options.defaultMoveRadial = e.target.checked;
        if (e.target.checked && state.options.defaultMove) {
          state.options.defaultMove = false;
          if ($('chkDefaultMove')) $('chkDefaultMove').checked = false;
        }
      });
    }

    // Tool options
    $('selBrushMode').addEventListener('change', (e) => {
      state.options.brushMode = e.target.value;
      updateToolOptionsVisibility();
    });
    $('rngSimplify').addEventListener('input', (e) => {
      state.options.simplifyTol = parseFloat(e.target.value);
      $('lblSimplify').textContent = state.options.simplifyTol.toFixed(4);
    });
    $('rngBrushStabilizer').addEventListener('input', (e) => {
      const pct = parseFloat(e.target.value) || 0;
      state.options.brushStabilizer = pct / 100;
      $('lblBrushStabilizer').textContent = `${Math.round(pct)}%`;
    });
    $('rngBrushWidth').addEventListener('input', (e) => {
      state.options.brushWidth = parseFloat(e.target.value);
      $('lblBrushWidth').textContent = state.options.brushWidth.toFixed(4);
    });
    $('chkBrushTaper').addEventListener('change', (e) => {
      state.options.brushTaper = e.target.checked;
    });
    $('selSplineMode').addEventListener('change', (e) => {
      state.options.splineMode = e.target.value;
      updateToolOptionsVisibility();
    });
    $('numSplineSegs').addEventListener('change', (e) => {
      state.options.splineSegs = Math.max(4, Math.min(40, parseInt(e.target.value, 10) || 12));
    });
    $('selShapeMode').addEventListener('change', (e) => {
      state.options.shapeMode = e.target.value;
      updateToolOptionsVisibility();
    });
    $('numCircleSegs').addEventListener('change', (e) => {
      state.options.circleSegs = Math.max(6, Math.min(180, parseInt(e.target.value, 10) || 36));
    });
    $('numArcStart').addEventListener('change', (e) => { state.options.arcStart = parseFloat(e.target.value) || 0; });
    $('numArcEnd').addEventListener('change', (e) => { state.options.arcEnd = parseFloat(e.target.value) ?? 360; });

    $('selStampType').addEventListener('change', (e) => { state.options.stampType = e.target.value; });
    $('numStampPoints').addEventListener('change', (e) => {
      state.options.stampPoints = Math.max(3, Math.min(24, parseInt(e.target.value, 10) || 5));
    });
    $('rngStampInner').addEventListener('input', (e) => {
      state.options.stampInner = parseFloat(e.target.value) || 0.45;
      $('lblStampInner').textContent = state.options.stampInner.toFixed(2);
    });

    $('rngEraserRadius').addEventListener('input', (e) => {
      state.options.eraserRadius = parseInt(e.target.value, 10);
      $('lblEraserRadius').textContent = `${state.options.eraserRadius}px`;
      requestRender();
    });

    // Reference Image & Auto-Draw controls
    $('btnRefSample').addEventListener('click', loadSampleLineart);
    $('btnRefClear').addEventListener('click', () => {
      state.refImage.img = null;
      state.refImage.name = '';
      state.traceCrop = { active: false, editing: false, x0: 0, y0: 0, x1: 1, y1: 1 };
      state.tracePreview.lines = [];
      state.tracePreview.quads = [];
      state.tracePreview.maskCanvas = null;
      $('chkTraceCropMode').checked = false;
      $('btnTraceCropReset').disabled = true;
      $('tracePreviewStats').textContent = 'Ready';
      $('btnRefClear').disabled = true;
      $('btnAutoTrace').disabled = true;
      requestRender();
    });
    $('chkRefVis').addEventListener('change', (e) => { state.refImage.visible = e.target.checked; requestRender(); });
    $('chkRefEditOnCanvas').addEventListener('change', (e) => { state.refImage.editOnCanvas = e.target.checked; requestRender(); });
    $('rngRefOpacity').addEventListener('input', (e) => {
      state.refImage.opacity = parseFloat(e.target.value);
      $('lblRefOpacity').textContent = `${Math.round(state.refImage.opacity * 100)}%`;
      requestRender();
    });
    $('rngRefScale').addEventListener('input', (e) => {
      state.refImage.scale = parseFloat(e.target.value);
      $('numRefScale').value = state.refImage.scale;
      scheduleLiveTracePreview();
      requestRender();
    });
    $('numRefScale').addEventListener('change', (e) => {
      state.refImage.scale = Math.max(0.01, parseFloat(e.target.value) || 0.45);
      $('rngRefScale').value = Math.min(1.6, state.refImage.scale);
      scheduleLiveTracePreview();
      requestRender();
    });
    $('numRefX').addEventListener('change', (e) => {
      state.refImage.x = parseFloat(e.target.value) || 0;
      scheduleLiveTracePreview();
      requestRender();
    });
    $('numRefY').addEventListener('change', (e) => {
      state.refImage.y = parseFloat(e.target.value) || 0;
      scheduleLiveTracePreview();
      requestRender();
    });
    $('rngRefRot').addEventListener('input', (e) => {
      state.refImage.rotation = parseFloat(e.target.value) || 0;
      $('lblRefRot').textContent = `${state.refImage.rotation}°`;
      scheduleLiveTracePreview();
      requestRender();
    });
    $('btnRefReset').addEventListener('click', () => {
      state.refImage.x = 0; state.refImage.y = 0; state.refImage.rotation = 0; state.refImage.scale = 0.45;
      $('numRefX').value = '0'; $('numRefY').value = '0'; $('rngRefRot').value = '0'; $('lblRefRot').textContent = '0°';
      $('rngRefScale').value = '0.45'; $('numRefScale').value = '0.45';
      scheduleLiveTracePreview();
      requestRender();
    });
    $('btnRefFit').addEventListener('click', () => {
      state.refImage.x = 0; state.refImage.y = 0; state.refImage.rotation = 0; state.refImage.scale = 0.9;
      $('numRefX').value = '0'; $('numRefY').value = '0'; $('rngRefRot').value = '0'; $('lblRefRot').textContent = '0°';
      $('rngRefScale').value = '0.9'; $('numRefScale').value = '0.9';
      scheduleLiveTracePreview();
      requestRender();
    });

    // Auto-Trace Slider Listeners (with live preview updates)
    function updateTraceModeVisibility() {
      const m = $('selTraceMode').value;
      $('traceSolidRadRow').hidden = m !== 'hybrid';
      $('traceSolidStyleRow').hidden = m !== 'hybrid' && m !== 'marching';
    }
    updateTraceModeVisibility();

    $('selTraceMode').addEventListener('change', () => {
      updateTraceModeVisibility();
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('selTraceOutput').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('selTraceSolidStyle').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('selTracePreviewStyle').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceSens').addEventListener('input', (e) => {
      $('lblTraceSens').textContent = `${e.target.value}%`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceContrast').addEventListener('input', (e) => {
      $('lblTraceContrast').textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceRes').addEventListener('input', (e) => {
      $('lblTraceRes').textContent = `${e.target.value}px`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceSimplify').addEventListener('input', (e) => {
      $('lblTraceSimplify').textContent = `${parseFloat(e.target.value).toFixed(2)}px`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceMinLen').addEventListener('input', (e) => {
      $('lblTraceMinLen').textContent = `${e.target.value}px`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceSpur').addEventListener('input', (e) => {
      $('lblTraceSpur').textContent = `${e.target.value}px`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('rngTraceSolidRad').addEventListener('input', (e) => {
      $('lblTraceSolidRad').textContent = `${parseFloat(e.target.value).toFixed(1)}px`;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('chkTraceLivePreview').addEventListener('change', () => {
      if ($('chkTraceLivePreview').checked) scheduleLiveTracePreview();
      requestRender();
    });
    $('chkTraceInvert').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('chkTraceWeldGaps').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('chkTraceCropMode').addEventListener('change', (e) => {
      state.traceCrop.editing = e.target.checked;
      if (state.traceCrop.editing && !state.refImage.img) {
        showToast('Load a Reference Image or Sample Art first', 'warn');
      } else if (state.traceCrop.editing) {
        showToast('Drag inside the canvas image to crop trace region');
      }
      requestRender();
    });
    $('btnTraceCropReset').addEventListener('click', () => {
      state.traceCrop.active = false;
      state.traceCrop.x0 = 0; state.traceCrop.y0 = 0; state.traceCrop.x1 = 1; state.traceCrop.y1 = 1;
      $('btnTraceCropReset').disabled = true;
      scheduleLiveTracePreview();
      requestRender();
    });
    $('btnAutoTrace').addEventListener('click', commitAutoTraceToDocument);
    $('btnUndoTrace').addEventListener('click', undoLastAutoTrace);

    // Layers controls
    $('chkExportBase').addEventListener('change', (e) => { state.options.exportBase = e.target.checked; });
    $('selOverlayMode').addEventListener('change', (e) => { state.options.overlayMode = e.target.value; });

    $('btnBakeStatic').addEventListener('click', () => {
      const tmpl = $('selStaticTemplate').value;
      const prevPreset = state.doc.header.crosshairPreset;
      if (tmpl === 'ariete') state.doc.header.crosshairPreset = 'ariete';
      else if (tmpl === 'standard') state.doc.header.crosshairPreset = '';
      BlkParser.synthesizeStaticSightGeometry(state.doc, 'base');
      state.doc.header.crosshairPreset = prevPreset;
      pushHistory();
      requestRender();
      showToast('Baked static crosshair & sight elements into Base Layer');
    });

    $('btnBaseVis').addEventListener('click', () => {
      state.layers.base.visible = !state.layers.base.visible;
      $('btnBaseVis').classList.toggle('active', state.layers.base.visible);
      updateMotionLegend();
      updateLayerLegend();
      requestRender();
    });
    $('btnBaseLock').addEventListener('click', () => {
      state.layers.base.locked = !state.layers.base.locked;
      $('btnBaseLock').classList.toggle('active', state.layers.base.locked);
      $('btnBaseLock').textContent = state.layers.base.locked ? '🔒' : '🔓';
      if (state.layers.base.locked) {
        for (const { item } of getSelectedEntries()) {
          if (item.layer === 'base') state.selection.delete(item.id);
        }
        updateSelectionUI();
        requestRender();
      }
    });
    $('btnDrawVis').addEventListener('click', () => {
      state.layers.draw.visible = !state.layers.draw.visible;
      $('btnDrawVis').classList.toggle('active', state.layers.draw.visible);
      updateMotionLegend();
      updateLayerLegend();
      requestRender();
    });
    $('btnDrawLock').addEventListener('click', () => {
      state.layers.draw.locked = !state.layers.draw.locked;
      $('btnDrawLock').classList.toggle('active', state.layers.draw.locked);
      $('btnDrawLock').textContent = state.layers.draw.locked ? '🔒' : '🔓';
    });

    $('btnBaseTransform').addEventListener('click', () => {
      const dx = parseFloat($('numBaseShiftX').value) || 0;
      const dy = parseFloat($('numBaseShiftY').value) || 0;
      const sc = parseFloat($('numBaseScale').value) || 1;
      const baseEntries = allShapes().filter(({ item }) => item.layer === 'base');
      if (baseEntries.length === 0) return;

      const b = getEntriesBoundsCanvas(baseEntries);
      if (sc !== 1 && b) transformShapes(baseEntries, b.cx, b.cy, sc, sc, 0);
      if (dx !== 0 || dy !== 0) translateEntries(baseEntries, dx, dy);
      $('numBaseShiftX').value = '0';
      $('numBaseShiftY').value = '0';
      $('numBaseScale').value = '1';
      pushHistory();
      requestRender();
    });

    const flipLayer = (layerName, axis) => {
      const entries = allShapes().filter(({ item }) => item.layer === layerName);
      const b = getEntriesBoundsCanvas(entries);
      if (!entries.length || !b) return;
      transformShapes(entries, b.cx, b.cy, axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1, 0);
      pushHistory();
      requestRender();
    };
    $('btnBaseFlipH').addEventListener('click', () => flipLayer('base', 'h'));
    $('btnBaseFlipV').addEventListener('click', () => flipLayer('base', 'v'));
    $('btnBaseCenter').addEventListener('click', () => centerEntriesAtOrigin(allShapes().filter(({ item }) => item.layer === 'base')));
    $('btnDrawCenter').addEventListener('click', () => centerEntriesAtOrigin(allShapes().filter(({ item }) => item.layer === 'draw')));

    const clearLayer = (layerName) => {
      state.doc.lines = state.doc.lines.filter((s) => s.layer !== layerName);
      state.doc.quads = state.doc.quads.filter((s) => s.layer !== layerName);
      state.doc.circles = state.doc.circles.filter((s) => s.layer !== layerName);
      state.doc.texts = state.doc.texts.filter((s) => s.layer !== layerName);
      state.selection.clear();
      pushHistory();
      updateSelectionUI();
      requestRender();
    };
    $('btnClearBase').addEventListener('click', () => clearLayer('base'));
    $('btnClearDraw').addEventListener('click', () => clearLayer('draw'));

    $('btnMergeToBase').addEventListener('click', () => {
      for (const { item } of allShapes()) item.layer = 'base';
      pushHistory();
      updateSelectionUI();
      requestRender();
      showToast('Merged all Drawn shapes into Base Layer');
    });

    // Sight Complexity & Interactive Optimizer (with Detail Kept slider & Undo Optimize)
    const runGlobalOptimize = (commitHistory, showNotification) => {
      if (!state.optimizerBaseline) {
        if (state.doc.lines.length < 2 && state.doc.quads.length < 2) return;
        state.optimizerBaseline = {
          lines: state.doc.lines.map((l) => ({ ...l })),
          quads: state.doc.quads.map((q) => ({
            ...q,
            tl: { ...q.tl },
            tr: { ...q.tr },
            br: { ...q.br },
            bl: { ...q.bl }
          }))
        };
      }
      const detailPct = parseFloat($('rngOptDetail').value) || 75;
      const allowWeld = $('chkOptWeld').checked;
      const optQuads = $('chkOptQuads').checked;

      const baseLines = state.optimizerBaseline.lines;
      const baseQuads = state.optimizerBaseline.quads;

      state.doc.lines = optimizeLinesCollection(baseLines, detailPct, allowWeld);
      state.doc.quads = optQuads
        ? optimizeQuadsCollection(baseQuads, detailPct)
        : baseQuads.map((q) => ({ ...q, tl: { ...q.tl }, tr: { ...q.tr }, br: { ...q.br }, bl: { ...q.bl } }));

      state.selection.clear();
      $('btnUndoOptimize').disabled = false;
      if (commitHistory) pushHistory();
      else updateStatsUI();
      updateSelectionUI();
      requestRender();

      if (showNotification) {
        const savedL = baseLines.length - state.doc.lines.length;
        const savedQ = baseQuads.length - state.doc.quads.length;
        showToast(
          `Optimized at ${detailPct}% detail: Lines ${baseLines.length} → ${state.doc.lines.length} (-${savedL})` +
            (optQuads && baseQuads.length ? `, Quads ${baseQuads.length} → ${state.doc.quads.length} (-${savedQ})` : '')
        );
      }
    };

    $('rngOptDetail').addEventListener('input', (e) => {
      $('lblOptDetail').textContent = `${e.target.value}%`;
      if (state.optimizerBaseline) {
        runGlobalOptimize(false, false);
      }
    });
    $('rngOptDetail').addEventListener('change', () => {
      if (state.optimizerBaseline) {
        runGlobalOptimize(true, true);
      }
    });
    $('chkOptWeld').addEventListener('change', () => {
      if (state.optimizerBaseline) runGlobalOptimize(true, true);
    });
    $('chkOptQuads').addEventListener('change', () => {
      if (state.optimizerBaseline) runGlobalOptimize(true, true);
    });
    $('btnOptimizeAll').addEventListener('click', async () => {
      const count = state.doc.lines.length + state.doc.quads.length;
      if (count > 400) {
        showTaskProgress('Optimizing Sight...', `Simplifying ${count} primitives...`, null);
        try {
          await nextPaintFrame();
          runGlobalOptimize(true, true);
        } finally {
          hideTaskProgress();
        }
      } else {
        runGlobalOptimize(true, true);
      }
    });
    $('btnUndoOptimize').addEventListener('click', () => {
      if (!state.optimizerBaseline) return;
      state.doc.lines = state.optimizerBaseline.lines.map((l) => ({ ...l }));
      state.doc.quads = state.optimizerBaseline.quads.map((q) => ({
        ...q,
        tl: { ...q.tl },
        tr: { ...q.tr },
        br: { ...q.br },
        bl: { ...q.bl }
      }));
      state.optimizerBaseline = null;
      $('btnUndoOptimize').disabled = true;
      state.selection.clear();
      pushHistory();
      updateSelectionUI();
      requestRender();
      showToast('Restored original un-optimized sight geometry');
    });

    // Selection Inspector CAD controls
    $('btnSelToDraw').addEventListener('click', () => {
      for (const { item } of getSelectedEntries()) item.layer = 'draw';
      pushHistory();
      updateSelectionUI();
      requestRender();
    });
    $('btnSelToBase').addEventListener('click', () => {
      for (const { item } of getSelectedEntries()) item.layer = 'base';
      pushHistory();
      updateSelectionUI();
      requestRender();
    });
    $('btnSelCenterOrigin').addEventListener('click', () => centerEntriesAtOrigin(getSelectedEntries()));
    $('btnSelMirrorX').addEventListener('click', () => mirrorCloneSelected('x'));
    $('btnSelMirrorY').addEventListener('click', () => mirrorCloneSelected('y'));
    $('btnRadialClone').addEventListener('click', radialCloneSelected);
    $('btnSelectConnected').addEventListener('click', selectConnectedChainFromSelection);

    const runSelectionOptimize = (commitHistory, showNotification) => {
      if (!state.selOptimizerBaseline) {
        const selLines = state.doc.lines.filter((l) => state.selection.has(l.id) && !isLayerLocked(l.layer));
        if (selLines.length < 2) {
          if (showNotification) showToast('Select at least 2 unlocked lines to simplify', 'warn');
          return;
        }
        const otherLines = state.doc.lines.filter((l) => !state.selection.has(l.id) || isLayerLocked(l.layer));
        state.selOptimizerBaseline = {
          selLines: selLines.map((l) => ({ ...l })),
          otherLines: otherLines.map((l) => ({ ...l }))
        };
      }
      const detailPct = parseFloat($('rngSelOptDetail').value) || 75;
      const baseSel = state.selOptimizerBaseline.selLines;
      const other = state.selOptimizerBaseline.otherLines.map((l) => ({ ...l }));
      const optimized = optimizeLinesCollection(baseSel, detailPct, true);
      state.doc.lines = other.concat(optimized);
      state.selection = new Set(optimized.map((l) => l.id));
      $('btnUndoSelOptimize').disabled = false;
      if (commitHistory) pushHistory();
      else updateStatsUI();
      updateSelectionUI();
      requestRender();
      if (showNotification) {
        showToast(`Simplified selected lines (${detailPct}% detail): ${baseSel.length} → ${optimized.length}`);
      }
    };

    $('rngSelOptDetail').addEventListener('input', (e) => {
      $('lblSelOptDetail').textContent = `${e.target.value}%`;
      if (state.selOptimizerBaseline) runSelectionOptimize(false, false);
    });
    $('rngSelOptDetail').addEventListener('change', () => {
      if (state.selOptimizerBaseline) runSelectionOptimize(true, true);
    });
    $('btnSimplifySelected').addEventListener('click', () => {
      state.selOptimizerBaseline = null;
      runSelectionOptimize(true, true);
    });
    $('btnUndoSelOptimize').addEventListener('click', () => {
      if (!state.selOptimizerBaseline) return;
      const restored = state.selOptimizerBaseline.selLines.map((l) => ({ ...l }));
      const other = state.selOptimizerBaseline.otherLines.map((l) => ({ ...l }));
      state.doc.lines = other.concat(restored);
      state.selection = new Set(restored.map((l) => l.id));
      state.selOptimizerBaseline = null;
      $('btnUndoSelOptimize').disabled = true;
      pushHistory();
      updateSelectionUI();
      requestRender();
      showToast('Restored un-simplified selection');
    });
    $('btnSmoothSelected').addEventListener('click', smoothSelectedLines);
    $('btnWeldSelected').addEventListener('click', weldSelectedLineGaps);
    $('btnLinesToQuads').addEventListener('click', convertSelectedLinesToQuads);
    $('btnQuadsToLines').addEventListener('click', convertSelectedQuadsToLines);

    $('chkSelMove').addEventListener('change', (e) => {
      const checked = e.target.checked;
      let changed = false;
      for (const { item } of getSelectedEntries()) {
        if (isLayerLocked(item.layer)) continue;
        item.move = checked;
        if (checked) item.moveRadial = false;
        changed = true;
      }
      if (!changed) {
        updateSelectionUI();
        return;
      }
      pushHistory();
      syncRadialPanelUIFromDoc();
      updateSelectionUI();
      updateMotionLegend();
      requestRender();
    });
    $('chkSelThousandth').addEventListener('change', (e) => {
      for (const { item } of getSelectedEntries()) item.thousandth = e.target.checked;
      pushHistory();
      requestRender();
    });
    if ($('chkSelHighlight')) {
      $('chkSelHighlight').addEventListener('change', (e) => {
        for (const { item } of getSelectedEntries()) item.highlight = e.target.checked;
        pushHistory();
        requestRender();
      });
    }
    $('btnSelMoveApply').addEventListener('click', () => {
      const dx = parseFloat($('numSelDx').value) || 0;
      const dy = parseFloat($('numSelDy').value) || 0;
      if (dx !== 0 || dy !== 0) {
        translateSelected(dx, dy);
        pushHistory();
        updateSelectionUI();
        requestRender();
      }
    });
    $('btnSelTransformApply').addEventListener('click', () => {
      const sc = parseFloat($('numSelScale').value) || 1;
      const rot = parseFloat($('numSelRot').value) || 0;
      const bounds = getSelectionBoundsCanvas();
      const entries = getSelectedEntries().filter(({ item }) => !isLayerLocked(item.layer));
      if (!bounds || !entries.length) return;
      transformShapes(entries, bounds.cx, bounds.cy, sc, sc, (rot * Math.PI) / 180);
      $('numSelScale').value = '1';
      $('numSelRot').value = '0';
      pushHistory();
      updateSelectionUI();
      requestRender();
    });

    // Global Sight Settings
    const bindHeaderToggle = (elId, key) => {
      $(elId).addEventListener('change', (e) => {
        state.doc.header[key] = e.target.checked;
        state.doc.modifiedHeaderKeys.add(key);
        pushHistory();
        requestRender();
      });
    };
    bindHeaderToggle('chkCentralVert', 'drawCentralLineVert');
    bindHeaderToggle('chkCentralHorz', 'drawCentralLineHorz');
    bindHeaderToggle('chkSightMask', 'drawSightMask');
    bindHeaderToggle('chkSmoothEdge', 'useSmoothEdge');
    if ($('chkDistCorr')) bindHeaderToggle('chkDistCorr', 'drawDistanceCorrection');
    if ($('chkApplyCorrGun')) {
      $('chkApplyCorrGun').addEventListener('change', (e) => {
        state.doc.header.applyCorrectionToGun = e.target.checked;
        state.doc.modifiedHeaderKeys.add('applyCorrectionToGun');
        if ($('chkRadialApplyGun')) $('chkRadialApplyGun').checked = e.target.checked;
        pushHistory();
        requestRender();
      });
    }

    if ($('selThousandthMode')) {
      $('selThousandthMode').addEventListener('change', (e) => {
        state.doc.header.thousandthMode = e.target.value || 'ussr';
        state.doc.modifiedHeaderKeys.add('thousandthMode');
        pushHistory();
        requestRender();
      });
    }

    const bindMatchExpToggle = (elId, propKey) => {
      const el = $(elId);
      if (!el) return;
      el.addEventListener('change', (e) => {
        if (!state.doc.header.matchExpClass) {
          state.doc.header.matchExpClass = { exp_tank: true, exp_heavy_tank: true, exp_tank_destroyer: true, exp_SPAA: true };
        }
        state.doc.header.matchExpClass[propKey] = e.target.checked;
        state.doc.modifiedHeaderKeys.add('matchExpClass');
        pushHistory();
      });
    };
    bindMatchExpToggle('chkExpTank', 'exp_tank');
    bindMatchExpToggle('chkExpHeavy', 'exp_heavy_tank');
    bindMatchExpToggle('chkExpTD', 'exp_tank_destroyer');
    bindMatchExpToggle('chkExpSPAA', 'exp_SPAA');

    $('numLineMult').addEventListener('change', (e) => {
      state.doc.header.lineSizeMult = Math.max(0.1, parseFloat(e.target.value) || 1);
      state.doc.modifiedHeaderKeys.add('lineSizeMult');
      pushHistory();
      requestRender();
    });
    $('numFontMult').addEventListener('change', (e) => {
      state.doc.header.fontSizeMult = Math.max(0.1, parseFloat(e.target.value) || 1);
      state.doc.modifiedHeaderKeys.add('fontSizeMult');
      pushHistory();
      requestRender();
    });
    const updateColor = (key, hexEl, alphaEl, targetPreviewMode) => {
      const rgb = hexToRgb($(hexEl).value);
      const a = parseInt($(alphaEl).value, 10);
      state.doc.header[key] = { r: rgb.r, g: rgb.g, b: rgb.b, a: Number.isFinite(a) ? a : 255 };
      state.doc.modifiedHeaderKeys.add(key);
      if (targetPreviewMode && state.previewMode !== targetPreviewMode && state.previewMode !== 'motion') {
        state.previewMode = targetPreviewMode;
        state.hudEditor.colorMode = targetPreviewMode;
      }
      syncAllColorIndicatorsUI();
      updateMotionLegend();
      updateLayerLegend();
      requestRender();
    };
    const bindColorPair = (hexId, alphaId, key, targetPreviewMode) => {
      if (!$(hexId) || !$(alphaId)) return;
      $(hexId).addEventListener('input', () => updateColor(key, hexId, alphaId, targetPreviewMode));
      $(alphaId).addEventListener('input', () => updateColor(key, hexId, alphaId, targetPreviewMode));
      $(hexId).addEventListener('change', () => pushHistory());
      $(alphaId).addEventListener('change', () => pushHistory());
    };
    bindColorPair('colCrosshair', 'rngCrosshairAlpha', 'crosshairColor', 'day');
    bindColorPair('colLight', 'rngLightAlpha', 'crosshairLightColor', 'light');
    bindColorPair('colNv', 'rngNvAlpha', 'crosshairNvColor', 'nvg');
    bindColorPair('colThermal', 'rngThermalAlpha', 'crosshairThermalColor', 'thermal');
    bindColorPair('colHudRetDay', 'rngHudRetDayAlpha', 'crosshairColor', 'day');
    bindColorPair('colHudRetLight', 'rngHudRetLightAlpha', 'crosshairLightColor', 'light');
    bindColorPair('colHudRetNv', 'rngHudRetNvAlpha', 'crosshairNvColor', 'nvg');
    bindColorPair('colHudRetThermal', 'rngHudRetThermalAlpha', 'crosshairThermalColor', 'thermal');

    if ($('numGlobalDistOffset')) {
      $('numGlobalDistOffset').addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        state.doc.header.shotDistScaleOffset = val;
        state.doc.modifiedHeaderKeys.add('shotDistScaleOffset');
        if ($('numShotDistOffset')) $('numShotDistOffset').value = String(val);
        pushHistory();
        requestRender();
      });
    }

    // Raw .blk Modal
    function refreshRawCodeModal() {
      const targetFmt = $('selRawModalTarget')?.value || 'sight';
      const names = getExportFileNames(state.fileName);
      const totalPrimitives = state.doc.lines.length + state.doc.quads.length + state.doc.circles.length + state.doc.texts.length;
      const linkedCrosshair = totalPrimitives > 0 ? names.reticleStem : (state.doc.header.crosshairPreset || names.reticleStem);
      const text = BlkParser.serialize(state.doc, {
        forceFormat: targetFmt === 'hud_preset' ? 'hud_preset' : 'sight',
        linkedReticleName: targetFmt === 'hud_preset' ? linkedCrosshair : undefined,
        excludeBaseLayer: !state.options.exportBase
      });
      $('rawBlkTextarea').value = text;
      const lineCount = text.split('\n').length;
      const fileLabel = targetFmt === 'hud_preset'
        ? `${names.presetFile} (→ tank_sight_presets)`
        : `${names.reticleFile} (→ all_tanks / <tank-ID>)`;
      $('codeStats').textContent = `${fileLabel} • ${lineCount} lines • ${(text.length / 1024).toFixed(1)} KB`;
    }

    $('btnViewCode').addEventListener('click', () => {
      const totalPrimitives = state.doc.lines.length + state.doc.quads.length + state.doc.circles.length + state.doc.texts.length;
      if ($('selRawModalTarget')) {
        $('selRawModalTarget').value = (state.doc.docType === 'hud_preset' && totalPrimitives === 0) ? 'hud_preset' : 'sight';
      }
      refreshRawCodeModal();
      $('codeModal').hidden = false;
    });
    $('selRawModalTarget')?.addEventListener('change', refreshRawCodeModal);
    $('btnCloseModal').addEventListener('click', () => { $('codeModal').hidden = true; });
    $('codeModal').addEventListener('click', (e) => {
      if (e.target === $('codeModal')) $('codeModal').hidden = true;
    });
    $('btnCopyBlk').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('rawBlkTextarea').value);
        showToast('Copied .blk source to clipboard');
      } catch {
        $('rawBlkTextarea').select();
        document.execCommand('copy');
        showToast('Copied .blk source to clipboard');
      }
    });
    $('btnModalDownload').addEventListener('click', () => {
      const targetFmt = $('selRawModalTarget')?.value || 'sight';
      const names = getExportFileNames(state.fileName);
      const outName = targetFmt === 'hud_preset' ? names.presetFile : names.reticleFile;
      downloadTextFile(outName, $('rawBlkTextarea').value);
      showToast(`Downloaded ${outName}`);
    });
    $('btnModalDownloadBoth')?.addEventListener('click', () => {
      saveBlkFile('both');
    });
    $('btnApplyRawBlk').addEventListener('click', () => {
      loadBlkDocument($('rawBlkTextarea').value, state.fileName, false);
      $('codeModal').hidden = true;
    });

    // Quick Guide Modal
    if ($('btnOpenGuide') && $('guideModal')) {
      $('btnOpenGuide').addEventListener('click', () => {
        $('guideModal').hidden = false;
      });
      if ($('btnCloseGuide')) {
        $('btnCloseGuide').addEventListener('click', () => { $('guideModal').hidden = true; });
      }
      if ($('btnGuideDone')) {
        $('btnGuideDone').addEventListener('click', () => { $('guideModal').hidden = true; });
      }
      $('guideModal').addEventListener('click', (e) => {
        if (e.target === $('guideModal')) $('guideModal').hidden = true;
      });
    }

    // Background polling for sights/ folder changes (every 2.5s and on window focus)
    const isLocalHost =
      window.location.protocol === 'file:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';

    setInterval(() => {
      if (isLocalHost) hotReloadPresetsJs(false);
      if (state.sightsDirHandle) scanLinkedSightsDirHandle(true);
    }, 2500);

    window.addEventListener('focus', () => {
      if (isLocalHost) hotReloadPresetsJs(false);
      if (state.sightsDirHandle) scanLinkedSightsDirHandle(true);
    });
  }

  // =========================================================================
  // Circular Rangefinder Builder & Range Simulation Preview Engine
  // =========================================================================
  function docHasRadialFeatures() {
    const h = state.doc?.header;
    if (h?.radial) return true;
    if ((state.doc?.ballistics || []).some((b) => b.radial)) return true;
    for (const { item } of allShapes()) {
      if (item.moveRadial) return true;
    }
    return false;
  }

  function getActiveRadialConfig() {
    if (state.radialTarget && state.radialTarget.startsWith('bullet:')) {
      const idx = parseInt(state.radialTarget.split(':')[1], 10);
      const b = state.doc.ballistics?.[idx];
      if (b) return { cfg: b, isBullet: true, bulletIdx: idx };
    }
    state.radialTarget = 'main';
    return { cfg: state.doc.header, isBullet: false, bulletIdx: -1 };
  }

  function rebuildRadialTargetDropdown() {
    const sel = $('selRadialScaleTarget');
    if (!sel) return;
    const prev = state.radialTarget || 'main';
    sel.innerHTML = '';
    const mainOpt = document.createElement('option');
    mainOpt.value = 'main';
    mainOpt.textContent = 'Main Scale (crosshair_distances)';
    sel.appendChild(mainOpt);

    const bullets = state.doc.ballistics || [];
    bullets.forEach((b, idx) => {
      const opt = document.createElement('option');
      opt.value = `bullet:${idx}`;
      opt.textContent = `Bullet #${idx + 1}: ${b.bulletType || 'shell'} (${Math.round(b.speed || 900)} m/s)`;
      sel.appendChild(opt);
    });

    if (prev.startsWith('bullet:') && bullets[parseInt(prev.split(':')[1], 10)]) {
      sel.value = prev;
      state.radialTarget = prev;
    } else if (bullets.length > 0 && !state.doc.header.radial && prev === 'main') {
      sel.value = 'bullet:0';
      state.radialTarget = 'bullet:0';
    } else {
      sel.value = 'main';
      state.radialTarget = 'main';
    }
  }

  function syncRadialPanelUIFromDoc() {
    rebuildRadialTargetDropdown();
    const { cfg, isBullet } = getActiveRadialConfig();
    const hasRadial = docHasRadialFeatures();

    const badge = $('radialStatusBadge');
    if (badge) {
      const bulletsCount = (state.doc.ballistics || []).filter((b) => b.radial).length;
      if (bulletsCount > 0) badge.textContent = `${bulletsCount} RING${bulletsCount > 1 ? 'S' : ''}`;
      else if (state.doc.header.radial) badge.textContent = 'RADIAL';
      else if (hasRadial) badge.textContent = 'VECTOR';
      else badge.textContent = 'OFF';
      badge.classList.toggle('active', hasRadial);
    }

    if ($('btnRangePreview')) {
      $('btnRangePreview').classList.toggle('has-radial', hasRadial);
    }

    if ($('btnRemoveBulletScale')) $('btnRemoveBulletScale').disabled = !isBullet;
    if ($('radialBulletFields')) $('radialBulletFields').hidden = !isBullet;

    if ($('chkRadialEnabled')) $('chkRadialEnabled').checked = !!cfg.radial;
    if ($('chkRadialCircleMode')) $('chkRadialCircleMode').checked = !!cfg.circleMode;
    if ($('chkRadialDrawUpward')) $('chkRadialDrawUpward').checked = cfg.drawUpward !== false;
    if ($('chkRadialApplyGun')) $('chkRadialApplyGun').checked = state.doc.header.applyCorrectionToGun !== false;

    if (isBullet) {
      if ($('selBulletType')) $('selBulletType').value = cfg.bulletType || 'apcbc_tank';
      if ($('numBulletSpeed')) $('numBulletSpeed').value = cfg.speed || 935;
    }

    const rr = cfg.radialRadius || [70, 1];
    if ($('numRadialRadius')) $('numRadialRadius').value = rr[0] ?? 70;
    if ($('chkRadialRadiusMil')) $('chkRadialRadiusMil').checked = rr[1] !== 0;
    if ($('numRadialAngle')) $('numRadialAngle').value = cfg.radialAngle ?? 180;
    if ($('numRadialStretch')) $('numRadialStretch').value = cfg.radialStretch ?? 5;
    const dp = cfg.distancePos || [0, 0];
    if ($('numRadialPosX')) $('numRadialPosX').value = dp[0] ?? 0;
    if ($('numRadialPosY')) $('numRadialPosY').value = dp[1] ?? 0;
    const tp = cfg.textPos || [0.015, 0];
    if ($('numRadialTextOff')) $('numRadialTextOff').value = tp[0] ?? 0.015;
  }

  function markRadialTargetModified(isBullet, key) {
    if (isBullet) {
      state.doc.modifiedHeaderKeys.add('ballistics');
    } else if (key) {
      state.doc.modifiedHeaderKeys.add(key);
    }
  }

  function generateDistanceEntries(stepM, maxM, labelEveryM, circleDot = false) {
    const out = [{ dist: 1, major: 0, minor: circleDot ? 0 : 0 }];
    const step = Math.max(50, stepM || 100);
    const maxD = Math.max(step, maxM || 3000);
    const lblEvery = Math.max(step, labelEveryM || 200);
    for (let d = step; d <= maxD; d += step) {
      const isMajor = (d % lblEvery) === 0;
      out.push({
        dist: d,
        major: isMajor ? Math.round(d / 100) : 0,
        minor: 0
      });
    }
    return out;
  }

  function buildRadialPreset(templateId) {
    const doc = BlkParser.createEmptyDoc();
    doc.hasSynthesizedStatic = true;
    doc.header.thousandthMode = 'real';
    doc.header.drawCentralLineVert = false;
    doc.header.drawCentralLineHorz = false;
    doc.header.drawDistanceCorrection = false;
    doc.header.applyCorrectionToGun = false;
    doc.header.crosshairDistHorSizeMain = [0.03, 0.02];
    doc.header.crosshairDistHorSizeAdditional = [0.005, 0.003];
    doc.distances = [];

    for (const k of [
      'thousandthMode', 'drawCentralLineVert', 'drawCentralLineHorz',
      'drawDistanceCorrection', 'applyCorrectionToGun', 'crosshair_distances', 'ballistics'
    ]) {
      doc.modifiedHeaderKeys.add(k);
    }

    const addL = (x1, y1, x2, y2, move = false, thousandth = false, extra = {}) => {
      doc.lines.push({
        id: BlkParser.nextId('line'),
        layer: 'base',
        x1, y1, x2, y2,
        move, thousandth,
        ...extra
      });
    };
    const addQ = (tl, tr, br, bl, move = false, thousandth = false, extra = {}) => {
      doc.quads.push({
        id: BlkParser.nextId('quad'),
        layer: 'base',
        tl, tr, br, bl,
        move, thousandth,
        ...extra
      });
    };

    // Classic German aiming triangle triad & vertical post (move with range when applyCorrectionToGun=no)
    const addGermanChevrons = () => {
      const ch = [
        [0, 0, 2, 4], [0, 0, -2, 4], [2, 4, -2, 4],
        [4, 0, 3, 2], [4, 0, 5, 2], [3, 2, 5, 2],
        [8, 0, 9, 2], [8, 0, 7, 2], [7, 2, 9, 2],
        [12, 0, 11, 2], [12, 0, 13, 2], [13, 2, 11, 2],
        [-4, 0, -3, 2], [-4, 0, -5, 2], [-3, 2, -5, 2],
        [-8, 0, -9, 2], [-8, 0, -7, 2], [-7, 2, -9, 2],
        [-12, 0, -11, 2], [-12, 0, -13, 2], [-13, 2, -11, 2]
      ];
      for (const [x1, y1, x2, y2] of ch) addL(x1, y1, x2, y2, true, true);
      addL(0, 1, 0, 0.03, true, false);
    };

    // Fixed 12 o'clock dial reference pointer
    const addTopIndexPointer = (tipY = -0.178) => {
      addQ(
        { x: -0.012, y: tipY - 0.024 },
        { x: 0.012, y: tipY - 0.024 },
        { x: 0, y: tipY },
        { x: 0, y: tipY },
        false, false
      );
    };

    if (templateId === 'tzf12a') {
      addGermanChevrons();
      addTopIndexPointer(-0.175);
      // Secondary HE 5 o'clock fixed marker + dynamic HE pointer
      addL(0.2, 0, 0.214, 0, false, false, { moveRadial: true, radialCenter: [0, 0], radialAngle: -66, radialMoveSpeed: 0 });
      addL(0.155, 0, 0.17, 0, false, false, { moveRadial: true, radialCenter: [0, 0], radialAngle: -66, radialMoveSpeed: -0.78 });

      doc.ballistics = [
        BlkParser.createDefaultBullet({
          bulletType: 'apcbc_tank',
          speed: 935,
          radial: true,
          circleMode: true,
          drawUpward: true,
          radialRadius: [70, 1],
          radialAngle: 180,
          radialStretch: 5,
          textPos: [0.015, 0],
          distances: generateDistanceEntries(100, 3000, 200, true)
        }),
        BlkParser.createDefaultBullet({
          bulletType: 'he_frag_tank',
          speed: 700,
          radial: true,
          circleMode: true,
          drawUpward: true,
          radialRadius: [70, 1],
          radialAngle: 24,
          radialStretch: 5,
          textPos: [-0.015, 0],
          distances: generateDistanceEntries(100, 2600, 200, true)
        })
      ];
      state.fileName = 'tzf12a_circular_sight.blk';
    } else if (templateId === 'tzf9b') {
      addGermanChevrons();
      addTopIndexPointer(-0.175);

      doc.ballistics = [
        BlkParser.createDefaultBullet({
          bulletType: 'apcbc_tank',
          speed: 773,
          radial: true,
          circleMode: true,
          drawUpward: true,
          radialRadius: [70, 1],
          radialAngle: 180,
          radialStretch: 4.5,
          textPos: [0.016, 0],
          distances: generateDistanceEntries(100, 3000, 200, true)
        }),
        BlkParser.createDefaultBullet({
          bulletType: 'he_frag_tank',
          speed: 700,
          radial: true,
          circleMode: false,
          drawUpward: true,
          radialRadius: [62, 1],
          radialAngle: 180,
          radialStretch: 4.5,
          textPos: [-0.016, 0],
          distances: generateDistanceEntries(100, 2400, 200, false)
        })
      ];
      state.fileName = 'tzf9b_tiger_circular.blk';
    } else {
      // Modern Radial Tick Dial (All Tanks via top-level radial:b=yes)
      doc.header.applyCorrectionToGun = true;
      doc.header.radial = true;
      doc.header.circleMode = false;
      doc.header.drawUpward = true;
      doc.header.radialRadius = [75, 1];
      doc.header.radialAngle = 180;
      doc.header.radialStretch = 5;
      doc.header.textPos = [0.016, 0];
      doc.header.crosshairDistHorSizeMain = [0.016, 0.01];
      doc.header.crosshairDistHorSizeAdditional = [0.008, 0.005];
      doc.distances = generateDistanceEntries(100, 3200, 200, false);

      for (const k of ['radial', 'circleMode', 'drawUpward', 'radialRadius', 'radialAngle', 'radialStretch', 'textPos']) {
        doc.modifiedHeaderKeys.add(k);
      }

      // Split crisp central crosshair + top dial index
      addL(-0.32, 0, -0.012, 0, false, false);
      addL(0.012, 0, 0.32, 0, false, false);
      addL(0, -0.14, 0, -0.012, false, false);
      addL(0, 0.012, 0, 0.25, false, false);
      addTopIndexPointer(-0.188);
      state.fileName = 'modern_radial_sight.blk';
    }

    state.fileHandle = null;
    state.doc = doc;
    state.selection.clear();
    state.lastTraceIds.clear();
    $('activeFileName').textContent = state.fileName;
    syncHeaderUIFromDoc();
    syncRadialPanelUIFromDoc();
    autoConfigurePreviewForDoc();
    setRangePreviewOpen(true);
    resetHistory();
    updateSelectionUI();
    fitView();
    showToast(`Built ${templateId.toUpperCase()} circular rangefinder sight — drag the range slider below!`);
  }

  function bakeActiveRadialScaleToVectors() {
    const { cfg, isBullet } = getActiveRadialConfig();
    if (!cfg.radial || !(cfg.distances || []).length) {
      showToast('Enable Circular (radial:b) and generate distance marks first', 'warn');
      return;
    }

    const milScale = getMilUnitScale();
    const rr = cfg.radialRadius || [70, 1];
    const R = rr[1] ? rr[0] * milScale : rr[0];
    const center = cfg.distancePos || [0, 0];
    const cx = center[0] || 0;
    const cy = center[1] || 0;
    const stretch = (cfg.radialStretch ?? 1) * (cfg.distanceStretch ?? 1);
    const speed = cfg.speed || state.rangePreview.speed || 935;
    const dragK = inferDragK(cfg.bulletType, speed);
    const baseRad = ((cfg.radialAngle ?? 180) * Math.PI) / 180;
    const upward = cfg.drawUpward !== false;
    const textOff = cfg.textPos || [0.015, 0];

    // Exact rotational speed calibration matching native radial scale:
    // deltaTheta = (dropCanvas * stretch) / (milScale * R_units) -> speed = R * stretch / (milScale * rr[0]) = stretch
    const moveSpeedPerCanvas = rr[1]
      ? (R * stretch) / (Math.max(0.01, rr[0]) * milScale)
      : stretch;
    const signSpeed = upward ? moveSpeedPerCanvas : -moveSpeedPerCanvas;

    let added = 0;
    for (const d of cfg.distances) {
      const dropM = computeBallisticDropMrad(d.dist, speed, dragK);
      const theta = rr[1]
        ? (dropM * stretch) / Math.max(0.01, rr[0])
        : (dropM * milScale * stretch) / Math.max(0.01, rr[0]);
      const phiDeg = ((upward ? baseRad - theta : baseRad + theta) * 180) / Math.PI;

      if (cfg.circleMode) {
        const diam = d.minor > 0 ? d.minor : (d.major > 0 ? 0.005 : 0.004);
        state.doc.circles.push({
          id: BlkParser.nextId('circle'),
          layer: 'draw',
          x: cx,
          y: cy + R,
          diameter: diam,
          size: 1.6,
          startAngle: 0,
          endAngle: 360,
          move: false,
          thousandth: false,
          moveRadial: true,
          radialCenter: [cx, cy],
          radialAngle: Number((phiDeg).toFixed(3)),
          radialMoveSpeed: Number(signSpeed.toFixed(6))
        });
        added++;
      } else {
        const tickLen = d.major > 0 ? Math.max(0.008, cfg.crosshairDistHorSizeMain?.[0] ?? 0.014) : Math.max(0.004, cfg.crosshairDistHorSizeAdditional?.[0] ?? 0.007);
        state.doc.lines.push({
          id: BlkParser.nextId('line'),
          layer: 'draw',
          x1: cx,
          y1: cy + R,
          x2: cx,
          y2: cy + R + tickLen,
          move: false,
          thousandth: false,
          moveRadial: true,
          radialCenter: [cx, cy],
          radialAngle: Number(phiDeg.toFixed(3)),
          radialMoveSpeed: Number(signSpeed.toFixed(6))
        });
        added++;
      }

      if (d.major > 0) {
        const labelR = R + (textOff[0] || 0.015);
        const labelSpeed = signSpeed * (labelR / Math.max(0.01, R));
        state.doc.texts.push({
          id: BlkParser.nextId('text'),
          layer: 'draw',
          text: String(d.major),
          x: cx + (textOff[1] || 0),
          y: cy + labelR,
          size: 0.72,
          align: cfg.textAlign || 0,
          move: false,
          thousandth: false,
          highlight: false,
          moveRadial: true,
          radialCenter: [cx, cy],
          radialAngle: Number(phiDeg.toFixed(3)),
          radialMoveSpeed: Number(labelSpeed.toFixed(6))
        });
        added++;
      }
    }

    // Turn off the source native radial ring so shapes aren't doubled
    cfg.radial = false;
    if (isBullet) {
      const idx = state.doc.ballistics.indexOf(cfg);
      if (idx !== -1) state.doc.ballistics.splice(idx, 1);
      state.doc.modifiedHeaderKeys.add('ballistics');
      state.radialTarget = 'main';
    } else {
      state.doc.modifiedHeaderKeys.add('radial');
    }

    pushHistory();
    syncRadialPanelUIFromDoc();
    updateSelectionUI();
    requestRender();
    showToast(`Baked ${added} editable moveRadial shapes into Drawn Layer`);
  }

  function syncPreviewShellOptions() {
    const sel = $('selPreviewShell');
    if (!sel) return;
    const prev = sel.value;
    // Keep built-in options and rebuild dynamic bullet options
    Array.from(sel.querySelectorAll('option[data-doc-bullet="1"]')).forEach((o) => o.remove());
    const bullets = state.doc.ballistics || [];
    bullets.forEach((b, idx) => {
      const opt = document.createElement('option');
      opt.value = `doc_bullet:${idx}`;
      opt.dataset.docBullet = '1';
      opt.textContent = `Sight Bullet #${idx + 1}: ${b.bulletType} (${Math.round(b.speed)} m/s)`;
      sel.appendChild(opt);
    });
    if (Array.from(sel.options).some((o) => o.value === prev)) {
      sel.value = prev;
    } else {
      sel.value = 'auto';
    }
  }

  function autoConfigurePreviewForDoc() {
    syncPreviewShellOptions();
    const bullets = state.doc.ballistics || [];
    let speed = 935;
    let dragK = 0.00011;
    let maxD = 3200;

    if (bullets.length > 0) {
      speed = bullets[0].speed || 935;
      dragK = inferDragK(bullets[0].bulletType, speed);
      const maxFromBullet = Math.max(...bullets.flatMap((b) => (b.distances || []).map((d) => d.dist || 0)), 0);
      if (maxFromBullet >= 600) maxD = Math.min(6000, Math.ceil(maxFromBullet / 200) * 200);
    } else if (state.doc.distances && state.doc.distances.length > 0) {
      const maxFromMain = Math.max(...state.doc.distances.map((d) => d.dist || 0), 0);
      if (maxFromMain >= 600) maxD = Math.min(6000, Math.ceil(maxFromMain / 200) * 200);
    }

    state.rangePreview.speed = speed;
    state.rangePreview.dragK = dragK;
    state.rangePreview.maxDistance = maxD;
    state.rangePreview.distance = 0;
    state.rangePreview.playing = false;

    const autoOpt = $('selPreviewShell')?.querySelector('option[value="auto"]');
    if (autoOpt) autoOpt.textContent = `Auto (${Math.round(speed)} m/s)`;
    if ($('selPreviewShell')) $('selPreviewShell').value = bullets.length > 0 ? 'doc_bullet:0' : 'auto';
    if ($('rngPreviewDist')) $('rngPreviewDist').max = String(maxD);
    syncRangePreviewUI();
  }

  function setPreviewDistance(dist) {
    state.rangePreview.distance = Math.max(0, Math.min(state.rangePreview.maxDistance, dist));
    updatePreviewReadouts();
    requestRender();
  }

  function updatePreviewReadouts() {
    const d = Math.round(state.rangePreview.distance);
    const dropM = computeBallisticDropMrad(d, state.rangePreview.speed, state.rangePreview.dragK);
    if ($('rngPreviewDist')) $('rngPreviewDist').value = String(d);
    if ($('lblPreviewDist')) $('lblPreviewDist').textContent = `${d} m`;
    if ($('lblPreviewDrop')) $('lblPreviewDrop').textContent = `${dropM.toFixed(1)} mil`;
  }

  function syncRangePreviewUI() {
    const active = state.rangePreview.active;
    if ($('rangePreviewBar')) $('rangePreviewBar').hidden = !active;
    if ($('btnRangePreview')) $('btnRangePreview').classList.toggle('preview-active', active);
    if ($('btnRangePlay')) {
      $('btnRangePlay').textContent = state.rangePreview.playing ? '⏸' : '▶';
      $('btnRangePlay').classList.toggle('playing', state.rangePreview.playing);
    }
    if ($('numPreviewSpeed')) $('numPreviewSpeed').value = String(Math.round(state.rangePreview.speed));
    if ($('rngPreviewZoom')) $('rngPreviewZoom').value = String(state.rangePreview.zoomMult);
    if ($('lblPreviewZoom')) $('lblPreviewZoom').textContent = `${state.rangePreview.zoomMult.toFixed(2)}x`;
    if ($('chkPreviewGuides')) $('chkPreviewGuides').checked = !!state.rangePreview.showGuides;
    updatePreviewReadouts();
  }

  function setRangePreviewOpen(open) {
    state.rangePreview.active = !!open;
    if (!open) {
      state.rangePreview.playing = false;
      state.rangePreview.distance = 0;
      state.rangePreview.zoomMult = 1.0;
    } else {
      syncPreviewShellOptions();
    }
    syncRangePreviewUI();
    requestRender();
  }

  function initRadialAndPreviewControls() {
    $('btnRangePreview')?.addEventListener('click', () => {
      setRangePreviewOpen(!state.rangePreview.active);
    });
    $('btnOpenRangePreview')?.addEventListener('click', () => {
      setRangePreviewOpen(true);
      if (state.rangePreview.distance === 0) {
        state.rangePreview.playing = true;
        syncRangePreviewUI();
      }
    });
    $('btnRangeClose')?.addEventListener('click', () => setRangePreviewOpen(false));
    $('btnRangeReset')?.addEventListener('click', () => {
      state.rangePreview.playing = false;
      setPreviewDistance(0);
      syncRangePreviewUI();
    });
    $('btnRangePlay')?.addEventListener('click', () => {
      if (!state.rangePreview.active) setRangePreviewOpen(true);
      state.rangePreview.playing = !state.rangePreview.playing;
      state.rangePreview.lastTs = 0;
      syncRangePreviewUI();
    });
    $('rngPreviewDist')?.addEventListener('input', (e) => {
      state.rangePreview.playing = false;
      setPreviewDistance(parseFloat(e.target.value) || 0);
      syncRangePreviewUI();
    });
    $('selPreviewShell')?.addEventListener('change', (e) => {
      const val = e.target.value;
      const presets = {
        panther_apcbc: { speed: 935, dragK: 0.00011 },
        tiger_aphe: { speed: 773, dragK: 0.00011 },
        he_700: { speed: 700, dragK: 0.00016 },
        apcr_1120: { speed: 1120, dragK: 0.00010 },
        apfsds_1650: { speed: 1650, dragK: 0.000045 }
      };
      if (val.startsWith('doc_bullet:')) {
        const b = state.doc.ballistics?.[parseInt(val.split(':')[1], 10)];
        if (b) {
          state.rangePreview.speed = b.speed || 935;
          state.rangePreview.dragK = inferDragK(b.bulletType, state.rangePreview.speed);
        }
      } else if (presets[val]) {
        state.rangePreview.speed = presets[val].speed;
        state.rangePreview.dragK = presets[val].dragK;
      } else {
        const firstB = state.doc.ballistics?.[0];
        state.rangePreview.speed = firstB?.speed || 935;
        state.rangePreview.dragK = inferDragK(firstB?.bulletType, state.rangePreview.speed);
      }
      syncRangePreviewUI();
      requestRender();
    });
    $('numPreviewSpeed')?.addEventListener('change', (e) => {
      state.rangePreview.speed = Math.max(100, Math.min(2500, parseFloat(e.target.value) || 935));
      state.rangePreview.dragK = inferDragK('', state.rangePreview.speed);
      syncRangePreviewUI();
      requestRender();
    });
    $('rngPreviewZoom')?.addEventListener('input', (e) => {
      state.rangePreview.zoomMult = parseFloat(e.target.value) || 1;
      syncRangePreviewUI();
      requestRender();
    });
    $('chkPreviewGuides')?.addEventListener('change', (e) => {
      state.rangePreview.showGuides = e.target.checked;
      requestRender();
    });

    // Circular Rangefinder Builder Panel
    $('btnBuildRadialPreset')?.addEventListener('click', () => {
      buildRadialPreset($('selRadialTemplate')?.value || 'tzf12a');
    });

    $('selRadialScaleTarget')?.addEventListener('change', (e) => {
      state.radialTarget = e.target.value;
      syncRadialPanelUIFromDoc();
    });

    $('btnAddBulletScale')?.addEventListener('click', () => {
      const idx = state.doc.ballistics.length;
      const offsetAngle = idx === 0 ? 180 : (24 + (idx - 1) * 90);
      const b = BlkParser.createDefaultBullet({
        bulletType: idx === 0 ? 'apcbc_tank' : 'he_frag_tank',
        speed: idx === 0 ? 935 : 700,
        radialAngle: offsetAngle,
        textPos: [idx % 2 === 0 ? 0.015 : -0.015, 0]
      });
      state.doc.ballistics.push(b);
      state.doc.modifiedHeaderKeys.add('ballistics');
      state.radialTarget = `bullet:${idx}`;
      pushHistory();
      syncRadialPanelUIFromDoc();
      syncPreviewShellOptions();
      requestRender();
      showToast(`Added Ballistic Ring #${idx + 1}`);
    });

    $('btnRemoveBulletScale')?.addEventListener('click', () => {
      if (!state.radialTarget.startsWith('bullet:')) return;
      const idx = parseInt(state.radialTarget.split(':')[1], 10);
      if (Number.isFinite(idx) && state.doc.ballistics[idx]) {
        state.doc.ballistics.splice(idx, 1);
        state.doc.modifiedHeaderKeys.add('ballistics');
        state.radialTarget = state.doc.ballistics.length > 0 ? 'bullet:0' : 'main';
        pushHistory();
        syncRadialPanelUIFromDoc();
        syncPreviewShellOptions();
        requestRender();
      }
    });

    const bindRadialCfg = (elId, handler, headerKey, renderEvent = 'change') => {
      $(elId)?.addEventListener(renderEvent, (e) => {
        const { cfg, isBullet } = getActiveRadialConfig();
        handler(cfg, e.target);
        markRadialTargetModified(isBullet, headerKey);
        if (renderEvent === 'change') pushHistory();
        syncRadialPanelUIFromDoc();
        syncPreviewShellOptions();
        requestRender();
      });
    };

    bindRadialCfg('chkRadialEnabled', (cfg, el) => {
      cfg.radial = el.checked;
      if (el.checked && (!(cfg.distances) || cfg.distances.length === 0)) {
        cfg.distances = generateDistanceEntries(100, 3000, 200, !!cfg.circleMode);
        if (cfg === state.doc.header) state.doc.modifiedHeaderKeys.add('crosshair_distances');
      }
    }, 'radial');
    bindRadialCfg('chkRadialCircleMode', (cfg, el) => { cfg.circleMode = el.checked; }, 'circleMode');
    bindRadialCfg('chkRadialDrawUpward', (cfg, el) => { cfg.drawUpward = el.checked; }, 'drawUpward');

    $('chkRadialApplyGun')?.addEventListener('change', (e) => {
      state.doc.header.applyCorrectionToGun = e.target.checked;
      state.doc.modifiedHeaderKeys.add('applyCorrectionToGun');
      if ($('chkApplyCorrGun')) $('chkApplyCorrGun').checked = e.target.checked;
      pushHistory();
      requestRender();
    });

    bindRadialCfg('selBulletType', (cfg, el) => { cfg.bulletType = el.value; }, null);
    bindRadialCfg('numBulletSpeed', (cfg, el) => { cfg.speed = Math.max(100, Math.min(2500, parseFloat(el.value) || 935)); }, null);
    bindRadialCfg('numRadialRadius', (cfg, el) => {
      const rr = cfg.radialRadius || [70, 1];
      cfg.radialRadius = [Math.max(0.01, parseFloat(el.value) || 70), rr[1] ?? 1];
    }, 'radialRadius');
    bindRadialCfg('chkRadialRadiusMil', (cfg, el) => {
      const rr = cfg.radialRadius || [70, 1];
      cfg.radialRadius = [rr[0] ?? 70, el.checked ? 1 : 0];
    }, 'radialRadius');
    bindRadialCfg('numRadialAngle', (cfg, el) => { cfg.radialAngle = parseFloat(el.value) || 0; }, 'radialAngle');
    bindRadialCfg('numRadialStretch', (cfg, el) => { cfg.radialStretch = Math.max(0.05, parseFloat(el.value) || 1); }, 'radialStretch');
    bindRadialCfg('numRadialPosX', (cfg, el) => {
      const dp = cfg.distancePos || [0, 0];
      cfg.distancePos = [parseFloat(el.value) || 0, dp[1] || 0];
    }, 'distancePos');
    bindRadialCfg('numRadialPosY', (cfg, el) => {
      const dp = cfg.distancePos || [0, 0];
      cfg.distancePos = [dp[0] || 0, parseFloat(el.value) || 0];
    }, 'distancePos');
    bindRadialCfg('numRadialTextOff', (cfg, el) => {
      const tp = cfg.textPos || [0.015, 0];
      cfg.textPos = [parseFloat(el.value) || 0, tp[1] || 0];
    }, 'textPos');

    $('btnApplyRadialTicks')?.addEventListener('click', () => {
      const { cfg, isBullet } = getActiveRadialConfig();
      const step = parseFloat($('numRadialStep')?.value) || 100;
      const maxD = parseFloat($('numRadialMax')?.value) || 3000;
      const lblEvery = parseFloat($('numRadialLabelStep')?.value) || 200;
      cfg.distances = generateDistanceEntries(step, maxD, lblEvery, !!cfg.circleMode);
      cfg.radial = true;
      markRadialTargetModified(isBullet, 'radial');
      if (!isBullet) state.doc.modifiedHeaderKeys.add('crosshair_distances');
      pushHistory();
      syncRadialPanelUIFromDoc();
      requestRender();
      showToast(`Generated ${cfg.distances.length - 1} circular distance marks (up to ${maxD}m)`);
    });

    $('btnAddRadialPointer')?.addEventListener('click', () => {
      const { cfg } = getActiveRadialConfig();
      const milScale = getMilUnitScale();
      const rr = cfg.radialRadius || [70, 1];
      const R = rr[1] ? rr[0] * milScale : rr[0];
      const cx = cfg.distancePos?.[0] || 0;
      const cy = cfg.distancePos?.[1] || 0;
      const tipY = cy - R;
      state.doc.quads.push({
        id: BlkParser.nextId('quad'),
        layer: 'draw',
        tl: { x: cx - 0.012, y: tipY - 0.024 },
        tr: { x: cx + 0.012, y: tipY - 0.024 },
        br: { x: cx, y: tipY },
        bl: { x: cx, y: tipY },
        move: false,
        thousandth: false
      });
      pushHistory();
      requestRender();
      showToast('Added 12 o\'clock dial index pointer');
    });

    $('btnBakeRadialShapes')?.addEventListener('click', bakeActiveRadialScaleToVectors);

    // Selection & CAD per-element moveRadial controls
    $('chkSelMoveRadial')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      let changed = false;
      for (const { item } of getSelectedEntries()) {
        if (isLayerLocked(item.layer)) continue;
        item.moveRadial = checked;
        if (checked) {
          item.move = false;
          if (!Array.isArray(item.radialCenter)) item.radialCenter = [0, 0];
          if (!Number.isFinite(item.radialAngle)) item.radialAngle = 0;
          if (!Number.isFinite(item.radialMoveSpeed)) item.radialMoveSpeed = 1;
        }
        changed = true;
      }
      if (!changed) {
        updateSelectionUI();
        return;
      }
      pushHistory();
      syncRadialPanelUIFromDoc();
      updateSelectionUI();
      updateMotionLegend();
      requestRender();
    });

    $('btnSelRadApply')?.addEventListener('click', () => {
      const entries = getSelectedEntries();
      if (entries.length === 0) return;
      const cxStr = $('numSelRadCx')?.value.trim() ?? '';
      const cyStr = $('numSelRadCy')?.value.trim() ?? '';
      const angStr = $('numSelRadAngle')?.value.trim() ?? '';
      const spdStr = $('numSelRadSpeed')?.value.trim() ?? '';
      const isRad = !!$('chkSelMoveRadial')?.checked;

      for (const { item } of entries) {
        if (isLayerLocked(item.layer)) continue;
        item.moveRadial = isRad;
        if (isRad) item.move = false;
        const curC = Array.isArray(item.radialCenter) ? item.radialCenter : [0, 0];
        const nx = cxStr !== '' ? (parseFloat(cxStr) || 0) : curC[0];
        const ny = cyStr !== '' ? (parseFloat(cyStr) || 0) : curC[1];
        item.radialCenter = [nx, ny];
        if (angStr !== '') item.radialAngle = parseFloat(angStr) || 0;
        if (spdStr !== '') item.radialMoveSpeed = parseFloat(spdStr) || 0;
      }
      pushHistory();
      syncRadialPanelUIFromDoc();
      updateSelectionUI();
      updateMotionLegend();
      requestRender();
      showToast(`Applied radial settings to ${entries.length} element(s)`);
    });

    $('btnSelRadSyncRigid')?.addEventListener('click', () => {
      const entries = getSelectedEntries().filter(({ item }) => !isLayerLocked(item.layer));
      if (entries.length === 0) return;
      const mult = parseFloat($('numSelRadMult')?.value) || 20.64;
      const cxStr = $('numSelRadCx')?.value.trim() ?? '';
      const cyStr = $('numSelRadCy')?.value.trim() ?? '';
      const milScale = getMilUnitScale();

      for (const { kind, item } of entries) {
        item.moveRadial = true;
        item.move = false;
        const curC = Array.isArray(item.radialCenter) ? item.radialCenter : [0, 0];
        const rcx = cxStr !== '' ? (parseFloat(cxStr) || 0) : curC[0];
        const rcy = cyStr !== '' ? (parseFloat(cyStr) || 0) : curC[1];
        item.radialCenter = [rcx, rcy];
        const th = !!item.thousandth;
        const ref = getElementBaseRefCanvas(kind, item, milScale);
        const r = Math.hypot(ref.x - toCanvasUnit(rcx, th, milScale), ref.y - toCanvasUnit(rcy, th, milScale));
        item.radialMoveSpeed = Number((mult * Math.max(0.01, r)).toFixed(6));
      }
      if ($('chkSelMove')) $('chkSelMove').checked = false;
      if ($('chkSelMoveRadial')) $('chkSelMoveRadial').checked = true;
      pushHistory();
      syncRadialPanelUIFromDoc();
      updateSelectionUI();
      updateMotionLegend();
      requestRender();
      showToast(`Synced rigid radialMoveSpeed (${mult}×r) on ${entries.length} element(s)`);
    });
  }

  // =========================================================================
  // Tank Sight Preset (HUD) & Reticle Overrides Controller
  // =========================================================================
  function ensureHudWidgetsOnDoc() {
    const defaults = BlkParser.createDefaultHudWidgets();
    if (!state.doc.hudWidgets) state.doc.hudWidgets = {};
    for (const k of BlkParser.HUD_WIDGET_ORDER) {
      if (!state.doc.hudWidgets[k]) state.doc.hudWidgets[k] = defaults[k];
    }
    return state.doc.hudWidgets;
  }

  function refreshHudBackdropDoc() {
    const dl = $('crosshairPresetList');
    if (dl) {
      dl.innerHTML = '';
      const seen = new Set(['default_sight', 'ariete']);
      const addOpt = (v) => {
        const o = document.createElement('option');
        o.value = v;
        dl.appendChild(o);
      };
      addOpt('Default_Sight');
      addOpt('ariete');
      for (const [k, txt] of Object.entries(state.sightsCatalog)) {
        if (k === 'Default Sight' || typeof txt !== 'string') continue;
        const stripped = k.replace(/\.blk$/i, '');
        if (seen.has(stripped.toLowerCase())) continue;
        const lCount = (txt.match(/line\s*\{/g) || []).length;
        const qCount = (txt.match(/quad\s*\{/g) || []).length;
        if (lCount > 0 || qCount > 0) {
          seen.add(stripped.toLowerCase());
          addOpt(stripped);
        }
      }
    }

    const statusEl = $('hudBackdropStatus');
    const ownPrimitives = state.doc.lines.length + state.doc.quads.length + state.doc.circles.length + state.doc.texts.length;
    if ((state.doc.docType !== 'hud_preset' && state.doc.docType !== 'both') || ownPrimitives > 0) {
      state.hudBackdrop.doc = null;
      state.hudBackdrop.key = '';
      if (statusEl) {
        statusEl.textContent = ownPrimitives > 0
          ? `Canvas Reticle active (${ownPrimitives} primitives → _reticle.blk)`
          : 'Backdrop preview active in HUD Preset mode';
      }
      return;
    }

    const preset = (state.doc.header?.crosshairPreset || 'Default_Sight').trim();
    if (state.hudBackdrop.customText) {
      const cacheKey = `custom:${state.hudBackdrop.customName}:${preset}`;
      if (state.hudBackdrop.key !== cacheKey) {
        const parsed = BlkParser.parse(state.hudBackdrop.customText, {
          defaultLayer: 'base',
          autoSynthesizeStatic: false
        });
        state.hudBackdrop.doc = parsed;
        state.hudBackdrop.key = cacheKey;
      }
      if (statusEl) statusEl.textContent = `Backdrop: ${state.hudBackdrop.customName} (loaded)`;
      return;
    }

    const target = preset.toLowerCase().replace(/\.blk$/i, '');
    let matchedName = '';
    let matchedTxt = '';
    for (const [k, txt] of Object.entries(state.sightsCatalog)) {
      if (k === 'Default Sight' || typeof txt !== 'string') continue;
      const fullNoExt = k.toLowerCase().replace(/\.blk$/i, '');
      const baseNoExt = (k.split('/').pop() || k).toLowerCase().replace(/\.blk$/i, '');
      if (fullNoExt === target || baseNoExt === target) {
        matchedName = k;
        matchedTxt = txt;
        break;
      }
    }

    if (matchedTxt) {
      const cacheKey = `cat:${matchedName}:${matchedTxt.length}`;
      if (state.hudBackdrop.key !== cacheKey) {
        const parsed = BlkParser.parse(matchedTxt, {
          defaultLayer: 'base',
          autoSynthesizeStatic: false
        });
        state.hudBackdrop.doc = parsed.docType === 'sight' ? parsed : null;
        state.hudBackdrop.key = cacheKey;
      }
      if (state.hudBackdrop.doc) {
        if (statusEl) statusEl.textContent = `Backdrop: ${matchedName} (from catalog)`;
        return;
      }
    }

    state.hudBackdrop.doc = null;
    state.hudBackdrop.key = `builtin:${target}`;
    if (!target || target === 'default_sight' || target === 'ariete') {
      if (statusEl) statusEl.textContent = `Backdrop: Built-in ${preset || 'Default_Sight'}`;
    } else {
      if (statusEl) statusEl.textContent = `Backdrop: "${preset}" not in sights/ (showing Standard — Load Backdrop .blk)`;
    }
  }

  function syncHudPresetUIFromDoc() {
    const doc = state.doc;
    const h = doc.header;
    const widgets = ensureHudWidgetsOnDoc();
    const includedCount = BlkParser.HUD_WIDGET_ORDER.filter((k) => widgets[k]?.included).length;
    const hasRet = docHasReticleThings(doc);
    const hasHud = docHasActiveHudSettings(doc);
    const hasBoth = hasRet && hasHud;
    if (hasBoth && doc.docType !== 'both') {
      doc.docType = 'both';
    } else if (!hasBoth && doc.docType === 'both') {
      doc.docType = hasRet ? 'sight' : (hasHud ? 'hud_preset' : 'sight');
    }
    const modeVal = doc.docType === 'both' ? 'both' : (doc.docType === 'hud_preset' ? 'hud_preset' : 'sight');

    if ($('selDocType')) $('selDocType').value = modeVal;
    if ($('hudPresetStatusBadge')) {
      const b = $('hudPresetStatusBadge');
      b.textContent = modeVal === 'both' ? 'RETICLE + HUD' : (modeVal === 'hud_preset' ? 'HUD PRESET' : (includedCount > 0 ? `${includedCount} HUD` : 'RETICLE'));
      b.classList.toggle('active', modeVal !== 'sight' || includedCount > 0);
    }

    if ($('hudVectorExportHint')) {
      $('hudVectorExportHint').hidden = !hasBoth;
    }

    if ($('inpCrosshairPreset')) $('inpCrosshairPreset').value = h.crosshairPreset ?? 'Default_Sight';
    if ($('numShotDistOffset')) $('numShotDistOffset').value = String(Math.round(h.shotDistScaleOffset || 0));

    const ret = h.reticle || { included: false, overridden: false, lineWidth: 0, fontSize: 0.7 };
    if ($('chkReticleInclude')) $('chkReticleInclude').checked = !!ret.included;
    if ($('chkReticleOverridden')) $('chkReticleOverridden').checked = !!ret.overridden;
    if ($('numReticleLineWidth')) $('numReticleLineWidth').value = String(ret.lineWidth ?? 0);
    if ($('numReticleFontSize')) $('numReticleFontSize').value = String(ret.fontSize ?? 0.7);

    if ($('chkShowHudOverlay')) $('chkShowHudOverlay').checked = state.options.showHudOverlay !== false;
    if ($('chkHudEditOnCanvas')) $('chkHudEditOnCanvas').checked = !!state.hudEditor.editOnCanvas;

    const selName = BlkParser.HUD_WIDGET_ORDER.includes(state.hudEditor.selectedWidget)
      ? state.hudEditor.selectedWidget
      : 'rangefinder';
    state.hudEditor.selectedWidget = selName;

    document.querySelectorAll('.hud-widget-tab').forEach((btn) => {
      const k = btn.dataset.hudWidget;
      const wObj = widgets[k];
      btn.classList.toggle('active', k === selName);
      btn.classList.toggle('included', !!wObj?.included);
      btn.classList.toggle('visible', !!(wObj?.included && wObj?.visible));
    });

    const colorMode = state.hudEditor.colorMode || 'day';
    document.querySelectorAll('.hud-mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.hudColorMode === colorMode);
    });

    const w = widgets[selName];
    if ($('lblHudWidgetTitle')) $('lblHudWidgetTitle').textContent = selName;
    if ($('chkHudWidgetIncluded')) $('chkHudWidgetIncluded').checked = !!w.included;
    if ($('chkHudWidgetVisible')) $('chkHudWidgetVisible').checked = w.visible !== false;

    const hasPos = selName !== 'fov';
    if ($('hudWidgetPosBox')) $('hudWidgetPosBox').hidden = !hasPos;
    if (hasPos) {
      const pos = Array.isArray(w.position) ? w.position : [960, 540];
      if ($('numHudPosX')) $('numHudPosX').value = String(BlkParser.formatNum(pos[0] ?? 960));
      if ($('numHudPosY')) $('numHudPosY').value = String(BlkParser.formatNum(pos[1] ?? 540));
    }

    const hasFont = selName === 'rangefinder' || selName === 'gunReady' || selName === 'bulletType';
    if ($('hudWidgetFontBox')) $('hudWidgetFontBox').hidden = !hasFont;
    if (hasFont) {
      if ($('numHudTextSize')) $('numHudTextSize').value = String(Math.round(w.textSize ?? 20));
      if ($('inpHudFont')) $('inpHudFont').value = w.font || 'hud';
    }

    if ($('hudGunReadyOpts')) $('hudGunReadyOpts').hidden = selName !== 'gunReady';
    if (selName === 'gunReady') {
      if ($('chkHudGunReadyMark')) $('chkHudGunReadyMark').checked = w.gunReadyMarkVisible !== false;
      if ($('chkHudGunReadyCountdown')) $('chkHudGunReadyCountdown').checked = w.gunReadyReloadCountdownVisible !== false;
    }

    if ($('hudBulletTypeOpts')) $('hudBulletTypeOpts').hidden = selName !== 'bulletType';
    if (selName === 'bulletType') {
      if ($('chkHudBulletShortName')) $('chkHudBulletShortName').checked = !!w.isShortName;
    }

    if ($('hudRangefinderOpts')) $('hudRangefinderOpts').hidden = selName !== 'rangefinder';
    if (selName === 'rangefinder') {
      const pc = w.progressColor || { r: 255, g: 255, b: 0, a: 255 };
      const pbg = w.progressBackgroundColor || { r: 0, g: 0, b: 0, a: 0 };
      if ($('colHudRfProg')) $('colHudRfProg').value = rgbToHex(pc.r, pc.g, pc.b);
      if ($('rngHudRfProgAlpha')) $('rngHudRfProgAlpha').value = String(pc.a ?? 255);
      if ($('lblHudRfProgAlpha')) $('lblHudRfProgAlpha').textContent = formatAlphaPct(pc.a ?? 255);
      if ($('colHudRfProgBg')) $('colHudRfProgBg').value = rgbToHex(pbg.r, pbg.g, pbg.b);
      if ($('rngHudRfProgBgAlpha')) $('rngHudRfProgBgAlpha').value = String(pbg.a ?? 0);
      if ($('lblHudRfProgBgAlpha')) $('lblHudRfProgBgAlpha').textContent = formatAlphaPct(pbg.a ?? 0);
    }

    const keys = getHudColorKeyMap(selName, colorMode);
    const fg = w[keys.fg] || { r: 0, g: 255, b: 60, a: 255 };
    if ($('lblHudFgColor')) $('lblHudFgColor').textContent = keys.bg ? 'Text Color' : 'Color';
    if ($('colHudFg')) $('colHudFg').value = rgbToHex(fg.r, fg.g, fg.b);
    if ($('rngHudFgAlpha')) $('rngHudFgAlpha').value = String(fg.a ?? 255);
    if ($('lblHudFgAlpha')) $('lblHudFgAlpha').textContent = formatAlphaPct(fg.a ?? 255);

    if ($('hudWidgetBgRow')) $('hudWidgetBgRow').hidden = !keys.bg;
    if (keys.bg) {
      const bg = w[keys.bg] || { r: 0, g: 0, b: 0, a: 0 };
      if ($('colHudBg')) $('colHudBg').value = rgbToHex(bg.r, bg.g, bg.b);
      if ($('rngHudBgAlpha')) $('rngHudBgAlpha').value = String(bg.a ?? 0);
      if ($('lblHudBgAlpha')) $('lblHudBgAlpha').textContent = formatAlphaPct(bg.a ?? 0);
    }
    syncAllColorIndicatorsUI();
    updatePrimarySaveButtonState();
  }

  function initHudPresetControls() {
    $('selDocType')?.addEventListener('change', (e) => {
      const v = e.target.value;
      const nextType = v === 'both' ? 'both' : (v === 'hud_preset' ? 'hud_preset' : 'sight');
      state.doc.docType = nextType;
      if (nextType === 'hud_preset' || nextType === 'both') {
        if (!state.doc.header.crosshairPreset) {
          state.doc.header.crosshairPreset = getExportFileNames(state.fileName).reticleStem;
        }
        state.hudEditor.editOnCanvas = true;
        state.options.showHudOverlay = true;
      } else {
        state.hudEditor.editOnCanvas = false;
      }
      pushHistory();
      syncHudPresetUIFromDoc();
      refreshHudBackdropDoc();
      requestRender();
      const msg = nextType === 'both'
        ? 'Export Mode set to Both Files (_reticle.blk + _preset.blk)'
        : (nextType === 'hud_preset' ? 'Export Mode set to HUD Preset Only (_preset.blk)' : 'Export Mode set to Reticle Only (_reticle.blk)');
      showToast(msg);
    });

    $('btnSaveBothBlk')?.addEventListener('click', () => saveBlkFile('both'));
    $('btnSaveReticleOnly')?.addEventListener('click', () => saveBlkFile('sight'));
    $('btnSavePresetOnly')?.addEventListener('click', () => saveBlkFile('hud_preset'));

    $('btnConvertToClassicSight')?.addEventListener('click', () => {
      state.doc.docType = 'both';
      if ($('selDocType')) $('selDocType').value = 'both';
      saveBlkFile('both');
    });

    $('btnBuildHudPreset')?.addEventListener('click', () => {
      const tmpl = $('selHudPresetTemplate')?.value || 'pro';
      state.fileHandle = null;
      state.fileName = tmpl === 'minimal' ? 'custom_hud_preset.blk' : 'pro_hud_preset.blk';
      state.doc = BlkParser.createEmptyHudPresetDoc(tmpl);
      state.selection.clear();
      state.hudBackdrop.customName = '';
      state.hudBackdrop.customText = '';
      state.hudBackdrop.doc = null;
      state.hudBackdrop.key = '';
      state.options.showHudOverlay = true;
      state.hudEditor.editOnCanvas = true;
      state.hudEditor.selectedWidget = tmpl === 'minimal' ? 'bulletType' : 'rangefinder';
      $('activeFileName').textContent = state.fileName;
      if ($('hudPresetPanel')) $('hudPresetPanel').open = true;
      syncHeaderUIFromDoc();
      syncRadialPanelUIFromDoc();
      refreshHudBackdropDoc();
      resetHistory();
      updateSelectionUI();
      fitView();
      showToast(`Applied ${tmpl === 'minimal' ? 'Minimal' : 'Pro Competitive'} Tank Sight HUD Preset`);
    });

    $('inpCrosshairPreset')?.addEventListener('change', (e) => {
      state.doc.header.crosshairPreset = (e.target.value || 'Default_Sight').trim();
      state.doc.modifiedHeaderKeys.add('crosshairPreset');
      state.hudBackdrop.customName = '';
      state.hudBackdrop.customText = '';
      state.hudBackdrop.key = '';
      refreshHudBackdropDoc();
      pushHistory();
      requestRender();
    });

    $('btnLoadHudBackdrop')?.addEventListener('click', () => $('fileHudBackdrop')?.click());
    $('fileHudBackdrop')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((txt) => {
        state.hudBackdrop.customName = file.name;
        state.hudBackdrop.customText = txt;
        state.hudBackdrop.key = '';
        const noExt = file.name.replace(/\.blk$/i, '');
        state.doc.header.crosshairPreset = noExt;
        state.doc.modifiedHeaderKeys.add('crosshairPreset');
        if ($('inpCrosshairPreset')) $('inpCrosshairPreset').value = noExt;
        refreshHudBackdropDoc();
        pushHistory();
        requestRender();
        showToast(`Loaded backdrop sight: ${file.name}`);
      });
      e.target.value = '';
    });

    $('btnClearHudBackdrop')?.addEventListener('click', () => {
      state.hudBackdrop.customName = '';
      state.hudBackdrop.customText = '';
      state.hudBackdrop.doc = null;
      state.hudBackdrop.key = '';
      refreshHudBackdropDoc();
      requestRender();
      showToast('Reset HUD backdrop lookup');
    });

    $('numShotDistOffset')?.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10) || 0;
      state.doc.header.shotDistScaleOffset = val;
      state.doc.modifiedHeaderKeys.add('shotDistScaleOffset');
      if ($('numGlobalDistOffset')) $('numGlobalDistOffset').value = String(val);
      pushHistory();
      requestRender();
    });

    const getReticle = () => {
      if (!state.doc.header.reticle) {
        state.doc.header.reticle = { included: false, overridden: false, lineWidth: 0, fontSize: 0.7 };
      }
      return state.doc.header.reticle;
    };

    $('chkReticleInclude')?.addEventListener('change', (e) => {
      getReticle().included = e.target.checked;
      pushHistory();
      requestRender();
    });
    $('chkReticleOverridden')?.addEventListener('change', (e) => {
      const r = getReticle();
      r.overridden = e.target.checked;
      if (e.target.checked) r.included = true;
      syncHudPresetUIFromDoc();
      pushHistory();
      requestRender();
    });
    $('numReticleLineWidth')?.addEventListener('change', (e) => {
      const r = getReticle();
      r.lineWidth = Math.max(0, Math.min(10, parseFloat(e.target.value) || 0));
      pushHistory();
      requestRender();
    });
    $('numReticleFontSize')?.addEventListener('change', (e) => {
      const r = getReticle();
      r.fontSize = Math.max(0.1, Math.min(5, parseFloat(e.target.value) || 0.7));
      pushHistory();
      requestRender();
    });

    $('chkShowHudOverlay')?.addEventListener('change', (e) => {
      state.options.showHudOverlay = e.target.checked;
      requestRender();
    });
    $('chkHudEditOnCanvas')?.addEventListener('change', (e) => {
      state.hudEditor.editOnCanvas = e.target.checked;
      requestRender();
    });

    document.querySelectorAll('.hud-widget-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.hudEditor.selectedWidget = btn.dataset.hudWidget;
        syncHudPresetUIFromDoc();
        requestRender();
      });
    });

    document.querySelectorAll('.hud-mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.hudColorMode;
        state.hudEditor.colorMode = mode;
        state.previewMode = mode;
        document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
        updateMotionLegend();
        syncHudPresetUIFromDoc();
        requestRender();
      });
    });

    const curW = () => ensureHudWidgetsOnDoc()[state.hudEditor.selectedWidget];

    $('chkHudWidgetIncluded')?.addEventListener('change', (e) => {
      curW().included = e.target.checked;
      syncHudPresetUIFromDoc();
      pushHistory();
      requestRender();
    });
    $('chkHudWidgetVisible')?.addEventListener('change', (e) => {
      const w = curW();
      w.visible = e.target.checked;
      if (e.target.checked) w.included = true;
      syncHudPresetUIFromDoc();
      pushHistory();
      requestRender();
    });

    const updateWidgetPos = (axis, raw) => {
      const w = curW();
      if (!Array.isArray(w.position)) w.position = [960, 540];
      const max = axis === 0 ? 1920 : 1080;
      const val = Math.max(0, Math.min(max, parseFloat(raw) || 0));
      w.position[axis] = Math.round(val * 100) / 100;
      w.wx = (w.position[0] - 960) / 1080;
      w.wy = (w.position[1] - 540) / 1080;
      pushHistory();
      requestRender();
    };
    $('numHudPosX')?.addEventListener('change', (e) => updateWidgetPos(0, e.target.value));
    $('numHudPosY')?.addEventListener('change', (e) => updateWidgetPos(1, e.target.value));

    $('btnHudCenterX')?.addEventListener('click', () => {
      updateWidgetPos(0, 960);
      syncHudPresetUIFromDoc();
    });
    $('btnHudCenterY')?.addEventListener('click', () => {
      updateWidgetPos(1, 540);
      syncHudPresetUIFromDoc();
    });
    $('btnHudMirrorX')?.addEventListener('click', () => {
      const w = curW();
      if (!Array.isArray(w.position)) return;
      updateWidgetPos(0, 1920 - w.position[0]);
      syncHudPresetUIFromDoc();
    });
    $('btnHudSyncRfReadyY')?.addEventListener('click', () => {
      const widgets = ensureHudWidgetsOnDoc();
      const selName = state.hudEditor.selectedWidget;
      const refY = (selName === 'gunReady' ? widgets.gunReady.position?.[1] : widgets.rangefinder.position?.[1]) ?? 549.75;
      if (Array.isArray(widgets.rangefinder.position)) {
        widgets.rangefinder.position[1] = refY;
        widgets.rangefinder.wy = (refY - 540) / 1080;
      }
      if (Array.isArray(widgets.gunReady.position)) {
        widgets.gunReady.position[1] = refY;
        widgets.gunReady.wy = (refY - 540) / 1080;
      }
      syncHudPresetUIFromDoc();
      pushHistory();
      requestRender();
      showToast(`Aligned Rangefinder & GunReady Y = ${refY}`);
    });

    $('numHudTextSize')?.addEventListener('change', (e) => {
      curW().textSize = Math.max(8, Math.min(72, Math.round(parseFloat(e.target.value) || 20)));
      pushHistory();
      requestRender();
    });
    $('inpHudFont')?.addEventListener('change', (e) => {
      curW().font = (e.target.value || 'hud').trim();
      pushHistory();
      requestRender();
    });
    $('chkHudGunReadyMark')?.addEventListener('change', (e) => {
      curW().gunReadyMarkVisible = e.target.checked;
      pushHistory();
      requestRender();
    });
    $('chkHudGunReadyCountdown')?.addEventListener('change', (e) => {
      curW().gunReadyReloadCountdownVisible = e.target.checked;
      pushHistory();
      requestRender();
    });
    $('chkHudBulletShortName')?.addEventListener('change', (e) => {
      curW().isShortName = e.target.checked;
      pushHistory();
      requestRender();
    });

    const bindRfProgColor = (hexId, alphaId, propKey) => {
      if (!$(hexId) || !$(alphaId)) return;
      const apply = () => {
        const rgb = hexToRgb($(hexId).value);
        const a = parseInt($(alphaId).value, 10);
        curW()[propKey] = { r: rgb.r, g: rgb.g, b: rgb.b, a: Number.isFinite(a) ? a : 255 };
        syncHudPresetUIFromDoc();
        requestRender();
      };
      $(hexId).addEventListener('input', apply);
      $(alphaId).addEventListener('input', apply);
      $(hexId).addEventListener('change', () => pushHistory());
      $(alphaId).addEventListener('change', () => pushHistory());
    };
    bindRfProgColor('colHudRfProg', 'rngHudRfProgAlpha', 'progressColor');
    bindRfProgColor('colHudRfProgBg', 'rngHudRfProgBgAlpha', 'progressBackgroundColor');

    const applyWidgetColor = (isBg, push) => {
      const name = state.hudEditor.selectedWidget;
      const w = curW();
      const keys = getHudColorKeyMap(name, state.hudEditor.colorMode);
      const targetKey = isBg ? keys.bg : keys.fg;
      if (!targetKey) return;
      const hexEl = $(isBg ? 'colHudBg' : 'colHudFg');
      const alphaEl = $(isBg ? 'rngHudBgAlpha' : 'rngHudFgAlpha');
      if (!hexEl || !alphaEl) return;
      const rgb = hexToRgb(hexEl.value);
      const a = parseInt(alphaEl.value, 10);
      w[targetKey] = { r: rgb.r, g: rgb.g, b: rgb.b, a: Number.isFinite(a) ? a : 255 };
      if (['day', 'light', 'nvg', 'thermal'].includes(state.hudEditor.colorMode) && state.previewMode !== state.hudEditor.colorMode && state.previewMode !== 'motion') {
        state.previewMode = state.hudEditor.colorMode;
      }
      syncHudPresetUIFromDoc();
      if (push) pushHistory();
      requestRender();
    };
    $('colHudFg')?.addEventListener('input', () => applyWidgetColor(false, false));
    $('rngHudFgAlpha')?.addEventListener('input', () => applyWidgetColor(false, false));
    $('colHudFg')?.addEventListener('change', () => applyWidgetColor(false, true));
    $('rngHudFgAlpha')?.addEventListener('change', () => applyWidgetColor(false, true));
    $('colHudBg')?.addEventListener('input', () => applyWidgetColor(true, false));
    $('rngHudBgAlpha')?.addEventListener('input', () => applyWidgetColor(true, false));
    $('colHudBg')?.addEventListener('change', () => applyWidgetColor(true, true));
    $('rngHudBgAlpha')?.addEventListener('change', () => applyWidgetColor(true, true));

    $('btnHudCopyDayToModes')?.addEventListener('click', () => {
      const name = state.hudEditor.selectedWidget;
      const w = curW();
      const dayKeys = getHudColorKeyMap(name, 'day');
      const fgSrc = w[dayKeys.fg];
      const bgSrc = dayKeys.bg ? w[dayKeys.bg] : null;
      for (const m of ['light', 'nvg', 'thermal']) {
        const mk = getHudColorKeyMap(name, m);
        if (fgSrc) w[mk.fg] = { ...fgSrc };
        if (mk.bg && bgSrc) w[mk.bg] = { ...bgSrc };
      }
      syncHudPresetUIFromDoc();
      pushHistory();
      requestRender();
      showToast(`Copied Day colors across all modes on ${name}`);
    });

    $('btnHudApplyColorsAllWidgets')?.addEventListener('click', () => {
      const srcName = state.hudEditor.selectedWidget;
      const widgets = ensureHudWidgetsOnDoc();
      const srcW = widgets[srcName];
      for (const targetName of BlkParser.HUD_WIDGET_ORDER) {
        if (targetName === srcName) continue;
        const dstW = widgets[targetName];
        for (const m of ['day', 'light', 'nvg', 'thermal']) {
          const sk = getHudColorKeyMap(srcName, m);
          const dk = getHudColorKeyMap(targetName, m);
          if (srcW[sk.fg]) dstW[dk.fg] = { ...srcW[sk.fg] };
          if (dk.bg && sk.bg && srcW[sk.bg]) dstW[dk.bg] = { ...srcW[sk.bg] };
        }
      }
      pushHistory();
      requestRender();
      showToast(`Applied ${srcName} color palette to all HUD widgets`);
    });

    $('btnHudMatchReticleColors')?.addEventListener('click', () => {
      const h = state.doc.header;
      const name = state.hudEditor.selectedWidget;
      const w = curW();
      const mapPairs = [
        ['day', h.crosshairColor],
        ['light', h.crosshairLightColor],
        ['nvg', h.crosshairNvColor],
        ['thermal', h.crosshairThermalColor]
      ];
      for (const [m, c] of mapPairs) {
        const mk = getHudColorKeyMap(name, m);
        if (c) w[mk.fg] = { ...c };
      }
      syncHudPresetUIFromDoc();
      pushHistory();
      requestRender();
      showToast(`Matched ${name} colors to Reticle optic colors`);
    });

    $('btnRangeSimHud')?.addEventListener('click', () => {
      if (state.hudSim.active) {
        state.hudSim.active = false;
        $('btnRangeSimHud')?.classList.remove('active');
        requestRender();
        return;
      }
      state.hudSim.active = true;
      state.hudSim.startTs = performance.now();
      $('btnRangeSimHud')?.classList.add('active');
      if (!state.options.showHudOverlay) {
        state.options.showHudOverlay = true;
        if ($('chkShowHudOverlay')) $('chkShowHudOverlay').checked = true;
      }
      requestRender();
    });
  }

  // =========================================================================
  // Keyboard Shortcuts
  // =========================================================================
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === ' ' && !isTyping) {
      e.preventDefault();
      state.spacePanning = true;
      updateCursorForTool();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveBlkFile();
      return;
    }

    if (isTyping) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected(0.015);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      const sel = getSelectedEntries();
      if (sel.length > 0) {
        e.preventDefault();
        state.clipboard = sel.map(({ kind, item }) => cloneEntry(kind, item, 'draw'));
        showToast(`Copied ${state.clipboard.length} shape(s)`);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (state.clipboard.length > 0) {
        e.preventDefault();
        const pasted = state.clipboard.map(({ kind, item }) => cloneEntry(kind, item, 'draw'));
        for (const p of pasted) insertClonedEntry(p);
        translateEntries(pasted, 0.015, 0.015);
        state.selection = new Set(pasted.map((p) => p.item.id));
        pushHistory();
        updateSelectionUI();
        requestRender();
        showToast(`Pasted ${pasted.length} shape(s)`);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.selection.clear();
      for (const { item } of allShapes()) {
        if (isLayerVisible(item.layer) && !isLayerLocked(item.layer)) {
          state.selection.add(item.id);
        }
      }
      updateSelectionUI();
      requestRender();
      return;
    }

    // Arrow key nudging (vector shapes, or selected HUD widget when Drag HUD is active)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (state.selection.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 0.02 : 0.0025;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        translateSelected(dx, dy);
        pushHistory();
        updateSelectionUI();
        requestRender();
        return;
      } else if (state.hudEditor.editOnCanvas && state.options.showHudOverlay) {
        const w = state.doc.hudWidgets?.[state.hudEditor.selectedWidget];
        if (w && w.included && w.visible && Array.isArray(w.position)) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          w.position[0] = Math.max(0, Math.min(1920, w.position[0] + dx));
          w.position[1] = Math.max(0, Math.min(1080, w.position[1] + dy));
          w.wx = (w.position[0] - 960) / 1080;
          w.wy = (w.position[1] - 540) / 1080;
          syncHudPresetUIFromDoc();
          pushHistory();
          requestRender();
          return;
        }
      }
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (e.key === 'Backspace' && state.polyPoints.length > 0) {
        e.preventDefault();
        state.polyPoints.pop();
        requestRender();
        return;
      }
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (e.key === 'Enter') {
      if (state.polyPoints.length > 0) finishPoly(true);
      return;
    }

    if (e.key === 'Escape') {
      if (!$('codeModal').hidden) {
        $('codeModal').hidden = true;
        return;
      }
      if (!$('textInputPopover').hidden) {
        closeTextPopover();
        return;
      }
      if (state.polyPoints.length > 0) {
        finishPoly(false);
        return;
      }
      if (state.pendingLineStart) {
        state.pendingLineStart = null;
        requestRender();
        return;
      }
      state.selection.clear();
      updateSelectionUI();
      requestRender();
      return;
    }

    const toolKeys = {
      v: 'select',
      l: 'line',
      p: 'polyline',
      s: 'spline',
      b: 'freehand',
      q: 'polygon',
      r: 'rect',
      c: 'circle',
      g: 'shape',
      t: 'text',
      e: 'eraser',
      h: 'pan'
    };
    const k = e.key.toLowerCase();
    if (toolKeys[k]) {
      setTool(toolKeys[k]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      state.spacePanning = false;
      updateCursorForTool();
    }
  });

  // =========================================================================
  // Resize & Animation Loop
  // =========================================================================
  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    canvasW = Math.max(100, rect.width);
    canvasH = Math.max(100, rect.height);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvasW * dpr);
    canvas.height = Math.round(canvasH * dpr);
    requestRender();
  }

  function loop(ts) {
    if (state.rangePreview.active && state.rangePreview.playing) {
      if (state.rangePreview.lastTs) {
        const dt = Math.min(0.05, (ts - state.rangePreview.lastTs) / 1000);
        if (ts >= state.rangePreview.pauseUntil) {
          let nextD = state.rangePreview.distance + state.rangePreview.playDir * 550 * dt;
          if (nextD >= state.rangePreview.maxDistance) {
            nextD = state.rangePreview.maxDistance;
            state.rangePreview.playDir = -1;
            state.rangePreview.pauseUntil = ts + 500;
          } else if (nextD <= 0) {
            nextD = 0;
            state.rangePreview.playDir = 1;
            state.rangePreview.pauseUntil = ts + 500;
          }
          state.rangePreview.distance = nextD;
          updatePreviewReadouts();
          needsRender = true;
        }
      }
      state.rangePreview.lastTs = ts;
    } else {
      state.rangePreview.lastTs = 0;
    }

    if (state.hudSim.active) {
      const elapsed = (ts - state.hudSim.startTs) / 1000;
      if (elapsed >= state.hudSim.reloadDuration + 0.6) {
        state.hudSim.active = false;
        $('btnRangeSimHud')?.classList.remove('active');
      }
      needsRender = true;
    }

    if (needsRender) render();
    requestAnimationFrame(loop);
  }

  // =========================================================================
  // Boot
  // =========================================================================
  syncThemeColorsFromCss();
  initUI();
  initRadialAndPreviewControls();
  initHudPresetControls();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('load', resizeCanvas);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeCanvas).observe(stage);
  }
  setTool('select');

  const initialNames = naturalSortNames(Object.keys(state.sightsCatalog));
  if (initialNames.length > 0) {
    const firstKey = state.sightsCatalog['3.blk'] ? '3.blk' : initialNames[0];
    $('presetSelect').value = firstKey;
    loadBlkDocument(state.sightsCatalog[firstKey], firstKey, false);
  } else {
    resetHistory();
    fitView();
  }

  requestAnimationFrame(loop);
})();
