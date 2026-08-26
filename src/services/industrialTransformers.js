/**
 * Post-processor transformers for Fanuc-compatible industrial controllers:
 *  - Mitsubishi Meldas
 *  - Mazak (EIA/ISO mode)
 *  - Okuma OSP
 *  - Haas (NGC / Classic)
 *  - Doosan
 *
 * All five understand standard ISO G-code (G0/G1/G2/G3, G81/G83/G84/G85)
 * but differ in program structure, decimal-point handling, safety blocks,
 * tool-change conventions, and a few controller-specific codes.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseParams(line) {
  const params = {};
  const re = /([A-Z])(-?\d+\.?\d*)/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    params[m[1].toUpperCase()] = m[2];
  }
  return params;
}

/**
 * Force decimal points on coordinate/feed values.  Okuma OSP requires this
 * (X10 without a dot is interpreted as X0.010); Mitsubishi and Mazak benefit
 * from the explicitness.  We target X, Y, Z, I, J, K, R, F values.
 */
function forceDecimals(line) {
  return line.replace(
    /([XYZIJKRFQ])(-?\d+)(?![\d.])/gi,
    (_, letter, num) => `${letter}${num}.`,
  );
}

function stripNWords(line) {
  return line.replace(/^N\d+\s*/i, "");
}

/** Lines that are pure modal-group settings already covered by the safety block. */
function isRedundantModeLine(line) {
  const clean = line.replace(/\s+/g, " ").trim().toUpperCase();
  if (/^(G90|G94|G17|G21|G40|G49|G80)(\s+(G90|G94|G17|G21|G40|G49|G80))*\s*$/.test(clean)) {
    return true;
  }
  return false;
}

function isComment(line) {
  return line.startsWith("(") || line.startsWith(";");
}

function convertComment(line) {
  if (line.startsWith(";")) return `(${line.slice(1).trim()})`;
  return line;
}

// ---------------------------------------------------------------------------
// Mitsubishi Meldas
// ---------------------------------------------------------------------------

export function isMitsubishi(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("mitsubishi") || p.includes("meldas");
}

export function transformToMeldas(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .toUpperCase()
    .slice(0, 20);
  const lines = gcode.split(/\r?\n/);
  const out = [];

  out.push("%");
  out.push("O0001");
  out.push(`(${name} - MITSUBISHI MELDAS)`);
  out.push("(ROVER CAD)");

  let headerDone = false;
  let safetyEmitted = false;
  let lastToolNum = null;

  for (const raw of lines) {
    const line = stripNWords(raw.trim());
    if (line === "" || line === "%" || /^O\d+/i.test(line)) continue;

    if (isComment(line)) {
      if (!headerDone) continue;
      out.push(convertComment(line));
      continue;
    }

    if (!headerDone) {
      headerDone = true;
    }

    if (!safetyEmitted && headerDone) {
      out.push("G80 G40 G49");
      out.push("G91 G28 Z0.");
      out.push("G90");
      safetyEmitted = true;
    }

    if (safetyEmitted && isRedundantModeLine(line)) continue;

    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      const tn = tNum.padStart(2, "0");
      lastToolNum = tn;
      out.push("G91 G28 Z0.");
      out.push(`T${tn} M6`);
      out.push(`G43 H${tn}`);
      continue;
    }
    if (/^T\d+\s*$/i.test(line)) continue;

    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) {
      continue;
    }

    out.push(forceDecimals(stripNWords(line)));
  }

  out.push("G91 G28 Z0.");
  out.push("G28 X0. Y0.");
  out.push("M30");
  out.push("%");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Mazak (EIA/ISO)
// ---------------------------------------------------------------------------

export function isMazak(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("mazak") || p.includes("mazatrol");
}

export function transformToMazak(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .toUpperCase()
    .slice(0, 20);
  const lines = gcode.split(/\r?\n/);
  const out = [];

  out.push("%");
  out.push("O0001");
  out.push(`(${name} - MAZAK EIA-ISO)`);
  out.push("(ROVER CAD)");

  let headerDone = false;
  let safetyEmitted = false;

  for (const raw of lines) {
    const line = stripNWords(raw.trim());
    if (line === "" || line === "%" || /^O\d+/i.test(line)) continue;

    if (isComment(line)) {
      if (!headerDone) continue;
      out.push(convertComment(line));
      continue;
    }

    if (!headerDone) headerDone = true;

    if (!safetyEmitted && headerDone) {
      out.push("G80 G40 G49");
      out.push("G91 G28 Z0.");
      out.push("G91 G28 X0. Y0.");
      out.push("G90 G17 G21 G40 G94");
      safetyEmitted = true;
    }

    if (safetyEmitted && isRedundantModeLine(line)) continue;

    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      const tn = tNum.padStart(2, "0");
      out.push("G91 G28 Z0.");
      out.push(`T${tn} M6`);
      out.push(`G43 H${tn}`);

      const sMatch = line.match(/\bS(\d+\.?\d*)/i);
      if (sMatch) out.push(`S${sMatch[1]} M3`);
      continue;
    }
    if (/^T\d+\s*$/i.test(line)) continue;

    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) {
      continue;
    }

    out.push(forceDecimals(stripNWords(line)));
  }

  out.push("G91 G28 Z0.");
  out.push("G91 G28 X0. Y0.");
  out.push("M30");
  out.push("%");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Okuma OSP
