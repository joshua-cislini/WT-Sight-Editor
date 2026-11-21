/**
 * WT Reticle Studio Pro - Interactive Vector & Art Editor for War Thunder .blk Custom Sights
 */
(function () {
  'use strict';

  const MIL_TO_UNIT = 0.0025;
  const BASE_SCALE = 700;
  const MAX_HISTORY = 50;
  const WT_RECOMMENDED_LIMIT = 8000;

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
    previewMode: 'day', // 'day' | 'light' | 'thermal' | 'nvg' | 'blueprint'
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
      exportBase: true,
      overlayMode: 'append', // 'append' | 'replace'
      gridStep: 0.025,
      defaultMove: false,
      defaultThousandth: false,
      defaultMoveRadial: false,
      brushMode: 'lines', // 'lines' | 'quadRibbon' | 'closedFill'
      simplifyTol: 0.0012,
      brushWidth: 0.004,
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

    tracePreview: {
      lines: [],
      quads: [],
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

  function cloneDocDrawState(doc) {
    const h = doc.header || {};
    return {
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
      header: {
        ...h,
        crosshairColor: { ...h.crosshairColor },
        crosshairLightColor: { ...h.crosshairLightColor },
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
    state.doc.lines = cloned.lines;
    state.doc.quads = cloned.quads;
    state.doc.circles = cloned.circles;
    state.doc.texts = cloned.texts;
    state.doc.distances = cloned.distances;
    state.doc.ballistics = cloned.ballistics;
    state.doc.header = cloned.header;
    state.doc.modifiedHeaderKeys = cloned.modifiedHeaderKeys;
    const validIds = new Set(allShapes().map((s) => s.item.id));
    for (const id of Array.from(state.selection)) {
      if (!validIds.has(id)) state.selection.delete(id);
    }
    syncHeaderUIFromDoc();
    syncRadialPanelUIFromDoc();
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
   * Catmull-Rom Spline interpolation through control points.
   */
  function evaluateCatmullRomSpline(ctrlPts, segsPerSpan = 12) {
    if (ctrlPts.length < 2) return ctrlPts.slice();
    if (ctrlPts.length === 2) return ctrlPts.slice();
    const out = [];
    const n = ctrlPts.length;

    for (let i = 0; i < n - 1; i++) {
      const p0 = ctrlPts[Math.max(0, i - 1)];
      const p1 = ctrlPts[i];
      const p2 = ctrlPts[i + 1];
      const p3 = ctrlPts[Math.min(n - 1, i + 2)];

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
    out.push(ctrlPts[n - 1]);
    return out;
  }

  function triangulatePolygon(pts) {
    if (pts.length < 3) return [];
    if (pts.length === 3) return [[pts[0], pts[1], pts[2]]];

    const poly = pts.map((p) => ({ x: p.x, y: p.y }));
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) poly.reverse();

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
    while (poly.length > 3 && guard++ < 600) {
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
      if (!earFound) break;
    }
    if (poly.length === 3) {
      tris.push([poly[0], poly[1], poly[2]]);
    }
    return tris;
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

  function addLineSymmetric(x1, y1, x2, y2, layer = 'draw') {
    const th = state.options.defaultThousandth;
    const mv = state.options.defaultMove;
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
    const mv = state.options.defaultMove;
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

  function addPolylineSymmetric(pts, mode = 'lines', width = 0.004, layer = 'draw') {
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
      return;
    }

    const halfW = width / 2;
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < pts.length; i++) {
      let nx = 0, ny = 0;
      if (i === 0) {
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        const len = Math.hypot(dx, dy) || 1;
        nx = -dy / len; ny = dx / len;
      } else if (i === pts.length - 1) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        const len = Math.hypot(dx, dy) || 1;
        nx = -dy / len; ny = dx / len;
      } else {
        const dx1 = pts[i].x - pts[i - 1].x, dy1 = pts[i].y - pts[i - 1].y;
        const l1 = Math.hypot(dx1, dy1) || 1;
        const dx2 = pts[i + 1].x - pts[i].x, dy2 = pts[i + 1].y - pts[i].y;
        const l2 = Math.hypot(dx2, dy2) || 1;
        const n1x = -dy1 / l1, n1y = dx1 / l1;
        const n2x = -dy2 / l2, n2y = dx2 / l2;
        nx = n1x + n2x; ny = n1y + n2y;
        const nl = Math.hypot(nx, ny);
        if (nl < 1e-5) {
          nx = n1x; ny = n1y;
        } else {
          nx /= nl; ny /= nl;
          const dot = Math.max(0.45, nx * n1x + ny * n1y);
          nx /= dot; ny /= dot;
        }
      }
      leftPts.push({ x: pts[i].x + nx * halfW, y: pts[i].y + ny * halfW });
      rightPts.push({ x: pts[i].x - nx * halfW, y: pts[i].y - ny * halfW });
    }

    for (let i = 0; i < pts.length - 1; i++) {
      addQuadSymmetric(leftPts[i], leftPts[i + 1], rightPts[i + 1], rightPts[i], layer);
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
    const tris = triangulatePolygon(pts);
    for (const tri of tris) {
      addQuadSymmetric(tri[0], tri[1], tri[2], tri[2], layer);
    }
  }

  function addCircleSymmetric(cx, cy, radius) {
    const mode = state.options.shapeMode;
    const segs = Math.max(6, Math.min(180, Math.round(state.options.circleSegs || 36)));
    const aStart = state.options.arcStart || 0;
    const aEnd = state.options.arcEnd ?? 360;
    const th = state.options.defaultThousandth;
    const mv = state.options.defaultMove;

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

  function convertSelectedLinesToQuads() {
    const selLines = state.doc.lines.filter((l) => state.selection.has(l.id) && !isLayerLocked(l.layer));
    if (selLines.length === 0) {
      showToast('Select one or more lines first', 'warn');
      return;
    }
    const halfW = (state.options.brushWidth || 0.004) / 2;
    const removeIds = new Set(selLines.map((l) => l.id));
    const newIds = new Set();

    for (const l of selLines) {
      const th = !!l.thousandth;
      const w = fromCanvasUnit(halfW, th);
      const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * w, ny = (dx / len) * w;
      const q = {
        ...cloneItemArrayProps(l),
        id: BlkParser.nextId('quad'),
        layer: l.layer,
        tl: { x: l.x1 + nx, y: l.y1 + ny },
        tr: { x: l.x2 + nx, y: l.y2 + ny },
        br: { x: l.x2 - nx, y: l.y2 - ny },
        bl: { x: l.x1 - nx, y: l.y1 - ny },
        move: l.move,
        thousandth: l.thousandth
      };
      delete q.x1; delete q.y1; delete q.x2; delete q.y2;
      state.doc.quads.push(q);
      newIds.add(q.id);
    }

    state.doc.lines = state.doc.lines.filter((l) => !removeIds.has(l.id));
    for (const id of removeIds) state.selection.delete(id);
    for (const id of newIds) state.selection.add(id);
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Converted ${selLines.length} line(s) to filled quads`);
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
      state.cam.scale = Math.min(canvasW, canvasH) * 0.85;
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
    if (mode === 'blueprint') {
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
      return {
        bgOuter: '#050608',
        bgScope: '#22262b',
        bgScopeEdge: '#121519',
        reticle: 'rgba(242, 248, 255, 0.96)',
        glow: 'rgba(200, 230, 255, 0.35)',
        grid: 'rgba(255, 255, 255, 0.06)',
        axis: 'rgba(220, 240, 255, 0.25)',
        crosshair: 'rgba(242, 248, 255, 0.9)'
      };
    }
    if (mode === 'nvg') {
      return {
        bgOuter: '#030804',
        bgScope: '#0b2411',
        bgScopeEdge: '#041207',
        reticle: 'rgba(110, 255, 145, 0.95)',
        glow: 'rgba(74, 222, 128, 0.5)',
        grid: 'rgba(74, 222, 128, 0.07)',
        axis: 'rgba(74, 222, 128, 0.25)',
        crosshair: 'rgba(110, 255, 145, 0.9)'
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

      // Live Auto-Trace Preview Overlay
      if ($('chkTraceLivePreview').checked && (state.tracePreview.lines.length > 0 || state.tracePreview.quads.length > 0)) {
        ctx.save();
        if (state.tracePreview.quads.length > 0) {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
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
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          for (const l of state.tracePreview.lines) {
            const a = worldToScreen(l.x1, l.y1);
            const b = worldToScreen(l.x2, l.y2);
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 3. Coordinate Grid & Symmetry Axes
    if (state.options.showGrid) {
      drawGrid(theme);
    }
    drawSymmetryGuides();

    // 4. Built-in War Thunder Central Lines & Range Ticks
    drawCentralSightOverlay(theme);

    // 5. Batched Render of Vector Elements (Quads -> Lines -> Circles -> Texts)
    const baseLineWidth = Math.max(1.1, (state.doc.header.lineSizeMult || 1) * 1.4);
    const totalCount = state.doc.lines.length + state.doc.quads.length;

    if (theme.glow && totalCount < 6000) {
      ctx.shadowColor = theme.glow;
      ctx.shadowBlur = 7;
    } else {
      ctx.shadowBlur = 0;
    }

    const colorByLayer = state.options.colorLayers;
    const layerStyle = (layer) => {
      if (!colorByLayer) return theme.reticle;
      return layer === 'base' ? '#38bdf8' : '#34d399';
    };

    // --- Batch Quads (Zero object allocation fast path for static, radial-aware transform when needed) ---
    const layerOrder = colorByLayer ? ['base', 'draw'] : ['all'];
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

    for (const grp of layerOrder) {
      ctx.fillStyle = grp === 'all' ? theme.reticle : layerStyle(grp);
      ctx.beginPath();
      let hasAny = false;
      for (let i = 0, len = state.doc.quads.length; i < len; i++) {
        const q = state.doc.quads[i];
        if (!isLayerVisible(q.layer)) continue;
        if (grp !== 'all' && q.layer !== grp) continue;
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

    for (const grp of layerOrder) {
      ctx.strokeStyle = grp === 'all' ? theme.reticle : layerStyle(grp);
      ctx.lineWidth = baseLineWidth;
      ctx.beginPath();
      let hasAny = false;
      for (let i = 0, len = state.doc.lines.length; i < len; i++) {
        const l = state.doc.lines[i];
        if (!isLayerVisible(l.layer)) continue;
        if (grp !== 'all' && l.layer !== grp) continue;
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
      ctx.strokeStyle = isSel ? '#f59e0b' : layerStyle(c.layer);
      ctx.lineWidth = Math.max(1, (c.size || 1.5) * (state.doc.header.lineSizeMult || 1));
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
      const fontPx = Math.max(9, 13 * (t.size || 1) * (state.doc.header.fontSizeMult || 1) * (state.cam.scale / BASE_SCALE));
      const isSel = state.selection.has(t.id);

      ctx.font = `600 ${fontPx}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = t.align === 1 ? 'left' : t.align === -1 ? 'right' : 'center';
      ctx.fillStyle = isSel ? '#f59e0b' : layerStyle(t.layer);
      ctx.fillText(t.text || '', pos.x, pos.y);
    }

    ctx.shadowBlur = 0;

    // 6. Selection Bounding Box & Handles
    renderSelectionOverlay();

    // 7. Live Tool Preview & Cursor Guides
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

  function drawSingleBallisticScale(cfg, theme, activeMilScale, previewGunDropMrad, isMainScale = false) {
    const h = state.doc.header;
    const distances = cfg.distances || [];
    if (distances.length === 0) return;

    const speed = cfg.speed || state.rangePreview.speed || 935;
    const dragK = inferDragK(cfg.bulletType, speed);
    const stretch = (cfg.radialStretch ?? 1) * (cfg.distanceStretch ?? 1);

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
      const fontMult = cfg.fontSizeMult || h.fontSizeMult || 1;
      const fontPx = Math.max(8, 12.5 * fontMult * (state.cam.scale / BASE_SCALE));
      const lineW = Math.max(1.1, (h.lineSizeMult || 1) * 1.4);

      ctx.save();
      ctx.strokeStyle = theme.reticle;
      ctx.fillStyle = theme.reticle;
      ctx.lineWidth = lineW;
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
    const origin = worldToScreen(0, 0);
    const mainSize = ((cfg.crosshairDistHorSizeMain?.[0] || h.crosshairDistHorSizeMain?.[0] || 0.03)) * state.cam.scale;
    const addSize = ((cfg.crosshairDistHorSizeAdditional?.[0] || h.crosshairDistHorSizeAdditional?.[0] || 0.005)) * state.cam.scale;
    const signY = h.applyCorrectionToGun === false ? 1 : -1;
    const gunShiftCanvas = previewGunDropMrad * activeMilScale * signY;
    const dStretch = cfg.distanceStretch ?? 1;

    ctx.save();
    ctx.strokeStyle = theme.crosshair;
    ctx.fillStyle = theme.crosshair;
    ctx.lineWidth = Math.max(1, (h.lineSizeMult || 1) * 1.1);
    ctx.font = `600 10px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const d of distances) {
      const dropY = (computeBallisticDropMrad(d.dist, speed, dragK) * activeMilScale * dStretch) + gunShiftCanvas;
      const p = worldToScreen(cfg.distancePos?.[0] || 0, dropY + (cfg.distancePos?.[1] || 0));
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
        const fontPx = Math.max(10, 13 * (h.fontSizeMult || 1) * (state.cam.scale / BASE_SCALE));
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
      ctx.save();
      ctx.strokeStyle = theme.crosshair;
      ctx.fillStyle = theme.crosshair;
      ctx.lineWidth = Math.max(1, (h.lineSizeMult || 1) * 1.1);

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
    }

    if ((state.tool === 'polyline' || state.tool === 'polygon' || state.tool === 'spline') && state.polyPoints.length > 0) {
      const rawPts = state.polyPoints.concat([{ x: state.pointer.snappedX, y: state.pointer.snappedY }]);
      const previewPts = state.tool === 'spline'
        ? evaluateCatmullRomSpline(rawPts, state.options.splineSegs)
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
        ctx.arc(sp.x, sp.y, i === 0 ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 && state.tool === 'polygon' ? '#f59e0b' : '#34d399';
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

  function finishPoly(commit) {
    if (commit && state.polyPoints.length >= 2) {
      if (state.tool === 'polyline') {
        addPolylineSymmetric(state.polyPoints, 'lines', state.options.brushWidth, 'draw');
        pushHistory();
      } else if (state.tool === 'spline') {
        const curvePts = evaluateCatmullRomSpline(state.polyPoints, state.options.splineSegs);
        addPolylineSymmetric(curvePts, state.options.splineMode, state.options.brushWidth, 'draw');
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

    // Reset rangefinder simulation back to 0m before committing edits so coordinates remain unskewed
    if (state.rangePreview.active && (state.rangePreview.distance > 0 || state.rangePreview.playing)) {
      state.rangePreview.playing = false;
      setPreviewDistance(0);
      syncRangePreviewUI();
      showToast('Range Preview reset to 0 m for editing', 'warn');
    }

    const wx = state.pointer.worldX;
    const wy = state.pointer.worldY;
    const px = state.pointer.snappedX;
    const py = state.pointer.snappedY;

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
      case 'spline': {
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
          points: [{ x: wx, y: wy }]
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
        const refH = getRefImageHandleAtScreen(sx, sy);
        if (refH) {
          canvas.style.cursor = refH.type === 'ref-move' ? 'move' : 'pointer';
        } else if (state.tool === 'select') {
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
        if (Math.hypot(wx - last.x, wy - last.y) >= minStep) {
          pts.push({ x: wx, y: wy });
          requestRender();
        }
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

    if (d.type === 'move' || d.type === 'vertex' || d.type === 'rotate' || d.type === 'scale') {
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
    } else if (d.type === 'freehand') {
      if (d.points.length >= 2) {
        const simplified = rdpSimplify(d.points, state.options.simplifyTol);
        if (simplified.length >= 2) {
          addPolylineSymmetric(simplified, state.options.brushMode, state.options.brushWidth, 'draw');
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
  // Studio-Grade Sub-Pixel Multi-Mode Auto-Draw Vectorizer
  // =========================================================================
  function smoothPixelChainSubpixel(chain, passes = 2) {
    if (chain.length <= 2) return chain;
    let pts = chain.map((p) => ({ x: p.x, y: p.y }));
    const isClosed = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1.5 && pts.length > 4;

    for (let pass = 0; pass < passes; pass++) {
      const next = pts.map((p) => ({ x: p.x, y: p.y }));
      for (let i = 1; i < pts.length - 1; i++) {
        // Corner preservation: if vertex turns sharply (> 42 deg), keep corner crisp
        const dx1 = pts[i].x - pts[i - 1].x, dy1 = pts[i].y - pts[i - 1].y;
        const dx2 = pts[i + 1].x - pts[i].x, dy2 = pts[i + 1].y - pts[i].y;
        const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
        const cosA = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
        if (cosA < 0.35) continue;
        next[i].x = 0.25 * pts[i - 1].x + 0.5 * pts[i].x + 0.25 * pts[i + 1].x;
        next[i].y = 0.25 * pts[i - 1].y + 0.5 * pts[i].y + 0.25 * pts[i + 1].y;
      }
      if (isClosed) {
        next[0].x = 0.25 * pts[pts.length - 2].x + 0.5 * pts[0].x + 0.25 * pts[1].x;
        next[0].y = 0.25 * pts[pts.length - 2].y + 0.5 * pts[0].y + 0.25 * pts[1].y;
        next[pts.length - 1].x = next[0].x;
        next[pts.length - 1].y = next[0].y;
      }
      pts = next;
    }
    return pts;
  }

  function computeImageVectorTrace() {
    const r = state.refImage;
    if (!r.img) return { lines: [], quads: [] };

    const mode = $('selTraceMode').value; // 'centerline' | 'marching' | 'canny' | 'hybrid'
    const sens = parseFloat($('rngTraceSens').value) || 72; // 5..99
    const contrastBoost = parseFloat($('rngTraceContrast').value) || 1.6; // 1..4
    const maxDim = parseInt($('rngTraceRes').value, 10) || 640;
    const simplifyPx = parseFloat($('rngTraceSimplify').value) || 0.65;
    const minChainLen = parseInt($('rngTraceMinLen').value, 10) || 3;
    const strokeOutput = $('selTraceOutput')?.value || 'lines'; // 'lines' | 'quadRibbon'
    const invert = $('chkTraceInvert').checked;

    const aspect = r.img.width / (r.img.height || 1);
    let w, h;
    if (r.img.width >= r.img.height) {
      w = Math.min(maxDim, Math.max(32, r.img.width));
      h = Math.max(16, Math.round(w / aspect));
    } else {
      h = Math.min(maxDim, Math.max(32, r.img.height));
      w = Math.max(16, Math.round(h * aspect));
    }

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(r.img, 0, 0, w, h);
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
      // Blend with darkest RGB channel so colored strokes (like red cheek blush) are detected cleanly
      const chromaDark = invert ? Math.max(rC, gC, bC) : Math.min(rC, gC, bC);
      let l = 0.5 * stdLum + 0.5 * chromaDark;
      if (invert) l = 255 - l;
      rawLum[i] = l;
      sumLum += l;
      hist[Math.max(0, Math.min(255, Math.round(l)))]++;
    }

    const meanLum = sumLum / (N || 1);

    // Otsu's Automatic Optimal Global Threshold + Background Peak Detection
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

    // Contrast boost + 3x3 Gaussian smoothing
    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const boosted = (rawLum[i] - meanLum) * contrastBoost + meanLum;
      lum[i] = Math.max(0, Math.min(255, boosted));
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

    // Background-Only 2D Integral Image: excludes dark foreground pixels (< otsuThresh)
    // so thick dark areas (like solid black eyes) NEVER drag down the local background estimate
    // or cause threshold indentations around/inside the eyes!
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

    const worldH = r.scale;
    const worldW = worldH * aspect;
    const rotRad = (r.rotation * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);

    function pixelToWorld(px, py) {
      const lx = (px / w - 0.5) * worldW;
      const ly = (py / h - 0.5) * worldH;
      return {
        x: r.x + lx * cosR - ly * sinR,
        y: r.y + lx * sinR + ly * cosR
      };
    }

    const outLines = [];
    const outQuads = [];

    function emitWorldPolyline(worldPts) {
      if (worldPts.length < 2) return;
      if (strokeOutput === 'quadRibbon') {
        const halfW = (state.options.brushWidth || 0.004) / 2;
        for (let i = 0; i < worldPts.length - 1; i++) {
          const a = worldPts[i], b = worldPts[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          const nx = (-dy / len) * halfW, ny = (dx / len) * halfW;
          outQuads.push({
            tl: { x: a.x + nx, y: a.y + ny },
            tr: { x: b.x + nx, y: b.y + ny },
            br: { x: b.x - nx, y: b.y - ny },
            bl: { x: a.x - nx, y: a.y - ny }
          });
        }
      } else {
        for (let i = 0; i < worldPts.length - 1; i++) {
          const a = worldPts[i], b = worldPts[i + 1];
          if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
          outLines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }
    }

    // -----------------------------------------------------------------------
    // MODE A: Sub-Pixel Marching Squares Contour Vectorizer ('marching')
    // -----------------------------------------------------------------------
    if (mode === 'marching') {
      const field = new Float32Array(N);
      const winRad = Math.max(12, Math.round(Math.min(w, h) / 20));
      const localMargin = Math.max(4, 68 * Math.pow(1 - sens / 100, 1.35));

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (alpha[i] < 40) {
            field[i] = -50;
            continue;
          }
          const bgLevel = getLocalBgLevel(x, y, winRad);
          const cut = bgLevel - localMargin;
          field[i] = cut - smooth[i];
        }
      }

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
        const k = `${Math.round(px * 50)},${Math.round(py * 50)}`;
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
        return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
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
        if (chain.length >= Math.max(2, minChainLen)) {
          const smoothed = smoothPixelChainSubpixel(chain, 1);
          const simp = rdpSimplify(smoothed, simplifyPx);
          emitWorldPolyline(simp.map((p) => pixelToWorld(p.x, p.y)));
        }
      }

      return { lines: outLines, quads: outQuads };
    }

    // -----------------------------------------------------------------------
    // MODE B, C, D: Smart Line Art (Centerline + Solid Shape Outer Borders) / Canny / Hybrid
    // -----------------------------------------------------------------------
    const edges = new Uint8Array(N);

    if (mode === 'centerline') {
      // 1. Background-Envelope Thresholding (never indents near or inside dark eyes!)
      const bin = new Uint8Array(N);
      const winRad = Math.max(12, Math.round(Math.min(w, h) / 20));
      const localMargin = Math.max(4, 68 * Math.pow(1 - sens / 100, 1.35));

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (alpha[i] < 35) continue;
          const bgLevel = getLocalBgLevel(x, y, winRad);
          if (smooth[i] < bgLevel - localMargin) {
            bin[i] = 1;
          }
        }
      }

      // Close 1-pixel micro-gaps
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!bin[i]) {
            if ((bin[i - 1] && bin[i + 1]) || (bin[i - w] && bin[i + w])) bin[i] = 1;
          }
        }
      }

      // 2. Chamfer Distance Transform on `bin` to distinguish Thin Strokes vs. Solid Filled Shapes (like dark eyes!)
      const dist = new Uint16Array(N);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!bin[i]) continue;
          const dTop = dist[i - w], dLeft = dist[i - 1];
          dist[i] = (dTop < dLeft ? dTop : dLeft) + 1;
        }
      }
      for (let y = h - 2; y >= 1; y--) {
        for (let x = w - 2; x >= 1; x--) {
          const i = y * w + x;
          if (!bin[i]) continue;
          const dBot = dist[i + w] + 1;
          const dRight = dist[i + 1] + 1;
          let m = dist[i];
          if (dBot < m) m = dBot;
          if (dRight < m) m = dRight;
          dist[i] = m;
        }
      }

      // Separable 2-pass Max Filter (radius = 6) on `dist` to identify pixels belonging to thick filled shapes
      const strokeHalfLimit = Math.max(4, Math.round(Math.min(w, h) / 110)); // ~5px at 640px res
      const rowMax = new Uint16Array(N);
      const localMaxDist = new Uint16Array(N);
      const mRad = strokeHalfLimit + 2;

      for (let y = 1; y < h - 1; y++) {
        const rowOff = y * w;
        for (let x = 1; x < w - 1; x++) {
          let mx = 0;
          const x0 = Math.max(0, x - mRad), x1 = Math.min(w - 1, x + mRad);
          for (let k = x0; k <= x1; k++) {
            const v = dist[rowOff + k];
            if (v > mx) mx = v;
          }
          rowMax[rowOff + x] = mx;
        }
      }
      for (let y = 1; y < h - 1; y++) {
        const y0 = Math.max(0, y - mRad), y1 = Math.min(h - 1, y + mRad);
        for (let x = 1; x < w - 1; x++) {
          let mx = 0;
          for (let k = y0; k <= y1; k++) {
            const v = rowMax[k * w + x];
            if (v > mx) mx = v;
          }
          localMaxDist[y * w + x] = mx;
        }
      }

      // For thick filled shapes (localMaxDist > strokeHalfLimit, e.g., solid black eye pupils):
      // Pin their exact outer border (dist === 1) and hollow out their deep interior (dist >= 2)
      // so the trace follows the EXACT outer border of the eye with zero indentation!
      const pinnedBorder = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (!bin[i]) continue;
        if (localMaxDist[i] > strokeHalfLimit) {
          if (dist[i] === 1) {
            pinnedBorder[i] = 1;
          } else {
            bin[i] = 0;
          }
        }
      }

      // 3. Full Zhang-Suen Thinning on line strokes (never erodes pinnedBorder outer contours of solid shapes!)
      const toClear = [];
      for (let iter = 0; iter < 64; iter++) {
        let changed = false;
        for (let step = 0; step < 2; step++) {
          toClear.length = 0;
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const i = y * w + x;
              if (!bin[i] || pinnedBorder[i]) continue;
              const p2 = bin[i - w], p3 = bin[i - w + 1], p4 = bin[i + 1], p5 = bin[i + w + 1];
              const p6 = bin[i + w], p7 = bin[i + w - 1], p8 = bin[i - 1], p9 = bin[i - w - 1];
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
            for (let k = 0; k < toClear.length; k++) bin[toClear[k]] = 0;
          }
        }
        if (!changed) break;
      }

      edges.set(bin);
    } else {
      // Canny Edge Detection ('canny' and 'hybrid')
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
          const m = Math.max(mL, mA);
          mag[i] = m;

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
          let n1 = 0, n2 = 0;
          if (d === 0) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
          else if (d === 1) { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
          else if (d === 2) { n1 = mag[i - w]; n2 = mag[i + w]; }
          else { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }

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

      if (mode === 'hybrid') {
        const winRad = Math.max(12, Math.round(Math.min(w, h) / 20));
        const localBias = Math.max(5, 58 * Math.pow(1 - sens / 100, 1.35));
        const rowStep = Math.max(2, Math.round(h / 150));
        for (let y = 1; y < h - 1; y += rowStep) {
          let runStart = -1;
          for (let x = 1; x < w; x++) {
            const i = y * w + x;
            const bgLevel = x < w - 1 ? getLocalBgLevel(x, y, winRad) : 255;
            const isDark = x < w - 1 && alpha[i] >= 40 && smooth[i] < bgLevel - localBias;
            if (isDark && runStart === -1) {
              runStart = x;
            } else if (!isDark && runStart !== -1) {
              if (x - runStart >= 2) {
                const tl = pixelToWorld(runStart, y);
                const tr = pixelToWorld(x, y);
                const br = pixelToWorld(x, y + rowStep * 0.95);
                const bl = pixelToWorld(runStart, y + rowStep * 0.95);
                outQuads.push({ tl, tr, br, bl });
              }
              runStart = -1;
            }
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // 2x2 L-Staircase Pruning (removes redundant corner pixels on diagonals)
    // -----------------------------------------------------------------------
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!edges[i]) continue;
        const p2 = edges[i - w], p4 = edges[i + 1], p6 = edges[i + w], p8 = edges[i - 1];
        const p3 = edges[i - w + 1], p5 = edges[i + w + 1], p7 = edges[i + w - 1], p9 = edges[i - w - 1];
        if ((p2 && p4 && !p7 && !p8 && !p6) ||
            (p4 && p6 && !p9 && !p2 && !p8) ||
            (p6 && p8 && !p3 && !p2 && !p4) ||
            (p8 && p2 && !p5 && !p4 && !p6)) {
          edges[i] = 0;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Endpoint-First & Tangent-Guided Graph Chainer
    // -----------------------------------------------------------------------
    const dirs = [
      [1, 0], [0, 1], [-1, 0], [0, -1], // Cardinals first
      [1, 1], [-1, 1], [-1, -1], [1, -1] // Diagonals second
    ];

    const degree = new Uint8Array(N);
    const startCandidates = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!edges[i]) continue;
        let deg = 0;
        for (const [dx, dy] of dirs) {
          if (edges[(y + dy) * w + (x + dx)]) deg++;
        }
        degree[i] = deg;
        if (deg === 1 || deg >= 3) {
          startCandidates.push({ x, y, deg });
        }
      }
    }
    // Sort so degree-1 endpoints trace before degree-3 junctions
    startCandidates.sort((a, b) => a.deg - b.deg);

    const visited = new Uint8Array(N);

    function traceChainFrom(startX, startY) {
      const chain = [];
      let cx = startX, cy = startY;
      let dirX = 0, dirY = 0;

      while (true) {
        const ci = cy * w + cx;
        visited[ci] = 1;
        chain.push({ x: cx, y: cy });

        let bestNx = -1, bestNy = -1;
        let bestScore = -Infinity;

        for (const [dx, dy] of dirs) {
          const nx = cx + dx, ny = cy + dy;
          if (nx <= 0 || nx >= w - 1 || ny <= 0 || ny >= h - 1) continue;
          const ni = ny * w + nx;
          if (!edges[ni] || visited[ni]) continue;

          const stepLen = Math.hypot(dx, dy);
          const ndx = dx / stepLen, ndy = dy / stepLen;
          // Prefer continuing straight along current tangent, and slight preference for orthogonal steps
          const align = (dirX === 0 && dirY === 0) ? 0.5 : (dirX * ndx + dirY * ndy);
          const score = align - (stepLen > 1.1 ? 0.08 : 0);
          if (score > bestScore) {
            bestScore = score;
            bestNx = nx;
            bestNy = ny;
          }
        }

        if (bestNx === -1) break;
        const stepDx = bestNx - cx, stepDy = bestNy - cy;
        const sl = Math.hypot(stepDx, stepDy) || 1;
        dirX = dirX * 0.45 + (stepDx / sl) * 0.55;
        dirY = dirY * 0.45 + (stepDy / sl) * 0.55;
        const dl = Math.hypot(dirX, dirY) || 1;
        dirX /= dl; dirY /= dl;
        cx = bestNx;
        cy = bestNy;
      }

      // Snap chain endpoints to neighboring junction pixels if adjacent so T-junctions connect cleanly
      if (chain.length >= 2) {
        const tail = chain[chain.length - 1];
        const prev = chain[chain.length - 2];
        for (const [dx, dy] of dirs) {
          const nx = tail.x + dx, ny = tail.y + dy;
          const ni = ny * w + nx;
          if (edges[ni] && degree[ni] >= 3 && !(nx === prev.x && ny === prev.y)) {
            chain.push({ x: nx, y: ny });
            break;
          }
        }
      }

      if (chain.length >= Math.max(2, minChainLen)) {
        const smoothed = smoothPixelChainSubpixel(chain, 2);
        const simp = rdpSimplify(smoothed, simplifyPx);
        emitWorldPolyline(simp.map((p) => pixelToWorld(p.x, p.y)));
      }
    }

    // 1. Trace open strokes from endpoints & junctions first
    for (const c of startCandidates) {
      if (!visited[c.y * w + c.x]) {
        traceChainFrom(c.x, c.y);
      }
    }

    // 2. Trace remaining closed loops (circles, ovals, closed contours)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (edges[i] && !visited[i] && degree[i] > 0) {
          traceChainFrom(x, y);
        }
      }
    }

    return { lines: outLines, quads: outQuads };
  }

  function scheduleLiveTracePreview() {
    if (!state.refImage.img) return;
    if (state.tracePreview.timer) clearTimeout(state.tracePreview.timer);
    state.tracePreview.timer = setTimeout(() => {
      const res = computeImageVectorTrace();
      state.tracePreview.lines = res.lines;
      state.tracePreview.quads = res.quads;
      const qTxt = res.quads.length > 0 ? ` + ${res.quads.length}Q` : '';
      $('tracePreviewStats').textContent = `${res.lines.length}L${qTxt}`;
      requestRender();
    }, 40);
  }

  function commitAutoTraceToDocument() {
    if (!state.refImage.img) return;
    const res = computeImageVectorTrace();
    if (res.lines.length === 0 && res.quads.length === 0) {
      showToast('No strokes detected. Try raising Sensitivity or toggling Invert B/W', 'warn');
      return;
    }

    if ($('chkTraceReplace').checked && state.lastTraceIds.size > 0) {
      state.doc.lines = state.doc.lines.filter((l) => !state.lastTraceIds.has(l.id));
      state.doc.quads = state.doc.quads.filter((q) => !state.lastTraceIds.has(q.id));
      state.lastTraceIds.clear();
    }

    const targetLayer = $('selTraceLayer').value || 'draw';
    const th = state.options.defaultThousandth;
    const mv = state.options.defaultMove;
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
        thousandth: th
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
        thousandth: th
      });
    }

    state.lastTraceIds = newBatchIds;
    $('btnUndoTrace').disabled = false;
    $('chkTraceLivePreview').checked = false;
    pushHistory();
    requestRender();
    showToast(`Auto-drew ${res.lines.length} lines${res.quads.length ? ` & ${res.quads.length} quads` : ''} into ${targetLayer === 'base' ? 'Base' : 'Drawn'} layer`);
  }

  function undoLastAutoTrace() {
    if (state.lastTraceIds.size === 0) return;
    const removedCount = state.lastTraceIds.size;
    state.doc.lines = state.doc.lines.filter((l) => !state.lastTraceIds.has(l.id));
    state.doc.quads = state.doc.quads.filter((q) => !state.lastTraceIds.has(q.id));
    for (const id of state.lastTraceIds) state.selection.delete(id);
    state.lastTraceIds.clear();
    $('btnUndoTrace').disabled = true;
    pushHistory();
    updateSelectionUI();
    requestRender();
    showToast(`Removed ${removedCount} auto-drawn element(s)`);
  }

  /**
   * Generate a clean procedural lineart test drawing in memory so users can test Auto-Draw immediately.
   */
  function loadSampleLineart() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 512, 512);

    g.strokeStyle = '#111111';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Tactical winged emblem + anime-style character silhouette lineart
    g.beginPath();
    g.arc(256, 256, 170, 0, Math.PI * 2);
    g.stroke();

    // Inner diamond star
    g.beginPath();
    g.moveTo(256, 65);
    g.quadraticCurveTo(285, 225, 445, 256);
    g.quadraticCurveTo(285, 285, 256, 445);
    g.quadraticCurveTo(225, 285, 65, 256);
    g.quadraticCurveTo(225, 225, 256, 65);
    g.stroke();

    // Wing feathers left & right
    for (let k = 0; k < 4; k++) {
      const yOff = 155 + k * 42;
      const span = 195 - k * 24;
      g.beginPath();
      g.moveTo(210, yOff);
      g.quadraticCurveTo(256 - span * 0.6, yOff - 28, 256 - span, yOff + 10);
      g.moveTo(302, yOff);
      g.quadraticCurveTo(256 + span * 0.6, yOff - 28, 256 + span, yOff + 10);
      g.stroke();
    }

    // Center aiming reticle cross & circle
    g.beginPath();
    g.arc(256, 256, 48, 0, Math.PI * 2);
    g.stroke();

    const img = new Image();
    img.onload = () => {
      state.refImage.img = img;
      state.refImage.name = 'Sample_Lineart.png';
      state.refImage.visible = true;
      $('chkRefVis').checked = true;
      $('btnRefClear').disabled = false;
      $('btnAutoTrace').disabled = false;
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
      requestRender();
      showToast('Loaded Sample Lineart. Click "Auto-Draw Image → Reticle" or adjust Sensitivity!');
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
      const presetName = m && m[1] ? m[1].toUpperCase() : 'Standard HUD';
      return `${name} (Static Preset: ${presetName})`;
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
      showToast(`Discovered new sight(s) in sights/: ${added.join(', ')}`);
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
        showToast(`Linked '${dirHandle.name}/' folder. New .blk sights will appear automatically!`);
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
  function loadBlkDocument(blkText, name, asOverlay = false) {
    try {
      const parsed = BlkParser.parse(blkText, {
        defaultLayer: 'base',
        autoSynthesizeStatic: true
      });

      if (asOverlay) {
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
        syncHeaderUIFromDoc();
        syncRadialPanelUIFromDoc();
        autoConfigurePreviewForDoc();
        resetHistory();
        updateSelectionUI();
        fitView();
        $('activeFileName').textContent = name;
        const hasRad = docHasRadialFeatures();
        const staticMsg = parsed.hasSynthesizedStatic ? ' [Static Crosshair & HUD Synthesized]' : '';
        const radMsg = hasRad ? ' • Circular Rangefinder detected (try ◎ Range Preview!)' : '';
        showToast(`Loaded ${name} (${parsed.lines.length}L, ${parsed.quads.length}Q, ${parsed.circles.length}C, ${parsed.texts.length}T)${staticMsg}${radMsg}`);
      }
    } catch (err) {
      console.error(err);
      showToast(`Failed to parse ${name}: ${err.message}`, 'error');
    }
  }

  function loadReferenceImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        state.refImage.img = img;
        state.refImage.name = file.name;
        state.refImage.visible = true;
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

  async function saveBlkFile() {
    const content = BlkParser.serialize(state.doc, {
      excludeBaseLayer: !state.options.exportBase
    });
    const rawOutName = state.fileName.endsWith('.blk') ? state.fileName : `${state.fileName}.blk`;
    const outName = rawOutName.replace(/\s+/g, '_');

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
        state.sightsCatalog[handle.name] = content;
        rebuildPresetsDropdown(true);
        if (/\s/.test(handle.name)) {
          showToast(`Saved ${handle.name} (Warning: remove spaces from filename for War Thunder)`, 'warn');
        } else {
          showToast(`Saved ${handle.name} directly to disk`);
        }
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    downloadTextFile(outName, content);
    showToast(`Downloaded ${outName}`);
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
    URL.revokeObjectURL(url);
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
      polyline: 'Click consecutive vertices to draw connected lines • Double-click or press Enter to finish',
      spline: 'Click control points to draw a smooth Catmull-Rom curve • Double-click or press Enter to finish',
      freehand: 'Click & drag to draw freely • Choose Lines, Thick Quad Ribbon, or Filled Closed Shape',
      polygon: 'Click 3+ vertices to create filled quads/polygons • Click orange start dot, double-click, or Enter to fill',
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

    $('chkSelMove').checked = entries.every(({ item }) => !!item.move);
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
    $('colCrosshair').value = rgbToHex(h.crosshairColor.r, h.crosshairColor.g, h.crosshairColor.b);
    $('rngCrosshairAlpha').value = h.crosshairColor.a;
    $('colLight').value = rgbToHex(h.crosshairLightColor.r, h.crosshairLightColor.g, h.crosshairLightColor.b);
    $('rngLightAlpha').value = h.crosshairLightColor.a;
    const mc = h.matchExpClass || { exp_tank: true, exp_heavy_tank: true, exp_tank_destroyer: true, exp_SPAA: true };
    if ($('chkExpTank')) $('chkExpTank').checked = !!mc.exp_tank;
    if ($('chkExpHeavy')) $('chkExpHeavy').checked = !!mc.exp_heavy_tank;
    if ($('chkExpTD')) $('chkExpTD').checked = !!mc.exp_tank_destroyer;
    if ($('chkExpSPAA')) $('chkExpSPAA').checked = !!mc.exp_SPAA;
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
      $('activeFileName').textContent = state.fileName;
      syncHeaderUIFromDoc();
      syncRadialPanelUIFromDoc();
      autoConfigurePreviewForDoc();
      resetHistory();
      updateSelectionUI();
      centerOrigin();
      showToast('Created new blank custom sight');
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
    $('btnSaveBlk').addEventListener('click', saveBlkFile);

    // Preview mode buttons
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.previewMode = btn.dataset.mode.trim();
        document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
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
    $('chkColorLayers').addEventListener('change', (e) => { state.options.colorLayers = e.target.checked; requestRender(); });
    $('chkShowTicks').addEventListener('change', (e) => { state.options.showTicks = e.target.checked; requestRender(); });
    $('numGridStep').addEventListener('change', (e) => {
      state.options.gridStep = Math.max(0.0005, parseFloat(e.target.value) || 0.025);
      requestRender();
    });
    $('chkDefaultMove').addEventListener('change', (e) => { state.options.defaultMove = e.target.checked; });
    $('chkDefaultThousandth').addEventListener('change', (e) => { state.options.defaultThousandth = e.target.checked; });
    if ($('chkDefaultMoveRadial')) {
      $('chkDefaultMoveRadial').addEventListener('change', (e) => { state.options.defaultMoveRadial = e.target.checked; });
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
    $('rngBrushWidth').addEventListener('input', (e) => {
      state.options.brushWidth = parseFloat(e.target.value);
      $('lblBrushWidth').textContent = state.options.brushWidth.toFixed(4);
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
      state.tracePreview.lines = [];
      state.tracePreview.quads = [];
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
    $('selTraceMode').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
    });
    $('selTraceOutput').addEventListener('change', () => {
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
    $('chkTraceLivePreview').addEventListener('change', () => {
      if ($('chkTraceLivePreview').checked) scheduleLiveTracePreview();
      requestRender();
    });
    $('chkTraceInvert').addEventListener('change', () => {
      $('chkTraceLivePreview').checked = true;
      scheduleLiveTracePreview();
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
    $('btnOptimizeAll').addEventListener('click', () => {
      runGlobalOptimize(true, true);
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
    $('btnLinesToQuads').addEventListener('click', convertSelectedLinesToQuads);
    $('btnQuadsToLines').addEventListener('click', convertSelectedQuadsToLines);

    $('chkSelMove').addEventListener('change', (e) => {
      for (const { item } of getSelectedEntries()) item.move = e.target.checked;
      pushHistory();
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
    const updateColor = (key, hexEl, alphaEl) => {
      const rgb = hexToRgb($(hexEl).value);
      const a = parseInt($(alphaEl).value, 10);
      state.doc.header[key] = { r: rgb.r, g: rgb.g, b: rgb.b, a: Number.isFinite(a) ? a : 255 };
      state.doc.modifiedHeaderKeys.add(key);
      requestRender();
    };
    $('colCrosshair').addEventListener('input', () => updateColor('crosshairColor', 'colCrosshair', 'rngCrosshairAlpha'));
    $('rngCrosshairAlpha').addEventListener('input', () => updateColor('crosshairColor', 'colCrosshair', 'rngCrosshairAlpha'));
    $('colLight').addEventListener('input', () => updateColor('crosshairLightColor', 'colLight', 'rngLightAlpha'));
    $('rngLightAlpha').addEventListener('input', () => updateColor('crosshairLightColor', 'colLight', 'rngLightAlpha'));

    // Raw .blk Modal
    $('btnViewCode').addEventListener('click', () => {
      const text = BlkParser.serialize(state.doc, {
        excludeBaseLayer: !state.options.exportBase
      });
      $('rawBlkTextarea').value = text;
      const lineCount = text.split('\n').length;
      $('codeStats').textContent = `${lineCount} lines • ${(text.length / 1024).toFixed(1)} KB`;
      $('codeModal').hidden = false;
    });
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
      const rawOutName = state.fileName.endsWith('.blk') ? state.fileName : `${state.fileName}.blk`;
      const outName = rawOutName.replace(/\s+/g, '_');
      downloadTextFile(outName, $('rawBlkTextarea').value);
      showToast(`Downloaded ${outName}`);
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
      for (const { item } of getSelectedEntries()) {
        item.moveRadial = checked;
        if (checked && !Array.isArray(item.radialCenter)) item.radialCenter = [0, 0];
        if (checked && !Number.isFinite(item.radialAngle)) item.radialAngle = 0;
        if (checked && !Number.isFinite(item.radialMoveSpeed)) item.radialMoveSpeed = 1;
      }
      pushHistory();
      syncRadialPanelUIFromDoc();
      updateSelectionUI();
      requestRender();
    });

    $('btnSelRadApply')?.addEventListener('click', () => {
      const entries = getSelectedEntries();
      if (entries.length === 0) return;
      const cxStr = $('numSelRadCx')?.value.trim() ?? '';
      const cyStr = $('numSelRadCy')?.value.trim() ?? '';
      const angStr = $('numSelRadAngle')?.value.trim() ?? '';
      const spdStr = $('numSelRadSpeed')?.value.trim() ?? '';

      for (const { item } of entries) {
        if (isLayerLocked(item.layer)) continue;
        item.moveRadial = !!$('chkSelMoveRadial')?.checked;
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
        const curC = Array.isArray(item.radialCenter) ? item.radialCenter : [0, 0];
        const rcx = cxStr !== '' ? (parseFloat(cxStr) || 0) : curC[0];
        const rcy = cyStr !== '' ? (parseFloat(cyStr) || 0) : curC[1];
        item.radialCenter = [rcx, rcy];
        const th = !!item.thousandth;
        const ref = getElementBaseRefCanvas(kind, item, milScale);
        const r = Math.hypot(ref.x - toCanvasUnit(rcx, th, milScale), ref.y - toCanvasUnit(rcy, th, milScale));
        item.radialMoveSpeed = Number((mult * Math.max(0.01, r)).toFixed(6));
      }
      if ($('chkSelMoveRadial')) $('chkSelMoveRadial').checked = true;
      pushHistory();
      syncRadialPanelUIFromDoc();
      updateSelectionUI();
      requestRender();
      showToast(`Synced rigid radialMoveSpeed (${mult}×r) on ${entries.length} element(s)`);
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

    // Arrow key nudging
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && state.selection.size > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 0.02 : 0.0025;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      translateSelected(dx, dy);
      pushHistory();
      updateSelectionUI();
      requestRender();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
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

    if (needsRender) render();
    requestAnimationFrame(loop);
  }

  // =========================================================================
  // Boot
  // =========================================================================
  initUI();
  initRadialAndPreviewControls();
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
