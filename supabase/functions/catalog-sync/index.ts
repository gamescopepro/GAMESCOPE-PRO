import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const RAWG_BASE = "https://api.rawg.io/api";
const PAGE_SIZE = 40;
const MAX_PAGES_PER_CATEGORY = 5;
const DETAIL_LOOKUPS_PER_RUN = 10;
const MAX_REPORT_ITEMS = 30;

type RawgGame = {
  id: number | string;
  name?: string;
  released?: string | null;
  genres?: Array<{ name?: string }>;
  platforms?: Array<{ platform?: { name?: string } }>;
  publishers?: Array<{ name?: string }>;
  developers?: Array<{ name?: string }>;
  metacritic?: number | null;
  [key: string]: unknown;
};

type CatalogRow = {
  id: string;
  title: string;
  genre?: string | null;
  platforms?: string | null;
  emoji?: string | null;
  critic?: number | null;
  publisher?: string | null;
  release_date?: string | null;
  release_status?: string | null;
  store_url?: string | null;
  is_hidden?: boolean;
  is_builtin?: boolean;
  updated_at?: string;
};

function getServiceKey(): string {
  const secretMap = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretMap) {
    try {
      const parsed = JSON.parse(secretMap);
      if (typeof parsed?.default === "string" && parsed.default) return parsed.default;
      const first = Object.values(parsed ?? {}).find((value) => typeof value === "string" && value);
      if (typeof first === "string") return first;
    } catch {
      // Fall through to the legacy environment variable.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const SERVICE_KEY = getServiceKey();

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:zero|zeroth)\b/g, "0")
    .replace(/\b(?:one|first)\b/g, "1")
    .replace(/\b(?:two|second|ii)\b/g, "2")
    .replace(/\b(?:three|third|iii)\b/g, "3")
    .replace(/\b(?:four|fourth|iv)\b/g, "4")
    .replace(/\b(?:five|fifth|v)\b/g, "5")
    .replace(/\b(?:six|sixth|vi)\b/g, "6")
    .replace(/\b(?:seven|seventh|vii)\b/g, "7")
    .replace(/\b(?:eight|eighth|viii)\b/g, "8")
    .replace(/\b(?:nine|ninth|ix)\b/g, "9")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function companyNames(game: RawgGame | null | undefined): string[] {
  if (!game) return [];
  const names = [
    ...(Array.isArray(game.publishers) ? game.publishers : []),
    ...(Array.isArray(game.developers) ? game.developers : []),
  ].map((item) => String(item?.name ?? "").trim()).filter(Boolean);
  return [...new Set(names)].slice(0, 2);
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    const text = await result.text();
    let parsed: any = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { detail: text.slice(0, 500) }; }
    if (!result.ok) {
      const error = new Error("RAWG HTTP " + result.status + ": " + String(parsed?.detail ?? parsed?.error ?? "request failed").slice(0, 240));
      (error as any).status = result.status;
      throw error;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCategory(
  apiKey: string,
  startDate: string,
  endDate: string,
  ordering: string,
): Promise<{ games: RawgGame[]; pages: number; error: string | null }> {
  const all: RawgGame[] = [];
  const seen = new Set<string>();
  let nextUrl: string | null = null;
  let pages = 0;
  let error: string | null = null;

  const initial = new URL(RAWG_BASE + "/games");
  initial.searchParams.set("key", apiKey);
  initial.searchParams.set("dates", startDate + "," + endDate);
  initial.searchParams.set("ordering", ordering);
  initial.searchParams.set("page_size", String(PAGE_SIZE));
  nextUrl = initial.toString();

  while (nextUrl && pages < MAX_PAGES_PER_CATEGORY) {
    try {
      const parsed = await fetchJson(nextUrl);
      const rows = Array.isArray(parsed?.results) ? parsed.results : [];
      for (const game of rows) {
        const id = String(game?.id ?? "");
        if (id && !seen.has(id) && game?.name) {
          seen.add(id);
          all.push(game as RawgGame);
        }
      }
      nextUrl = typeof parsed?.next === "string" && parsed.next.startsWith("https://api.rawg.io/api/games")
        ? parsed.next
        : null;
      pages++;
    } catch (err) {
      error = err instanceof Error ? err.message : "RAWG request failed";
      break;
    }
  }
  return { games: all, pages, error };
}

async function restRequest(path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("apikey", SERVICE_KEY);
  headers.set("Authorization", "Bearer " + SERVICE_KEY);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const result = await fetch(PROJECT_URL + "/rest/v1/" + path, { ...init, headers });
  const text = await result.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!result.ok) {
    throw new Error("Supabase REST " + result.status + ": " + String(parsed?.message ?? parsed?.hint ?? parsed ?? "request failed").slice(0, 400));
  }
  return parsed;
}

