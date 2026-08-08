/**
 * Transform standard Fanuc/ISO G-code into Heidenhain Klartext format.
 *
 * Klartext is a conversational CNC language completely different from G-code:
 *  - L X+10 Y+20 R0 FMAX          (rapid linear)
 *  - L X+10 Y+20 R0 F600          (feed linear)
 *  - CC X+cx Y+cy / C X+ex Y+ey   (circular arc via center)
 *  - TOOL CALL {n} Z S{rpm}       (tool change)
 *  - CYCL DEF 200 DRILLING ...    (canned cycles)
 *  - BEGIN PGM / END PGM          (program structure)
 *  - Every line is numbered sequentially starting from 0
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

// --- Cycle definitions (modern CYCL DEF 200+ format) -------------------------

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

const CYCLE_DEFS = {
  G81: (z, r, _q, f, _s, sfc) => cyclDef200(z, r, f, sfc),
  G83: (z, r, q, f, _s, sfc) => cyclDef205(z, r, q, f, sfc),
  G84: (z, r, _q, f, s, sfc) => {
    const pitch = s > 0 ? f / s : 1;
    return cyclDef207(z, r, pitch, sfc);
  },
  G85: (z, r, _q, f, _s, sfc) => cyclDef201(z, r, f, sfc),
};

/**
 * Transform Fanuc/ISO G-code into Heidenhain Klartext.
 * @param {string} gcode   raw Fanuc G-code
 * @param {string} [partName] part name for header
 * @returns {string} Klartext program with line numbers
 */
export function transformToHeidenhain(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()
    .slice(0, 24);
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
  out.push("; Rover CAD tarafindan olusturuldu");

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

    // --- Tool change (look ahead for S on the next few lines) ---
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

    // --- Pure mode lines (no coordinates) ---
    const stripped = line.replace(/^N\d+\s*/i, "");
    if (/^(G\d+\s*)+$/i.test(stripped) && !/\b[XYZIJKRF]\b/i.test(stripped)) {
      if (/\bG0?0\b/i.test(stripped)) motionMode = "G0";
      if (/\bG0?1\b/i.test(stripped)) motionMode = "G1";
      continue;
    }

    // --- Spindle / coolant standalone ---
    if (/\bM0?3\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) {
      pendingM.push("M3");
      continue;
    }
    if (/\bM0?4\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) {
      pendingM.push("M4");
      continue;
    }
    if (/\bM0?5\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) {
      pendingM.push("M5");
      continue;
    }
    if (/\bM0?8\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) {
      pendingM.push("M8");
      continue;
    }
    if (/\bM0?9\b/i.test(line) && !/\b[GXYZ]\b/i.test(line)) {
      pendingM.push("M9");
      continue;
    }
    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) {
      continue;
    }

    // --- Canned drilling cycles ---
    const cycleMatch = line.match(/\bG(8[1345])\b/i);
    if (cycleMatch) {
      const code = "G" + cycleMatch[1];
      const p = parseParams(line);
      if (p.R !== undefined) lastR = p.R;
      if (p.Q !== undefined) lastQ = p.Q;
      if (p.F !== undefined) lastF = p.F;
      const z = p.Z !== undefined ? p.Z : curZ;

      const builder = CYCLE_DEFS[code];
      if (builder) {
        out.push(...builder(z, lastR, lastQ, lastF, lastS, surface));
      }

      if (p.X !== undefined || p.Y !== undefined) {
        const x = p.X !== undefined ? p.X : curX;
        const y = p.Y !== undefined ? p.Y : curY;
        out.push(`L ${fmtCoord("X", x)} ${fmtCoord("Y", y)} R0 FMAX M99`);
        curX = x;
        curY = y;
      }
      activeCycle = code;
      continue;
    }

    if (/\bG80\b/i.test(line)) {
      activeCycle = null;
      continue;
    }

    if (
      activeCycle &&
      /\b[XY]/i.test(line) &&
      !/\bG[0-3]\d?\b/i.test(line) &&
      !/\bG8/i.test(line)
    ) {
      const p = parseParams(line);
      if (p.X !== undefined || p.Y !== undefined) {
        const x = p.X !== undefined ? p.X : curX;
        const y = p.Y !== undefined ? p.Y : curY;
        out.push(`L ${fmtCoord("X", x)} ${fmtCoord("Y", y)} R0 FMAX M99`);
        curX = x;
        curY = y;
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
        parts.push(isG2 ? "DR-" : "DR+");
        parts.push("R0", `F${Math.round(lastF)}`);
        curX = endX;
        curY = endY;
        if (p.Z !== undefined) curZ = p.Z;
        out.push(parts.join(" "));
      } else if (p.R !== undefined) {
        const endX = p.X !== undefined ? p.X : curX;
        const endY = p.Y !== undefined ? p.Y : curY;
        const rSign = Math.abs(p.R) >= 0 ? "+" : "";
        const parts = [
          "CR",
          fmtCoord("X", endX),
          fmtCoord("Y", endY),
        ];
        if (p.Z !== undefined) parts.push(fmtCoord("Z", p.Z));
        parts.push(`R${rSign}${fmtNum(Math.abs(p.R))}`);
        parts.push(isG2 ? "DR-" : "DR+");
        parts.push(`F${Math.round(lastF)}`);
        curX = endX;
        curY = endY;
        if (p.Z !== undefined) curZ = p.Z;
        out.push(parts.join(" "));
      }
      continue;
    }

    // --- Modal continuation: coordinates without explicit G-code ---
    if (/^[XYZF]/i.test(stripped) && !/^[GMTSO]/i.test(stripped)) {
      const p = parseParams(stripped);
      if (p.F) lastF = p.F;
      const parts = ["L"];
      if (p.X !== undefined) { parts.push(fmtCoord("X", p.X)); curX = p.X; }
      if (p.Y !== undefined) { parts.push(fmtCoord("Y", p.Y)); curY = p.Y; }
      if (p.Z !== undefined) { parts.push(fmtCoord("Z", p.Z)); curZ = p.Z; }
      parts.push("R0");
      parts.push(motionMode === "G0" ? "FMAX" : `F${Math.round(lastF)}`);
      if (pendingM.length) parts.push(pendingM.shift());
      out.push(parts.join(" "));
      continue;
    }

    // --- Standalone S (spindle speed change without tool change) ---
    if (/^S\d+/i.test(stripped) && !/\b[GXYZ]\b/i.test(stripped)) {
      out.push(`TOOL CALL S${Math.round(lastS)}`);
      continue;
    }

    // --- Anything else: pass through as comment ---
    if (stripped && !/^[;%]/.test(stripped)) {
      out.push("; " + stripped);
    }
  }

  for (const m of pendingM) {
    out.push(m);
  }

  out.push(`END PGM ${name} MM`);

  return out.map((l, idx) => `${idx} ${l}`).join("\n");
}

export function isHeidenhain(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("heidenhain") || p.includes("klartext");
}
