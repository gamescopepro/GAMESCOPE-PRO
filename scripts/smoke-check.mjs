import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(root, "index.html");
const html = readFileSync(htmlPath, "utf8");
const errors = [];

const markupOnly = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
const ids = [...markupOnly.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
const idCounts = new Map();
for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);

for (const [id, count] of idCounts) {
  if (count > 1) errors.push("Duplicate HTML id: " + id + " (" + count + " times)");
}

const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/\bsrc\s*=/.test(m[1]) && !/application\/ld\+json/i.test(m[1]));

if (scripts.length === 0) errors.push("No inline JavaScript blocks were found.");

for (let i = 0; i < scripts.length; i += 1) {
  try {
    new Script(scripts[i][2], { filename: "index-inline-" + (i + 1) + ".js" });
  } catch (error) {
    errors.push("Inline JavaScript " + (i + 1) + " has a syntax error: " + error.message);
  }
}

const referencedIds = new Set();
for (const match of html.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
  referencedIds.add(match[1]);
}
for (const match of html.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)) {
  referencedIds.add(match[1]);
}
for (const id of referencedIds) {
  if (!idCounts.has(id)) errors.push("JavaScript references missing HTML id: " + id);
}

const requiredIds = [
  "onlineResults", "onlineSearch", "onlineMore", "onlineRefreshBtn",
  "games", "addToggle", "saveGame", "exportBtn", "importBtn",
  "openPsnAccount", "gsOwnerLogin"
];
for (const id of requiredIds) {
  if (!idCounts.has(id)) errors.push("Required site element is missing: " + id);
}

const requiredFilters = ["all", "library", "favorites", "playing", "completed", "wishlist"];
const actualFilters = new Set([...markupOnly.matchAll(/data-filter=["']([^"']+)["']/g)].map((m) => m[1]));
for (const filter of requiredFilters) {
  if (!actualFilters.has(filter)) errors.push("Required personal-library filter is missing: " + filter);
}

for (const requiredCode of [
  "function isSupportedPlatformName",
  "function gameHasSupportedPlatform",
  "window.gamescopeFetchPublicCatalog",
  "window.gamescopeSearchPublicCatalog",
  "store_url,cover,updated_at",
  "function toCloudGameRow",
  "pendingUploads",
  "window.gamescopeSyncGame",
  'onConflict:"user_id,game_id"',
  "gamescope-pro-backup.json"
]) {
  if (!html.includes(requiredCode)) errors.push("Required feature code is missing: " + requiredCode);
}

if (errors.length) {
  console.error("GAMESCOPE PRO smoke checks FAILED:");
  for (const error of errors) console.error(" - " + error);
  process.exitCode = 1;
} else {
  console.log("GAMESCOPE PRO smoke checks passed.");
  console.log("Checked " + scripts.length + " inline JavaScript blocks, " + ids.length + " HTML ids, " + referencedIds.size + " static id references, and " + requiredFilters.length + " personal-library filters.");
}
