const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = 4179;
const GAME_TITLE = "GAMESCOPE Test Quest";
const FIXTURE = {
  id: 900001,
  name: GAME_TITLE,
  slug: "gamescope-test-quest",
  released: "2025-06-01",
  background_image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3C/svg%3E",
  dataSource: "STEAM",
  rating: 4.2,
  metacritic: 84,
  genres: [{ name: "Adventure" }],
  publishers: [{ name: "GAMESCOPE Test Studio" }],
  developers: [],
  platforms: [
    { platform: { name: "PC" } },
    { platform: { name: "PlayStation 5" } }
  ]
};
let observedSearchQuery = false;
let capturedCloudUploads = [];
const MOBILE_ONLY_FIXTURE = {
  id: 900002,
  name: "GAMESCOPE Mobile Only Must Be Filtered",
  released: "2025-06-01",
  platforms: [
    { platform: { name: "Android" } },
    { platform: { name: "iOS" } }
  ]
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sendJson(route, data, status = 200, extraHeaders = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "content-range": "0-0/0",
      ...extraHeaders
    },
    body: JSON.stringify(data)
  });
}

async function mockSupabase(route) {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;

  if (request.method() === "OPTIONS") {
    return route.fulfill({
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"
      }
    });
  }

  if (pathname.endsWith("/functions/v1/game-catalog")) {
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    const search = String(body?.params?.search || "").toLowerCase();
    if (search.includes("gamescope test quest")) observedSearchQuery = true;
    const results = search
      ? [FIXTURE, MOBILE_ONLY_FIXTURE]
      : [FIXTURE, MOBILE_ONLY_FIXTURE];
    return sendJson(route, {
      count: results.length,
      next: null,
      previous: null,
      results
    });
  }

  if (pathname.endsWith("/auth/v1/settings")) {
    return sendJson(route, {
      disable_signup: false,
      mailer_autoconfirm: true,
      sms_autoconfirm: false,
      external: {},
      password_min_length: 6
    });
  }

  if (pathname.endsWith("/rest/v1/site_settings")) {
    return sendJson(route, {
      id: "main",
      tagline: "کاتالوگ جهانی بازی‌های PlayStation، PC و Xbox",
      hero_title: "دنیای بازی‌ها، در یک کاتالوگ 🌍",
      hero_description: "محیط آزمایشی کنترل‌شده برای بررسی سلامت رابط کاربری."
    });
  }

  if (pathname.endsWith("/rest/v1/user_games")) {
    if (request.method() === "POST") {
      try {
        const body = request.postDataJSON();
        capturedCloudUploads.push(...(Array.isArray(body) ? body : body ? [body] : []));
      } catch {}
    }
    return sendJson(route, []);
  }

  if (
    pathname.endsWith("/rest/v1/site_catalog") ||
    pathname.endsWith("/rest/v1/site_update_runs") ||
    pathname.endsWith("/rest/v1/profiles")
  ) {
    return sendJson(route, []);
  }

  if (pathname.includes("/auth/v1/")) {
    return sendJson(route, { error: "No auth session in isolated browser test." }, 401);
  }

  return sendJson(route, []);
}

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1:" + PORT);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.resolve(ROOT, requested);
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, "index.html")) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      const type = ext === ".html" ? "text/html; charset=utf-8"
        : ext === ".svg" ? "image/svg+xml"
        : "application/octet-stream";
      response.writeHead(200, { "content-type": type });
      response.end(content);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    await context.route("https://axwjiwpwqoykvcbumixy.supabase.co/**", mockSupabase);
    const page = await context.newPage();
    await context.addInitScript(() => {
      const now = Date.now();
      if (!localStorage.getItem("gamescope-smoke-seeded")) {
        localStorage.setItem("sadra_pshub_v1", JSON.stringify([{
          id: "offline_sync_probe", title: "GAMESCOPE Offline Sync Probe", genre: "Test", emoji: "🎮",
          cover: "", platforms: "PC", owned: false, fav: false, status: "در فهرست علاقه‌مندی",
          rating: null, note: "", created: now - 5000, updated: now - 3000
        }]));
        localStorage.setItem("gamescope-smoke-seeded", "1");
      }
      const userId = "00000000-0000-4000-8000-000000000123";
      const nowSeconds = Math.floor(now / 1000);
      const payload = btoa(JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", exp: nowSeconds + 3600, iat: nowSeconds }));
      const token = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." + payload.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "") + ".mock";
      localStorage.setItem("sb-axwjiwpwqoykvcbumixy-auth-token", JSON.stringify({
        access_token: token, token_type: "bearer", expires_in: 3600, expires_at: nowSeconds + 3600,
        refresh_token: "gamescope-smoke-refresh", user: {
          id: userId, aud: "authenticated", role: "authenticated", email: "smoke@example.invalid",
          app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { username: "smoketest" },
          created_at: new Date(now).toISOString(), email_confirmed_at: new Date(now).toISOString()
        }
      }));
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
    await page.locator("#onlineSearch").waitFor({ state: "visible" });
    await page.waitForFunction(() => (document.querySelector("#gsAuthMessage")?.textContent || "").includes("بازی محلی همگام شد"), null, { timeout: 15000 });
    assert(capturedCloudUploads.some(row => row.game_id === "offline_sync_probe"), "A local-only game was not uploaded to the signed-in cloud account.");
    await page.waitForFunction(() => {
      const status = document.querySelector("#onlineStatus")?.textContent || "";
      return status.length > 0 && !/در حال (جست‌وجو|دریافت)/.test(status);
    }, null, { timeout: 15000 });

    await page.locator("#onlineSearch").fill(GAME_TITLE);
    await page.locator("#onlineSearchBtn").click();

    const onlineCard = page.locator("#onlineResults article.card").filter({ hasText: GAME_TITLE }).first();
    await page.waitForFunction((query) => {
      return (document.querySelector("#onlineStatus")?.textContent || "").includes("نتایج جست‌وجو برای «" + query + "»");
    }, GAME_TITLE, { timeout: 15000 });
    await onlineCard.waitFor({ state: "visible", timeout: 15000 });
    assert(observedSearchQuery, "The search term was not sent to the catalog proxy.");
    assert(await onlineCard.locator(".meta").first().textContent().then(t => /استیم/.test(t) && !/بخار/.test(t)), "Steam source brand was translated instead of shown as استیم.");
    assert(await onlineCard.locator("h4").getAttribute("translate") === "no", "The original game title was not protected from automatic translation.");
    assert(await onlineCard.locator(".cover img").count() === 1, "The online catalog card did not render its cover image.");
    assert(
      await page.locator("#onlineResults").getByText(MOBILE_ONLY_FIXTURE.name, { exact: true }).count() === 0,
      "A mobile-only game was shown in the supported-platform catalog."
    );

    await onlineCard.locator('button[onclick^="addRawgGame("]').click();
    const personalCard = page.locator("#games article.card").filter({ hasText: GAME_TITLE }).first();
    await personalCard.waitFor({ state: "visible", timeout: 5000 });
    assert(await personalCard.locator(".cover img").count() === 1, "The personal-library card did not preserve the saved cover image.");

    const savedBeforeLibrary = await page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("sadra_pshub_v1") || "[]");
      return rows.find((row) => row.title === "GAMESCOPE Test Quest") || null;
    });
    assert(!!savedBeforeLibrary, "Adding the online result did not save a personal game record.");
    assert(savedBeforeLibrary.owned === false, "A game was unexpectedly marked as owned before adding it to the library.");

    await personalCard.locator('button[onclick^="toggleOwned("]').click();
    await page.locator('#tabs button[data-filter="library"]').click();
    await page.locator("#games article.card").filter({ hasText: GAME_TITLE }).waitFor({ state: "visible" });

    await page.locator("#games article.card").filter({ hasText: GAME_TITLE }).locator("select").selectOption({ label: "در حال بازی" });
    await page.locator('#tabs button[data-filter="playing"]').click();
    await page.locator("#games article.card").filter({ hasText: GAME_TITLE }).waitFor({ state: "visible" });

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportBtn").click();
    const download = await downloadPromise;
    assert(
      download.suggestedFilename() === "gamescope-pro-backup.json",
      "The personal-library backup filename was not correct."
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#onlineSearch").waitFor({ state: "visible" });
    await page.locator("#games article.card").filter({ hasText: GAME_TITLE }).waitFor({ state: "visible", timeout: 10000 });
    const afterReload = await page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("sadra_pshub_v1") || "[]");
      return rows.find((row) => row.title === "GAMESCOPE Test Quest") || null;
    });
    assert(!!afterReload && afterReload.owned === true, "Library state did not persist after reloading the page.");
    assert(afterReload.status === "در حال بازی", "The selected game status did not persist after reloading.");

    assert(pageErrors.length === 0, "Browser JavaScript errors: " + pageErrors.join(" | "));
    console.log("GAMESCOPE PRO browser checks passed.");
    console.log("- Online search rendered a supported PC + PlayStation fixture and its cover image.");
    console.log("- A local-only game was uploaded through the mocked cloud sync path.");
    console.log("- Mobile-only fixture was filtered from search results.");
    console.log("- Add-to-personal-list and add-to-library flows worked.");
    console.log("- Playing status and local persistence survived a page reload.");
    console.log("- Personal-library backup download produced the expected JSON filename.");
    console.log("- No uncaught browser JavaScript errors were detected.");

    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("GAMESCOPE PRO browser checks FAILED:");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
