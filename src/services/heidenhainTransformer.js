/**
 * Transform standard Fanuc/ISO G-code into Heidenhain Klartext format.
 *
 * Supports three controller families:
 *  - TNC 640 / TNC 320  (modern, CYCL DEF 200+ with full Q params)
 *  - iTNC 530           (modern, CYCL DEF 200+ compatible subset)
 *  - TNC 426 / TNC 430  (legacy, CYCL DEF 1.x / 2.x / 4.x numbering)
 *
 * Adds BLK FORM stock definition when stock dimensions are provided.
 */

function parseParams(line) {
  const params = {};
  const re = /([A-Z])(-?\d+\.?\d*)/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    params[m[1].toUpperCase()] = parseFloat(m[2]);
  }
  return params;
}

function fmtNum(v) {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtCoord(letter, value) {
  const v = Number(value);
  return v >= 0 ? `${letter}+${fmtNum(v)}` : `${letter}${fmtNum(v)}`;
}

function extractMCodes(line) {
  const matches = line.match(/\bM(\d+)/gi) || [];
  return matches
    .map((m) => m.toUpperCase())
    .filter((m) => {
      const n = parseInt(m.slice(1));
      return n !== 6 && n !== 2 && n !== 30;
    });
}

// ---------------------------------------------------------------------------
// BLK FORM — stock definition
// ---------------------------------------------------------------------------

function buildBlkForm(opts) {
  const sx = Number(opts.stockX) || 0;
  const sy = Number(opts.stockY) || 0;
  const sz = Number(opts.stockZ) || 0;
  if (sx <= 0 || sy <= 0 || sz <= 0) return [];

  const wcs = String(opts.wcs || "").toLowerCase();

  let minX, minY, minZ, maxX, maxY, maxZ;
  if (wcs.includes("merkez")) {
    minX = -(sx / 2);
    minY = -(sy / 2);
    maxX = sx / 2;
    maxY = sy / 2;
  } else {
    minX = 0;
    minY = 0;
    maxX = sx;
    maxY = sy;
  }
  if (wcs.includes("alt yuzey") || wcs.includes("alt")) {
    minZ = 0;
    maxZ = sz;
  } else {
    minZ = -sz;
    maxZ = 0;
  }

  return [
    `BLK FORM 0.1 Z ${fmtCoord("X", minX)} ${fmtCoord("Y", minY)} ${fmtCoord("Z", minZ)}`,
    `BLK FORM 0.2 ${fmtCoord("X", maxX)} ${fmtCoord("Y", maxY)} ${fmtCoord("Z", maxZ)}`,
  ];
}

// ---------------------------------------------------------------------------
// Modern cycles — CYCL DEF 200+ (TNC 640 / iTNC 530)
// ---------------------------------------------------------------------------

function cyclDef200(depth, retract, feed, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  return [
    "CYCL DEF 200 DRILLING ~",
    `  Q200=${fmtNum(sc)} ;SET-UP CLEARANCE ~`,
    `  Q201=${fmtNum(depth)} ;DEPTH ~`,
    `  Q206=${fmtNum(feed)} ;FEED RATE FOR PLNGNG ~`,
    `  Q202=${fmtNum(Math.abs(depth - surface))} ;PLUNGING DEPTH ~`,
    "  Q210=0 ;DWELL TIME AT TOP ~",
    `  Q203=${fmtNum(surface)} ;SURFACE COORDINATE ~`,
    "  Q204=50 ;2ND SET-UP CLEARANCE",
  ];
}

function cyclDef205(depth, retract, peck, feed, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  const q = Math.abs(peck);
  return [
    "CYCL DEF 205 UNIVERSAL PECKING ~",
    `  Q200=${fmtNum(sc)} ;SET-UP CLEARANCE ~`,
    `  Q201=${fmtNum(depth)} ;DEPTH ~`,
    `  Q206=${fmtNum(feed)} ;FEED RATE FOR PLNGNG ~`,
    `  Q202=${fmtNum(q)} ;PLUNGING DEPTH ~`,
    `  Q203=${fmtNum(surface)} ;SURFACE COORDINATE ~`,
    "  Q204=50 ;2ND SET-UP CLEARANCE ~",
    "  Q212=0 ;DECREMENT ~",
    `  Q205=${fmtNum(Math.max(0.5, q * 0.5))} ;MIN. PLUNGING DEPTH ~`,
    "  Q258=0.2 ;UPPER ADV STOP DIST ~",
    "  Q259=1 ;LOWER ADV STOP DIST ~",
    "  Q257=5 ;CLEARANCE DEPTH ~",
    "  Q256=0.1 ;DIST FOR CHIP BRKNG ~",
    "  Q211=0 ;DWELL TIME AT BOTTOM ~",
    "  Q379=0 ;STARTING POINT",
  ];
}

function cyclDef207(depth, retract, pitch, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  return [
    "CYCL DEF 207 RIGID TAPPING NEW ~",
    `  Q200=${fmtNum(sc)} ;SET-UP CLEARANCE ~`,
    `  Q201=${fmtNum(depth)} ;DEPTH ~`,
    `  Q239=${fmtNum(pitch)} ;PITCH ~`,
    `  Q203=${fmtNum(surface)} ;SURFACE COORDINATE ~`,
    "  Q204=50 ;2ND SET-UP CLEARANCE",
  ];
}

function cyclDef201(depth, retract, feed, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  return [
    "CYCL DEF 201 REAMING ~",
    `  Q200=${fmtNum(sc)} ;SET-UP CLEARANCE ~`,
    `  Q201=${fmtNum(depth)} ;DEPTH ~`,
    `  Q206=${fmtNum(feed)} ;FEED RATE FOR PLNGNG ~`,
    "  Q211=0 ;DWELL TIME AT BOTTOM ~",
    "  Q208=99999 ;RETRACTION FEED RATE ~",
    `  Q203=${fmtNum(surface)} ;SURFACE COORDINATE ~`,
    "  Q204=50 ;2ND SET-UP CLEARANCE",
  ];
}

// ---------------------------------------------------------------------------
// Legacy cycles — CYCL DEF 1.x / 2.x (TNC 426 / TNC 430)
// ---------------------------------------------------------------------------

function cyclDefOld1(depth, retract, peck, feed, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  const q = Math.abs(peck);
  return [
    "CYCL DEF 1.0 PECKING",
    `CYCL DEF 1.1 SET UP ${fmtNum(sc)}`,
    `CYCL DEF 1.2 DEPTH ${fmtNum(depth)}`,
    `CYCL DEF 1.3 PECKG ${fmtNum(q || Math.abs(depth - surface))}`,
    "CYCL DEF 1.4 DWELL 0",
    `CYCL DEF 1.5 F${Math.round(feed)}`,
  ];
}

function cyclDefOld2(depth, retract, pitch, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  return [
    "CYCL DEF 2.0 TAPPING",
    `CYCL DEF 2.1 SET UP ${fmtNum(sc)}`,
    `CYCL DEF 2.2 DEPTH ${fmtNum(depth)}`,
    "CYCL DEF 2.3 DWELL 0",
    `CYCL DEF 2.4 F${fmtNum(pitch)}`,
  ];
}

function cyclDefOldBoring(depth, retract, feed, surface) {
  const sc = Math.max(0.5, Math.abs(retract - surface));
  return [
    "CYCL DEF 1.0 PECKING",
    `CYCL DEF 1.1 SET UP ${fmtNum(sc)}`,
    `CYCL DEF 1.2 DEPTH ${fmtNum(depth)}`,
    `CYCL DEF 1.3 PECKG ${fmtNum(Math.abs(depth - surface))}`,
    "CYCL DEF 1.4 DWELL 0.5",
    `CYCL DEF 1.5 F${Math.round(feed)}`,
  ];
}

// ---------------------------------------------------------------------------
// Cycle dispatch tables keyed by controller generation
// ---------------------------------------------------------------------------

const MODERN_CYCLES = {
  G81: (z, r, _q, f, _s, sfc) => cyclDef200(z, r, f, sfc),
  G83: (z, r, q, f, _s, sfc) => cyclDef205(z, r, q, f, sfc),
  G84: (z, r, _q, f, s, sfc) => {
    const pitch = s > 0 ? f / s : 1;
    return cyclDef207(z, r, pitch, sfc);
  },
  G85: (z, r, _q, f, _s, sfc) => cyclDef201(z, r, f, sfc),
};

const LEGACY_CYCLES = {
  G81: (z, r, _q, f, _s, sfc) => cyclDefOld1(z, r, 0, f, sfc),
  G83: (z, r, q, f, _s, sfc) => cyclDefOld1(z, r, q, f, sfc),
  G84: (z, r, _q, f, s, sfc) => {
    const pitch = s > 0 ? f / s : 1;
    return cyclDefOld2(z, r, pitch, sfc);
  },
  G85: (z, r, _q, f, _s, sfc) => cyclDefOldBoring(z, r, f, sfc),
};

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

export function heidenhainVersion(postName) {
  const p = String(postName || "").toLowerCase();
  if (p.includes("426") || p.includes("430")) return "legacy";
  return "modern";
}

// ---------------------------------------------------------------------------
// Main transformer
// ---------------------------------------------------------------------------

/**
 * @param {string} gcode      raw Fanuc G-code
 * @param {string} [partName] part name for header
 * @param {object} [opts]     { stockX, stockY, stockZ, wcs, version }
 */
export function transformToHeidenhain(gcode, partName, opts = {}) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()
    .slice(0, 24);
  const version = opts.version || "modern";
  const cycleDefs = version === "legacy" ? LEGACY_CYCLES : MODERN_CYCLES;

  const lines = gcode.split(/\r?\n/);
  const out = [];

  let curX = 0,
    curY = 0,
    curZ = 0;
  let lastF = 100;
  let lastS = 1000;
  let lastR = 2;
  let lastQ = 3;
  let motionMode = "G0";
  let activeCycle = null;
  let pendingM = [];
  let surface = 0;

  out.push(`BEGIN PGM ${name} MM`);
  out.push("; Heidenhain Klartext Programi");
  if (version === "legacy") {
    out.push("; Kontrolcu: TNC 426/430");
  } else {
    out.push("; Kontrolcu: TNC 640 / iTNC 530");
  }
  out.push("; Rover CAD tarafindan olusturuldu");

  // BLK FORM (stock definition)
  const blk = buildBlkForm(opts);
  if (blk.length) {
    out.push(...blk);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === "" || line === "%" || /^O\d+/i.test(line)) continue;

    if (line.startsWith("(") && line.endsWith(")")) {
      out.push("; " + line.slice(1, -1).trim());
      continue;
    }
    if (line.startsWith(";")) {
      out.push(line);
      continue;
    }

    const sMatch = line.match(/\bS(\d+\.?\d*)/i);
    if (sMatch) lastS = parseFloat(sMatch[1]);
    const fMatch = line.match(/\bF(\d+\.?\d*)/i);
    if (fMatch) lastF = parseFloat(fMatch[1]);

    // --- Tool change (look ahead for S) ---
    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const ahead = lines[j].trim();
        const sa = ahead.match(/\bS(\d+\.?\d*)/i);
        if (sa) { lastS = parseFloat(sa[1]); break; }
        if (/\b[XYZ]/i.test(ahead) && /\bG/i.test(ahead)) break;
      }
      out.push(`TOOL CALL ${tNum} Z S${Math.round(lastS)}`);
      continue;
    }
    if (/^T\d+\s*$/i.test(line)) continue;

    // --- Pure mode lines ---
    const stripped = line.replace(/^N\d+\s*/i, "");
    if (/^(G\d+\s*)+$/i.test(stripped) && !/\b[XYZIJKRF]\b/i.test(stripped)) {
      if (/\bG0?0\b/i.test(stripped)) motionMode = "G0";
      if (/\bG0?1\b/i.test(stripped)) motionMode = "G1";
      continue;
    }

    // --- Spindle / coolant standalone ---
    if (/\bM0?3\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) { pendingM.push("M3"); continue; }
    if (/\bM0?4\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) { pendingM.push("M4"); continue; }
    if (/\bM0?5\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) { pendingM.push("M5"); continue; }
    if (/\bM0?8\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) { pendingM.push("M8"); continue; }
    if (/\bM0?9\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) { pendingM.push("M9"); continue; }
    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) continue;

    // --- Canned drilling cycles ---
    // Real Fanuc-style modal canned-cycle output very often omits X/Y (or
    // Z) on a given line whenever it hasn't changed since the previous one
    // — the cycle-invoking line itself is frequently just "G81 Z.. F.. R.."
    // with X/Y already set by an earlier rapid. A Heidenhain CYCL DEF only
    // actually runs the drill on a following "M99" call line, so gating
    // that call on "this exact line repeats X/Y" (the previous logic)
    // silently dropped the cycle call whenever a line didn't happen to
    // repeat X/Y — on real hardware that means the drill cycle never
    // fires, and the machine instead rapids (FMAX) straight to the target
    // depth on whatever plain move comes next.
    const cycleMatch = line.match(/\bG(8[1345])\b/i);
    if (cycleMatch) {
      const code = "G" + cycleMatch[1];
      const p = parseParams(line);
      if (p.R !== undefined) lastR = p.R;
      if (p.Q !== undefined) lastQ = p.Q;
      if (p.F !== undefined) lastF = p.F;
      const z = p.Z !== undefined ? p.Z : curZ;
      curZ = z;

      const builder = cycleDefs[code];
      if (builder) out.push(...builder(z, lastR, lastQ, lastF, lastS, surface));

      const x = p.X !== undefined ? p.X : curX;
      const y = p.Y !== undefined ? p.Y : curY;
      out.push(`L ${fmtCoord("X", x)} ${fmtCoord("Y", y)} R0 FMAX M99`);
      curX = x; curY = y;
      activeCycle = code;
      continue;
    }

    if (/\bG80\b/i.test(line)) { activeCycle = null; continue; }

    if (activeCycle) {
      // Another modal continuation under the same active cycle: a new
      // hole (X/Y changed), the same hole redone at a different depth (Z
      // changed — common when consecutive drilling operations share a
      // test/part coordinate), or both. Heidenhain bakes the depth into
      // the CYCL DEF itself (unlike Fanuc's modal G81), so a depth change
      // needs a fresh CYCL DEF before the M99 call, not just the call.
      const stripped2 = line.replace(/^N\d+\s*/i, "");
      if (/^[XYZ]/i.test(stripped2) && !/^[GMTSO]/i.test(stripped2)) {
        const p = parseParams(stripped2);
        if (p.R !== undefined) lastR = p.R;
        if (p.F !== undefined) lastF = p.F;
        const x = p.X !== undefined ? p.X : curX;
        const y = p.Y !== undefined ? p.Y : curY;
        const z = p.Z !== undefined ? p.Z : curZ;
        if (p.Z !== undefined) {
          const builder = cycleDefs[activeCycle];
          if (builder) out.push(...builder(z, lastR, lastQ, lastF, lastS, surface));
        }
        out.push(`L ${fmtCoord("X", x)} ${fmtCoord("Y", y)} R0 FMAX M99`);
        curX = x; curY = y; curZ = z;
        continue;
      }
    }

    // --- G0: rapid ---
    if (/\bG0?0\b/i.test(line) && /\b[XYZ]/i.test(line)) {
      motionMode = "G0";
      const p = parseParams(line);
      const parts = ["L"];
      if (p.X !== undefined) { parts.push(fmtCoord("X", p.X)); curX = p.X; }
      if (p.Y !== undefined) { parts.push(fmtCoord("Y", p.Y)); curY = p.Y; }
      if (p.Z !== undefined) { parts.push(fmtCoord("Z", p.Z)); curZ = p.Z; }
      parts.push("R0", "FMAX");
      const mc = extractMCodes(line);
      pendingM.push(...mc);
      if (pendingM.length) parts.push(pendingM.shift());
      out.push(parts.join(" "));
      continue;
    }

    // --- G1: feed ---
    if (/\bG0?1\b/i.test(line) && /\b[XYZ]/i.test(line)) {
      motionMode = "G1";
      const p = parseParams(line);
      if (p.F) lastF = p.F;
      const parts = ["L"];
      if (p.X !== undefined) { parts.push(fmtCoord("X", p.X)); curX = p.X; }
      if (p.Y !== undefined) { parts.push(fmtCoord("Y", p.Y)); curY = p.Y; }
      if (p.Z !== undefined) { parts.push(fmtCoord("Z", p.Z)); curZ = p.Z; }
      parts.push("R0", `F${Math.round(lastF)}`);
      const mc = extractMCodes(line);
      pendingM.push(...mc);
      if (pendingM.length) parts.push(pendingM.shift());
      out.push(parts.join(" "));
      continue;
    }

    // --- G2/G3: circular arcs ---
    if (/\bG0?[23]\b/i.test(line)) {
      const isG2 = /\bG0?2\b/i.test(line);
      const p = parseParams(line);
      if (p.F) lastF = p.F;

      if (p.I !== undefined || p.J !== undefined) {
        const cx = curX + (p.I || 0);
        const cy = curY + (p.J || 0);
        out.push(`CC ${fmtCoord("X", cx)} ${fmtCoord("Y", cy)}`);
        const endX = p.X !== undefined ? p.X : curX;
        const endY = p.Y !== undefined ? p.Y : curY;
        const parts = ["C", fmtCoord("X", endX), fmtCoord("Y", endY)];
        if (p.Z !== undefined) parts.push(fmtCoord("Z", p.Z));
        parts.push(isG2 ? "DR-" : "DR+", "R0", `F${Math.round(lastF)}`);
        curX = endX; curY = endY;
        if (p.Z !== undefined) curZ = p.Z;
        out.push(parts.join(" "));
      } else if (p.R !== undefined) {
        const endX = p.X !== undefined ? p.X : curX;
        const endY = p.Y !== undefined ? p.Y : curY;
        const parts = ["CR", fmtCoord("X", endX), fmtCoord("Y", endY)];
        if (p.Z !== undefined) parts.push(fmtCoord("Z", p.Z));
        parts.push(`R+${fmtNum(Math.abs(p.R))}`, isG2 ? "DR-" : "DR+", `F${Math.round(lastF)}`);
        curX = endX; curY = endY;
        if (p.Z !== undefined) curZ = p.Z;
        out.push(parts.join(" "));
      }
      continue;
    }

    // --- Modal continuation ---
    if (/^[XYZF]/i.test(stripped) && !/^[GMTSO]/i.test(stripped)) {
      const p = parseParams(stripped);
      if (p.F) lastF = p.F;
      const parts = ["L"];
      if (p.X !== undefined) { parts.push(fmtCoord("X", p.X)); curX = p.X; }
      if (p.Y !== undefined) { parts.push(fmtCoord("Y", p.Y)); curY = p.Y; }
      if (p.Z !== undefined) { parts.push(fmtCoord("Z", p.Z)); curZ = p.Z; }
      parts.push("R0", motionMode === "G0" ? "FMAX" : `F${Math.round(lastF)}`);
      if (pendingM.length) parts.push(pendingM.shift());
      out.push(parts.join(" "));
      continue;
    }

    // --- Standalone S ---
    if (/^S\d+/i.test(stripped) && !/\b[GXYZ]\b/i.test(stripped)) {
      out.push(`TOOL CALL S${Math.round(lastS)}`);
      continue;
    }

    if (stripped && !/^[;%]/.test(stripped)) {
      out.push("; " + stripped);
    }
  }

  for (const m of pendingM) out.push(m);

  out.push(`END PGM ${name} MM`);

  return out.map((l, idx) => `${idx} ${l}`).join("\n");
}

export function isHeidenhain(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("heidenhain") || p.includes("klartext");
}