async function verifyCronToken(token: string): Promise<boolean> {
  const result = await restRequest("rpc/verify_gamescope_catalog_cron_token", {
    method: "POST",
    body: JSON.stringify({ p_token: token }),
  });
  return result === true;
}

async function saveRun(status: "success" | "partial" | "failed", added: number, updated: number, note: string, items: unknown[]) {
  await restRequest("site_update_runs", {
    method: "POST",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({
      status,
      added_count: added,
      updated_count: updated,
      note: note.slice(0, 4000),
      items: items.slice(0, MAX_REPORT_ITEMS),
    }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  if (!PROJECT_URL || !SERVICE_KEY) return response({ error: "server_not_configured" }, 500);

  const suppliedToken = req.headers.get("x-gamescope-cron-token") ?? "";
  if (suppliedToken.length < 32) return response({ error: "unauthorized" }, 401);
  try {
    if (!(await verifyCronToken(suppliedToken))) return response({ error: "unauthorized" }, 401);
  } catch (error) {
    console.error("Cron token verification failed:", error instanceof Error ? error.message : "unknown error");
    return response({ error: "authorization_check_failed" }, 503);
  }

  const apiKey = Deno.env.get("RAWG_API_KEY") ?? "";
  if (!apiKey) return response({ error: "rawg_not_configured" }, 503);

  const now = new Date();
  const futureEnd = new Date(now);
  futureEnd.setUTCFullYear(futureEnd.getUTCFullYear() + 3);
  const recentStart = new Date(now);
  recentStart.setUTCDate(recentStart.getUTCDate() - 45);

  const [futureResult, recentResult] = await Promise.all([
    fetchCategory(apiKey, dateString(now), dateString(futureEnd), "released"),
    fetchCategory(apiKey, dateString(recentStart), dateString(now), "-released"),
  ]);

  const futureGames = futureResult.games;
  const recentGames = recentResult.games;
  const candidates = new Map<string, RawgGame>();
  for (const game of futureGames) candidates.set(String(game.id), game);
  for (const game of recentGames) candidates.set(String(game.id), game);

  let existingRows: CatalogRow[];
  try {
    existingRows = await restRequest("site_catalog?select=id,title,genre,platforms,emoji,critic,publisher,release_date,release_status,store_url,is_hidden,is_builtin");
    if (!Array.isArray(existingRows)) existingRows = [];
  } catch (error) {
    const message = "خواندن کاتالوگ عمومی ناموفق بود: " + (error instanceof Error ? error.message : "خطای ناشناخته");
    try { await saveRun("failed", 0, 0, message, []); } catch { /* Keep original error response. */ }
    return response({ error: "catalog_read_failed", message }, 502);
  }

  const byId = new Map(existingRows.map((row) => [String(row.id), row]));
  const byTitle = new Map(existingRows.map((row) => [normalizeName(row.title), row]));
  const today = dateString(now);
  const batch: CatalogRow[] = [];
  const changedItems: Array<{ kind: string; title: string; text: string }> = [];
  let added = 0;
  let updated = 0;
  let detailRequests = 0;

  for (const game of candidates.values()) {
    const rawId = "rawg_" + String(game.id);
    const existing = byId.get(rawId) ?? byTitle.get(normalizeName(game.name));
    let companies = companyNames(game);

    if (!companies.length && detailRequests < DETAIL_LOOKUPS_PER_RUN) {
      detailRequests++;
      try {
        const detail = await fetchJson(RAWG_BASE + "/games/" + encodeURIComponent(String(game.id)) + "?key=" + encodeURIComponent(apiKey));
        companies = companyNames(detail as RawgGame);
      } catch {
        // Publisher/developer enrichment is best-effort; keep the catalog sync alive.
      }
    }

    const releaseDate = game.released || existing?.release_date || null;
    const releaseStatus = releaseDate
      ? (releaseDate > today ? "upcoming" : "released")
      : (existing?.release_status || "unknown");
    const genre = Array.isArray(game.genres)
      ? game.genres.map((item) => String(item?.name ?? "").trim()).filter(Boolean).join("، ")
      : "";
    const platformNames = Array.isArray(game.platforms)
      ? game.platforms.map((item) => String(item?.platform?.name ?? "").trim()).filter(Boolean).join("، ")
      : "";
    const storeUrl = "https://store.playstation.com/en-us/search/" + encodeURIComponent(String(game.name ?? ""));

    if (existing) {
      const next: CatalogRow = { ...existing };
      if ((!next.publisher || !String(next.publisher).trim()) && companies.length) next.publisher = companies.join(" • ");
      if (!next.release_date && releaseDate) next.release_date = releaseDate;
      if ((!next.genre || next.genre === "ژانر نامشخص") && genre) next.genre = genre;
      if ((!next.platforms || !String(next.platforms).trim()) && platformNames) next.platforms = platformNames;
      if ((next.critic === null || next.critic === undefined) && typeof game.metacritic === "number") {
        next.critic = Math.round(game.metacritic) / 10;
      }
      if (!next.store_url) next.store_url = storeUrl;
      if (!next.emoji) next.emoji = "🎮";
      if (next.release_status !== releaseStatus) next.release_status = releaseStatus;

      const fields: Array<keyof CatalogRow> = ["publisher", "release_date", "genre", "critic", "store_url", "emoji", "release_status", "platforms"];
      const changed = fields.some((field) => String(next[field] ?? "") !== String(existing[field] ?? ""));
      if (changed) {
        next.updated_at = now.toISOString();
        batch.push(next);
        byId.set(String(next.id), next);
        byTitle.set(normalizeName(next.title), next);
        updated++;
        changedItems.push({
          kind: "base",
          title: next.title,
          text: "اطلاعات کاتالوگ به‌روزرسانی شد • " + (releaseStatus === "upcoming" ? "بازی آینده" : releaseStatus === "released" ? "منتشر شده" : "وضعیت نامشخص"),
        });
      }
    } else {
      const next: CatalogRow = {
        id: rawId,
        title: String(game.name ?? "").trim(),
        genre: genre || "ژانر نامشخص",
        platforms: platformNames || "نامشخص",
        emoji: "🎮",
        critic: typeof game.metacritic === "number" ? Math.round(game.metacritic) / 10 : null,
        publisher: companies.length ? companies.join(" • ") : null,
        release_date: releaseDate,
        release_status: releaseStatus,
        store_url: storeUrl,
        is_hidden: false,
        is_builtin: false,
      };
      batch.push(next);
      byId.set(rawId, next);
      byTitle.set(normalizeName(next.title), next);
      added++;
      changedItems.push({
        kind: "new",
        title: next.title,
        text: "به کاتالوگ عمومی افزوده شد" +
          (next.publisher ? " • شرکت: " + next.publisher : " • شرکت سازنده/ناشر در RAWG ثبت نشده") +
          " • " + (releaseStatus === "upcoming" ? "بازی آینده" : releaseStatus === "released" ? "منتشر شده" : "وضعیت انتشار نامشخص"),
      });
    }
  }

  try {
    for (let offset = 0; offset < batch.length; offset += 100) {
      await restRequest("site_catalog?on_conflict=id", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(batch.slice(offset, offset + 100)),
      });
    }

    const errors = [futureResult.error, recentResult.error].filter(Boolean);
    const bothEmptyDueToErrors = errors.length === 2 && futureGames.length === 0 && recentGames.length === 0;
    const status: "success" | "partial" | "failed" = bothEmptyDueToErrors ? "failed" : errors.length ? "partial" : "success";
    const errorText = errors.length ? " خطای منبع: " + errors.join(" | ") : "";
    const note =
      "همگام‌سازی مستقل سرور انجام شد: " +
      futureGames.length + " بازی آینده و " + recentGames.length +
      " بازی منتشرشدهٔ اخیر از RAWG برای همهٔ پلتفرم‌ها دریافت شد (حداکثر ۵ صفحه برای هر دسته). " +
      added + " بازی جدید و " + updated + " بازی به‌روزرسانی شد. " +
      "این بررسی پوشش کامل همهٔ بازی‌های دنیا یا تمام فروشگاه‌ها را تضمین نمی‌کند." + errorText;

    await saveRun(status, added, updated, note, changedItems);
    return response({
      ok: status !== "failed",
      status,
      checked_at: now.toISOString(),
      future_found: futureGames.length,
      recent_found: recentGames.length,
      added,
      updated,
      pages: { future: futureResult.pages, recent: recentResult.pages },
      report_saved: true,
    }, status === "failed" ? 502 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطای ناشناخته هنگام ذخیره";
    try { await saveRun("failed", added, updated, "همگام‌سازی سرور کامل نشد: " + message, changedItems); } catch { /* Keep original error response. */ }
    console.error("GAMESCOPE catalog sync failed:", message);
    return response({ error: "sync_failed", message }, 502);
  }
});
