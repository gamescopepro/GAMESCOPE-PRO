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

function isSupportedPlatformName(value: unknown): boolean {
  const name = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["pc", "windows", "microsoft windows", "linux", "macos", "mac os", "steam deck"].includes(name)) return true;
  if (/^(playstation(?:\s|$)|ps\s?(?:1|2|3|4|5)\b|psp\b|ps vita\b)/i.test(name)) return true;
  return /^xbox(?:\s|$)/i.test(name);
}

function gameHasSupportedPlatform(game: RawgGame): boolean {
  return Array.isArray(game.platforms) && game.platforms.some((item) =>
    isSupportedPlatformName(item?.platform?.name)
  );
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
      const error = new Error("Upstream HTTP " + result.status + ": " + String(parsed?.detail ?? parsed?.error ?? "request failed").slice(0, 240));
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

async function restRequestAll(path: string, pageSize = 1000): Promise<any[]> {
  const separator = path.includes("?") ? "&" : "?";
  const all: any[] = [];
  for (let offset = 0; offset < 100_000; offset += pageSize) {
    const page = await restRequest(
      path + separator + "order=id.asc&limit=" + pageSize + "&offset=" + offset,
    );
    if (!Array.isArray(page)) throw new Error("Supabase paginated query returned a non-array response.");
    all.push(...page);
    if (page.length < pageSize) return all;
  }
  throw new Error("Supabase catalog exceeded the 100,000-row safety pagination limit.");
}



function normalizeCatalogWrite(row: Partial<CatalogRow>): CatalogRow {
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? "").trim(),
    genre: row.genre ?? "ژانر نامشخص",
    platforms: row.platforms ?? "نامشخص",
    emoji: row.emoji ?? "🎮",
    critic: row.critic ?? null,
    publisher: row.publisher ?? null,
    release_date: row.release_date ?? null,
    release_status: row.release_status ?? "unknown",
    store_url: row.store_url ?? null,
    is_hidden: row.is_hidden ?? false,
    is_builtin: row.is_builtin ?? false,
    updated_at: row.updated_at ?? nowIso,
  };
}

async function upsertCatalogRows(rows: Partial<CatalogRow>[]): Promise<void> {
  const normalized = rows
    .map(normalizeCatalogWrite)
    .filter((row) => row.id && row.title);
  for (let offset = 0; offset < normalized.length; offset += 100) {
    await restRequest("site_catalog?on_conflict=id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(normalized.slice(offset, offset + 100)),
    });
  }
}

type SupplementalSyncResult = {
  enabled: boolean;
  skipped?: boolean;
  discovered: number;
  added: number;
  updated: number;
  errors: string[];
  items: Array<{ kind: string; title: string; text: string }>;
};

function releaseDateFromUnknown(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim()) {
    const match = value.match(/\\d{4}-\\d{2}-\\d{2}/);
    if (match) return match[0];
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return releaseDateFromUnknown(record.date ?? record.timestamp ?? record.value);
  }
  return null;
}

