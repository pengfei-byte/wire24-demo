function explain(err, data, status) {
  if (data?.error) {
    const e = data.error;
    const wrapped = new Error(e.message || "Request failed");
    wrapped.code = e.code;
    wrapped.retryAfter = e.retry_after_ms;
    wrapped.payload = data;
    return wrapped;
  }
  if (err?.name === "TypeError" || /failed to fetch/i.test(err?.message || "")) {
    return new Error("The local server is not running. Start npm run dev, then refresh.");
  }
  return new Error(err?.message || `Request failed${status ? ` (${status})` : ""}`);
}

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
      ...options,
    });
  } catch (err) {
    throw explain(err);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw explain(null, data, res.status);
  return data;
}

export function fetchHealth() {
  return request("/api/health");
}

export function fetchBriefing(force = false) {
  return request(force ? "/api/briefing?force=1" : "/api/briefing");
}

export async function startBroadcast(body) {
  let res;
  try {
    res = await fetch("/api/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    throw explain(err);
  }
  const data = await res.json().catch(() => ({}));
  if (data?.briefing) return data;
  if (!res.ok) throw explain(null, data, res.status);
  return data;
}

export function closeSession(sessionId) {
  if (!sessionId) return Promise.resolve();
  return fetch(`/api/sessions/${sessionId}/close`, { method: "POST" }).catch(() => {});
}

export function heartbeat(sessionId) {
  if (!sessionId) return Promise.resolve();
  return fetch(`/api/sessions/${sessionId}/heartbeat`, { method: "POST" }).catch(() => {});
}
