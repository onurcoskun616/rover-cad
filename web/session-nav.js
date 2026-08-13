const API_BASE = "https://api.topkapikoleji.org";
const token = localStorage.getItem("rover_session");
document.getElementById("logout-btn")?.addEventListener("click", () => {
  localStorage.removeItem("rover_session"); localStorage.removeItem("rover_refresh"); window.location.replace("login.html");
});
if (token) {
  fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => {
      if (r.status === 401 || r.status === 403) {
        localStorage.removeItem("rover_session");
        localStorage.removeItem("rover_refresh");
        window.location.replace("login.html");
        return null;
      }
      return r.ok ? r.json() : null;
    })
    .then((data) => {
      if (!data) return;
      const link = document.getElementById("admin-link");
      if (link) link.hidden = data.user?.role !== "admin";
    })
    .catch(() => {});
} else if (!/login\.html/.test(location.pathname)) {
  window.location.replace("login.html");
}
