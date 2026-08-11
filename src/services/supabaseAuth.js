import { config } from "../config.js";

function authUrl(path) {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw Object.assign(new Error("Supabase Auth is not configured"), {
      status: 503,
      code: "AUTH_NOT_CONFIGURED",
    });
  }
  return `${config.supabase.url.replace(/\/$/, "")}/auth/v1${path}`;
}

async function authRequest(path, { method = "GET", token, body } = {}) {
  const response = await fetch(authUrl(path), {
    method,
    headers: {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${token || config.supabase.anonKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.msg || payload.message || payload.error_description || "Kimlik doğrulama başarısız");
    error.status = response.status;
    error.code = payload.code || "AUTH_ERROR";
    throw error;
  }
  return payload;
}

export function registerWithSupabase({ name, email, password }) {
  return authRequest("/signup", {
    method: "POST",
    body: {
      email: String(email ?? "").trim().toLowerCase(),
      password: String(password ?? ""),
      data: { name: String(name ?? "").trim() },
    },
  });
}

export function loginWithSupabase({ email, password }) {
  return authRequest("/token?grant_type=password", {
    method: "POST",
    body: {
      email: String(email ?? "").trim().toLowerCase(),
      password: String(password ?? ""),
    },
  });
}

export function getSupabaseUser(token) {
  if (!token) return null;
  return authRequest("/user", { token }).catch((error) => {
    if (error.status === 401 || error.status === 403) return null;
    throw error;
  });
}

export function googleOAuthUrl(redirectTo) {
  const url = new URL(authUrl("/authorize"));
  url.searchParams.set("provider", "google");
  if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
  return url.toString();
}