// ---------------------------------------------------------------------------

export function isOkuma(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("okuma") || p.includes("osp");
}

/**
 * Okuma OSP requires decimal points on ALL numeric values — a bare `X10`
 * is read as X0.010 (÷1000).  Additionally:
 *  - G54→G15 H01 work-offset mapping (G54-G59 → H01-H06)
 *  - Subprogram calls: M98 P{n} → CALL O{n}
 *  - Tool change: T{nn} / M6 on separate lines
 */
export function transformToOkumaOSP(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .toUpperCase()
    .slice(0, 20);
  const lines = gcode.split(/\r?\n/);
  const out = [];

  out.push(`O0001 (${name} - OKUMA OSP)`);
  out.push("(ROVER CAD)");

  let headerDone = false;
  let safetyEmitted = false;

  const WCS_MAP = {
    G54: "G15 H01",
    G55: "G15 H02",
    G56: "G15 H03",
    G57: "G15 H04",
    G58: "G15 H05",
    G59: "G15 H06",
  };

  for (const raw of lines) {
    let line = stripNWords(raw.trim());
    if (line === "" || line === "%" || /^O\d+/i.test(line)) continue;

    if (isComment(line)) {
      if (!headerDone) continue;
      out.push(convertComment(line));
      continue;
    }

    if (!headerDone) headerDone = true;

    if (!safetyEmitted && headerDone) {
      out.push("G80 G40 G49");
      out.push("G28 Z0.");
      out.push("G90 G17 G21 G94");
      safetyEmitted = true;
    }

    if (safetyEmitted && isRedundantModeLine(line)) continue;

    // Work-offset mapping: G54-G59 → G15 H01-H06
    for (const [fanuc, osp] of Object.entries(WCS_MAP)) {
      const re = new RegExp(`\\b${fanuc}\\b`, "i");
      if (re.test(line)) {
        line = line.replace(re, osp);
      }
    }

    // Subprogram calls: M98 P{n} → CALL O{n}
    const subMatch = line.match(/\bM98\s*P(\d+)/i);
    if (subMatch) {
      const subNum = subMatch[1].padStart(4, "0");
      out.push(`CALL O${subNum}`);
      continue;
    }
    if (/\bM99\b/i.test(line) && !/\b[XYZ]\b/i.test(line)) {
      out.push("RTS");
      continue;
    }

    // Tool change: T{nn} then M6 on separate line
    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      const tn = tNum.padStart(2, "0");
      out.push("G28 Z0.");
      out.push(`T${tn}`);
      out.push("M6");
      out.push(`G43 H${tn}`);

      const sMatch = line.match(/\bS(\d+\.?\d*)/i);
      if (sMatch) out.push(`S${sMatch[1]} M3`);
      continue;
    }
    if (/^T\d+\s*$/i.test(line)) {
      out.push(`T${line.match(/T(\d+)/i)[1].padStart(2, "0")}`);
      continue;
    }

    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) {
      continue;
    }

    out.push(forceDecimals(stripNWords(line)));
  }

  out.push("G28 Z0.");
  out.push("M30");
  out.push("%");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Haas (NGC / Classic)
// ---------------------------------------------------------------------------

export function isHaas(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("haas");
}

/**
 * Haas is largely Fanuc-compatible: same G54-G59 work offsets, same
 * G81-G89 canned cycles (confirmed against real Haas documentation, not
 * assumed). Two real, documented conventions actually differ:
 *  - Tool change: Haas expects T{n} and M6 on ONE line ("T2 M6"), not
 *    Fanuc's classic "pre-select T while the previous tool is still
 *    cutting, M6 alone later" split.
 *  - Tool-change retract: "G53 G0 Z0." (rapid in true machine coordinates)
 *    is the Haas-idiomatic tool-change position, in place of Fanuc's
 *    G91 G28 Z0. (incremental return-to-reference).
 * Unlike Okuma, Haas does NOT require forced decimal points (X10 parses
 * as X10.000 exactly like Fanuc) — that's an Okuma-specific quirk, not a
 * general "industrial controller" one, so it's deliberately not applied
 * here.
 */