async function mergeSupplementalGame(
  sourceId: string,
  title: string,
  genre: string | null,
  platforms: string,
  publisher: string | null,
  releaseDate: string | null,
  releaseStatus: string,
  storeUrl: string | null,
): Promise<"added" | "updated" | "unchanged" | "hidden"> {
  const existingRows = await restRequest(
    "site_catalog?select=id,title,genre,platforms,emoji,critic,publisher,release_date,release_status,store_url,is_hidden,is_builtin&title=eq." +
      encodeURIComponent(title) + "&limit=10",
  );
  const sourceRows = await restRequest(
    "site_catalog?select=id,title,genre,platforms,emoji,critic,publisher,release_date,release_status,store_url,is_hidden,is_builtin&id=eq." +
      encodeURIComponent(sourceId) + "&limit=1",
  );
  const sourceExisting = Array.isArray(sourceRows) ? sourceRows[0] : null;
  const sameTitle = Array.isArray(existingRows)
    ? existingRows.find((row: any) =>
        normalizeName(row?.title) === normalizeName(title) &&
        String(row?.id) !== sourceId &&
        !String(row?.id ?? "").startsWith("steam_") &&
        !String(row?.id ?? "").startsWith("gog_") &&
        !String(row?.id ?? "").startsWith("igdb_"),
      )
    : null;
  const target = sameTitle || sourceExisting;
  if (target?.is_hidden) return "hidden";

  const today = dateString(new Date());
  const nextPlatforms = [...new Set(
    String(target?.platforms ?? platforms).split(/[،,]/).map((x: string) => x.trim()).filter(Boolean).concat(
      platforms.split(/[،,]/).map((x: string) => x.trim()).filter(Boolean),
    ),
  )].join("، ");
  const next: CatalogRow = normalizeCatalogWrite({
    ...(target ?? {}),
    id: String(target?.id ?? sourceId),
    title: String(target?.title ?? title),
    genre: target?.genre && target.genre !== "ژانر نامشخص" ? target.genre : (genre || target?.genre || "ژانر نامشخص"),
    platforms: nextPlatforms || platforms,
    emoji: target?.emoji || "🎮",
    critic: target?.critic ?? null,
    publisher: target?.publisher || publisher || null,
    release_date: target?.release_date || releaseDate || null,
    release_status: releaseStatus !== "unknown"
      ? releaseStatus
      : (target?.release_status || "unknown"),
    store_url: target?.store_url || storeUrl || null,
    is_hidden: false,
    is_builtin: target?.is_builtin ?? false,
    updated_at: new Date().toISOString(),
  });

  const changedFields: Array<keyof CatalogRow> = [
    "genre", "platforms", "publisher", "release_date", "release_status", "store_url",
  ];
  const changed = !target || changedFields.some((key) =>
    String(next[key] ?? "") !== String((target as any)[key] ?? "")
  );
  if (!changed) return "unchanged";
  await upsertCatalogRows([next]);
  return target ? "updated" : "added";
}

