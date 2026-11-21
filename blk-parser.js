/**
 * War Thunder .blk Custom Sight Parser, Static Geometry Synthesizer & Serializer
 * Supports classic custom sights (drawLines, drawQuads, drawCircles, drawTexts)
 * AND modern War Thunder Sight HUD Presets (crosshair:t="...", rangefinder, turret, fov, gunReady, bulletType),
 * automatically synthesizing static sight geometry so any sight or preset can be imported and drawn over.
 */
(function (global) {
  'use strict';

  let _nextId = 1;
  function nextId(prefix) {
    return `${prefix}_${_nextId++}`;
  }

  function formatNum(n) {
    if (!Number.isFinite(n)) return '0';
    const rounded = Math.round(n * 1e7) / 1e7;
    if (Object.is(rounded, -0) || rounded === 0) return '0';
    let s = rounded.toFixed(7);
    if (s.indexOf('.') !== -1) {
      s = s.replace(/\.?0+$/, '');
    }
    return s === '-0' ? '0' : s;
  }

  function parseBool(val) {
    if (typeof val === 'boolean') return val;
    const s = String(val).trim().toLowerCase();
    return s === 'yes' || s === 'true' || s === '1';
  }

  function parseNums(val) {
    return String(val)
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n));
  }

  function clampByte(n, fallback = 255) {
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(255, Math.round(n)));
  }

  function cloneColor(c, fallback = { r: 0, g: 0, b: 0, a: 255 }) {
    if (!c || typeof c !== 'object') return { ...fallback };
    return {
      r: clampByte(c.r, fallback.r),
      g: clampByte(c.g, fallback.g),
      b: clampByte(c.b, fallback.b),
      a: clampByte(c.a, fallback.a)
    };
  }

  function parseColor(rawValue, fallback = { r: 0, g: 0, b: 0, a: 255 }) {
    const nums = parseNums(rawValue);
    if (nums.length < 3) return cloneColor(fallback);
    return {
      r: clampByte(nums[0], fallback.r),
      g: clampByte(nums[1], fallback.g),
      b: clampByte(nums[2], fallback.b),
      a: nums.length >= 4 ? clampByte(nums[3], fallback.a) : 255
    };
  }

  function formatColor(c, fallback = { r: 0, g: 0, b: 0, a: 255 }) {
    const col = cloneColor(c, fallback);
    return `${col.r}, ${col.g}, ${col.b}, ${col.a}`;
  }

  function getCloseQuote(ch) {
    if (ch === '"') return '"';
    if (ch === "'") return "'";
    if (ch === '\u201C') return '\u201D';
    if (ch === '\u2018') return '\u2019';
    return null;
  }

  function unquote(val) {
    const s = String(val).trim();
    if (s.length >= 2) {
      const close = getCloseQuote(s[0]);
      if (close && (s.endsWith(close) || s.endsWith(s[0]))) {
        return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    return s;
  }

  function quoteStr(val) {
    const s = String(val ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${s}"`;
  }

  function findMatchingBrace(text, openBraceIdx) {
    let depth = 0;
    let inQuote = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = openBraceIdx; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inQuote) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === inQuote) inQuote = null;
        continue;
      }

      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      const closeQ = getCloseQuote(ch);
      if (closeQ) {
        inQuote = closeQ;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return text.length - 1;
  }

  function stripComments(text) {
    let out = '';
    let inQuote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inQuote) {
        out += ch;
        if (ch === '\\' && i + 1 < text.length) {
          out += text[++i];
          continue;
        }
        if (ch === inQuote) inQuote = null;
        continue;
      }
      const closeQ = getCloseQuote(ch);
      if (closeQ) {
        inQuote = closeQ;
        out += ch;
        continue;
      }
      if (ch === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }

  function stripChildBlocks(body) {
    const clean = stripComments(body);
    let out = '';
    let inQuote = null;
    let i = 0;

    while (i < clean.length) {
      const ch = clean[i];
      if (inQuote) {
        out += ch;
        if (ch === '\\' && i + 1 < clean.length) {
          out += clean[++i];
          i++;
          continue;
        }
        if (ch === inQuote) inQuote = null;
        i++;
        continue;
      }
      const closeQ = getCloseQuote(ch);
      if (closeQ) {
        inQuote = closeQ;
        out += ch;
        i++;
        continue;
      }
      if (ch === '{') {
        // Strip preceding identifier token on the same statement
        out = out.replace(/[a-zA-Z0-9_.]+\s*$/, '');
        const endBrace = findMatchingBrace(clean, i);
        i = endBrace + 1;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  function parseKeyValueBody(body) {
    const clean = stripComments(body);
    const props = [];
    let current = '';
    let inQuote = null;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inQuote) {
        current += ch;
        if (ch === '\\' && i + 1 < clean.length) {
          current += clean[++i];
          continue;
        }
        if (ch === inQuote) inQuote = null;
        continue;
      }
      const closeQ = getCloseQuote(ch);
      if (closeQ) {
        inQuote = closeQ;
        current += ch;
        continue;
      }
      if (ch === ';' || ch === '\n' || ch === '\r') {
        const trimmed = current.trim();
        if (trimmed) props.push(trimmed);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) props.push(current.trim());

    const map = {};
    for (const stmt of props) {
      const eqIdx = stmt.indexOf('=');
      if (eqIdx === -1) continue;
      const lhs = stmt.slice(0, eqIdx).trim();
      const rhs = stmt.slice(eqIdx + 1).trim();
      const colonIdx = lhs.indexOf(':');
      const key = colonIdx === -1 ? lhs : lhs.slice(0, colonIdx).trim();
      const type = colonIdx === -1 ? '' : lhs.slice(colonIdx + 1).trim();
      map[key] = { key, type, rawValue: rhs };
    }
    return map;
  }

  function extractChildBlocks(body, expectedNames) {
    const clean = stripComments(body);
    const results = [];
    let i = 0;

    while (i < clean.length) {
      while (i < clean.length && /\s/.test(clean[i])) i++;
      if (i >= clean.length) break;

      const start = i;
      while (i < clean.length && /[a-zA-Z0-9_.]/.test(clean[i])) i++;
      const name = clean.slice(start, i);

      while (i < clean.length && /\s/.test(clean[i])) i++;
      if (clean[i] === '{') {
        const endBrace = findMatchingBrace(clean, i);
        const inner = clean.slice(i + 1, endBrace);
        if (!expectedNames || expectedNames.includes(name)) {
          results.push({ name, body: inner });
        }
        i = endBrace + 1;
      } else {
        while (i < clean.length && clean[i] !== '\n' && clean[i] !== ';') i++;
        i++;
      }
    }
    return results;
  }

  function parseTopLevel(text) {
    const items = [];
    let i = 0;
    let inQuote = null;

    while (i < text.length) {
      while (i < text.length && (/\s/.test(text[i]) || text[i] === ';')) i++;
      if (i >= text.length) break;

      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      const tokenStart = i;
      while (i < text.length && !/[\s{}=;:]/.test(text[i])) i++;
      const ident = text.slice(tokenStart, i);

      let j = i;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;

      if (text[j] === '{') {
        const closeIdx = findMatchingBrace(text, j);
        const body = text.slice(j + 1, closeIdx);
        const rawText = text.slice(tokenStart, closeIdx + 1);
        items.push({ kind: 'block', name: ident, body, rawText });
        i = closeIdx + 1;
      } else {
        let stmtEnd = i;
        inQuote = null;
        while (stmtEnd < text.length) {
          const ch = text[stmtEnd];
          if (inQuote) {
            if (ch === '\\') {
              stmtEnd += 2;
              continue;
            }
            if (ch === inQuote) inQuote = null;
          } else {
            const closeQ = getCloseQuote(ch);
            if (closeQ) inQuote = closeQ;
            else if (ch === '\n' || ch === ';') break;
            else if (ch === '/' && text[stmtEnd + 1] === '/') break;
          }
          stmtEnd++;
        }
        const fullStmt = text.slice(tokenStart, stmtEnd).trim();
        const eqIdx = fullStmt.indexOf('=');
        if (eqIdx !== -1) {
          const lhs = fullStmt.slice(0, eqIdx).trim();
          const rhs = fullStmt.slice(eqIdx + 1).trim();
          const colonIdx = lhs.indexOf(':');
          const key = colonIdx === -1 ? lhs : lhs.slice(0, colonIdx).trim();
          const type = colonIdx === -1 ? '' : lhs.slice(colonIdx + 1).trim();
          items.push({ kind: 'prop', key, type, rawValue: rhs });
        }
        i = text[stmtEnd] === '/' ? stmtEnd : stmtEnd + 1;
      }
    }
    return items;
  }

  const HUD_WIDGET_ORDER = ['rangefinder', 'turret', 'fov', 'gunReady', 'bulletType'];

  function createDefaultHudWidgets() {
    const green = { r: 0, g: 255, b: 60, a: 255 };
    const redOrange = { r: 255, g: 36, b: 0, a: 255 };
    const blue = { r: 0, g: 100, b: 255, a: 255 };
    const yellow = { r: 255, g: 255, b: 0, a: 255 };
    const transparent = { r: 0, g: 0, b: 0, a: 0 };

    return {
      rangefinder: {
        name: 'rangefinder',
        included: false,
        visible: true,
        textColor: cloneColor(green),
        bgColor: cloneColor(transparent),
        nightVisionTextColor: cloneColor(redOrange),
        nightVisionBgColor: cloneColor(transparent),
        lightTextColor: cloneColor(redOrange),
        lightBgColor: cloneColor(transparent),
        thermalTextColor: cloneColor(green),
        thermalBgColor: cloneColor(transparent),
        position: [1024.5, 549.75],
        textSize: 20,
        font: 'hud',
        progressColor: cloneColor(yellow),
        progressBackgroundColor: cloneColor(transparent),
        wx: (1024.5 - 960) / 1080,
        wy: (549.75 - 540) / 1080
      },
      turret: {
        name: 'turret',
        included: false,
        visible: true,
        color: cloneColor(green),
        lightColor: cloneColor(redOrange),
        nvColor: cloneColor(redOrange),
        thermalColor: cloneColor(green),
        position: [489.75, 726.75],
        wx: (489.75 - 960) / 1080,
        wy: (726.75 - 540) / 1080
      },
      fov: {
        name: 'fov',
        included: false,
        visible: true,
        color: cloneColor(green),
        lightColor: cloneColor(redOrange),
        nvColor: cloneColor(redOrange),
        thermalColor: cloneColor(green)
      },
      gunReady: {
        name: 'gunReady',
        included: false,
        visible: true,
        color: cloneColor(blue),
        lightColor: cloneColor(redOrange),
        nvColor: cloneColor(redOrange),
        thermalColor: cloneColor(blue),
        textSize: 20,
        font: 'hud',
        position: [831, 549.75],
        gunReadyMarkVisible: true,
        gunReadyReloadCountdownVisible: true,
        wx: (831 - 960) / 1080,
        wy: (549.75 - 540) / 1080
      },
      bulletType: {
        name: 'bulletType',
        included: false,
        visible: true,
        isShortName: false,
        textColor: cloneColor(green),
        bgColor: cloneColor(transparent),
        nightVisionTextColor: cloneColor(redOrange),
        nightVisionBgColor: cloneColor(transparent),
        lightTextColor: cloneColor(redOrange),
        lightBgColor: cloneColor(transparent),
        thermalTextColor: cloneColor(green),
        thermalBgColor: cloneColor(transparent),
        position: [483.75, 273.75],
        textSize: 30,
        font: 'hud',
        wx: (483.75 - 960) / 1080,
        wy: (273.75 - 540) / 1080
      }
    };
  }

  function createDefaultHeader() {
    return {
      crosshairPreset: null,
      drawCentralLineVert: true,
      drawCentralLineHorz: true,
      drawSightMask: true,
      useSmoothEdge: true,
      applyCorrectionToGun: true,
      lineSizeMult: 1,
      fontSizeMult: 1,
      crosshairColor: { r: 0, g: 0, b: 0, a: 255 },
      crosshairLightColor: { r: 255, g: 64, b: 64, a: 255 },
      crosshairNvColor: { r: 110, g: 255, b: 145, a: 255 },
      crosshairThermalColor: { r: 242, g: 248, b: 255, a: 255 },
      shotDistScaleOffset: 0,
      reticle: {
        included: false,
        overridden: false,
        lineWidth: 0,
        fontSize: 0.7
      },
      crosshairHorVertSize: [3, 2],
      crosshairDistHorSizeMain: [0.03, 0.02],
      crosshairDistHorSizeAdditional: [0.005, 0.003],
      distanceCorrectionPos: [-0.26, -0.05],
      drawDistanceCorrection: true,
      thousandth: false,
      thousandthMode: 'ussr',
      radial: false,
      circleMode: false,
      drawUpward: false,
      radialRadius: [70, 1],
      radialAngle: 180,
      radialStretch: 5,
      distancePos: [0, 0],
      distanceStretch: 1,
      textPos: [0.015, 0],
      textAlign: 0,
      drawAdditionalLines: true,
      matchExpClass: {
        exp_tank: true,
        exp_heavy_tank: true,
        exp_tank_destroyer: true,
        exp_SPAA: true
      }
    };
  }

  function createDefaultBullet(overrides = {}) {
    return {
      id: nextId('bullet'),
      bulletType: 'apcbc_tank',
      speed: 935,
      radial: true,
      circleMode: true,
      drawUpward: true,
      radialRadius: [70, 1],
      radialAngle: 180,
      radialStretch: 5,
      distancePos: [0, 0],
      distanceStretch: 1,
      crosshairDistHorSizeMain: [0.001, 0.001],
      crosshairDistHorSizeAdditional: [0.005, 0.003],
      textPos: [0.015, 0],
      textAlign: 0,
      fontSizeMult: null,
      drawAdditionalLines: false,
      drawDistanceCorrection: false,
      distanceCorrectionPos: [-0.2, -0.05],
      distances: [
        { dist: 200, major: 2, minor: 0 },
        { dist: 400, major: 4, minor: 0 },
        { dist: 600, major: 6, minor: 0 },
        { dist: 800, major: 8, minor: 0 },
        { dist: 1000, major: 10, minor: 0 },
        { dist: 1200, major: 12, minor: 0 },
        { dist: 1400, major: 14, minor: 0 },
        { dist: 1600, major: 16, minor: 0 },
        { dist: 1800, major: 18, minor: 0 },
        { dist: 2000, major: 20, minor: 0 },
        { dist: 2200, major: 22, minor: 0 },
        { dist: 2400, major: 24, minor: 0 },
        { dist: 2600, major: 26, minor: 0 },
        { dist: 2800, major: 28, minor: 0 },
        { dist: 3000, major: 30, minor: 0 }
      ],
      ...overrides
    };
  }

  function createEmptyDoc() {
    return {
      docType: 'sight',
      settings: [
        { key: 'thousandth', type: 't', rawValue: '"ussr"' },
        { key: 'crosshairHorVertSize', type: 'p2', rawValue: '3, 2' },
        { key: 'rangefinderProgressBarColor1', type: 'c', rawValue: '0, 255, 0, 64' },
        { key: 'rangefinderProgressBarColor2', type: 'c', rawValue: '255, 255, 255, 64' },
        { key: 'rangefinderTextScale', type: 'r', rawValue: '0.7' },
        { key: 'rangefinderUseThousandth', type: 'b', rawValue: 'no' },
        { key: 'rangefinderVerticalOffset', type: 'r', rawValue: '0.1' },
        { key: 'rangefinderHorizontalOffset', type: 'r', rawValue: '5' },
        { key: 'detectAllyTextScale', type: 'r', rawValue: '0.7' },
        { key: 'detectAllyOffset', type: 'p2', rawValue: '4, 0.05' },
        { key: 'fontSizeMult', type: 'r', rawValue: '1' },
        { key: 'lineSizeMult', type: 'r', rawValue: '1' },
        { key: 'drawCentralLineVert', type: 'b', rawValue: 'yes' },
        { key: 'drawCentralLineHorz', type: 'b', rawValue: 'yes' },
        { key: 'drawSightMask', type: 'b', rawValue: 'yes' },
        { key: 'useSmoothEdge', type: 'b', rawValue: 'yes' },
        { key: 'crosshairColor', type: 'c', rawValue: '0, 0, 0, 255' },
        { key: 'crosshairLightColor', type: 'c', rawValue: '255, 64, 64, 255' },
        { key: 'crosshairDistHorSizeMain', type: 'p2', rawValue: '0.03, 0.02' },
        { key: 'crosshairDistHorSizeAdditional', type: 'p2', rawValue: '0.005, 0.003' },
        { key: 'distanceCorrectionPos', type: 'p2', rawValue: '-0.26, -0.05' },
        { key: 'drawDistanceCorrection', type: 'b', rawValue: 'yes' }
      ],
      header: createDefaultHeader(),
      distances: [
        { dist: 200, major: 0, minor: 0 },
        { dist: 400, major: 4, minor: 0 },
        { dist: 600, major: 0, minor: 0 },
        { dist: 800, major: 8, minor: 0 },
        { dist: 1000, major: 0, minor: 0 },
        { dist: 1200, major: 12, minor: 0 },
        { dist: 1400, major: 0, minor: 0 },
        { dist: 1600, major: 16, minor: 0 },
        { dist: 1800, major: 0, minor: 0 },
        { dist: 2000, major: 20, minor: 0 }
      ],
      horRanges: [],
      ballistics: [],
      hudWidgets: createDefaultHudWidgets(),
      preservedBlocks: [
        {
          name: 'matchExpClass',
          rawText: 'matchExpClass {\n  exp_tank:b = yes\n  exp_heavy_tank:b = yes\n  exp_tank_destroyer:b = yes\n  exp_SPAA:b = yes\n}'
        },
        {
          name: 'crosshair_distances',
          rawText: 'crosshair_distances {\n}'
        },
        {
          name: 'crosshair_hor_ranges',
          rawText: 'crosshair_hor_ranges {\n}'
        }
      ],
      lines: [],
      quads: [],
      circles: [],
      texts: [],
      modifiedHeaderKeys: new Set(),
      hasSynthesizedStatic: false
    };
  }

  function createEmptyHudPresetDoc(template = 'pro') {
    const header = createDefaultHeader();
    header.crosshairPreset = 'Default_Sight';
    header.shotDistScaleOffset = 0;

    const widgets = createDefaultHudWidgets();

    if (template === 'minimal') {
      header.crosshairColor = { r: 0, g: 0, b: 0, a: 255 };
      header.crosshairLightColor = { r: 255, g: 64, b: 64, a: 255 };
      header.crosshairNvColor = { r: 0, g: 0, b: 0, a: 255 };
      header.crosshairThermalColor = { r: 0, g: 0, b: 0, a: 255 };
      header.reticle = { included: false, overridden: false, lineWidth: 0, fontSize: 0.7 };

      const black = { r: 0, g: 0, b: 0, a: 255 };
      const trans = { r: 0, g: 0, b: 0, a: 0 };
      const bt = widgets.bulletType;
      bt.included = true;
      bt.visible = false;
      bt.isShortName = false;
      bt.textColor = cloneColor(black);
      bt.bgColor = cloneColor(trans);
      bt.nightVisionTextColor = cloneColor(black);
      bt.nightVisionBgColor = cloneColor(trans);
      bt.lightTextColor = cloneColor(black);
      bt.lightBgColor = cloneColor(trans);
      bt.thermalTextColor = cloneColor(black);
      bt.thermalBgColor = cloneColor(trans);
      bt.position = [700, 202];
      bt.wx = (700 - 960) / 1080;
      bt.wy = (202 - 540) / 1080;
      bt.textSize = 30;
      bt.font = 'hud';
    } else {
      header.crosshairColor = { r: 0, g: 255, b: 60, a: 255 };
      header.crosshairLightColor = { r: 255, g: 36, b: 0, a: 255 };
      header.crosshairNvColor = { r: 255, g: 36, b: 0, a: 255 };
      header.crosshairThermalColor = { r: 0, g: 255, b: 60, a: 255 };
      header.reticle = { included: true, overridden: true, lineWidth: 0, fontSize: 0.7 };
      for (const name of HUD_WIDGET_ORDER) {
        widgets[name].included = true;
        widgets[name].visible = true;
      }
    }

    return {
      docType: 'hud_preset',
      settings: [],
      header,
      distances: [],
      horRanges: [],
      ballistics: [],
      hudWidgets: widgets,
      preservedBlocks: [],
      lines: [],
      quads: [],
      circles: [],
      texts: [],
      modifiedHeaderKeys: new Set(),
      hasSynthesizedStatic: false
    };
  }

  function parseRadialAndExtraProps(props) {
    const out = {};
    if (props.highlight) out.highlight = parseBool(props.highlight.rawValue);
    if (props.center) {
      if (props.center.type === 'p2' || props.center.rawValue.includes(',')) {
        const cp = parseNums(props.center.rawValue);
        if (cp.length >= 2) out.centerPos = [cp[0], cp[1]];
      } else {
        out.center = parseBool(props.center.rawValue);
      }
    }
    if (props.moveRadial) out.moveRadial = parseBool(props.moveRadial.rawValue);
    if (props.radialCenter) {
      const rc = parseNums(props.radialCenter.rawValue);
      if (rc.length >= 2) out.radialCenter = [rc[0], rc[1]];
    }
    if (props.radialAngle) {
      const ra = parseFloat(props.radialAngle.rawValue);
      if (Number.isFinite(ra)) out.radialAngle = ra;
    }
    if (props.radialMoveSpeed) {
      const rs = parseFloat(props.radialMoveSpeed.rawValue);
      if (Number.isFinite(rs)) out.radialMoveSpeed = rs;
    }
    if (props.radialRadius) {
      const rr = parseNums(props.radialRadius.rawValue);
      if (rr.length >= 1) out.radialRadius = [rr[0], rr[1] ?? 0];
    }
    if (props.drawUpward) out.drawUpward = parseBool(props.drawUpward.rawValue);
    return out;
  }

  function parse(blkText, options = {}) {
    const defaultLayer = options.defaultLayer || 'base';
    const autoSynthesizeStatic = options.autoSynthesizeStatic !== false;
    const forceSynthesizeStatic = options.forceSynthesizeStatic === true;
    const items = parseTopLevel(blkText || '');
    const doc = {
      docType: 'sight',
      settings: [],
      header: createDefaultHeader(),
      distances: [],
      horRanges: [],
      ballistics: [],
      hudWidgets: createDefaultHudWidgets(),
      preservedBlocks: [],
      lines: [],
      quads: [],
      circles: [],
      texts: [],
      modifiedHeaderKeys: new Set(),
      hasSynthesizedStatic: false
    };

    const drawBlockNames = new Set(['drawLines', 'drawQuads', 'drawCircles', 'drawTexts']);
    const hudBlockNames = new Set(HUD_WIDGET_ORDER);

    for (const item of items) {
      if (item.kind === 'prop') {
        const settingObj = { key: item.key, type: item.type, rawValue: item.rawValue };
        applyHeaderProp(doc.header, settingObj);
        doc.settings.push(settingObj);
      } else if (item.kind === 'block') {
        if (!drawBlockNames.has(item.name)) {
          if (hudBlockNames.has(item.name)) {
            doc.hudWidgets[item.name] = parseHudWidgetBlock(item.name, item.body);
          } else if (item.name === 'reticle') {
            doc.header.reticle = parseReticleBlock(item.body);
          } else {
            doc.preservedBlocks.push({ name: item.name, rawText: item.rawText });
            if (item.name === 'crosshair_distances') {
              doc.distances = parseDistancesBlock(item.body);
            } else if (item.name === 'crosshair_hor_ranges') {
              doc.horRanges = parseHorRangesBlock(item.body);
            } else if (item.name === 'ballistics') {
              doc.ballistics = parseBallisticsBlock(item.body);
            } else if (item.name === 'matchExpClass') {
              const mp = parseKeyValueBody(item.body);
              doc.header.matchExpClass = {
                exp_tank: mp.exp_tank ? parseBool(mp.exp_tank.rawValue) : false,
                exp_heavy_tank: mp.exp_heavy_tank ? parseBool(mp.exp_heavy_tank.rawValue) : false,
                exp_tank_destroyer: mp.exp_tank_destroyer ? parseBool(mp.exp_tank_destroyer.rawValue) : false,
                exp_SPAA: mp.exp_SPAA ? parseBool(mp.exp_SPAA.rawValue) : false
              };
            }
          }
          continue;
        }

        if (item.name === 'drawLines') {
          const blocks = extractChildBlocks(item.body, ['line']);
          for (const b of blocks) {
            const props = parseKeyValueBody(b.body);
            if (!props.line) continue;
            const coords = parseNums(props.line.rawValue);
            if (coords.length < 4) continue;
            const extra = parseRadialAndExtraProps(props);
            doc.lines.push({
              id: nextId('line'),
              layer: defaultLayer,
              x1: coords[0],
              y1: coords[1],
              x2: coords[2],
              y2: coords[3],
              move: extra.moveRadial ? false : (props.move ? parseBool(props.move.rawValue) : false),
              thousandth: props.thousandth ? parseBool(props.thousandth.rawValue) : false,
              ...extra
            });
          }
        } else if (item.name === 'drawQuads') {
          const blocks = extractChildBlocks(item.body, ['quad']);
          for (const b of blocks) {
            const props = parseKeyValueBody(b.body);
            if (!props.tl || !props.tr || !props.br || !props.bl) continue;
            const tl = parseNums(props.tl.rawValue);
            const tr = parseNums(props.tr.rawValue);
            const br = parseNums(props.br.rawValue);
            const bl = parseNums(props.bl.rawValue);
            if (tl.length < 2 || tr.length < 2 || br.length < 2 || bl.length < 2) continue;
            const extra = parseRadialAndExtraProps(props);
            doc.quads.push({
              id: nextId('quad'),
              layer: defaultLayer,
              tl: { x: tl[0], y: tl[1] },
              tr: { x: tr[0], y: tr[1] },
              br: { x: br[0], y: br[1] },
              bl: { x: bl[0], y: bl[1] },
              move: extra.moveRadial ? false : (props.move ? parseBool(props.move.rawValue) : false),
              thousandth: props.thousandth ? parseBool(props.thousandth.rawValue) : false,
              ...extra
            });
          }
        } else if (item.name === 'drawCircles') {
          const blocks = extractChildBlocks(item.body, ['circle']);
          for (const b of blocks) {
            const props = parseKeyValueBody(b.body);
            const pos = props.pos ? parseNums(props.pos.rawValue) : [0, 0];
            const seg = props.segment ? parseNums(props.segment.rawValue) : [0, 360];
            const diameter = props.diameter ? parseFloat(props.diameter.rawValue) : 0.05;
            const size = props.size ? parseFloat(props.size.rawValue) : 1.5;
            const extra = parseRadialAndExtraProps(props);
            doc.circles.push({
              id: nextId('circle'),
              layer: defaultLayer,
              x: pos[0] || 0,
              y: pos[1] || 0,
              diameter: Number.isFinite(diameter) ? diameter : 0.05,
              size: Number.isFinite(size) ? size : 1.5,
              startAngle: Number.isFinite(seg[0]) ? seg[0] : 0,
              endAngle: Number.isFinite(seg[1]) ? seg[1] : 360,
              move: extra.moveRadial ? false : (props.move ? parseBool(props.move.rawValue) : false),
              thousandth: props.thousandth ? parseBool(props.thousandth.rawValue) : false,
              ...extra
            });
          }
        } else if (item.name === 'drawTexts') {
          const blocks = extractChildBlocks(item.body, ['text']);
          for (const b of blocks) {
            const props = parseKeyValueBody(b.body);
            const pos = props.pos ? parseNums(props.pos.rawValue) : [0, 0];
            const size = props.size ? parseFloat(props.size.rawValue) : 1;
            const align = props.align ? parseInt(props.align.rawValue, 10) : 0;
            const extra = parseRadialAndExtraProps(props);
            doc.texts.push({
              id: nextId('text'),
              layer: defaultLayer,
              text: props.text ? unquote(props.text.rawValue) : '',
              x: pos[0] || 0,
              y: pos[1] || 0,
              size: Number.isFinite(size) ? size : 1,
              align: Number.isFinite(align) ? align : 0,
              move: extra.moveRadial ? false : (props.move ? parseBool(props.move.rawValue) : false),
              thousandth: props.thousandth ? parseBool(props.thousandth.rawValue) : false,
              highlight: props.highlight ? parseBool(props.highlight.rawValue) : false,
              ...extra
            });
          }
        }
      }
    }

    const totalCustomShapes = doc.lines.length + doc.quads.length + doc.circles.length + doc.texts.length;
    const classicKeys = new Set(['drawCentralLineVert', 'drawCentralLineHorz', 'thousandth', 'crosshairHorVertSize', 'radial', 'fontSizeMult', 'lineSizeMult']);
    const hasHudSignal =
      doc.settings.some((s) => s.key === 'crosshair' || s.key === 'shotDistScaleOffset' || s.key === 'crosshairNvColor' || s.key === 'crosshairThermalColor') ||
      HUD_WIDGET_ORDER.some((k) => doc.hudWidgets[k]?.included) ||
      !!doc.header.reticle?.included;
    const hasClassicSignal =
      totalCustomShapes > 0 ||
      doc.ballistics.length > 0 ||
      doc.distances.length > 0 ||
      doc.horRanges.length > 0 ||
      !!doc.header.radial ||
      doc.settings.some((s) => classicKeys.has(s.key)) ||
      doc.preservedBlocks.some((b) => b.name === 'matchExpClass' || b.name === 'crosshair_distances' || b.name === 'crosshair_hor_ranges');

    if (hasHudSignal && !hasClassicSignal) {
      doc.docType = 'hud_preset';
    }

    // Auto-synthesize static wireframe geometry only for classic preset sights (e.g. 4.blk / 5.blk),
    // keeping tank_sight_presets HUD files clean (they render live HUD widgets + reticle backdrop directly).
    if (forceSynthesizeStatic || (autoSynthesizeStatic && totalCustomShapes === 0 && items.length > 0 && !doc.header.radial && doc.ballistics.length === 0 && doc.docType !== 'hud_preset')) {
      synthesizeStaticSightGeometry(doc, defaultLayer);
    }

    return doc;
  }

  /**
   * Synthesize static vector geometry (lines, circles, texts) for built-in War Thunder crosshairs
   * (Standard Tank Crosshair, "ariete" reticle, ballistic distance scales, and HUD preset elements)
   * so users can import dynamic/preset sights and draw custom art directly over them.
   */
  function synthesizeStaticSightGeometry(doc, layer = 'base') {
    const addL = (x1, y1, x2, y2, move = false) => {
      doc.lines.push({
        id: nextId('line'),
        layer,
        x1, y1, x2, y2,
        move,
        thousandth: false,
        staticGenerated: true
      });
    };
    const addC = (x, y, diameter, size = 1.4, startAngle = 0, endAngle = 360) => {
      doc.circles.push({
        id: nextId('circle'),
        layer,
        x, y, diameter, size, startAngle, endAngle,
        move: false,
        thousandth: false,
        staticGenerated: true
      });
    };
    const addT = (text, x, y, size = 0.75, align = 0, move = false) => {
      doc.texts.push({
        id: nextId('text'),
        layer,
        text: String(text),
        x, y, size, align,
        move,
        thousandth: false,
        highlight: false,
        staticGenerated: true
      });
    };

    const preset = (doc.header.crosshairPreset || '').toLowerCase();

    if (preset === 'ariete') {
      // C1 Ariete Tactical Sight Static Geometry
      // 1. Center aiming chevron & precision bore circle
      addL(-0.011, 0.013, 0, 0);
      addL(0, 0, 0.011, 0.013);
      addL(-0.007, 0.022, 0, 0.012);
      addL(0, 0.012, 0.007, 0.022);
      addC(0, 0, 0.036, 1.3);

      // 2. Split main horizontal & vertical crosshair bars
      addL(-0.38, 0, -0.024, 0);
      addL(0.024, 0, 0.38, 0);
      addL(0, -0.34, 0, -0.024);
      addL(0, 0.032, 0, 0.36);

      // 3. Horizontal mil scale ticks & labels (4 to 32 mils)
      for (let mil = 4; mil <= 32; mil += 4) {
        const x = mil * 0.0095;
        const isMajor = mil % 8 === 0;
        const h = isMajor ? 0.015 : 0.008;
        addL(-x, 0, -x, h);
        addL(x, 0, x, h);
        if (isMajor) {
          addT(String(mil), -x, h + 0.016, 0.65, 0);
          addT(String(mil), x, h + 0.016, 0.65, 0);
        }
      }

      // 4. Vertical ballistic drop ladder (400m to 2800m)
      for (let hm = 4; hm <= 28; hm += 4) {
        const y = hm * 0.0115 + 0.015;
        const isMajor = hm % 8 === 0 || hm === 4;
        const w = isMajor ? 0.018 : 0.01;
        addL(-w, y, w, y, true);
        if (hm % 4 === 0) {
          addT(String(hm), -w - 0.012, y, 0.62, -1, true);
        }
      }
    } else {
      // Standard War Thunder Tank Crosshair (Standard.blk / Default Sight)
      if (doc.header.drawCentralLineHorz !== false) {
        addL(-0.46, 0, -0.01, 0);
        addL(0.01, 0, 0.46, 0);
        addL(-0.005, 0, 0.005, 0);
      }
      if (doc.header.drawCentralLineVert !== false) {
        addL(0, -0.46, 0, -0.01);
        addL(0, 0.01, 0, 0.46);
        addL(0, -0.005, 0, 0.005);
      }

      // Horizontal mil ticks (from horRanges or standard 4..32 mil scale)
      const horList = doc.horRanges.length > 0
        ? doc.horRanges
        : [
            { range: -32, label: 32 }, { range: -28, label: 0 }, { range: -24, label: 24 }, { range: -20, label: 0 },
            { range: -16, label: 16 }, { range: -12, label: 0 }, { range: -8, label: 8 }, { range: -4, label: 0 },
            { range: 4, label: 0 }, { range: 8, label: 8 }, { range: 12, label: 0 }, { range: 16, label: 16 },
            { range: 20, label: 0 }, { range: 24, label: 24 }, { range: 28, label: 0 }, { range: 32, label: 32 }
          ];

      for (const hr of horList) {
        const x = hr.range * 0.009;
        const isMajor = hr.label > 0;
        const h = isMajor ? 0.014 : 0.007;
        addL(x, -h * 0.3, x, h);
        if (isMajor) {
          addT(String(hr.label), x, h + 0.015, 0.65, 0);
        }
      }

      // Vertical ballistic distance ticks (from crosshair_distances or standard 200m..2400m)
      const distList = doc.distances.length > 0
        ? doc.distances
        : [
            { dist: 200, major: 0 }, { dist: 400, major: 4 }, { dist: 600, major: 0 }, { dist: 800, major: 8 },
            { dist: 1000, major: 0 }, { dist: 1200, major: 12 }, { dist: 1400, major: 0 }, { dist: 1600, major: 16 },
            { dist: 1800, major: 0 }, { dist: 2000, major: 20 }, { dist: 2400, major: 24 }, { dist: 2800, major: 28 }
          ];

      const mainW = doc.header.crosshairDistHorSizeMain?.[0] || 0.024;
      const addW = doc.header.crosshairDistHorSizeAdditional?.[0] || 0.009;
      for (const d of distList) {
        const y = (d.dist / 2000) * 0.25;
        const isMajor = d.major > 0;
        const w = isMajor ? Math.max(0.016, mainW * 0.75) : Math.max(0.007, addW * 1.4);
        addL(-w, y, w, y, true);
        if (isMajor) {
          addT(String(d.major), -w - 0.012, y, 0.65, -1, true);
        }
      }
    }

    // 5. Synthesize static HUD preset widgets (rangefinder, turret, fov, gunReady, bulletType)
    const addBox = (cx, cy, w, h) => {
      const hw = w / 2, hh = h / 2;
      addL(cx - hw, cy - hh, cx + hw, cy - hh);
      addL(cx + hw, cy - hh, cx + hw, cy + hh);
      addL(cx + hw, cy + hh, cx - hw, cy + hh);
      addL(cx - hw, cy + hh, cx - hw, cy - hh);
    };

    const widgets = doc.hudWidgets || {};
    const widgetCoords = (w) => {
      if (Array.isArray(w.position) && w.position.length >= 2) {
        return {
          wx: ((w.position[0] ?? 960) - 960) / 1080,
          wy: ((w.position[1] ?? 540) - 540) / 1080
        };
      }
      return { wx: w.wx ?? 0, wy: w.wy ?? 0 };
    };

    if (widgets.rangefinder && widgets.rangefinder.included && widgets.rangefinder.visible) {
      const { wx, wy } = widgetCoords(widgets.rangefinder);
      addBox(wx, wy, 0.095, 0.036);
      addT('0000 m', wx, wy, 0.72, 0);
    }

    if (widgets.turret && widgets.turret.included && widgets.turret.visible) {
      const { wx, wy } = widgetCoords(widgets.turret);
      // Tank hull outline + turret ring + gun barrel
      addBox(wx, wy, 0.046, 0.068);
      addC(wx, wy + 0.004, 0.03, 1.3);
      addL(wx, wy - 0.011, wx, wy - 0.052);
    }

    if (widgets.fov && widgets.fov.included && widgets.fov.visible) {
      // 4 Optical FOV Corner Brackets
      const bx = 0.26, by = 0.18, bl = 0.025;
      // Top-left
      addL(-bx, -by, -bx + bl, -by); addL(-bx, -by, -bx, -by + bl);
      // Top-right
      addL(bx, -by, bx - bl, -by); addL(bx, -by, bx, -by + bl);
      // Bottom-left
      addL(-bx, by, -bx + bl, by); addL(-bx, by, -bx, by - bl);
      // Bottom-right
      addL(bx, by, bx - bl, by); addL(bx, by, bx, by - bl);
    }

    if (widgets.gunReady && widgets.gunReady.included && widgets.gunReady.visible) {
      const { wx, wy } = widgetCoords(widgets.gunReady);
      addBox(wx, wy, 0.095, 0.036);
      addT('READY', wx, wy, 0.72, 0);
    }

    if (widgets.bulletType && widgets.bulletType.included && widgets.bulletType.visible) {
      const { wx, wy } = widgetCoords(widgets.bulletType);
      addBox(wx, wy, 0.10, 0.034);
      addT('APFSDS', wx, wy, 0.68, 0);
    }

    doc.hasSynthesizedStatic = true;
  }

  function applyHeaderProp(header, prop) {
    switch (prop.key) {
      case 'crosshair':
        header.crosshairPreset = unquote(prop.rawValue);
        break;
      case 'drawCentralLineVert':
        header.drawCentralLineVert = parseBool(prop.rawValue);
        break;
      case 'drawCentralLineHorz':
        header.drawCentralLineHorz = parseBool(prop.rawValue);
        break;
      case 'drawSightMask':
        header.drawSightMask = parseBool(prop.rawValue);
        break;
      case 'useSmoothEdge':
        header.useSmoothEdge = parseBool(prop.rawValue);
        break;
      case 'applyCorrectionToGun':
        header.applyCorrectionToGun = parseBool(prop.rawValue);
        break;
      case 'radial':
        header.radial = parseBool(prop.rawValue);
        break;
      case 'circleMode':
        header.circleMode = parseBool(prop.rawValue);
        break;
      case 'drawUpward':
        header.drawUpward = parseBool(prop.rawValue);
        break;
      case 'radialRadius': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 1) header.radialRadius = [v[0], v[1] ?? 0];
        break;
      }
      case 'radialAngle': {
        const v = parseFloat(prop.rawValue);
        if (Number.isFinite(v)) header.radialAngle = v;
        break;
      }
      case 'radialStretch': {
        const v = parseFloat(prop.rawValue);
        if (Number.isFinite(v)) header.radialStretch = v;
        break;
      }
      case 'distancePos': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 2) header.distancePos = [v[0], v[1]];
        break;
      }
      case 'distanceStretch': {
        const v = parseFloat(prop.rawValue);
        if (Number.isFinite(v)) header.distanceStretch = v;
        break;
      }
      case 'textPos': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 2) header.textPos = [v[0], v[1]];
        break;
      }
      case 'textAlign': {
        const v = parseInt(prop.rawValue, 10);
        if (Number.isFinite(v)) header.textAlign = v;
        break;
      }
      case 'drawAdditionalLines':
        header.drawAdditionalLines = parseBool(prop.rawValue);
        break;
      case 'lineSizeMult': {
        const v = parseFloat(prop.rawValue);
        if (Number.isFinite(v)) header.lineSizeMult = v;
        break;
      }
      case 'fontSizeMult': {
        const v = parseFloat(prop.rawValue);
        if (Number.isFinite(v)) header.fontSizeMult = v;
        break;
      }
      case 'crosshairColor':
        header.crosshairColor = parseColor(prop.rawValue, header.crosshairColor);
        break;
      case 'crosshairLightColor':
        header.crosshairLightColor = parseColor(prop.rawValue, header.crosshairLightColor);
        break;
      case 'crosshairNvColor':
        header.crosshairNvColor = parseColor(prop.rawValue, header.crosshairNvColor);
        break;
      case 'crosshairThermalColor':
        header.crosshairThermalColor = parseColor(prop.rawValue, header.crosshairThermalColor);
        break;
      case 'shotDistScaleOffset': {
        const v = parseInt(prop.rawValue, 10);
        if (Number.isFinite(v)) header.shotDistScaleOffset = v;
        break;
      }
      case 'crosshairHorVertSize': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 2) header.crosshairHorVertSize = [v[0], v[1]];
        break;
      }
      case 'crosshairDistHorSizeMain': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 2) header.crosshairDistHorSizeMain = [v[0], v[1]];
        break;
      }
      case 'crosshairDistHorSizeAdditional': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 2) header.crosshairDistHorSizeAdditional = [v[0], v[1]];
        break;
      }
      case 'distanceCorrectionPos': {
        const v = parseNums(prop.rawValue);
        if (v.length >= 2) header.distanceCorrectionPos = [v[0], v[1]];
        break;
      }
      case 'drawDistanceCorrection':
        header.drawDistanceCorrection = parseBool(prop.rawValue);
        break;
      case 'thousandth':
        if (prop.type === 'b') {
          header.thousandth = parseBool(prop.rawValue);
        } else if (prop.type === 't' || /["'\u201C\u201D\u2018\u2019]/.test(prop.rawValue)) {
          const mode = unquote(prop.rawValue).toLowerCase();
          if (mode === 'ussr' || mode === 'nato' || mode === 'real') {
            header.thousandthMode = mode;
            prop.rawValue = quoteStr(mode);
          }
        }
        break;
    }
  }

  function parseDistancesBlock(body) {
    const clean = stripComments(body);
    const out = [];
    const lines = clean.split(/[\r\n;]+/);
    for (const ln of lines) {
      const m = ln.match(/distance\s*:\s*p3\s*=\s*([^\r\n;]+)/i);
      if (m) {
        const nums = parseNums(m[1]);
        if (nums.length >= 1) {
          out.push({
            dist: nums[0],
            major: nums[1] || 0,
            minor: nums[2] || 0
          });
        }
      }
    }
    return out;
  }

  function parseHorRangesBlock(body) {
    const clean = stripComments(body);
    const out = [];
    const lines = clean.split(/[\r\n;]+/);
    for (const ln of lines) {
      const m = ln.match(/range\s*:\s*p2\s*=\s*([^\r\n;]+)/i);
      if (m) {
        const nums = parseNums(m[1]);
        if (nums.length >= 1) {
          out.push({
            range: nums[0],
            label: nums[1] || 0
          });
        }
      }
    }
    return out;
  }

  function parseBallisticsBlock(body) {
    const bullets = [];
    const childBlocks = extractChildBlocks(body, ['bullet']);
    for (const b of childBlocks) {
      const topOnly = stripChildBlocks(b.body);
      const props = parseKeyValueBody(topOnly);
      const distBlocks = extractChildBlocks(b.body, ['crosshair_distances']);
      const distances = distBlocks.length > 0 ? parseDistancesBlock(distBlocks[0].body) : [];

      const radialRadius = props.radialRadius ? parseNums(props.radialRadius.rawValue) : [70, 1];
      const distancePos = props.distancePos ? parseNums(props.distancePos.rawValue) : [0, 0];
      const mainSize = props.crosshairDistHorSizeMain ? parseNums(props.crosshairDistHorSizeMain.rawValue) : [0.001, 0.001];
      const addSize = props.crosshairDistHorSizeAdditional ? parseNums(props.crosshairDistHorSizeAdditional.rawValue) : [0.005, 0.003];
      const textPos = props.textPos ? parseNums(props.textPos.rawValue) : [0.015, 0];
      const distCorrPos = props.distanceCorrectionPos ? parseNums(props.distanceCorrectionPos.rawValue) : [-0.2, -0.05];
      const speedVal = props.speed ? parseFloat(props.speed.rawValue) : 900;
      const radialAngleVal = props.radialAngle ? parseFloat(props.radialAngle.rawValue) : 180;
      const radialStretchVal = props.radialStretch ? parseFloat(props.radialStretch.rawValue) : 1;
      const distStretchVal = props.distanceStretch ? parseFloat(props.distanceStretch.rawValue) : 1;
      const textAlignVal = props.textAlign ? parseInt(props.textAlign.rawValue, 10) : 0;
      const fontMultVal = props.fontSizeMult ? parseFloat(props.fontSizeMult.rawValue) : null;

      bullets.push({
        id: nextId('bullet'),
        bulletType: props.bulletType ? unquote(props.bulletType.rawValue) : 'apcbc_tank',
        speed: Number.isFinite(speedVal) ? speedVal : 900,
        radial: props.radial ? parseBool(props.radial.rawValue) : false,
        circleMode: props.circleMode ? parseBool(props.circleMode.rawValue) : false,
        drawUpward: props.drawUpward ? parseBool(props.drawUpward.rawValue) : true,
        radialRadius: [radialRadius[0] ?? 70, radialRadius[1] ?? 1],
        radialAngle: Number.isFinite(radialAngleVal) ? radialAngleVal : 180,
        radialStretch: Number.isFinite(radialStretchVal) ? radialStretchVal : 1,
        distancePos: [distancePos[0] ?? 0, distancePos[1] ?? 0],
        distanceStretch: Number.isFinite(distStretchVal) ? distStretchVal : 1,
        crosshairDistHorSizeMain: [mainSize[0] ?? 0.001, mainSize[1] ?? 0.001],
        crosshairDistHorSizeAdditional: [addSize[0] ?? 0.005, addSize[1] ?? 0.003],
        textPos: [textPos[0] ?? 0.015, textPos[1] ?? 0],
        textAlign: Number.isFinite(textAlignVal) ? textAlignVal : 0,
        fontSizeMult: Number.isFinite(fontMultVal) ? fontMultVal : null,
        drawAdditionalLines: props.drawAdditionalLines ? parseBool(props.drawAdditionalLines.rawValue) : false,
        drawDistanceCorrection: props.drawDistanceCorrection ? parseBool(props.drawDistanceCorrection.rawValue) : false,
        distanceCorrectionPos: [distCorrPos[0] ?? -0.2, distCorrPos[1] ?? -0.05],
        distances
      });
    }
    return bullets;
  }

  function buildDistancesBlock(distances, indent = '') {
    const out = [`${indent}crosshair_distances {`];
    for (const d of (distances || [])) {
      out.push(`${indent}  distance:p3 = ${formatNum(d.dist)}, ${formatNum(d.major || 0)}, ${formatNum(d.minor || 0)}`);
    }
    out.push(`${indent}}`);
    return out.join('\n');
  }

  function buildBallisticsBlock(ballistics) {
    if (!ballistics || ballistics.length === 0) return '';
    const out = ['ballistics {'];
    for (const b of ballistics) {
      out.push('  bullet {');
      out.push(`    bulletType:t = ${quoteStr(b.bulletType || 'apcbc_tank')}`);
      out.push(`    speed:r = ${formatNum(b.speed || 935)}`);
      out.push(`    drawAdditionalLines:b = ${b.drawAdditionalLines ? 'yes' : 'no'}`);
      out.push(`    drawDistanceCorrection:b = ${b.drawDistanceCorrection ? 'yes' : 'no'}`);
      const dcp = b.distanceCorrectionPos || [-0.2, -0.05];
      out.push(`    distanceCorrectionPos:p2 = ${formatNum(dcp[0])}, ${formatNum(dcp[1])}`);
      out.push(`    distanceStretch:r = ${formatNum(b.distanceStretch ?? 1)}`);
      const dp = b.distancePos || [0, 0];
      out.push(`    distancePos:p2 = ${formatNum(dp[0])}, ${formatNum(dp[1])}`);
      const msz = b.crosshairDistHorSizeMain || [0.001, 0.001];
      const asz = b.crosshairDistHorSizeAdditional || [0.005, 0.003];
      out.push(`    crosshairDistHorSizeMain:p2 = ${formatNum(msz[0])}, ${formatNum(msz[1])}`);
      out.push(`    crosshairDistHorSizeAdditional:p2 = ${formatNum(asz[0])}, ${formatNum(asz[1])}`);
      const tp = b.textPos || [0.015, 0];
      out.push(`    textPos:p2 = ${formatNum(tp[0])}, ${formatNum(tp[1])}`);
      out.push(`    textAlign:i = ${Math.round(b.textAlign || 0)}`);
      if (Number.isFinite(b.fontSizeMult) && b.fontSizeMult > 0) {
        out.push(`    fontSizeMult:r = ${formatNum(b.fontSizeMult)}`);
      }
      out.push(`    drawUpward:b = ${b.drawUpward ? 'yes' : 'no'}`);
      out.push(`    circleMode:b = ${b.circleMode ? 'yes' : 'no'}`);
      out.push(`    radial:b = ${b.radial ? 'yes' : 'no'}`);
      const rr = b.radialRadius || [70, 1];
      out.push(`    radialRadius:p2 = ${formatNum(rr[0])}, ${formatNum(rr[1] ?? 1)}`);
      out.push(`    radialAngle:r = ${formatNum(b.radialAngle ?? 180)}`);
      out.push(`    radialStretch:r = ${formatNum(b.radialStretch ?? 5)}`);
      out.push(buildDistancesBlock(b.distances || [], '    '));
      out.push('  }');
    }
    out.push('}');
    return out.join('\n');
  }

  function parseReticleBlock(body) {
    const props = parseKeyValueBody(body);
    const lw = props.lineWidth ? parseFloat(props.lineWidth.rawValue) : 0;
    const fs = props.fontSize ? parseFloat(props.fontSize.rawValue) : 0.7;
    return {
      included: true,
      overridden: props.overridden ? parseBool(props.overridden.rawValue) : false,
      lineWidth: Number.isFinite(lw) ? lw : 0,
      fontSize: Number.isFinite(fs) ? fs : 0.7
    };
  }

  function buildReticleBlock(ret) {
    const r = ret || { overridden: false, lineWidth: 0, fontSize: 0.7 };
    return [
      'reticle{',
      `  overridden:b=${r.overridden ? 'yes' : 'no'}`,
      `  lineWidth:r=${formatNum(r.lineWidth ?? 0)}`,
      `  fontSize:r=${formatNum(r.fontSize ?? 0.7)}`,
      '}'
    ].join('\n');
  }

  function parseHudWidgetBlock(name, body) {
    const props = parseKeyValueBody(body);
    const defaults = createDefaultHudWidgets();
    const w = defaults[name] ? { ...defaults[name] } : { name, visible: true };
    w.included = true;

    if (props.visible) w.visible = parseBool(props.visible.rawValue);
    if (props.position) {
      const pos = parseNums(props.position.rawValue);
      if (pos.length >= 2) w.position = [pos[0], pos[1]];
    }
    const pos = Array.isArray(w.position) ? w.position : [960, 540];
    w.wx = ((pos[0] ?? 960) - 960) / 1080;
    w.wy = ((pos[1] ?? 540) - 540) / 1080;

    if (props.textSize) {
      const ts = parseInt(props.textSize.rawValue, 10);
      if (Number.isFinite(ts)) w.textSize = ts;
    }
    if (props.font) w.font = unquote(props.font.rawValue) || 'hud';

    if (name === 'rangefinder' || name === 'bulletType') {
      if (props.textColor) w.textColor = parseColor(props.textColor.rawValue, w.textColor);
      if (props.bgColor) w.bgColor = parseColor(props.bgColor.rawValue, w.bgColor);
      if (props.nightVisionTextColor) w.nightVisionTextColor = parseColor(props.nightVisionTextColor.rawValue, w.nightVisionTextColor);
      if (props.nightVisionBgColor) w.nightVisionBgColor = parseColor(props.nightVisionBgColor.rawValue, w.nightVisionBgColor);
      if (props.lightTextColor) w.lightTextColor = parseColor(props.lightTextColor.rawValue, w.lightTextColor);
      if (props.lightBgColor) w.lightBgColor = parseColor(props.lightBgColor.rawValue, w.lightBgColor);
      if (props.thermalTextColor) w.thermalTextColor = parseColor(props.thermalTextColor.rawValue, w.thermalTextColor);
      if (props.thermalBgColor) w.thermalBgColor = parseColor(props.thermalBgColor.rawValue, w.thermalBgColor);
    }

    if (name === 'rangefinder') {
      if (props.progressColor) w.progressColor = parseColor(props.progressColor.rawValue, w.progressColor);
      if (props.progressBackgroundColor) w.progressBackgroundColor = parseColor(props.progressBackgroundColor.rawValue, w.progressBackgroundColor);
    }

    if (name === 'bulletType' && props.isShortName) {
      w.isShortName = parseBool(props.isShortName.rawValue);
    }

    if (name === 'turret' || name === 'fov' || name === 'gunReady') {
      if (props.color) w.color = parseColor(props.color.rawValue, w.color);
      if (props.lightColor) w.lightColor = parseColor(props.lightColor.rawValue, w.lightColor);
      if (props.nvColor) w.nvColor = parseColor(props.nvColor.rawValue, w.nvColor);
      if (props.thermalColor) w.thermalColor = parseColor(props.thermalColor.rawValue, w.thermalColor);
    }

    if (name === 'gunReady') {
      if (props.gunReadyMarkVisible) w.gunReadyMarkVisible = parseBool(props.gunReadyMarkVisible.rawValue);
      if (props.gunReadyReloadCountdownVisible) w.gunReadyReloadCountdownVisible = parseBool(props.gunReadyReloadCountdownVisible.rawValue);
    }

    return w;
  }

  function buildHudWidgetBlock(name, w) {
    if (!w) return '';
    const out = [`${name}{`];
    out.push(`  visible:b=${w.visible !== false ? 'yes' : 'no'}`);
    const pos = Array.isArray(w.position) ? w.position : [960, 540];

    if (name === 'rangefinder') {
      out.push(`  textColor:c=${formatColor(w.textColor)}`);
      out.push(`  bgColor:c=${formatColor(w.bgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  nightVisionTextColor:c=${formatColor(w.nightVisionTextColor)}`);
      out.push(`  nightVisionBgColor:c=${formatColor(w.nightVisionBgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  lightTextColor:c=${formatColor(w.lightTextColor)}`);
      out.push(`  lightBgColor:c=${formatColor(w.lightBgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  thermalTextColor:c=${formatColor(w.thermalTextColor)}`);
      out.push(`  thermalBgColor:c=${formatColor(w.thermalBgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  position:p2=${formatNum(pos[0] ?? 1024.5)}, ${formatNum(pos[1] ?? 549.75)}`);
      out.push(`  textSize:i=${Math.round(w.textSize ?? 20)}`);
      out.push(`  font:t=${quoteStr(w.font || 'hud')}`);
      out.push(`  progressColor:c=${formatColor(w.progressColor, { r: 255, g: 255, b: 0, a: 255 })}`);
      out.push(`  progressBackgroundColor:c=${formatColor(w.progressBackgroundColor, { r: 0, g: 0, b: 0, a: 0 })}`);
    } else if (name === 'turret') {
      out.push(`  color:c=${formatColor(w.color)}`);
      out.push(`  lightColor:c=${formatColor(w.lightColor)}`);
      out.push(`  nvColor:c=${formatColor(w.nvColor)}`);
      out.push(`  thermalColor:c=${formatColor(w.thermalColor)}`);
      out.push(`  position:p2=${formatNum(pos[0] ?? 489.75)}, ${formatNum(pos[1] ?? 726.75)}`);
    } else if (name === 'fov') {
      out.push(`  color:c=${formatColor(w.color)}`);
      out.push(`  lightColor:c=${formatColor(w.lightColor)}`);
      out.push(`  nvColor:c=${formatColor(w.nvColor)}`);
      out.push(`  thermalColor:c=${formatColor(w.thermalColor)}`);
    } else if (name === 'gunReady') {
      out.push(`  color:c=${formatColor(w.color)}`);
      out.push(`  lightColor:c=${formatColor(w.lightColor)}`);
      out.push(`  nvColor:c=${formatColor(w.nvColor)}`);
      out.push(`  thermalColor:c=${formatColor(w.thermalColor)}`);
      out.push(`  textSize:i=${Math.round(w.textSize ?? 20)}`);
      out.push(`  font:t=${quoteStr(w.font || 'hud')}`);
      out.push(`  position:p2=${formatNum(pos[0] ?? 831)}, ${formatNum(pos[1] ?? 549.75)}`);
      out.push(`  gunReadyMarkVisible:b=${w.gunReadyMarkVisible !== false ? 'yes' : 'no'}`);
      out.push(`  gunReadyReloadCountdownVisible:b=${w.gunReadyReloadCountdownVisible !== false ? 'yes' : 'no'}`);
    } else if (name === 'bulletType') {
      out.push(`  isShortName:b=${w.isShortName ? 'yes' : 'no'}`);
      out.push(`  textColor:c=${formatColor(w.textColor)}`);
      out.push(`  bgColor:c=${formatColor(w.bgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  nightVisionTextColor:c=${formatColor(w.nightVisionTextColor)}`);
      out.push(`  nightVisionBgColor:c=${formatColor(w.nightVisionBgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  lightTextColor:c=${formatColor(w.lightTextColor)}`);
      out.push(`  lightBgColor:c=${formatColor(w.lightBgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  thermalTextColor:c=${formatColor(w.thermalTextColor)}`);
      out.push(`  thermalBgColor:c=${formatColor(w.thermalBgColor, { r: 0, g: 0, b: 0, a: 0 })}`);
      out.push(`  position:p2=${formatNum(pos[0] ?? 483.75)}, ${formatNum(pos[1] ?? 273.75)}`);
      out.push(`  textSize:i=${Math.round(w.textSize ?? 30)}`);
      out.push(`  font:t=${quoteStr(w.font || 'hud')}`);
    }

    out.push('}');
    return out.join('\n');
  }

  function upsertSetting(settings, key, type, rawValue) {
    const idx = settings.findIndex((s) => s.key === key && (!type || !s.type || s.type === type));
    if (idx !== -1) {
      settings[idx] = { key, type: settings[idx].type || type, rawValue };
    } else {
      settings.push({ key, type, rawValue });
    }
  }

  function syncHeaderToSettings(doc) {
    const h = doc.header;
    // Strip HUD-preset-only keys from classic reticle settings
    const hudOnlyKeys = new Set(['crosshair', 'crosshairNvColor', 'crosshairThermalColor']);
    const settings = (doc.settings || [])
      .filter((s) => !hudOnlyKeys.has(s.key))
      .map((s) => ({ ...s }));
    const p2Str = (arr, defA = 0, defB = 0) => `${formatNum(arr?.[0] ?? defA)}, ${formatNum(arr?.[1] ?? defB)}`;

    // Ensure essential classic CDK headers exist (e.g. when user started from Pro.blk HUD preset and drew a reticle)
    const missingClassicHeader = !settings.some((s) => s.key === 'drawCentralLineVert' || s.key === 'crosshairHorVertSize');
    if (missingClassicHeader) {
      const defaults = [
        ['thousandth', 't', quoteStr(h.thousandthMode || 'ussr')],
        ['crosshairHorVertSize', 'p2', '3, 2'],
        ['rangefinderProgressBarColor1', 'c', '0, 255, 0, 64'],
        ['rangefinderProgressBarColor2', 'c', '255, 255, 255, 64'],
        ['rangefinderTextScale', 'r', '0.7'],
        ['rangefinderUseThousandth', 'b', 'no'],
        ['rangefinderVerticalOffset', 'r', '0.1'],
        ['rangefinderHorizontalOffset', 'r', '5'],
        ['detectAllyTextScale', 'r', '0.7'],
        ['detectAllyOffset', 'p2', '4, 0.05'],
        ['fontSizeMult', 'r', formatNum(h.fontSizeMult ?? 1)],
        ['lineSizeMult', 'r', formatNum(h.lineSizeMult ?? 1)],
        ['drawCentralLineVert', 'b', h.drawCentralLineVert ? 'yes' : 'no'],
        ['drawCentralLineHorz', 'b', h.drawCentralLineHorz ? 'yes' : 'no'],
        ['drawSightMask', 'b', h.drawSightMask !== false ? 'yes' : 'no'],
        ['useSmoothEdge', 'b', h.useSmoothEdge !== false ? 'yes' : 'no'],
        ['crosshairColor', 'c', formatColor(h.crosshairColor)],
        ['crosshairLightColor', 'c', formatColor(h.crosshairLightColor)],
        ['crosshairDistHorSizeMain', 'p2', p2Str(h.crosshairDistHorSizeMain, 0.03, 0.02)],
        ['crosshairDistHorSizeAdditional', 'p2', p2Str(h.crosshairDistHorSizeAdditional, 0.005, 0.003)],
        ['distanceCorrectionPos', 'p2', '-0.26, -0.05'],
        ['drawDistanceCorrection', 'b', h.drawDistanceCorrection !== false ? 'yes' : 'no']
      ];
      for (const [k, t, v] of defaults) {
        if (!settings.some((s) => s.key === k)) {
          upsertSetting(settings, k, t, v);
        }
      }
    }

    const managed = [
      ['thousandth', 't', quoteStr(h.thousandthMode || 'ussr')],
      ['fontSizeMult', 'r', formatNum(h.fontSizeMult)],
      ['lineSizeMult', 'r', formatNum(h.lineSizeMult)],
      ['drawCentralLineVert', 'b', h.drawCentralLineVert ? 'yes' : 'no'],
      ['drawCentralLineHorz', 'b', h.drawCentralLineHorz ? 'yes' : 'no'],
      ['drawSightMask', 'b', h.drawSightMask ? 'yes' : 'no'],
      ['useSmoothEdge', 'b', h.useSmoothEdge ? 'yes' : 'no'],
      ['applyCorrectionToGun', 'b', h.applyCorrectionToGun !== false ? 'yes' : 'no'],
      ['drawDistanceCorrection', 'b', h.drawDistanceCorrection ? 'yes' : 'no'],
      ['crosshairColor', 'c', formatColor(h.crosshairColor)],
      ['crosshairLightColor', 'c', formatColor(h.crosshairLightColor)],
      ['shotDistScaleOffset', 'i', String(Math.round(h.shotDistScaleOffset || 0))],
      ['radial', 'b', h.radial ? 'yes' : 'no'],
      ['circleMode', 'b', h.circleMode ? 'yes' : 'no'],
      ['drawUpward', 'b', h.drawUpward ? 'yes' : 'no'],
      ['radialRadius', 'p2', p2Str(h.radialRadius, 70, 1)],
      ['radialAngle', 'r', formatNum(h.radialAngle ?? 180)],
      ['radialStretch', 'r', formatNum(h.radialStretch ?? 5)],
      ['distancePos', 'p2', p2Str(h.distancePos, 0, 0)],
      ['distanceStretch', 'r', formatNum(h.distanceStretch ?? 1)],
      ['textPos', 'p2', p2Str(h.textPos, 0.015, 0)],
      ['textAlign', 'i', String(Math.round(h.textAlign || 0))],
      ['drawAdditionalLines', 'b', h.drawAdditionalLines !== false ? 'yes' : 'no'],
      ['crosshairDistHorSizeMain', 'p2', p2Str(h.crosshairDistHorSizeMain, 0.03, 0.02)],
      ['crosshairDistHorSizeAdditional', 'p2', p2Str(h.crosshairDistHorSizeAdditional, 0.005, 0.003)]
    ];

    for (const [key, type, val] of managed) {
      const exists = settings.some((s) => s.key === key && (!type || !s.type || s.type === type));
      const modified = doc.modifiedHeaderKeys && (
        doc.modifiedHeaderKeys.has(key) ||
        (key === 'thousandth' && doc.modifiedHeaderKeys.has('thousandthMode'))
      );
      if (exists || modified) {
        upsertSetting(settings, key, type, val);
      }
    }
    return settings;
  }

  function formatExtraElementProps(el) {
    let s = '';
    if (el.highlight) s += 'highlight:b=yes;';
    if (Array.isArray(el.centerPos) && el.centerPos.length >= 2) {
      s += `center:p2=${formatNum(el.centerPos[0])},${formatNum(el.centerPos[1])};`;
    } else if (el.center) {
      s += 'center:b=yes;';
    }
    if (el.moveRadial) s += 'moveRadial:b=yes;';
    if (Array.isArray(el.radialCenter) && el.radialCenter.length >= 2) {
      s += `radialCenter:p2=${formatNum(el.radialCenter[0])},${formatNum(el.radialCenter[1])};`;
    }
    if (Number.isFinite(el.radialAngle)) {
      s += `radialAngle:r=${formatNum(el.radialAngle)};`;
    }
    if (Number.isFinite(el.radialMoveSpeed)) {
      s += `radialMoveSpeed:r=${formatNum(el.radialMoveSpeed)};`;
    }
    if (Array.isArray(el.radialRadius) && el.radialRadius.length >= 1) {
      s += `radialRadius:p2=${formatNum(el.radialRadius[0])},${formatNum(el.radialRadius[1] ?? 0)};`;
    }
    if (typeof el.drawUpward === 'boolean') {
      s += `drawUpward:b=${el.drawUpward ? 'yes' : 'no'};`;
    }
    return s;
  }

  function buildMatchExpClassBlock(mc) {
    const m = mc || { exp_tank: true, exp_heavy_tank: true, exp_tank_destroyer: true, exp_SPAA: true };
    return [
      'matchExpClass {',
      `  exp_tank:b = ${m.exp_tank ? 'yes' : 'no'}`,
      `  exp_heavy_tank:b = ${m.exp_heavy_tank ? 'yes' : 'no'}`,
      `  exp_tank_destroyer:b = ${m.exp_tank_destroyer ? 'yes' : 'no'}`,
      `  exp_SPAA:b = ${m.exp_SPAA ? 'yes' : 'no'}`,
      '}'
    ].join('\n');
  }

  function serializeHudPreset(doc, options = {}) {
    const h = doc.header;
    const targetCrosshair = (options.linkedReticleName || h.crosshairPreset || 'Default_Sight').replace(/\.blk$/i, '');
    const linesOut = [
      `crosshair:t=${quoteStr(targetCrosshair)}`,
      `crosshairColor:c=${formatColor(h.crosshairColor)}`,
      `crosshairLightColor:c=${formatColor(h.crosshairLightColor)}`,
      `crosshairNvColor:c=${formatColor(h.crosshairNvColor)}`,
      `crosshairThermalColor:c=${formatColor(h.crosshairThermalColor)}`,
      `shotDistScaleOffset:i=${Math.round(h.shotDistScaleOffset || 0)}`
    ];

    const widgets = doc.hudWidgets || {};
    const blockStrings = [];
    for (const name of HUD_WIDGET_ORDER) {
      if (widgets[name] && widgets[name].included) {
        blockStrings.push(buildHudWidgetBlock(name, widgets[name]));
      }
    }
    if (h.reticle && h.reticle.included) {
      blockStrings.push(buildReticleBlock(h.reticle));
    }

    if (blockStrings.length > 0) {
      linesOut.push('');
      for (let i = 0; i < blockStrings.length; i++) {
        linesOut.push(blockStrings[i]);
        if (i < blockStrings.length - 1) linesOut.push('');
      }
    }

    linesOut.push('');
    return linesOut.join('\n');
  }

  function serialize(doc, options = {}) {
    if (options.forceFormat === 'hud_preset' || (doc.docType === 'hud_preset' && options.forceFormat !== 'sight')) {
      return serializeHudPreset(doc, options);
    }

    const excludeBaseLayer = options.excludeBaseLayer === true;
    const linesOut = [];
    const settings = syncHeaderToSettings(doc);

    for (const s of settings) {
      const typePart = s.type ? `:${s.type}` : '';
      linesOut.push(`${s.key}${typePart}=${s.rawValue}`);
    }

    // Only keep classic CDK blocks in the Reticle .blk file (HUD widget blocks belong in tank_sight_presets/*.blk)
    const hudBlockNames = new Set([...HUD_WIDGET_ORDER, 'reticle']);
    const preserved = (doc.preservedBlocks || [])
      .filter((b) => !hudBlockNames.has(b.name))
      .map((b) => ({ ...b }));

    const matchIdx = preserved.findIndex((b) => b.name === 'matchExpClass');
    const matchModified = doc.modifiedHeaderKeys && doc.modifiedHeaderKeys.has('matchExpClass');
    if (matchIdx !== -1 && matchModified) {
      preserved[matchIdx].rawText = buildMatchExpClassBlock(doc.header.matchExpClass);
    } else if (matchIdx === -1) {
      preserved.unshift({
        name: 'matchExpClass',
        rawText: buildMatchExpClassBlock(doc.header.matchExpClass)
      });
    }

    const distIdx = preserved.findIndex((b) => b.name === 'crosshair_distances');
    if (doc.modifiedHeaderKeys && doc.modifiedHeaderKeys.has('crosshair_distances')) {
      const distRaw = buildDistancesBlock(doc.distances || []);
      if (distIdx !== -1) preserved[distIdx].rawText = distRaw;
      else preserved.push({ name: 'crosshair_distances', rawText: distRaw });
    } else if (distIdx === -1) {
      preserved.push({ name: 'crosshair_distances', rawText: buildDistancesBlock(doc.distances || []) });
    }

    const horIdx = preserved.findIndex((b) => b.name === 'crosshair_hor_ranges');
    if (horIdx === -1) {
      preserved.push({ name: 'crosshair_hor_ranges', rawText: 'crosshair_hor_ranges{\n}' });
    }

    if (doc.modifiedHeaderKeys && doc.modifiedHeaderKeys.has('ballistics')) {
      const balIdx = preserved.findIndex((b) => b.name === 'ballistics');
      if (doc.ballistics && doc.ballistics.length > 0) {
        const balRaw = buildBallisticsBlock(doc.ballistics);
        if (balIdx !== -1) preserved[balIdx].rawText = balRaw;
        else preserved.push({ name: 'ballistics', rawText: balRaw });
      } else if (balIdx !== -1) {
        preserved.splice(balIdx, 1);
      }
    }

    if (preserved.length > 0) {
      linesOut.push('');
      for (const blk of preserved) {
        linesOut.push(blk.rawText.trim());
        linesOut.push('');
      }
    }

    const filterFn = (item) => !(excludeBaseLayer && item.layer === 'base');
    const exportLines = (doc.lines || []).filter(filterFn);
    const exportQuads = (doc.quads || []).filter(filterFn);
    const exportCircles = (doc.circles || []).filter(filterFn);
    const exportTexts = (doc.texts || []).filter(filterFn);

    linesOut.push('drawLines{');
    for (const l of exportLines) {
      const isMove = !l.moveRadial && !!l.move;
      const th = l.thousandth ? 'thousandth:b=true;' : '';
      const extra = formatExtraElementProps(l);
      linesOut.push(
        `  line {line:p4=${formatNum(l.x1)},${formatNum(l.y1)},${formatNum(l.x2)},${formatNum(l.y2)};move:b=${isMove ? 'true' : 'false'};${th}${extra}}`
      );
    }
    linesOut.push('}');

    if (exportQuads.length > 0) {
      linesOut.push('');
      linesOut.push('drawQuads{');
      for (const q of exportQuads) {
        const isMove = !q.moveRadial && !!q.move;
        const mv = isMove ? 'move:b=true;' : '';
        const th = q.thousandth ? 'thousandth:b=true;' : '';
        const extra = formatExtraElementProps(q);
        linesOut.push(
          `  quad {tl:p2=${formatNum(q.tl.x)},${formatNum(q.tl.y)};tr:p2=${formatNum(q.tr.x)},${formatNum(q.tr.y)};br:p2=${formatNum(q.br.x)},${formatNum(q.br.y)};bl:p2=${formatNum(q.bl.x)},${formatNum(q.bl.y)};${mv}${th}${extra}}`
        );
      }
      linesOut.push('}');
    }

    if (exportCircles.length > 0) {
      linesOut.push('');
      linesOut.push('drawCircles{');
      for (const c of exportCircles) {
        const isMove = !c.moveRadial && !!c.move;
        const th = c.thousandth ? 'thousandth:b=true;' : '';
        const extra = formatExtraElementProps(c);
        linesOut.push(
          `  circle {segment:p2=${formatNum(c.startAngle)},${formatNum(c.endAngle)};pos:p2=${formatNum(c.x)},${formatNum(c.y)};diameter:r=${formatNum(c.diameter)};size:r=${formatNum(c.size)};move:b=${isMove ? 'true' : 'false'};${th}${extra}}`
        );
      }
      linesOut.push('}');
    }

    if (exportTexts.length > 0) {
      linesOut.push('');
      linesOut.push('drawTexts{');
      for (const t of exportTexts) {
        const isMove = !t.moveRadial && !!t.move;
        const th = t.thousandth ? 'thousandth:b=true;' : '';
        const extra = formatExtraElementProps(t);
        linesOut.push(
          `  text {text:t=${quoteStr(t.text)};align:i=${Math.round(t.align || 0)};pos:p2=${formatNum(t.x)},${formatNum(t.y)};move:b=${isMove ? 'true' : 'false'};size:r=${formatNum(t.size)};${extra}${th}}`
        );
      }
      linesOut.push('}');
    }

    linesOut.push('');
    return linesOut.join('\n');
  }

  global.BlkParser = {
    parse,
    serialize,
    createEmptyDoc,
    createEmptyHudPresetDoc,
    createDefaultHudWidgets,
    createDefaultBullet,
    buildDistancesBlock,
    buildBallisticsBlock,
    buildHudWidgetBlock,
    buildReticleBlock,
    synthesizeStaticSightGeometry,
    HUD_WIDGET_ORDER,
    nextId,
    formatNum
  };
})(window);
