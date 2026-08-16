const API_BASE = location.hostname === "localhost" || location.hostname === "127.0.0.1" ? location.origin : "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const fmt = new Intl.NumberFormat("tr-TR");
const byId = (id) => document.getElementById(id);

const emptyData = {
  stats: { users: 0, activeUsers: 0, monthlyTokensUsed: 0, files: 0 },
  usage: [],
  users: [],
  activity: [],
};

let allUsers = [];
let previewMode = false;
let currentUsage = [];

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderStats(stats) {
  const activeRate = stats.users ? Math.round((stats.activeUsers / stats.users) * 100) : 0;
  const items = [
    ["Toplam kullanıcı", fmt.format(stats.users), "gerçek kayıt", "users"],
    ["Aktif kullanıcı", fmt.format(stats.activeUsers), `%${activeRate} aktif`, "active"],
    ["Bu ay kullanılan", fmt.format(stats.monthlyTokensUsed), "token", "tokens"],
    ["Oluşturulan dosya", fmt.format(stats.files || 0), "arşiv", "files"]
  ];
  byId("stats").innerHTML = items.map(([label, value, note, tone]) => `<article><div class="admin-metric-icon ${tone}">${tone === "users" ? "◎" : tone === "active" ? "✓" : tone === "tokens" ? "↗" : "▤"}</div><div><span>${label}</span><strong>${value}</strong><small>${note}</small></div></article>`).join("");
}

function renderUsage(items = []) {
  const featureNames = { "/generate": "CAD model üretimi", "/generate-from-image": "Resimden CAD", "/revise": "CAD revizyonu", "/cam-confirm": "CAM / CNC üretimi", "/simulate/generate": "Simülasyon üretimi" };
  byId("llm-usage-list").innerHTML = items.length ? items.map((item) => {
    const path = String(item.feature).replace(/^POST\s+/, "");
    return `<tr><td><strong>${safeText(featureNames[path] || path)}</strong><small>${safeText(item.provider)}</small></td><td>${safeText(item.model)}</td><td>${fmt.format(item.calls)}</td><td>${fmt.format(item.inputTokens)}</td><td>${fmt.format(item.outputTokens)}</td><td>${fmt.format((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}</td><td><b>${fmt.format(item.totalTokens)}</b></td><td>$${Number(item.costUsd || 0).toFixed(2)}</td></tr>`;
  }).join("") : '<tr><td colspan="8">Henüz ölçülmüş LLM kullanımı bulunmuyor.</td></tr>';
}

function filteredUsers() {
  const query = byId("search").value.trim().toLocaleLowerCase("tr-TR");
  const status = byId("status-filter").value;
  const plan = byId("plan-filter").value;
  return allUsers.filter((user) => `${user.name} ${user.email}`.toLocaleLowerCase("tr-TR").includes(query) && (status === "all" || user.status === status) && (plan === "all" || user.plan === plan));
}

