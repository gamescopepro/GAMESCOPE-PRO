import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_SITE_ORIGINS = new Set([
  "https://gamescopepro.github.io",
  "https://sadraps595-gif.github.io"
]);
const RAWG_BASE = "https://api.rawg.io/api";
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const CACHE_TTL_LIST_MS = 60_000;
const CACHE_TTL_DETAIL_MS = 24 * 60 * 60_000;

type CacheEntry = { expiresAt: number; body: unknown; status: number };
type RateEntry = { startedAt: number; count: number };

const responseCache = new Map<string, CacheEntry>();
const rateLimits = new Map<string, RateEntry>();

const ALLOWED_PARAMS = new Set([
  "page", "page_size", "search", "ordering", "dates", "platforms", "stores",
  "search_precise", "parent_platforms", "metacritic", "exclude_additions",
  "exclude_parents", "exclude_game_series", "developers", "publishers", "genres",
  "tags", "added", "updated", "year"
]);

function json(data: unknown, status: number, origin: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  });
  if (origin && ALLOWED_SITE_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type, x-supabase-api-version");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function stripRawgApiKeyFromPagination(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const output = { ...(data as Record<string, unknown>) };
  for (const field of ["next", "previous"]) {
    const value = output[field];
    if (typeof value !== "string" || !value) continue;
    try {
      const url = new URL(value);
      if (url.hostname === "api.rawg.io") url.searchParams.delete("key");
      output[field] = url.toString();
    } catch {
      // Keep malformed pagination values; the client rejects them safely.
    }
  }
  return output;
}
function getClientKey(req: Request) {
  return req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function rateLimited(clientKey: string) {
  const now = Date.now();
  const current = rateLimits.get(clientKey);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(clientKey, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > MAX_REQUESTS_PER_WINDOW;
}

function cleanParams(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("پارامترهای درخواست معتبر نیستند.");
  }
  const output = new URLSearchParams();
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_PARAMS.has(key) || raw === null || raw === undefined || raw === "") continue;
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new Error("مقدار یکی از پارامترها معتبر نیست.");
    }
    const value = String(raw).trim();
    if (value.length > 180) throw new Error("طول یکی از پارامترها بیش از حد مجاز است.");
    if (key === "page" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) {
      throw new Error("شماره صفحه خارج از محدوده مجاز است.");
    }
    if (key === "page_size" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 40)) {
      throw new Error("تعداد نتایج هر صفحه باید بین ۱ تا ۴۰ باشد.");
    }
    output.set(key, value);
  }
  return output;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    if ((!origin || !ALLOWED_SITE_ORIGINS.has(origin))) return json({ error: "origin_not_allowed" }, 403, origin);
    return json({ ok: true }, 200, origin);
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);
  if ((!origin || !ALLOWED_SITE_ORIGINS.has(origin))) return json({ error: "origin_not_allowed" }, 403, origin);

  const clientKey = getClientKey(req);
  if (rateLimited(clientKey)) {
    return json({ error: "rate_limited", message: "تعداد درخواست‌ها زیاد است؛ یک دقیقه دیگر دوباره تلاش کن." }, 429, origin);
  }

  const apiKey = Deno.env.get("RAWG_API_KEY");
  if (!apiKey) {
    return json({
      error: "server_not_configured",
      message: "کلید RAWG هنوز در تنظیمات امن سرور ثبت نشده است."
    }, 503, origin);
  }

  try {
    const body = await req.json();
    const path = typeof body?.path === "string" ? body.path : "";
    if (!/^\/games(?:\/\d+)?$/.test(path)) {
      return json({ error: "endpoint_not_allowed" }, 400, origin);
    }

    const params = cleanParams(body.params);
    const target = new URL(RAWG_BASE + path);
    params.forEach((value, key) => target.searchParams.set(key, value));
    target.searchParams.set("key", apiKey);

    const cacheKey = path + "?" + [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => k + "=" + v).join("&");
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return json(cached.body, cached.status, origin);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let upstream: Response;
    try {
      upstream = await fetch(target.toString(), {
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    let data: unknown;
    try { data = await upstream.json(); }
    catch { data = { error: "upstream_invalid_response" }; }

    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      const message = upstream.status === 429
        ? "سقف درخواست سرویس بازی‌ها موقتاً پر شده است. کمی بعد دوباره تلاش کن."
        : upstream.status === 401 || upstream.status === 403
          ? "کلید سرویس بازی‌ها معتبر نیست یا دسترسی آن محدود شده است."
          : "سرویس اطلاعات بازی‌ها موقتاً خطا داد.";
      return json({ error: "rawg_upstream_error", message, upstream_status: upstream.status }, status, origin);
    }

    // Never send the upstream RAWG API key back to browsers in pagination URLs.
    const publicData = stripRawgApiKeyFromPagination(data);
    const ttl = path === "/games" ? CACHE_TTL_LIST_MS : CACHE_TTL_DETAIL_MS;
    responseCache.set(cacheKey, { body: publicData, status: 200, expiresAt: Date.now() + ttl });

    if (responseCache.size > 500) {
      const now = Date.now();
      for (const [key, entry] of responseCache) {
        if (entry.expiresAt <= now) responseCache.delete(key);
      }
      while (responseCache.size > 400) responseCache.delete(responseCache.keys().next().value!);
    }
    if (rateLimits.size > 5000) {
      const now = Date.now();
      for (const [key, entry] of rateLimits) {
        if (now - entry.startedAt >= RATE_WINDOW_MS) rateLimits.delete(key);
      }
    }

    return json(publicData, 200, origin);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return json({ error: "upstream_timeout", message: "پاسخ سرویس بازی‌ها دیر شد؛ دوباره تلاش کن." }, 504, origin);
    }
    return json({ error: "bad_request", message: error instanceof Error ? error.message : "درخواست نامعتبر است." }, 400, origin);
  }
});
