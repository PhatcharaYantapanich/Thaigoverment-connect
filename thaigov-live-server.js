#!/usr/bin/env node
/*
 * ThaiGov Connect — Live News Connector Server
 * ---------------------------------------------
 * ตัวเชื่อมต่อดึงข่าวจริงจาก RSS/API ทางการของหน่วยงานรัฐ แล้วเสิร์ฟให้แอพ
 * ThaiGov-Connect.html ผ่าน http://localhost:8787/api/news (เปิด CORS ให้แล้ว)
 *
 * วิธีใช้:
 *   1) ติดตั้ง Node.js 18 ขึ้นไป (มี fetch ในตัว ไม่ต้องลง dependency ใด ๆ)
 *   2) รัน:  node thaigov-live-server.js
 *   3) เปิด ThaiGov-Connect.html แล้วกดปุ่มรีเฟรช → แอพจะดึงข่าวสดอัตโนมัติ
 *
 * เพิ่ม/แก้แหล่งข่าวได้ที่ SOURCES ด้านล่าง (รองรับ RSS/Atom ทุกตัว)
 * หมายเหตุ: feed ที่ทำเครื่องหมาย verify ควรตรวจ URL ปัจจุบันของหน่วยงานอีกครั้ง
 * เพราะเว็บราชการย้าย path บ่อย — ตัว parser เป็น generic RSS ใช้ได้กับทุก feed
 */

const http = require("http");

const PORT = process.env.PORT || 8787;
const CACHE_MS = 10 * 60 * 1000; // cache 10 นาที กันยิง feed ถี่เกิน

// ---------------------------------------------------------------------------
// แหล่งข่าว: ใส่ RSS/Atom URL ของหน่วยงาน + ministry key ของแอพ (+ ag ถ้าเป็นระดับกรม/องค์การ)
// ministry keys: opm mod mfa mof mots msdhs mhesi moac mot mnre mdes moen moc
//                moi moj mol mocu moe moph moind reg
// ---------------------------------------------------------------------------
const SOURCES = [
  // ---- ทุกอันด้านล่างนี้ "ยืนยันแล้ว" ว่าดึงได้จริง (ทดสอบ 1 ก.ย. 2026) ----
  { name: "TAT Newsroom (ททท.)", url: "https://tatnews.org/feed/",
    min: "mots", ag: "การท่องเที่ยวแห่งประเทศไทย (ททท.)" },
  { name: "กระทรวงการท่องเที่ยวและกีฬา", url: "https://www.mots.go.th/mots_en/api/rss/category/200",
    min: "mots" },
  { name: "กรมสรรพากร — ข่าวประชาสัมพันธ์", url: "https://www.rd.go.th/publish.xml",
    min: "mof", ag: "กรมสรรพากร" },
  { name: "กรมสรรพากร — กฎหมายภาษีใหม่", url: "https://www.rd.go.th/law.xml",
    min: "mof", ag: "กรมสรรพากร" },
  { name: "สวทช. (NSTDA)", url: "https://www.nstda.or.th/home/feed/",
    min: "mhesi", ag: "สำนักงานพัฒนาวิทยาศาสตร์และเทคโนโลยีแห่งชาติ (สวทช.)" },
  { name: "กระทรวงทรัพยากรธรรมชาติและสิ่งแวดล้อม", url: "https://www.mnre.go.th/rss",
    min: "mnre" },
  { name: "กระทรวงคมนาคม — ข่าวทั่วไป", url: "https://rapi.mot.go.th/api/rss/latest-news/MOT",
    min: "mot" },
  { name: "กระทรวงคมนาคม — ข่าวผู้บริหาร", url: "https://rapi.mot.go.th/api/rss/latest-news/Executive",
    min: "mot" },
];