function renderUsers() {
  const users = filteredUsers();
  byId("user-count").textContent = `${fmt.format(allUsers.length)} kayıtlı kullanıcı`;
  byId("result-summary").textContent = users.length ? `${users.length} kullanıcı gösteriliyor` : "Sonuç bulunamadı";
  byId("users-list").innerHTML = users.length ? users.map((user) => {
    const totalLimit = Number(user.monthlyTokens) + Number(user.bonusTokens || 0);
    const rate = totalLimit ? Math.min(100, Math.round((user.usedTokens / totalLimit) * 100)) : 0;
    const remaining = Math.max(0, Number(user.remainingTokens ?? totalLimit - user.usedTokens - (user.reservedTokens || 0)));
    return `<tr data-user-id="${safeText(user.id)}">
      <td><div class="admin-user-cell"><span>${safeText(user.initials || user.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join(""))}</span><div><strong>${safeText(user.name)}</strong><small>${safeText(user.email)}</small></div></div></td>
      <td><select class="admin-inline-select" data-field="plan"><option value="free" ${user.plan === "free" ? "selected" : ""}>Ücretsiz</option><option value="pro" ${user.plan === "pro" ? "selected" : ""}>Pro</option></select></td>
      <td><div class="admin-usage-cell"><span><b>${fmt.format(user.usedTokens)}</b> / ${fmt.format(totalLimit)}</span><small>Kalan: ${fmt.format(remaining)}</small><i><em style="width:${rate}%"></em></i></div></td>
      <td><select class="admin-inline-select status-${safeText(user.status)}" data-field="status"><option value="active" ${user.status === "active" ? "selected" : ""}>Aktif</option><option value="blocked" ${user.status === "blocked" ? "selected" : ""}>Engelli</option></select></td>
      <td><div class="admin-token-cell"><input class="admin-quota-input" data-field="monthlyTokens" type="number" min="0" step="1000" value="${Number(user.monthlyTokens)}" aria-label="${safeText(user.name)} aylık token kotası"><div><button type="button" data-token-preset="50000">50K</button><button type="button" data-token-preset="100000">100K</button><button type="button" data-token-preset="250000">250K</button></div></div></td>
      <td><div class="admin-bonus-cell"><span>${fmt.format(user.bonusTokens || 0)}</span><button class="admin-grant-btn" data-grant="${safeText(user.id)}" type="button">+ Token ver</button></div></td>
      <td><button class="admin-save-btn" data-save="${safeText(user.id)}" type="button">Kaydet</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7"><div class="admin-empty-state"><strong>Gerçek kullanıcı kaydı bulunamadı.</strong><span>Kullanıcılar Supabase ile kayıt olup ilk giriş yaptıklarında burada görünür.</span></div></td></tr>`;
}

function renderActivity(items) {
  byId("activity-list").innerHTML = items.length
    ? items.map((item) => `<div class="admin-activity"><span class="${safeText(item.tone)}">${safeText(item.icon)}</span><div><strong>${safeText(item.title)}</strong><small>${safeText(item.detail)}</small></div><time>${safeText(item.time)}</time></div>`).join("")
    : `<div class="admin-empty-state"><strong>Henüz sistem hareketi yok.</strong><span>Gerçek kullanım başladığında hareketler burada listelenecek.</span></div>`;
}

function render(data, isPreview) {
  previewMode = isPreview;
  allUsers = data.users;
  currentUsage = data.usage || [];
  renderStats(data.stats);
  renderUsage(data.usage);
  renderUsers();
  renderActivity(data.activity ?? []);
  byId("preview-banner").hidden = !isPreview;
  byId("system-badge").textContent = isPreview ? "Uyarı" : "Aktif";
  byId("api-status-light").classList.toggle("is-warning", isPreview);
  byId("api-status-text").textContent = isPreview ? "Kontrol gerekiyor" : "Bağlı";
  byId("data-status-text").textContent = isPreview ? "Önizleme" : "Canlı veri";
}

async function loadAdmin() {
  try {
    const headers = { Authorization: `Bearer ${sessionToken}` };
    const [statsResponse, usersResponse, usageResponse] = await Promise.all([fetch(`${API_BASE}/admin/stats`, { headers }), fetch(`${API_BASE}/admin/users`, { headers }), fetch(`${API_BASE}/admin/usage-summary?days=31`, { headers })]);
    if (statsResponse.status === 401) { localStorage.removeItem("rover_session"); location.replace("login.html"); return; }
    if (statsResponse.status === 403) throw new Error("Bu hesapta yönetici yetkisi bulunmuyor.");
    if (!statsResponse.ok || !usersResponse.ok) throw new Error("Yönetim verileri alınamadı.");
    const stats = await statsResponse.json();
    const usersPayload = await usersResponse.json();
    const usagePayload = usageResponse.ok ? await usageResponse.json() : { usage: [] };
    render({ stats, users: usersPayload.users, usage: usagePayload.usage, activity: [] }, false);
  } catch (error) {
    render(emptyData, true);
    byId("admin-notice").textContent = error.message;
  }
}

["search", "status-filter", "plan-filter"].forEach((id) => byId(id).addEventListener(id === "search" ? "input" : "change", renderUsers));

byId("users-list").addEventListener("click", async (event) => {
  const preset = event.target.dataset.tokenPreset;
  const row = event.target.closest("tr");
  if (preset && row) {
    row.querySelector('[data-field="monthlyTokens"]').value = preset;
    byId("admin-notice").textContent = `${fmt.format(Number(preset))} token seçildi. Kaydet'e basın.`;
    return;
  }
  const id = event.target.dataset.save;
  if (!id) return;
  const body = {};
  row.querySelectorAll("[data-field]").forEach((field) => { body[field.dataset.field] = field.type === "number" ? Number(field.value) : field.value; });
  if (!previewMode) {
    const response = await fetch(`${API_BASE}/admin/users/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      byId("admin-notice").textContent = payload.error || "Değişiklik kaydedilemedi.";
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (payload.user) Object.assign(body, payload.user);
  }
  const user = allUsers.find((item) => String(item.id) === String(id));
  if (user) Object.assign(user, body);
  event.target.textContent = "Kaydedildi";
  byId("admin-notice").textContent = previewMode ? "Önizlemede kayıt yapılmadı." : "Kullanıcı ve token kotası güncellendi.";
  setTimeout(() => { event.target.textContent = "Kaydet"; renderUsers(); }, 1000);
});

byId("users-list").addEventListener("click", async (event) => {
  const userId = event.target.dataset.grant;
  if (!userId) return;
  const user = allUsers.find((u) => String(u.id) === String(userId));
  const input = prompt(`${user ? user.name + " kullanıcısına" : "Kullanıcıya"} kaç bonus token eklemek istiyorsunuz?`, "10000");
  if (!input) return;
  const amount = Number(input);
  if (!amount || amount <= 0) { byId("admin-notice").textContent = "Geçerli bir token miktarı giriniz."; return; }
  if (previewMode) {
    if (user) user.bonusTokens = (user.bonusTokens || 0) + amount;
    renderUsers();
    byId("admin-notice").textContent = `Önizleme: ${fmt.format(amount)} bonus token eklendi.`;
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/admin/users/${userId}/grant-tokens`, {
      method: "POST", headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!response.ok) { byId("admin-notice").textContent = "Token eklenemedi."; return; }
    const data = await response.json();
    const idx = allUsers.findIndex((u) => String(u.id) === String(userId));
    if (idx >= 0 && data.user) allUsers[idx] = data.user;
    renderUsers();
    byId("admin-notice").textContent = `${fmt.format(amount)} bonus token başarıyla eklendi.`;
  } catch { byId("admin-notice").textContent = "Token eklenirken hata oluştu."; }
});

document.querySelectorAll("[data-admin-action]").forEach((button) => button.addEventListener("click", () => {
  const action = button.dataset.adminAction;
  if (action === "tokens") {
    document.getElementById("users")?.scrollIntoView({ behavior: "smooth", block: "start" });
    byId("admin-notice").textContent = "Kullanıcı satırındaki aylık kota alanını değiştirip Kaydet'e basın.";
    return;
  }
  if (action === "export") {
    downloadUsageCsv();
    return;
  }
  if (action === "add") {
    location.href = "login.html";
    return;
  }
  if (action === "settings") {
    document.getElementById("system")?.scrollIntoView({ behavior: "smooth", block: "start" });
    byId("admin-notice").textContent = "Sistem ayarları ve bakım bilgileri bu bölümde.";
    return;
  }
}));

function downloadUsageCsv() {
  const rows = [
    ["İşlem", "Sağlayıcı", "Model", "Çağrı", "Giriş Token", "Çıkış Token", "Önbellek Token", "Toplam Token", "Maliyet USD"],
    ...currentUsage.map((item) => [
      item.feature,
      item.provider,
      item.model,
      item.calls,
      item.inputTokens,
      item.outputTokens,
      (Number(item.cacheReadTokens) || 0) + (Number(item.cacheWriteTokens) || 0),
      item.totalTokens,
      Number(item.costUsd || 0).toFixed(2),
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `topkapi-ai-kullanim-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  byId("admin-notice").textContent = "Kullanım raporu indirildi.";
}

byId("copy-maintenance-command")?.addEventListener("click", async () => {
  const command = byId("maintenance-command").textContent.trim();
  try {
    await navigator.clipboard.writeText(command);
    byId("admin-notice").textContent = "Bakım komutu kopyalandı. CMD penceresine yapıştırıp çalıştırabilirsiniz.";
  } catch {
    byId("admin-notice").textContent = "Kopyalanamadı. Komutu panelden seçip elle kopyalayın.";
  }
});

byId("logout-btn").addEventListener("click", () => { localStorage.removeItem("rover_session"); location.replace("login.html"); });
loadAdmin();