async function syncGogCatalog(): Promise<SupplementalSyncResult> {
  const result: SupplementalSyncResult = {
    enabled: true, discovered: 0, added: 0, updated: 0, errors: [], items: [],
  };
  // GOG's public storefront listing endpoint is an undocumented/community-documented
  // interface. Treat it as best-effort and never let it block RAWG or Steam updates.
  const url = "https://embed.gog.com/games/ajax/filtered?mediaType=game&page=1&limit=50";
  const payload = await fetchJson(url, 18000);
  const products = Array.isArray(payload?.products) ? payload.products : [];
  if (!products.length && Number(payload?.totalResults ?? payload?.totalGamesFound ?? 0) > 0) {
    throw new Error("GOG listing returned an unexpected response format.");
  }
  const seen = new Set<string>();
  for (const product of products) {
    const id = Number(product?.id);
    const title = String(product?.title ?? "").trim();
    const systems = product?.worksOn ?? {};
    const isPc = Boolean(systems?.Windows || systems?.Mac || systems?.Linux);
    if (!Number.isSafeInteger(id) || id <= 0 || !title || !isPc || product?.isGame === false || product?.isMovie === true) continue;
    const key = normalizeName(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.discovered++;
    const releaseDate = releaseDateFromUnknown(product?.releaseDate);
    const releaseStatus = product?.isComingSoon
      ? "upcoming"
      : releaseDate
        ? (releaseDate > dateString(new Date()) ? "upcoming" : "released")
        : "unknown";
    const path = String(product?.url ?? (product?.slug ? "/game/" + product.slug : ""));
    const storeUrl = path.startsWith("https://")
      ? path
      : path.startsWith("/")
        ? "https://www.gog.com" + path
        : null;
    const outcome = await mergeSupplementalGame(
      "gog_" + id,
      title,
      String(product?.category ?? "").trim() || null,
      "PC",
      String(product?.publisher ?? "").trim() || null,
      releaseDate,
      releaseStatus,
      storeUrl,
    );
    if (outcome === "added") {
      result.added++;
      if (result.items.length < MAX_REPORT_ITEMS) result.items.push({
        kind: "new", title, text: "از فهرست فروشگاه GOG شناسایی و به کاتالوگ PC اضافه شد.",
      });
    } else if (outcome === "updated") {
      result.updated++;
      if (result.items.length < MAX_REPORT_ITEMS) result.items.push({
        kind: "updated", title, text: "اطلاعات بازی با داده‌های فروشگاه GOG تکمیل شد.",
      });
    }
  }
  return result;
}

async function syncIgdbCatalog(): Promise<SupplementalSyncResult> {
  const result: SupplementalSyncResult = {
    enabled: false, skipped: true, discovered: 0, added: 0, updated: 0, errors: [], items: [],
  };
  const clientId = Deno.env.get("IGDB_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("IGDB_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) return result;

  result.enabled = true;
  result.skipped = false;
  const tokenResponse = await fetchJson(
    "https://id.twitch.tv/oauth2/token?client_id=" + encodeURIComponent(clientId) +
      "&client_secret=" + encodeURIComponent(clientSecret) + "&grant_type=client_credentials",
    15000,
  );
  const accessToken = String(tokenResponse?.access_token ?? "");
  if (!accessToken) throw new Error("Twitch OAuth did not return an IGDB app access token.");

  const now = new Date();
  const from = Math.floor(new Date(now.getTime() - 45 * 86400000).getTime() / 1000);
  const to = Math.floor(new Date(now.getTime() + 3 * 365 * 86400000).getTime() / 1000);
  const query = [
    "fields name,first_release_date,genres.name,platforms.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,rating,aggregated_rating;",
    "where platforms = (6,7,8,9,11,12,48,49,167,169) & first_release_date >= " + from +
      " & first_release_date <= " + to + " & version_parent = null;",
    "sort first_release_date asc;",
    "limit 100;",
  ].join(" ");
  const response = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "text/plain",
      "Accept": "application/json",
    },
    body: query,
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text();
  let games: any;
  try { games = body ? JSON.parse(body) : []; } catch { games = []; }
  if (!response.ok || !Array.isArray(games)) {
    throw new Error("IGDB HTTP " + response.status + ": " + String(body).slice(0, 180));
  }

  for (const game of games) {
    const title = String(game?.name ?? "").trim();
    if (!title) continue;
    result.discovered++;
    const releaseDate = releaseDateFromUnknown(game?.first_release_date);
    const releaseStatus = releaseDate
      ? (releaseDate > dateString(new Date()) ? "upcoming" : "released")
      : "unknown";
    const platformList = Array.isArray(game?.platforms)
      ? game.platforms.map((p: any) => String(p?.name ?? "").trim()).filter(Boolean)
      : [];
    const platforms = [...new Set(platformList.map((name) => {
      const normalized = name.toLowerCase();
      if (/pc|windows|linux|macos|mac os/.test(normalized)) return "PC";
      if (/playstation\s*5|ps5/.test(normalized)) return "PS5";
      if (/playstation\s*4|ps4/.test(normalized)) return "PS4";
      if (/playstation\s*3|ps3/.test(normalized)) return "PS3";
      if (/playstation\s*2|ps2/.test(normalized)) return "PS2";
      if (/xbox.*series|series.*xbox/.test(normalized)) return "Xbox Series X|S";
      if (/xbox.*one|one.*xbox/.test(normalized)) return "Xbox One";
      if (/xbox/.test(normalized)) return "Xbox";
      return name;
    }))].join("، ") || "PC";
    const companies = Array.isArray(game?.involved_companies)
      ? game.involved_companies
        .filter((x: any) => x?.publisher || x?.developer)
        .map((x: any) => String(x?.company?.name ?? "").trim())
        .filter(Boolean)
      : [];
    const genre = Array.isArray(game?.genres)
      ? game.genres.map((x: any) => String(x?.name ?? "").trim()).filter(Boolean).join("، ")
      : "";
    const critic = Number.isFinite(Number(game?.aggregated_rating))
      ? Number(game.aggregated_rating) / 10
      : Number.isFinite(Number(game?.rating))
        ? Number(game.rating) / 10
        : null;
    const platformLower = platforms.toLowerCase();
    let storeUrl: string | null = null;
    if (/playstation 5|playstation 4|ps5|ps4/i.test(platforms)) {
      storeUrl = "https://store.playstation.com/en-us/search/" + encodeURIComponent(title);
    } else if (/xbox/i.test(platforms)) {
      storeUrl = "https://www.xbox.com/en-US/search?q=" + encodeURIComponent(title);
    } else if (/pc|windows/i.test(platformLower)) {
      storeUrl = "https://store.steampowered.com/search/?term=" + encodeURIComponent(title);
    }
    const outcome = await mergeSupplementalGame(
      "igdb_" + String(game.id),
      title,
      genre || null,
      platforms,
      [...new Set(companies)].slice(0, 2).join(" • ") || null,
      releaseDate,
      releaseStatus,
      storeUrl,
    );
    if (outcome === "added") {
      result.added++;
      if (result.items.length < MAX_REPORT_ITEMS) result.items.push({
        kind: "new", title, text: "از پایگاه داده IGDB شناسایی و به کاتالوگ چندپلتفرمی اضافه شد.",
      });
    } else if (outcome === "updated") {
      result.updated++;
      if (result.items.length < MAX_REPORT_ITEMS) result.items.push({
        kind: "updated", title, text: "اطلاعات پلتفرم، تاریخ انتشار یا شرکت از IGDB تکمیل شد.",
      });
    }
  }
  return result;
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


type SteamSyncResult = {
  enabled: boolean;
  queued: number;
  processed: number;
  added: number;
  updated: number;
  discovered: number;
  page: number;
  errors: string[];
  items: Array<{ kind: string; title: string; text: string }>;
};

function pgIn(values: string[]): string {
  return "in.(" + values.map((value) =>
    '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
  ).join(",") + ")";
}

async function syncSteamCatalog(): Promise<SteamSyncResult> {
  const result: SteamSyncResult = {
    enabled: true, queued: 0, processed: 0, added: 0, updated: 0,
    discovered: 0, page: 0, errors: [], items: [],
  };

  // SteamSpy's public catalogue endpoint needs no personal Steam Web API key.
  const stateRows = await restRequest(
    "steam_sync_state?id=eq.main&select=steamspy_page,last_steamspy_fetch_at",
  );
  let page = Math.max(0, Number(stateRows?.[0]?.steamspy_page ?? 0) || 0);
  const lastFetchedAt = stateRows?.[0]?.last_steamspy_fetch_at
    ? Date.parse(String(stateRows[0].last_steamspy_fetch_at))
    : 0;
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const mayFetchSteamSpy = !Number.isFinite(lastFetchedAt) ||
    now.getTime() - lastFetchedAt >= 60_000;

  if (mayFetchSteamSpy) {
    const url = "https://steamspy.com/api.php?request=all&page=" + page;
    const payload = await fetchJson(url, 25000);
    let sourceApps: any[] = [];
    if (Array.isArray(payload)) {
      sourceApps = payload;
    } else if (payload && typeof payload === "object") {
      sourceApps = Object.entries(payload).map(([key, value]) => ({
        ...(value && typeof value === "object" ? value as Record<string, unknown> : {}),
        appid: (value as any)?.appid ?? key,
      }));
    }
    const discovered = sourceApps.map((app: any) => ({
      appid: Number(app?.appid ?? app?.app_id),
      name: String(app?.name ?? "").trim(),
      publisher: String(app?.publisher ?? app?.developer ?? "").trim(),
      genre: String(app?.genre ?? "").trim(),
    })).filter((app) =>
      Number.isSafeInteger(app.appid) && app.appid > 0 &&
      app.name.length > 0 && app.name.length <= 180
    );
    if (sourceApps.length > 0 && discovered.length === 0) {
      throw new Error("SteamSpy returned data in an unexpected format.");
    }

    result.discovered = discovered.length;
    const ids = [...new Set(discovered.map((app) => app.appid))];
    const idRows: any[] = [];
    const titleRows: any[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100).map((appid) => "steam_" + appid);
      const rows = await restRequest(
        "site_catalog?select=*&id=" + encodeURIComponent(pgIn(chunk)),
      );
      if (Array.isArray(rows)) idRows.push(...rows);
    }
    const titleValues = [...new Set(discovered.map((app) => app.name))];
    for (let offset = 0; offset < titleValues.length; offset += 80) {
      const chunk = titleValues.slice(offset, offset + 80);
      const rows = await restRequest(
        "site_catalog?select=*&title=" + encodeURIComponent(pgIn(chunk)),
      );
      if (Array.isArray(rows)) titleRows.push(...rows);
    }

    const byId = new Map<string, any>(idRows.map((row) => [String(row.id), row]));
    const byTitle = new Map<string, any>();
    for (const row of titleRows) {
      const key = normalizeName(row?.title);
      if (!key) continue;
      const current = byTitle.get(key);
      // Prefer a hidden/manual RAWG record over a Steam record when exact-title
      // matches exist; separate Steam AppIDs must never be merged by title alone.
      if (!current || (String(current.id ?? "").startsWith("steam_") && !String(row?.id ?? "").startsWith("steam_"))) {
        byTitle.set(key, row);
      }
    }
    const catalogWrites = new Map<string, any>();
    const nowIso = now.toISOString();

    for (const app of discovered) {
      const catalogId = "steam_" + app.appid;
      const steamUrl = "https://store.steampowered.com/app/" + app.appid + "/";
      const existingById = byId.get(catalogId);
      if (existingById?.is_hidden) continue;

      const sameTitle = byTitle.get(normalizeName(app.name));
      const mergeableSameTitle = sameTitle &&
        String(sameTitle.id) !== catalogId &&
        !String(sameTitle.id ?? "").startsWith("steam_");
      if (mergeableSameTitle) {
        if (sameTitle.is_hidden) continue;
        const currentPlatforms = String(sameTitle.platforms ?? "");
        const hasPc = /\bpc\b/i.test(currentPlatforms);
        const next = {
          ...sameTitle,
          platforms: hasPc ? currentPlatforms : (currentPlatforms ? currentPlatforms + ", PC" : "PC"),
          // Preserve an existing store page; a PC store search is still available in the UI.
          store_url: sameTitle.store_url || steamUrl,
          updated_at: nowIso,
        };
        catalogWrites.set(String(next.id), next);
        byTitle.set(normalizeName(app.name), next);
        result.updated++;
      } else {
        const row = {
          ...(existingById ?? {}),
          id: catalogId,
          title: app.name,
          genre: existingById?.genre && existingById.genre !== "ژانر نامشخص"
            ? existingById.genre
            : app.genre || "ژانر نامشخص",
          platforms: "PC",
          emoji: existingById?.emoji || "🎮",
          critic: existingById?.critic ?? null,
          publisher: existingById?.publisher || app.publisher || null,
          release_date: existingById?.release_date ?? null,
          release_status: existingById?.release_status || "unknown",
          store_url: steamUrl,
          is_hidden: false,
          is_builtin: existingById?.is_builtin ?? false,
          updated_at: nowIso,
        };
        catalogWrites.set(catalogId, row);
        byTitle.set(normalizeName(app.name), row);
        if (existingById) result.updated++;
        else result.added++;
        if (!existingById && result.items.length < MAX_REPORT_ITEMS) {
          result.items.push({
            kind: "new",
            title: app.name,
            text: "از فهرست عمومی SteamSpy به کاتالوگ PC اضافه شد؛ تاریخ انتشار در انتظار تکمیل از منابع بازی است.",
          });
        }
      }
    }

    const writeRows = [...catalogWrites.values()].map(normalizeCatalogWrite);
    for (let offset = 0; offset < writeRows.length; offset += 100) {
      await restRequest("site_catalog?on_conflict=id", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(writeRows.slice(offset, offset + 100)),
      });
    }

    // Advance the page only after its catalogue rows have been safely stored.
    const nextPage = sourceApps.length >= 1000 ? page + 1 : 0;
    await restRequest("steam_sync_state?id=eq.main", {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        steamspy_page: nextPage,
        last_steamspy_fetch_at: nowIso,
        updated_at: nowIso,
      }),
    });
    page = nextPage;
  }
  result.page = page;

  // The Steam storefront's public featured feed is useful for new releases and upcoming games.
  // It is supplemental discovery, not a complete list of every unreleased Steam title.
  try {
    const featured = await fetchJson(
      "https://store.steampowered.com/api/featuredcategories/?cc=us&l=en",
      15000,
    );
    const featuredIds = new Set<number>();
    for (const categoryName of ["coming_soon", "new_releases", "top_sellers"]) {
      const items = featured?.[categoryName]?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const appid = Number(item?.id ?? item?.appid);
        if (Number.isSafeInteger(appid) && appid > 0) featuredIds.add(appid);
      }
    }
    const queueRows = [...featuredIds].map((appid) => ({
      appid,
      last_modified: nowSeconds,
    }));
    for (let offset = 0; offset < queueRows.length; offset += 500) {
      const chunk = queueRows.slice(offset, offset + 500);
      await restRequest("steam_sync_queue?on_conflict=appid", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
    }
    result.queued += queueRows.length;
  } catch (error) {
    result.errors.push("Steam featured feed: " +
      (error instanceof Error ? error.message : "request failed").slice(0, 180));
  }

  // Enrich a small, bounded number of featured AppIDs per run to respect public storefront limits.
  const pending = await restRequest(
    "steam_sync_queue?select=appid,last_modified&order=queued_at.asc&limit=8",
  );
  for (const queued of (Array.isArray(pending) ? pending : [])) {
    const appid = Number(queued?.appid);
    if (!Number.isSafeInteger(appid) || appid <= 0) continue;
    try {
      const detailPayload = await fetchJson(
        "https://store.steampowered.com/api/appdetails?appids=" + appid + "&cc=us&l=en",
        15000,
      );
      const detailEntry = detailPayload?.[String(appid)];
      const game = detailEntry?.success ? detailEntry?.data : null;
      const pcPlatforms = game?.platforms ?? {};
      const isPcGame = game?.type === "game" &&
        Boolean(pcPlatforms.windows || pcPlatforms.mac || pcPlatforms.linux);
      if (!isPcGame || !game?.name) {
        await restRequest("steam_sync_queue?appid=eq." + appid, { method: "DELETE" });
        result.processed++;
        continue;
      }

      const title = String(game.name).trim();
      const catalogId = "steam_" + appid;
      const existingById = await restRequest(
        "site_catalog?id=eq." + catalogId + "&select=*&limit=1",
      );
      const existing = Array.isArray(existingById) ? existingById[0] : null;
      if (existing?.is_hidden) {
        await restRequest("steam_sync_queue?appid=eq." + appid, { method: "DELETE" });
        result.processed++;
        continue;
      }

      const sameTitleRows = await restRequest(
        "site_catalog?title=eq." + encodeURIComponent(title) + "&select=*&limit=10",
      );
      const sameTitle = Array.isArray(sameTitleRows)
        ? sameTitleRows.find((row: any) =>
            String(row?.id) !== catalogId &&
            !String(row?.id ?? "").startsWith("steam_"),
          ) ?? null
        : null;
      const releaseText = String(game?.release_date?.date ?? "").trim();
      const parsedRelease = releaseText ? Date.parse(releaseText) : NaN;
      const releaseDate = Number.isFinite(parsedRelease)
        ? new Date(parsedRelease).toISOString().slice(0, 10)
        : null;
      const comingSoon = Boolean(game?.release_date?.coming_soon);
      const today = dateString(new Date());
      const releaseStatus = comingSoon ? "upcoming" :
        releaseDate ? (releaseDate > today ? "upcoming" : "released") : "unknown";
      const genres = Array.isArray(game?.genres)
        ? game.genres.map((item: any) => String(item?.description ?? "").trim()).filter(Boolean).join("، ")
        : "";
      const companies = [
        ...(Array.isArray(game?.publishers) ? game.publishers : []),
        ...(Array.isArray(game?.developers) ? game.developers : []),
      ].map((name: unknown) => String(name ?? "").trim()).filter(Boolean);
      const publisher = [...new Set(companies)].slice(0, 2).join(" • ") ||
        String(existing?.publisher ?? "") || null;
      const steamUrl = "https://store.steampowered.com/app/" + appid + "/";
      const mergeableSameTitle = Boolean(sameTitle) && !String(sameTitle?.id ?? "").startsWith("steam_");
      const target = mergeableSameTitle ? sameTitle : existing;

      if (mergeableSameTitle && sameTitle && !sameTitle.is_hidden) {
        const currentPlatforms = String(sameTitle.platforms ?? "");
        const hasPc = /\bpc\b/i.test(currentPlatforms);
        await restRequest("site_catalog?id=eq." + encodeURIComponent(String(sameTitle.id)), {
          method: "PATCH",
          headers: { "Prefer": "return=minimal" },
          body: JSON.stringify({
            platforms: hasPc ? currentPlatforms : (currentPlatforms ? currentPlatforms + ", PC" : "PC"),
            store_url: sameTitle.store_url || steamUrl,
            updated_at: new Date().toISOString(),
          }),
        });
        result.updated++;
        result.items.push({
          kind: "updated", title,
          text: "نسخهٔ Steam بررسی شد؛ پلتفرم PC و لینک مستقیم Steam ثبت شد.",
        });
      } else {
        const row: CatalogRow = {
          ...(target ?? {}),
          id: catalogId,
          title,
          genre: genres || target?.genre || "ژانر نامشخص",
          platforms: "PC",
          emoji: target?.emoji || "🎮",
          critic: target?.critic ?? null,
          publisher,
          release_date: releaseDate ?? target?.release_date ?? null,
          release_status: releaseStatus !== "unknown"
            ? releaseStatus
            : (target?.release_status || "unknown"),
          store_url: steamUrl,
          is_hidden: false,
          is_builtin: target?.is_builtin ?? false,
          updated_at: new Date().toISOString(),
        };
        await restRequest("site_catalog?on_conflict=id", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(row),
        });
        if (existing) result.updated++;
        else result.added++;
        result.items.push({
          kind: existing ? "updated" : "new",
          title,
          text: (existing ? "اطلاعات بازی Steam تکمیل شد" : "بازی جدید Steam به کاتالوگ افزوده شد") +
            " • " + (releaseStatus === "upcoming" ? "بازی آینده" :
              releaseStatus === "released" ? "منتشر شده" : "تاریخ انتشار نامشخص"),
        });
      }

      await restRequest("steam_sync_queue?appid=eq." + appid, { method: "DELETE" });
      result.processed++;
    } catch (error) {
      result.errors.push("Steam AppID " + appid + ": " +
        (error instanceof Error ? error.message : "خطای ناشناخته").slice(0, 180));
    }
  }
  return result;
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

  const futureGames = futureResult.games.filter(gameHasSupportedPlatform);
  const recentGames = recentResult.games.filter(gameHasSupportedPlatform);
  const candidates = new Map<string, RawgGame>();
  for (const game of futureGames) candidates.set(String(game.id), game);
  for (const game of recentGames) candidates.set(String(game.id), game);

  let existingRows: CatalogRow[];
  try {
    existingRows = await restRequestAll("site_catalog?select=id,title,genre,platforms,emoji,critic,publisher,release_date,release_status,store_url,is_hidden,is_builtin");
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
        body: JSON.stringify(batch.slice(offset, offset + 100).map(normalizeCatalogWrite)),
      });
    }

    let steamResult: SteamSyncResult = {
      enabled: true, queued: 0, processed: 0, added: 0, updated: 0, discovered: 0, page: 0, errors: [], items: [],
    };
    try {
      steamResult = await syncSteamCatalog();
      changedItems.push(...steamResult.items);
    } catch (error) {
      steamResult = {
        enabled: true, queued: 0, processed: 0, added: 0, updated: 0,
        discovered: 0, page: 0,
        errors: [error instanceof Error ? error.message : "Steam sync failed"], items: [],
      };
    }

    // The currently documented public GOG listing endpoint returned HTTP 400
    // during live verification. Keep it disabled until its current contract can be
    // confirmed; this prevents a known-broken provider from marking every run partial.
    const gogResult: SupplementalSyncResult = {
      enabled: false, skipped: true, discovered: 0, added: 0, updated: 0, errors: [], items: [],
    };

    let igdbResult: SupplementalSyncResult = {
      enabled: false, skipped: true, discovered: 0, added: 0, updated: 0, errors: [], items: [],
    };
    try {
      igdbResult = await syncIgdbCatalog();
      changedItems.push(...igdbResult.items);
    } catch (error) {
      igdbResult.errors.push(error instanceof Error ? error.message : "IGDB sync failed");
    }

    const errors = [futureResult.error, recentResult.error, ...steamResult.errors, ...gogResult.errors, ...igdbResult.errors].filter(Boolean);
    const activeSources = 1 + (steamResult.enabled ? 1 : 0) + (gogResult.enabled ? 1 : 0) + (igdbResult.enabled ? 1 : 0);
    const successfulSources = (futureResult.error ? 0 : 1) + (recentResult.error ? 0 : 1) + (steamResult.errors.length ? 0 : 1) + (gogResult.errors.length ? 0 : 1) + (igdbResult.errors.length ? 0 : (igdbResult.enabled ? 1 : 0));
    const bothEmptyDueToErrors = successfulSources === 0 && futureGames.length === 0 && recentGames.length === 0 && steamResult.processed === 0 && gogResult.discovered === 0;
    const status: "success" | "partial" | "failed" = bothEmptyDueToErrors ? "failed" : errors.length ? "partial" : "success";
    const totalAdded = added + steamResult.added + gogResult.added + igdbResult.added;
    const totalUpdated = updated + steamResult.updated + gogResult.updated + igdbResult.updated;
    const errorText = errors.length ? " خطای منبع: " + errors.join(" | ") : "";
    const steamText = " SteamSpy: " + steamResult.discovered +
      " مورد کشف شد؛ " + steamResult.queued + " شناسهٔ فروشگاه در صف قرار گرفت و " +
      steamResult.processed + " مورد بررسی شد (" + steamResult.added + " جدید، " + steamResult.updated + " تکمیل‌شده).";
    const gogText = " GOG فعلاً غیرفعال است؛ رابط عمومی هنگام تست پاسخ HTTP 400 داد و تا تأیید سازگاری دوباره داده‌ای از آن وارد نمی‌شود.";
    const igdbText = igdbResult.enabled
      ? " IGDB: " + igdbResult.discovered + " نتیجه بررسی شد (" + igdbResult.added + " جدید، " + igdbResult.updated + " تکمیل‌شده)."
      : " IGDB هنوز فعال نیست؛ برای فعال‌سازی امن، IGDB_CLIENT_ID و IGDB_CLIENT_SECRET باید در Edge Function Secrets تنظیم شوند.";
    const note =
      "همگام‌سازی مستقل سرور انجام شد: RAWG " +
      futureGames.length + " بازی آینده و " + recentGames.length +
      " بازی منتشرشدهٔ اخیر را دریافت کرد (حداکثر ۵ صفحه برای هر دسته)." +
      steamText + gogText + igdbText +
      " مجموع " + totalAdded + " بازی جدید و " + totalUpdated + " بازی تکمیل‌شده." +
      " این بررسی پوشش کامل همهٔ بازی‌های دنیا یا تمام فروشگاه‌ها را تضمین نمی‌کند." + errorText;

    await saveRun(status, totalAdded, totalUpdated, note, changedItems);
    return response({
      ok: status !== "failed",
      status,
      checked_at: now.toISOString(),
      future_found: futureGames.length,
      recent_found: recentGames.length,
      added: totalAdded,
      updated: totalUpdated,
      sources: {
        rawg: { enabled: true, future_found: futureGames.length, recent_found: recentGames.length, errors: [futureResult.error, recentResult.error].filter(Boolean).length },
        steam: {
          enabled: steamResult.enabled,
          source: "SteamSpy public catalogue + Steam Store featured/appdetails",
          page: steamResult.page, discovered: steamResult.discovered,
          queued: steamResult.queued, processed: steamResult.processed,
          added: steamResult.added, updated: steamResult.updated, errors: steamResult.errors.length,
        },
        gog: { enabled: gogResult.enabled, discovered: gogResult.discovered, added: gogResult.added, updated: gogResult.updated, errors: gogResult.errors.length },
        igdb: { enabled: igdbResult.enabled, skipped: Boolean(igdbResult.skipped), discovered: igdbResult.discovered, added: igdbResult.added, updated: igdbResult.updated, errors: igdbResult.errors.length },
      },
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
