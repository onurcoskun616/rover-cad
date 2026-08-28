import { OPERATION_TYPES } from "./stockCamPlanService.js";
import { toolWearStatus } from "./cncMagazineService.js";
import { computeStockCamCost } from "./stockCamCostService.js";
import { MATERIAL_CUTTING_DATA } from "./materialCuttingData.js";
import { buildToolChecklist } from "./stockCamGenerateService.js";

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

export function buildSetupSheetHtml(plan, postName, costInputs) {
  const rows = plan.operations
    .map((op, i) => {
      const label = OPERATION_TYPES[op.type]?.label || op.type;
      return [
        "<tr>",
        `<td>${i + 1}</td>`,
        `<td>${escapeHtml(label)}</td>`,
        `<td>${escapeHtml(opParamSummary(op))}</td>`,
        `<td>${escapeHtml(opToolSummary(op))}</td>`,
        `<td>${escapeHtml(op.note || "-")}</td>`,
        "</tr>",
      ].join("");
    })
    .join("\n");

  // Takım Ön-Kontrol Listesi: shown BEFORE the operations table so the
  // operator can prepare every tool before reading the job step-by-step.
  const checklist = buildToolChecklist(plan.operations);
  const checklistRows = checklist
    .map((t, i) => {
      const pitchStr = t.pitch ? ` (adım ${t.pitch}mm)` : "";
      const toolNumStr = t.toolNum != null ? `T${String(t.toolNum).padStart(2, "0")}` : "⚠ magazin eşleşmesi yok — elle hazırlayın";
      return `<tr><td>${i + 1}</td><td>${escapeHtml(t.kind)} Ø${escapeHtml(t.dia)}mm${escapeHtml(pitchStr)}</td><td>${escapeHtml(toolNumStr)}</td><td>${t.opCount}</td></tr>`;
    })
    .join("\n");
  const checklistSection = `
  <h2 style="font-size:15px;margin-top:20px;">Takim On-Kontrol Listesi</h2>
  <table>
    <thead><tr><th>#</th><th>Takim</th><th>Slot</th><th>Kullanildigi islem sayisi</th></tr></thead>
    <tbody>${checklistRows}</tbody>
  </table>`;

  const totalTime = Number.isFinite(plan.lastEstimatedMinutes) ? `${plan.lastEstimatedMinutes} dk` : "-";
  const matInfo = MATERIAL_CUTTING_DATA[plan.material];
  const coolantLine = matInfo?.coolant
    ? `${escapeHtml(matInfo.coolant.type)} — ${escapeHtml(matInfo.coolant.note)}`
    : "-";

  // Maliyet Hesaplama: optional -- only rendered when the operator actually
  // supplied at least one real cost input (never shown with silently-zeroed
  // numbers, which would look like a real "0 TL" quote).
  const hasCostInputs = costInputs && (Number(costInputs.materialPricePerKg) > 0 || Number(costInputs.hourlyRate) > 0);
  let costSection = "";
  if (hasCostInputs) {
    const quote = computeStockCamCost({
      stock: plan.stock,
      material: plan.material,
      minutes: plan.lastEstimatedMinutes,
      materialPricePerKg: costInputs.materialPricePerKg,
      hourlyRate: costInputs.hourlyRate,
      profitPct: costInputs.profitPct,
    });
    const costRows = quote.items
      .map((it) => `<tr><td>${escapeHtml(it.label)}</td><td>${escapeHtml(it.amount)} TL</td></tr>`)
      .join("\n");
    costSection = `
  <h2 style="font-size:15px;margin-top:20px;">Maliyet Dokumu</h2>
  <table>
    <tbody>${costRows}
      <tr><td><b>TOPLAM</b></td><td><b>${escapeHtml(quote.total)} TL</b></td></tr>
    </tbody>
  </table>
  <div style="font-size:11px;color:#666;margin-top:4px;">Bu tutar operatorun girdigi malzeme/saat ucretine gore hesaplanmistir; baglayici bir teklif degildir.</div>`;
  }

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
    <div><b>Malzeme:</b> ${escapeHtml(matInfo?.label || plan.material || "-")}</div>
    <div><b>Sogutma:</b> ${coolantLine}</div>
    <div><b>Kontrolcu:</b> ${escapeHtml(postName || "belirtilmedi")}</div>
    <div><b>Toplam islem:</b> ${plan.operations.length}</div>
    <div><b>Tahmini toplam sure:</b> ${escapeHtml(totalTime)}</div>
    <div><b>Olusturulma:</b> ${escapeHtml(new Date().toLocaleString("tr-TR"))}</div>
  </div>
  ${checklistSection}
  <table>
    <thead><tr><th>#</th><th>Islem</th><th>Parametreler</th><th>Takim</th><th>Not</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${costSection}
</body>
</html>`;
}
