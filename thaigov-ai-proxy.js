/* ============================================================================
 * ThaiGov Connect — AI data proxy (secure backend)
 * ----------------------------------------------------------------------------
 * A tiny zero-dependency Node server that holds your API keys (Jina, Firecrawl,
 * Apify) in ENVIRONMENT VARIABLES — never in the public web app — and exposes a
 * few safe endpoints the app calls. This keeps your keys off the public
 * GitHub Pages site.
 *
 * Requires Node 18+ (uses the built-in global fetch). No npm install needed.
 *
 * ---- RUN LOCALLY -----------------------------------------------------------
 *   JINA_KEY=... FIRECRAWL_KEY=... APIFY_TOKEN=... node thaigov-ai-proxy.js
 *   (all keys optional — Jina works without a key; set only what you use)
 *
 * ---- DEPLOY FREE (Render.com, recommended) ---------------------------------
 *   1. Push this file to a GitHub repo (can be the same repo, a /server folder).
 *   2. render.com -> New -> Web Service -> connect the repo.
 *   3. Runtime: Node. Build command: (leave empty). Start command:
 *          node thaigov-ai-proxy.js
 *   4. Add Environment variables (Settings -> Environment):
 *          FIRECRAWL_KEY   = fc-...            (optional)
 *          JINA_KEY        = jina_...          (optional; higher rate limit)
 *          APIFY_TOKEN     = apify_api_...     (optional; for social search)
 *          APIFY_ACTOR_X   = user~actor        (optional; X/Twitter actor id)
 *          APIFY_ACTOR_IG  = user~actor        (optional; Instagram actor id)
 *          APIFY_ACTOR_FB  = user~actor        (optional; Facebook actor id)
 *          ALLOW_ORIGIN    = https://phatcharayantapanich.github.io   (your site)
 *          PROXY_TOKEN     = any-long-random-string   (optional shared secret)
 *   5. Deploy. Render gives you a URL like https://thaigov-ai-proxy.onrender.com
 *   6. In the app: Admin -> แหล่งข่าว -> การเชื่อมต่อ AI -> paste that URL into
 *      "Backend proxy URL" (and the PROXY_TOKEN if you set one). Save.
 *
 * Other hosts work the same way (Railway, Fly.io, a small VPS, etc.).
 * ==========================================================================*/
"use strict";
const http = require("http");

const PORT        = process.env.PORT || 8787;
const JINA_KEY    = process.env.JINA_KEY || "";
const FIRECRAWL   = process.env.FIRECRAWL_KEY || "";
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const APIFY_ACTORS= { x: process.env.APIFY_ACTOR_X || "", ig: process.env.APIFY_ACTOR_IG || "", fb: process.env.APIFY_ACTOR_FB || "" };
const ALLOW_ORIGIN= process.env.ALLOW_ORIGIN || "*";
const PROXY_TOKEN = process.env.PROXY_TOKEN || "";

function cors(res){
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Proxy-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function send(res, code, body, type){
  cors(res);
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function withTimeout(ms){ const c = new AbortController(); const t = setTimeout(()=>c.abort(), ms); return { signal:c.signal, done:()=>clearTimeout(t) }; }
function authed(req, u){
  if(!PROXY_TOKEN) return true;
  const t = req.headers["x-proxy-token"] || u.searchParams.get("token") || "";
  return t === PROXY_TOKEN;
}
function readBody(req){ return new Promise(r=>{ let d=""; req.on("data",c=>d+=c); req.on("end",()=>{ try{r(JSON.parse(d||"{}"))}catch(e){r({})} }); }); }

/* ---- news: Google News RSS by query (CORS-free for the browser) ---- */
async function newsRSS(q){
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=th&gl=TH&ceid=TH:th";
  const to = withTimeout(15000);
  try { const r = await fetch(url, { signal: to.signal }); return r.ok ? await r.text() : ""; }
  catch(e){ return ""; } finally { to.done(); }
}
/* ---- opendata: data.go.th CKAN search ---- */
async function openData(q){
  const url = "https://data.go.th/api/3/action/package_search?q=" + encodeURIComponent(q) + "&rows=8";
  const to = withTimeout(15000);
  try { const r = await fetch(url, { signal: to.signal }); return r.ok ? await r.json() : { result:{ results:[] } }; }
  catch(e){ return { result:{ results:[] } }; } finally { to.done(); }
}
/* ---- scrape: Firecrawl if key present, else Jina Reader ---- */
async function scrape(url){
  const to = withTimeout(25000);
  try {
    if (FIRECRAWL) {
      const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method:"POST", signal: to.signal,
        headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+FIRECRAWL },
        body: JSON.stringify({ url, formats:["markdown"] })
      });
      if (r.ok) { const j = await r.json(); return { markdown: (j && j.data && (j.data.markdown||j.data.content)) || "", via:"firecrawl" }; }
    }
    const h = { "x-return-format":"markdown" };
    if (JINA_KEY) h["Authorization"] = "Bearer " + JINA_KEY;
    const r2 = await fetch("https://r.jina.ai/" + url, { headers:h, signal: to.signal });
    return { markdown: r2.ok ? await r2.text() : "", via:"jina" };
  } catch(e){ return { markdown:"", error:String(e && e.message || e) }; } finally { to.done(); }
}
/* ---- social: run an Apify actor for a platform ---- */
async function social(platform, query){
  const actor = APIFY_ACTORS[platform];
  if (!APIFY_TOKEN || !actor) return { items:[], error:"apify not configured for "+platform };
  const to = withTimeout(60000);
  try {
    const r = await fetch("https://api.apify.com/v2/acts/" + encodeURIComponent(actor) + "/run-sync-get-dataset-items?token=" + encodeURIComponent(APIFY_TOKEN), {
      method:"POST", signal: to.signal,
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ search:query, searchTerms:[query], query, maxItems:10, resultsLimit:10 })
    });
    return { items: r.ok ? await r.json() : [] };
  } catch(e){ return { items:[], error:String(e && e.message || e) }; } finally { to.done(); }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  if (u.pathname === "/health" || u.pathname === "/") {
    return send(res, 200, { ok:true, service:"thaigov-ai-proxy",
      firecrawl:!!FIRECRAWL, jina:!!JINA_KEY||true, apify:!!APIFY_TOKEN, tokenRequired:!!PROXY_TOKEN });
  }
  if (u.pathname.startsWith("/api/")) {
    if (!authed(req, u)) return send(res, 401, { error:"unauthorized" });
    try {
      if (u.pathname === "/api/news")     return send(res, 200, await newsRSS(u.searchParams.get("q")||""), "application/xml; charset=utf-8");
      if (u.pathname === "/api/opendata") return send(res, 200, await openData(u.searchParams.get("q")||""));
      if (u.pathname === "/api/scrape")   return send(res, 200, await scrape(u.searchParams.get("url")||""));
      if (u.pathname === "/api/social") {
        const b = req.method === "POST" ? await readBody(req) : {};
        const platform = b.platform || u.searchParams.get("platform") || "x";
        const query    = b.query || u.searchParams.get("q") || "";
        return send(res, 200, await social(platform, query));
      }
    } catch(e){ return send(res, 500, { error:String(e && e.message || e) }); }
  }
  return send(res, 404, { error:"not found" });
});
server.listen(PORT, () => console.log("thaigov-ai-proxy listening on :" + PORT));