// ---------------------------------------------------------------------------
// แหล่งที่ "ตรวจแล้วใช้ไม่ได้" (1 ก.ย. 2026) — อย่าเปิดกลับโดยไม่เช็คใหม่:
//   thaigov.go.th/news/rss        -> เว็บเป็น Next.js SPA ไม่มี XML feed
//   prd.go.th/th/rss              -> connection refused
//   mof.go.th/rss/news.xml        -> 404 (ใช้ feed กรมสรรพากรแทน)
//   depa.or.th/th/rss, etda.or.th/th/rss -> 404 (ไม่มี RSS แล้ว)
//   boi.go.th                     -> บล็อกด้วย Incapsula (403)
//   sec.or.th/rss                 -> 403, nbtc.go.th/rss -> 404
//   mol.go.th/rss, businesseventsthailand.com/rss -> feed มีแต่ว่างเปล่า
//   moph, moi, moen, m-culture, sso, gistda, nia, dbd, sme -> ไม่มี RSS/404/timeout
// หน่วยงานเหล่านี้ครอบคลุมผ่าน Google News RSS ด้านล่างแทน
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Google News RSS — ปิดช่องกระทรวงที่ไม่มี RSS ของตัวเอง (เสถียร, มาตรฐาน RSS 2.0)
// ข้อสังเกต: ข่าวมาจากสื่อที่รายงานถึงหน่วยงาน ไม่ใช่ประกาศตรงจากหน่วยงานเสมอไป
// ---------------------------------------------------------------------------
const GNEWS = [
  ["opm",   'สำนักนายกรัฐมนตรี'],
  ["mod",   'กระทรวงกลาโหม'],
  ["mfa",   'กระทรวงการต่างประเทศ'],
  ["msdhs", 'กระทรวงการพัฒนาสังคมและความมั่นคงของมนุษย์'],
  ["moac",  'กระทรวงเกษตรและสหกรณ์'],
  ["mdes",  'กระทรวงดิจิทัลเพื่อเศรษฐกิจและสังคม'],
  ["moen",  'กระทรวงพลังงาน'],
  ["moc",   'กระทรวงพาณิชย์'],
  ["moi",   'กระทรวงมหาดไทย'],
  ["moj",   'กระทรวงยุติธรรม'],
  ["mol",   'กระทรวงแรงงาน'],
  ["mocu",  'กระทรวงวัฒนธรรม'],
  ["moe",   'กระทรวงศึกษาธิการ'],
  ["moph",  'กระทรวงสาธารณสุข'],
  ["moind", 'กระทรวงอุตสาหกรรม'],
  ["reg",   '"ธนาคารแห่งประเทศไทย" OR "ก.ล.ต." OR "กสทช."'],
];
GNEWS.forEach(([min, q]) => SOURCES.push({
  name: "Google News — " + q.replace(/"/g, ""),
  url: "https://news.google.com/rss/search?q=" +
    encodeURIComponent(q.startsWith('"') || q.includes(" OR ") ? q : '"' + q + '"') +
    "&hl=th&gl=TH&ceid=TH:th",
  min, gn: true,
}));

// ---------------------------------------------------------------------------
// สื่อภายนอกที่น่าเชื่อถือ (RSS ยืนยันแล้ว 2 ก.ย. 2026) — ประเภท "ข้อมูลจากแหล่งอื่น"
// เก็บเฉพาะข่าวที่เกี่ยวข้องกับหน่วยงานรัฐ (ต้อง match MIN_KEYWORDS) กันข่าวนอกเรื่อง
// ตรวจแล้วใช้ไม่ได้: เดลินิวส์ (feed ว่างเปล่า), BBC Thai (ปิดบริการ),
//   ประชาชาติ (403), Bangkok Post (paywall 402), Thai PBS / MGR (404)
// ---------------------------------------------------------------------------
const MEDIA = [
  ["ไทยรัฐ",          "https://www.thairath.co.th/rss/news"],
  ["มติชน",           "https://www.matichon.co.th/feed"],
  ["ข่าวสด",          "https://www.khaosod.co.th/feed"],
  ["กรุงเทพธุรกิจ",    "https://www.bangkokbiznews.com/rss"],
  ["ฐานเศรษฐกิจ",     "https://www.thansettakij.com/rss"],
  ["The Standard",   "https://thestandard.co/feed/"],
  ["อินโฟเควสท์",      "https://www.infoquest.co.th/feed"],
];
MEDIA.forEach(([name, url]) => SOURCES.push({ name, url, media: true }));

// คำสำคัญ → จัดข่าวเข้ากระทรวง อัตโนมัติ (ใช้กับ feed รวม เช่น thaigov/PRD)
const MIN_KEYWORDS = {
  mof: ["กระทรวงการคลัง", "สรรพากร", "ภาษี", "สรรพสามิต", "ศุลกากร", "ธนารักษ์"],
  mdes: ["ดิจิทัล", "ไซเบอร์", "depa", "ETDA", "PDPA", "PDPC"],
  moph: ["สาธารณสุข", "โรงพยาบาล", "อนามัย", "สปสช", "วัคซีน"],
  moc: ["พาณิชย์", "ส่งออก", "การค้า", "DITP", "ทรัพย์สินทางปัญญา"],
  mots: ["ท่องเที่ยว", "กีฬา", "ททท"],
  moac: ["เกษตร", "ชลประทาน", "ประมง", "ปศุสัตว์", "ข้าว"],
  mol: ["แรงงาน", "ประกันสังคม", "จัดหางาน", "ค่าจ้าง"],
  moe: ["ศึกษาธิการ", "โรงเรียน", "นักเรียน", "สพฐ"],
  mhesi: ["อุดมศึกษา", "วิจัย", "นวัตกรรม", "อว.", "มหาวิทยาลัย", "GISTDA", "สวทช"],
  mnre: ["สิ่งแวดล้อม", "ทรัพยากรธรรมชาติ", "ป่าไม้", "อุทยาน", "มลพิษ", "โลกร้อน"],
  moen: ["พลังงาน", "ไฟฟ้า", "น้ำมัน", "โซลาร์", "กฟผ"],
  mot: ["คมนาคม", "รถไฟ", "ทางหลวง", "สนามบิน", "ขนส่ง"],
  moi: ["มหาดไทย", "จังหวัด", "ท้องถิ่น", "กฟภ", "ประปา"],
  moj: ["ยุติธรรม", "ราชทัณฑ์", "DSI", "บังคับคดี"],
  mfa: ["ต่างประเทศ", "ทูต", "วีซ่า", "กงสุล"],
  mod: ["กลาโหม", "กองทัพ", "ทหาร"],
  msdhs: ["พัฒนาสังคม", "พม.", "ผู้สูงอายุ", "เด็กและเยาวชน", "คนพิการ"],
  mocu: ["วัฒนธรรม", "ศิลปะ", "มรดก", "soft power"],
  moind: ["อุตสาหกรรม", "โรงงาน", "SME", "เหมืองแร่"],
  reg: ["ธปท", "แบงก์ชาติ", "ก.ล.ต.", "กสทช", "คปภ"],
};

const BENEFIT_KEYWORDS = ["เปิดรับสมัคร", "สมัครได้", "ขอรับทุน", "เงินสนับสนุน", "สิทธิประโยชน์",
  "ลงทะเบียน", "รับข้อเสนอ", "ขอรับการส่งเสริม", "grant", "apply", "funding", "อบรมฟรี", "สัมมนา"];

// ---------------------------------------------------------------------------
// Generic RSS/Atom parser (regex-based, no dependencies)
// ---------------------------------------------------------------------------
function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? m[1] : "";
}
function toISO(d) {
  const t = new Date(d);
  if (isNaN(t)) return null;
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}
function itemImage(b) { // สกัดรูป/อินโฟกราฟฟิคที่แนบมากับ feed
  let m = b.match(/<enclosure[^>]+url="([^"]+)"[^>]*(?:type="image[^"]*")?/i);
  if (m && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(m[1] || "")) return m[1];
  m = b.match(/<media:content[^>]+url="([^"]+)"/i) || b.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
  if (m) return m[1];
  m = b.match(/<img[^>]+src=["']([^"']+)["']/i); // รูปแรกใน description (CDATA)
  if (m) return m[1];
  m = decode(b).match(/<img[^>]+src=["']([^"']+)["']/i); // description ที่ escape เป็น &lt;img&gt;
  if (m) return m[1];
  m = b.match(/<enclosure[^>]+url="([^"]+)"/i);
  return m ? m[1] : null;
}
function parseFeed(xml, src) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 20).map(b => {
    let title = decode(tag(b, "title"));
    if (src.gn) title = title.replace(/\s+-\s+[^-]+$/, ""); // ตัดชื่อสำนักข่าวท้าย title ของ Google News
    const sum = decode(tag(b, "description") || tag(b, "summary") || tag(b, "content")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let link = decode(tag(b, "link"));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ""; }
    const pub = toISO(decode(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
    if (!title) return null;
    const hay = title + " " + sum;
    let min = src.min || null;
    if (!src.ag && !src.gn) { // feed รวม/สื่อภายนอก → จับกระทรวงจากคำสำคัญ
      for (const [k, words] of Object.entries(MIN_KEYWORDS)) {
        if (words.some(w => hay.includes(w))) { min = k; break; }
      }
    }
    if (src.media && !min) return null; // ข่าวสื่อภายนอกที่ไม่เกี่ยวกับหน่วยงานรัฐ → ตัดทิ้ง
    return {
      min,
      ag: src.ag || null,
      type: BENEFIT_KEYWORDS.some(w => hay.toLowerCase().includes(w.toLowerCase())) ? "benefit" : "news",
      title, sum: sum.slice(0, 400), pub, link,
      chair: src.name,
      srcName: src.name,
      srcType: src.media ? "media" : src.gn ? "gnews" : "official",
      img: itemImage(b),
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
let cache = { at: 0, items: [], errors: [] };

async function collect() {
  if (Date.now() - cache.at < CACHE_MS && cache.items.length) return cache;
  const items = [], errors = [];
  await Promise.all(SOURCES.map(async src => {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 10000);
      const r = await fetch(src.url, {
        signal: ctl.signal,
        headers: { "user-agent": "ThaiGovConnect/1.0 (+news aggregator)" },
      });
      clearTimeout(to);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const xml = await r.text();
      const got = parseFeed(xml, src);
      items.push(...got);
      console.log("  ✓ " + src.name + ": " + got.length + " items");
    } catch (e) {
      errors.push(src.name + ": " + e.message);
      console.log("  ✗ " + src.name + ": " + e.message);
    }
  }));
  // dedupe ด้วย title, เรียงล่าสุดก่อน
  const seen = new Set();
  const uniq = items.filter(it => { const k = it.title.slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.pub || "").localeCompare(String(a.pub || "")));
  cache = { at: Date.now(), items: uniq, errors };
  return cache;
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.url.startsWith("/api/news")) {
    console.log(new Date().toISOString() + " GET /api/news — fetching feeds…");
    const { items, errors } = await collect();
    res.end(JSON.stringify({ ok: true, count: items.length, errors, items }));
  } else {
    res.end(JSON.stringify({ ok: true, hint: "GET /api/news" }));
  }
}).listen(PORT, () => {
  console.log("ThaiGov Connect live connector running → http://localhost:" + PORT + "/api/news");
  console.log("เปิด ThaiGov-Connect.html แล้วกดปุ่มรีเฟรชได้เลย");
});
