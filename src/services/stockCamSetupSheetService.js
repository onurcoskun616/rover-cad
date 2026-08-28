import { OPERATION_TYPES } from "./stockCamPlanService.js";
import { toolWearStatus } from "./cncMagazineService.js";

// Printable job/routing sheet: a shop-floor document summarizing a
// stock-cam plan's stock, controller, and confirmed operations (in order)
// with whatever tool info the operator's own magazine lookup already
// attached to each op's params (toolDia/toolNum). Synchronous, plan-data
// only -- no FreeCAD/LLM call, since everything it needs is already
// sitting in the plan's own confirmed operations (see
// stockCamPlanService.js's setLastEstimatedMinutes for the one piece of
// data -- the total time estimate -- that DOES come from a FreeCAD call,
// but one already made at confirm/edit time, not repeated here).

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function opParamSummary(op) {
  const def = OPERATION_TYPES[op.type];
  if (!def) return "";
  return def.params
    .map((f) => {
      const v = op.params?.[f.name];
      if (v === undefined || v === null || v === "") return null;
      return `${f.label}: ${v}${f.unit || ""}`;
    })
    .filter(Boolean)
    .join(", ");
}

function opToolSummary(op) {
  const dia = op.params?.toolDia;
  const num = op.params?.toolNum;
  if (dia === undefined && num === undefined) return "-";
  const parts = [];
  if (dia !== undefined) parts.push(`Ø${dia}mm`);
  if (num !== undefined) parts.push(`T${String(num).padStart(2, "0")}`);
  // Takım Ömrü Takibi: only present when the client's own tool magazine
  // matched a real registered tool (toolRefId) -- see cncMagazineService.js.
  const refId = op.params?.toolRefId;
  if (typeof refId === "string" && refId) {
    const wear = toolWearStatus(refId);
    if (wear.minutes > 0) {
      parts.push(`(${wear.minutes} dk / sınır ${wear.limit} dk${wear.overLimit ? " ⚠ sınır aşıldı" : ""})`);
    }
  }
  return parts.join(" ");
}

export function buildSetupSheetHtml(plan, postName) {
  const rows = plan.operations
    .map((op, i) => {
      const label = OPERATION_TYPES[op.type]?.label || op.type;
      return [
        "<tr>",
        `<td>${i + 1}</td>`,
        `<td>${escapeHtml(label)}</td>`,
        `<td>${escapeHtml(opParamSummary(op))}</td>`,
        `<td>${escapeHtml(opToolSummary(op))}</td>`,
        "</tr>",
      ].join("");
    })
    .join("\n");

  const totalTime = Number.isFinite(plan.lastEstimatedMinutes) ? `${plan.lastEstimatedMinutes} dk` : "-";

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>Is Emri - ${escapeHtml(plan.planKey)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { margin-bottom: 16px; font-size: 14px; }
  .meta div { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { border: 1px solid #999; padding: 6px 8px; font-size: 13px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  @media print { body { margin: 8mm; } }
</style>
</head>
<body>
  <h1>CNC Is Emri</h1>
  <div class="meta">
    <div><b>Stok:</b> ${escapeHtml(plan.stock.w)} x ${escapeHtml(plan.stock.d)} x ${escapeHtml(plan.stock.h)} mm</div>
    <div><b>Kontrolcu:</b> ${escapeHtml(postName || "belirtilmedi")}</div>
    <div><b>Toplam islem:</b> ${plan.operations.length}</div>
    <div><b>Tahmini toplam sure:</b> ${escapeHtml(totalTime)}</div>
    <div><b>Olusturulma:</b> ${escapeHtml(new Date().toLocaleString("tr-TR"))}</div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Islem</th><th>Parametreler</th><th>Takim</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
