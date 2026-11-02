import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGIN = "https://gamescopepro.github.io";
const MODEL = "gemini-3.5-flash-lite";
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 8;
const limits = new Map<string, { start: number; count: number }>();

function reply(data: unknown, status: number, origin: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function clientIp(req: Request) {
  return req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function rateLimited(ip: string) {
  const now = Date.now();
  const old = limits.get(ip);
  if (!old || now - old.start >= WINDOW_MS) {
    limits.set(ip, { start: now, count: 1 });
    return false;
  }
  old.count++;
  return old.count > MAX_REQUESTS;
}

const SYSTEM_INSTRUCTION = `You are GAMESCOPE AI, the friendly video-game assistant inside GAMESCOPE PRO.
Answer naturally in the user's language, especially Persian or English.
Focus on video games, PlayStation, Xbox, PC, release dates, developers, publishers, genres, gaming hardware, and industry topics.
Be clear, helpful, age-appropriate, and concise. Use Google Search grounding when current information is useful. Search the live web for recent gaming news, release dates, platform availability, prices, updates, and official announcements.
For current news, rumors, release dates, prices, or availability, clearly say when you cannot verify them and recommend checking an official publisher, platform store, or studio source. Distinguish confirmed facts from rumors.
Never invent sources, links, dates, prices, or citations. If unsure, say so.
Do not ask for passwords, API keys, payment details, or private information.
Do not suggest enabling billing or paid API usage.`;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return reply({ error: "origin_not_allowed" }, 403, origin);
    return reply({ ok: true }, 200, origin);
  }
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405, origin);
  if (origin !== ALLOWED_ORIGIN) return reply({ error: "origin_not_allowed" }, 403, origin);

  if (rateLimited(clientIp(req))) {
    return reply({ error: "rate_limited", message: "درخواست‌ها خیلی سریع ارسال شده‌اند؛ یک دقیقه دیگر دوباره امتحان کن." }, 429, origin);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return reply({ error: "not_configured", message: "کلید هوش مصنوعی هنوز در تنظیمات امن سرور پیدا نشد." }, 503, origin);
  }

  try {
    const body = await req.json();
    const rawHistory = Array.isArray(body?.history) ? body.history.slice(-8) : [];
    if (!rawHistory.length) return reply({ error: "empty_message", message: "اول یک سؤال بنویس." }, 400, origin);

    const contents = [];
    let totalChars = 0;
    for (const item of rawHistory) {
      const role = item?.role === "model" ? "model" : item?.role === "user" ? "user" : "";
      const value = typeof item?.text === "string" ? item.text.trim() : "";
      if (!role || !value || value.length > 2500) continue;
      totalChars += value.length;
      if (totalChars > 9000) {
        return reply({ error: "message_too_long", message: "گفت‌وگو خیلی طولانی شده؛ یک گفت‌وگوی تازه شروع کن." }, 413, origin);
      }
      contents.push({ role, parts: [{ text: value }] });
    }
    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return reply({ error: "invalid_history", message: "پیام آخر معتبر نیست." }, 400, origin);
    }

    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";
    const geminiPayload = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      tools: [{ google_search: {} }],
      // Google Search grounding retrieves current web pages and provides source metadata.
      // Temperature is intentionally omitted for Gemini 3.6+.
      generationConfig: {
        maxOutputTokens: 500,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    });
    let upstream: Response | null = null;
    // Fail fast on stalled requests. Retry only an explicit 503 capacity response once;
    // a network timeout is returned immediately rather than making users wait another 25s.
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        upstream = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "x-goog-api-key": apiKey },
          body: geminiPayload,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (upstream.ok || upstream.status !== 503 || attempt === 1) break;
      const delayMs = 1200 + Math.floor(Math.random() * 500);
      console.warn("Gemini capacity response; retrying once", JSON.stringify({
        httpStatus: upstream.status,
        attempt: attempt + 1,
        delayMs,
      }));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!upstream) {
      return reply({ error: "provider_unavailable", message: "ارتباط موقت با سرویس هوش مصنوعی برقرار نشد؛ کمی بعد دوباره تلاش کن." }, 503, origin);
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // Log provider diagnostics without ever logging the API key or request headers.
      console.error("Gemini upstream error", JSON.stringify({ httpStatus: upstream.status, status: data?.error?.status ?? null, code: data?.error?.code ?? null, message: typeof data?.error?.message === "string" ? data.error.message.slice(0, 500) : null }));
      if (upstream.status === 429 || data?.error?.status === "RESOURCE_EXHAUSTED") {
        return reply({ error: "free_quota_exhausted", message: "سهمیه رایگان Gemini فعلاً پر شده؛ بعداً دوباره امتحان کن. هیچ مسیر پولی فعال نمی‌شود." }, 429, origin);
      }
      if (upstream.status === 402 || data?.error?.status === "PAYMENT_REQUIRED") {
        return reply({ error: "paid_access_blocked", message: "این درخواست به دسترسی پولی نیاز دارد؛ برای جلوگیری از هزینه، هیچ پرداخت یا ارتقایی انجام نمی‌شود." }, 402, origin);
      }
      if (upstream.status === 400 || upstream.status === 403) {
        return reply({ error: "provider_rejected", message: "Gemini درخواست را نپذیرفت. لطفاً تنظیمات کلید یا دسترسی مدل را بررسی کنیم." }, 502, origin);
      }
      if (upstream.status === 503) {
        return reply({ error: "provider_busy", message: "سرویس Gemini فعلاً شلوغ است. اتصال سایت برقرار است؛ چند لحظه دیگر دوباره امتحان کن." }, 503, origin);
      }
      if ([408, 500, 502, 504].includes(upstream.status)) {
        return reply({ error: "provider_temporarily_unavailable", message: "سرویس هوش مصنوعی پس از چند تلاش هنوز پاسخ نداده؛ کمی بعد دوباره تلاش کن." }, 503, origin);
      }
      return reply({ error: "provider_error", message: "سرویس هوش مصنوعی موقتاً پاسخ نداد؛ کمی بعد دوباره تلاش کن." }, 502, origin);
    }

    const answer = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((part: { text?: string }) => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();
    if (!answer) {
      return reply({ error: "empty_response", message: "پاسخ خالی دریافت شد؛ سؤال را کمی متفاوت بپرس." }, 502, origin);
    }
    const sourceChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = [];
    const seenSources = new Set<string>();
    for (const chunk of sourceChunks) {
      const web = chunk?.web;
      const uri = typeof web?.uri === "string" ? web.uri : "";
      const title = typeof web?.title === "string" ? web.title : uri;
      if (!uri || !/^https?:\/\//i.test(uri) || seenSources.has(uri)) continue;
      seenSources.add(uri);
      sources.push({ title: title.slice(0, 180), url: uri });
      if (sources.length >= 6) break;
    }
    return reply({ answer, model: MODEL, sources, searchedWeb: sources.length > 0 }, 200, origin);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const transportError = error instanceof TypeError;
    if (transportError) {
      console.error("Gemini transport failure", JSON.stringify({
        name: error.name,
        message: error.message.slice(0, 240),
      }));
    }
    return reply({
      error: timedOut ? "timeout" : transportError ? "provider_unreachable" : "bad_request",
      message: timedOut
        ? "پاسخ‌دادن طول کشید؛ دوباره امتحان کن."
        : transportError
          ? "ارتباط با سرویس Gemini موقتاً قطع شد؛ کمی بعد دوباره تلاش کن."
          : "درخواست قابل پردازش نبود.",
    }, timedOut ? 504 : transportError ? 503 : 400, origin);
  }
});