export function transformToHaas(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .toUpperCase()
    .slice(0, 20);
  const lines = gcode.split(/\r?\n/);
  const out = [];

  out.push("%");
  out.push("O0001");
  out.push(`(${name} - HAAS)`);
  out.push("(ROVER CAD)");

  let headerDone = false;
  let safetyEmitted = false;

  for (const raw of lines) {
    const line = stripNWords(raw.trim());
    if (line === "" || line === "%" || /^O\d+/i.test(line)) continue;

    if (isComment(line)) {
      if (!headerDone) continue;
      out.push(convertComment(line));
      continue;
    }

    if (!headerDone) headerDone = true;

    if (!safetyEmitted && headerDone) {
      out.push("G80 G40 G49");
      out.push("G53 G0 Z0.");
      out.push("G90 G17 G21 G94");
      safetyEmitted = true;
    }

    if (safetyEmitted && isRedundantModeLine(line)) continue;

    // Haas-idiomatic tool-change retract in place of Fanuc's incremental
    // return-to-reference.
    if (/^G91\s+G28\s+Z0\.?\s*$/i.test(line) || /^G28\s+Z0\.?\s*$/i.test(line)) {
      out.push("G53 G0 Z0.");
      continue;
    }

    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      out.push("G53 G0 Z0.");
      out.push(`T${tNum} M6`);

      const sMatch = line.match(/\bS(\d+\.?\d*)/i);
      if (sMatch) out.push(`S${sMatch[1]} M3`);
      continue;
    }
    if (/^T\d+\s*$/i.test(line)) continue;

    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) {
      continue;
    }

    out.push(stripNWords(line));
  }

  out.push("G53 G0 Z0.");
  out.push("M30");
  out.push("%");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Doosan
// ---------------------------------------------------------------------------

export function isDoosan(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("doosan");
}

/**
 * Doosan machining centers overwhelmingly run genuinely Fanuc-compatible
 * controls (real machinists commonly describe their setup as simply
 * "Doosan/Fanuc") — standard G0-G3/G81-G89, standard G54-G59, standard
 * T{n} M6 tool change. The one Doosan-specific extension found in
 * real-world documentation is a pair of OPTIONAL tool-change-interlock
 * M-codes (M58/M59); they're advanced/machine-setup-dependent, not
 * required for a normal safe tool change, so they aren't invented here
 * without a firsthand-confirmed source. This transform is deliberately
 * conservative: standard Fanuc-style safety block, decimal forcing (never
 * wrong under standard parsing, just more explicit) and tool-change
 * reformatting like the other three industrial dialects above, but no
 * fabricated Doosan-only G/M-codes.
 */
export function transformToDoosan(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .toUpperCase()
    .slice(0, 20);
  const lines = gcode.split(/\r?\n/);
  const out = [];

  out.push("%");
  out.push("O0001");
  out.push(`(${name} - DOOSAN)`);
  out.push("(ROVER CAD)");

  let headerDone = false;
  let safetyEmitted = false;

  for (const raw of lines) {
    const line = stripNWords(raw.trim());
    if (line === "" || line === "%" || /^O\d+/i.test(line)) continue;

    if (isComment(line)) {
      if (!headerDone) continue;
      out.push(convertComment(line));
      continue;
    }

    if (!headerDone) headerDone = true;

    if (!safetyEmitted && headerDone) {
      out.push("G80 G40 G49");
      out.push("G91 G28 Z0.");
      out.push("G90 G17 G21 G94");
      safetyEmitted = true;
    }

    if (safetyEmitted && isRedundantModeLine(line)) continue;

    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      out.push("G91 G28 Z0.");
      out.push(`T${tNum} M6`);

      const sMatch = line.match(/\bS(\d+\.?\d*)/i);
      if (sMatch) out.push(`S${sMatch[1]} M3`);
      continue;
    }
    if (/^T\d+\s*$/i.test(line)) continue;

    if (/\bM30\b/i.test(line) || (/\bM0?2\b/i.test(line) && !/\bM0?[3-9]\b/i.test(line))) {
      continue;
    }

    out.push(forceDecimals(stripNWords(line)));
  }

  out.push("G91 G28 Z0.");
  out.push("M30");
  out.push("%");

  return out.join("\n");
}
