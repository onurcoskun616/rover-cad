/**
 * Transform standard Fanuc/ISO G-code into Siemens Sinumerik format.
 *
 * Sinumerik controllers understand standard ISO G-code moves (G0/G1/G2/G3),
 * so the main transformations are:
 *  1. Program header/footer → Sinumerik MPF format
 *  2. Tool changes           → T{n} D1 + M6 syntax
 *  3. Canned drilling cycles → CYCLE81/83/84/85
 *  4. Line-number cleanup    → strip N-words (Sinumerik uses labels, not N)
 *  5. Comment format          → (text) ➜ ; text
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

function positionLine(p) {
  const parts = [];
  if (p.X !== undefined) parts.push(`X${fmtNum(p.X)}`);
  if (p.Y !== undefined) parts.push(`Y${fmtNum(p.Y)}`);
  return parts.length ? `G0 ${parts.join(" ")}` : null;
}

function buildCycle81(z, rtp, rfp) {
  return `CYCLE81(${fmtNum(rtp)}, ${fmtNum(rfp)}, 0, ${fmtNum(z)})`;
}

function buildCycle83(z, rtp, rfp, peck) {
  const q = Math.abs(peck);
  return `CYCLE83(${fmtNum(rtp)}, ${fmtNum(rfp)}, 0, ${fmtNum(z)}, 0, ${fmtNum(q)}, 0, 0, 0, 0, 1, 0)`;
}

function buildCycle84(z, rtp, rfp, feed, sSpeed) {
  const pitch = sSpeed > 0 ? feed / sSpeed : 1;
  return `CYCLE84(${fmtNum(rtp)}, ${fmtNum(rfp)}, 0, ${fmtNum(z)}, 0, 0, 3, 0, ${fmtNum(pitch)})`;
}

function buildCycle85(z, rtp, rfp, feed) {
  return `CYCLE85(${fmtNum(rtp)}, ${fmtNum(rfp)}, 0, ${fmtNum(z)}, 0, 0, ${fmtNum(feed)})`;
}

const CYCLE_BUILDERS = {
  G81: (z, rtp, rfp, _q, _f, _s) => buildCycle81(z, rtp, rfp),
  G83: (z, rtp, rfp, q, _f, _s) => buildCycle83(z, rtp, rfp, q),
  G84: (z, rtp, rfp, _q, f, s) => buildCycle84(z, rtp, rfp, f, s),
  G85: (z, rtp, rfp, _q, f, _s) => buildCycle85(z, rtp, rfp, f),
};

/**
 * Transform Fanuc/ISO G-code into Sinumerik format.
 * @param {string} gcode   raw Fanuc G-code
 * @param {string} [partName] optional part name for the header
 * @returns {string} Sinumerik-formatted program
 */
export function transformToSinumerik(gcode, partName) {
  const name = (partName || "PART")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()
    .slice(0, 24);
  const lines = gcode.split(/\r?\n/);
  const out = [];

  out.push(`; %_N_${name}_MPF`);
  out.push("; Siemens Sinumerik CNC Programi");
  out.push("; Rover CAD tarafindan olusturuldu");
  out.push("");

  let activeCycle = null;
  let lastR = 2;
  let lastQ = 3;
  let lastF = 100;
  let lastS = 1000;
  let lastZ = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === "") {
      out.push("");
      continue;
    }

    if (line === "%" || /^O\d+/i.test(line)) continue;

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

    if (/\bM0?6\b/i.test(line) && /\bT(\d+)/i.test(line)) {
      const tNum = line.match(/\bT(\d+)/i)[1];
      out.push(`T${tNum} D1`);
      out.push("M6");
      continue;
    }
    if (/^T(\d+)\s*$/i.test(line)) {
      const tNum = line.match(/^T(\d+)/i)[1];
      out.push(`T${tNum} D1`);
      continue;
    }

    const cycleMatch = line.match(/\bG(8[1345])\b/i);
    if (cycleMatch) {
      const cycleCode = "G" + cycleMatch[1];
      const p = parseParams(line);
      if (p.R !== undefined) lastR = p.R;
      if (p.Q !== undefined) lastQ = p.Q;
      if (p.F !== undefined) lastF = p.F;
      if (p.Z !== undefined) lastZ = p.Z;

      const pos = positionLine(p);
      if (pos) out.push(pos);

      const builder = CYCLE_BUILDERS[cycleCode];
      if (builder) {
        out.push(builder(lastZ, lastR, 0, lastQ, lastF, lastS));
      }
      activeCycle = cycleCode;
      continue;
    }

    if (/\bG80\b/i.test(line)) {
      activeCycle = null;
      out.push("; Dongu sonu");
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
        const pos = positionLine(p);
        if (pos) out.push(pos);
        if (p.Z !== undefined) lastZ = p.Z;
        const builder = CYCLE_BUILDERS[activeCycle];
        if (builder) {
          out.push(builder(lastZ, lastR, 0, lastQ, lastF, lastS));
        }
        continue;
      }
    }

    let cleaned = line.replace(/^N\d+\s*/i, "");

    if (/\bM0?2\b/i.test(cleaned) && !/\bM0?[356]\b/i.test(cleaned)) {
      cleaned = cleaned.replace(/\bM0?2\b/i, "M30");
    }

    out.push(cleaned);
  }

  const lastLine = out
    .slice()
    .reverse()
    .find((l) => l.trim() !== "");
  if (!lastLine || !/\bM30\b/i.test(lastLine)) {
    out.push("M30");
  }

  return out.join("\n");
}

export function isSinumerik(postName) {
  const p = String(postName || "").toLowerCase();
  return p.includes("siemens") || p.includes("sinumerik");
}
