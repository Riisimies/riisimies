import fs from "node:fs";
import path from "node:path";
import * as si from "simple-icons";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : "dist";
const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const USER = process.env.USERNAME || cfg.username;
const TZ = process.env.TZ_NAME || cfg.timeZone;
const ACCENT = cfg.accent || "#8B5CF6";
const ACCENT_LIGHT = "#C4B5FD";
const PANEL = "#0f0f13", PANEL_STROKE = "#1c1c22";
const FONT = "Inter, 'Segoe UI', -apple-system, Helvetica, Arial, sans-serif";
const BG = "#09090b";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAYNAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const pad2 = (n) => String(n).padStart(2, "0");
const NUMGRAD = `<linearGradient id="numGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${ACCENT_LIGHT}"/></linearGradient>`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");
const f1 = (n) => Math.round(n * 10) / 10;
const T = (x, y, s, o = {}) =>
  `<text x="${f1(x)}" y="${f1(y)}" font-size="${o.size || 12}" font-weight="${o.weight || 400}" fill="${o.fill || "#a1a1aa"}" text-anchor="${o.anchor || "start"}">${esc(s)}</text>`;
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const lerp = (a, b, t) => rgb2hex(hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t));
const shade = (h, k) => rgb2hex(hex2rgb(h).map((v) => v * k));
const wrap = (w, h, inner, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}">` +
  `<defs><radialGradient id="glow" cx="0" cy="0" r="${Math.round(w * 0.6)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.055"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></radialGradient>${defs}</defs>` +
  `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="18" fill="${BG}" stroke="#27272a"/>` +
  `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="18" fill="url(#glow)"/>${inner}</svg>`;

async function gql(query, variables) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN / GITHUB_TOKEN missing");
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function liveData() {
  const to = new Date();
  const from = new Date(to.getTime() - 364 * 864e5);
  const d = await gql(
    `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){
        id
        contributionsCollection(from:$from,to:$to){
          contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
          commitContributionsByRepository(maxRepositories:25){ repository{ name owner{ login } } }
        }
        repositories(first:100, ownerAffiliations:OWNER, isFork:false, orderBy:{field:PUSHED_AT,direction:DESC}){
          nodes{ languages(first:8, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name } } } }
        }
      }
    }`,
    { login: USER, from: from.toISOString(), to: to.toISOString() }
  );
  const u = d.user;
  const days = u.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((x) => ({ date: x.date, count: x.contributionCount }))
    .slice(-365);

  const langMap = {};
  for (const repo of u.repositories.nodes)
    for (const e of repo.languages.edges) langMap[e.node.name] = (langMap[e.node.name] || 0) + e.size;
  const langs = Object.entries(langMap).map(([name, size]) => ({ name, size }));

  const hours = Array(24).fill(0);
  const fmtH = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ });
  try {
    for (const c of u.contributionsCollection.commitContributionsByRepository) {
      let after = null;
      for (let page = 0; page < 5; page++) {
        const r = await gql(
          `query($o:String!,$n:String!,$id:ID!,$since:GitTimestamp!,$after:String){
            repository(owner:$o,name:$n){ defaultBranchRef{ target{ ... on Commit{
              history(first:100, author:{id:$id}, since:$since, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ committedDate } }
            } } } }
          }`,
          { o: c.repository.owner.login, n: c.repository.name, id: u.id, since: from.toISOString(), after }
        );
        const h = r.repository?.defaultBranchRef?.target?.history;
        if (!h) break;
        for (const n of h.nodes) hours[parseInt(fmtH.format(new Date(n.committedDate)), 10)]++;
        if (!h.pageInfo.hasNextPage) break;
        after = h.pageInfo.endCursor;
      }
    }
  } catch (e) {
    console.warn("hour histogram failed:", e.message);
  }
  return { days, hours, langs };
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function demoData() {
  const r = rng(7);
  const end = Date.UTC(2026, 9, 14);
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const t = (364 - i) / 364;
    const p = t < 0.45 ? 0.05 : t < 0.62 ? 0.4 : t < 0.8 ? 0.6 : 0.85;
    const scale = t < 0.45 ? 12 : t < 0.8 ? 80 : 150;
    let c = 0;
    if (r() < p) c = Math.max(1, Math.round(Math.pow(r(), 2.1) * scale * (0.4 + t)));
    days.push({ date: new Date(end - i * 864e5).toISOString().slice(0, 10), count: c });
  }
  const L = days.length;
  for (let i = L - 41; i < L - 28; i++) days[i].count = Math.max(days[i].count, 8);
  days[L - 5].count = 0;
  for (let i = L - 4; i < L; i++) days[i].count = Math.max(days[i].count, 20);
  days[L - 2].count = 430;
  const hw = [3, 3, 2, 2, 1, 1, 0.4, 0.3, 0.2, 0.15, 0.2, 0.5, 0.9, 1.2, 1.6, 2, 2.6, 3.4, 4, 3.6, 3, 2.4, 3.2, 4.4];
  const hours = hw.map((w, i) => Math.round(w * 40 + (i === 22 ? 60 : 0)));
  const langs = [
    { name: "Lua", size: 54 }, { name: "JavaScript", size: 15 }, { name: "TypeScript", size: 14 },
    { name: "Luau", size: 12 }, { name: "HTML", size: 3 }, { name: "CSS", size: 1.2 }, { name: "Python", size: 0.8 },
  ];
  return { days, hours, langs };
}

function stats(days) {
  const total = days.reduce((a, d) => a + d.count, 0);
  let longest = 0, run = 0;
  for (const d of days) { run = d.count > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let i = days.length - 1;
  if (days[i].count === 0) i--;
  let cur = 0;
  while (i >= 0 && days[i].count > 0) { cur++; i--; }
  const best = days.reduce((b, d) => (d.count > b.count ? d : b), days[0]);
  const active = days.filter((d) => d.count > 0).length;
  const wd = Array(7).fill(0);
  for (const d of days) wd[(new Date(d.date + "T00:00:00Z").getUTCDay() + 6) % 7] += d.count;
  return { total, longest, cur, best, active, wd };
}
const dayLabel = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

function statsCard({ days, hours, langs }) {
  const W = 840, H = 550, X0 = 32, CW = 776;
  const s = stats(days);
  let out = "";

  out += `<text x="32" y="100" font-size="54" font-weight="800" fill="url(#numGrad)">${fmt(s.total)}</text>`;
  out += T(32, 124, "contributions in the last year", { size: 13 });
  const tiles = [
    [516, 28, `${s.cur} days`, "current streak"], [664, 28, `${s.longest} days`, "longest streak"],
    [516, 98, fmt(s.best.count), `best day · ${dayLabel(s.best.date)}`], [664, 98, fmt(s.active), "active days"],
  ];
  for (const [x, y, v, l] of tiles) {
    out += `<rect x="${x}" y="${y}" width="144" height="62" rx="12" fill="${PANEL}" stroke="${PANEL_STROKE}"/>`;
    out += T(x + 16, y + 30, v, { size: 20, weight: 700, fill: "#fff" }) + T(x + 16, y + 48, l, { size: 11 });
  }

  const L = days.length, N = Math.ceil(L / 7), wk = Array(N).fill(0);
  const weekOf = (i) => N - 1 - Math.floor((L - 1 - i) / 7);
  days.forEach((d, i) => (wk[weekOf(i)] += d.count));
  const wmax = Math.max(...wk, 1), pitch = CW / N, bw = Math.max(3, pitch * 0.66), BASE = 336, TOP = 200;
  let bars = "";
  wk.forEach((v, i) => {
    const h = v > 0 ? Math.max(3, Math.sqrt(v / wmax) * (BASE - TOP)) : 2;
    const x = X0 + i * pitch + (pitch - bw) / 2, peak = v === wmax;
    const fill = v === 0 ? "#26242f" : peak ? "url(#barHot)" : "url(#bar)";
    const op = v === 0 || peak ? 1 : (0.45 + 0.55 * Math.sqrt(v / wmax)).toFixed(2);
    bars += `<rect x="${f1(x)}" y="${f1(BASE - h)}" width="${f1(bw)}" height="${f1(h)}" rx="${f1(Math.min(3, bw / 2))}" fill="${fill}" fill-opacity="${op}"/>`;
  });
  out += bars;
  const pi = wk.indexOf(wmax), px = X0 + pi * pitch + pitch / 2, ph = (wmax / wmax) * (BASE - TOP);
  out += T(Math.max(X0 + 50, Math.min(X0 + CW - 50, px)), BASE - ph - 10, `peak week · ${fmt(wmax)}`, { size: 11, weight: 600, fill: ACCENT_LIGHT, anchor: "middle" });
  out += `<line x1="${X0}" y1="${BASE + 0.5}" x2="${X0 + CW}" y2="${BASE + 0.5}" stroke="#26262d"/>`;

  const groups = new Map();
  days.forEach((d, i) => { const k = d.date.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  [...groups.entries()].forEach(([k, idx], gi) => {
    if ((gi === 0 && idx.length < 28) || idx.length < 7) return;
    const mid = (weekOf(idx[0]) + weekOf(idx[idx.length - 1])) / 2;
    const x = Math.max(X0 + 14, Math.min(X0 + CW - 14, X0 + (mid + 0.5) * pitch));
    out += T(x, 358, MONTHS[parseInt(k.slice(5), 10) - 1], { size: 11, anchor: "middle", fill: "#71717a" });
  });

  const Y0 = 384, PH = 146;
  for (const [x, w] of [[32, 250], [294, 250], [556, 252]])
    out += `<rect x="${x}" y="${Y0}" width="${w}" height="${PH}" rx="14" fill="${PANEL}" stroke="${PANEL_STROKE}"/>`;

  out += T(48, 406, "languages", { size: 12, weight: 600 });
  const sorted = [...langs].sort((a, c) => c.size - a.size);
  const tot = sorted.reduce((a, c) => a + c.size, 0) || 1;
  const top5 = sorted.slice(0, 5).map((l) => ({ name: l.name, pct: (l.size / tot) * 100 }));
  const rows = [...top5, { name: "Other", pct: Math.max(0, 100 - top5.reduce((a, c) => a + c.pct, 0)) }];
  const pal = [ACCENT_LIGHT, ACCENT, "#6D4AD8", "#4C3A99", "#3A3068", "#2B2748"];
  const R = 33, CIR = 2 * Math.PI * R, cx = 90, cy = 468;
  let acc = 0;
  rows.forEach((r, i) => {
    const len = (r.pct / 100) * CIR;
    if (len > 0.5) {
      const seg = Math.max(0.5, len - (len > 4 ? 1.5 : 0));
      out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${pal[i]}" stroke-width="12" stroke-dasharray="${f1(seg)} ${f1(CIR - seg)}" stroke-dashoffset="${f1(-acc)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    }
    acc += len;
  });
  out += T(cx, cy + 5, `${Math.round(rows[0].pct)}%`, { size: 14, weight: 700, fill: "#fff", anchor: "middle" });
  rows.forEach((r, i) => {
    const y = 428 + i * 16;
    out += `<circle cx="144" cy="${y - 4}" r="3.5" fill="${pal[i]}"/>`;
    out += T(153, y, r.name, { size: 11, weight: 500, fill: "#fff" });
    out += T(266, y, `${Math.round(r.pct)}%`, { size: 11, anchor: "end" });
  });

  const yB = Y0 + PH - 28, MH = 74;
  const grid = (x1, x2) =>
    [0.5, 1].map((f) => `<line x1="${x1}" y1="${f1(yB - MH * f)}" x2="${x2}" y2="${f1(yB - MH * f)}" stroke="#1d1b26" stroke-dasharray="3 4"/>`).join("") +
    `<line x1="${x1}" y1="${yB + 0.5}" x2="${x2}" y2="${yB + 0.5}" stroke="#26262d"/>`;

  const dmax = Math.max(...s.wd, 1), dpeak = s.wd.indexOf(dmax);
  out += T(310, 406, "by weekday", { size: 12, weight: 600 }) + T(528, 406, `${DAYNAMES[dpeak]} · ${fmt(dmax)}`, { size: 11, weight: 600, fill: ACCENT_LIGHT, anchor: "end" });
  out += grid(314, 524);
  const bw7 = 22, g7 = (210 - 7 * bw7) / 6;
  s.wd.forEach((v, i) => {
    const h = Math.max(4, (v / dmax) * MH), x = 314 + i * (bw7 + g7), pk = i === dpeak;
    if (pk) out += `<rect x="${f1(x)}" y="${f1(yB - h)}" width="${bw7}" height="${f1(h)}" rx="6" fill="${ACCENT}" opacity="0.22" filter="url(#blur)"/>`;
    out += `<rect x="${f1(x)}" y="${f1(yB - h)}" width="${bw7}" height="${f1(h)}" rx="6" fill="${pk ? "url(#bar)" : "url(#barDim)"}"/>`;
    out += T(x + bw7 / 2, yB + 16, WEEKDAYS[i], { size: 10, anchor: "middle", fill: pk ? "#fff" : "#71717a", weight: pk ? 700 : 400 });
  });

  const hmax = Math.max(...hours, 1), hpeak = hours.indexOf(hmax), hp = 220 / 24, hb = 6;
  out += T(572, 406, "by hour", { size: 12, weight: 600 }) + T(792, 406, `peak ${pad2(hpeak)}:00`, { size: 11, weight: 600, fill: ACCENT_LIGHT, anchor: "end" });
  out += grid(572, 792);
  hours.forEach((v, i) => {
    const h = Math.max(3, (v / hmax) * MH), x = 572 + i * hp + (hp - hb) / 2, pk = i === hpeak;
    if (pk) out += `<rect x="${f1(x)}" y="${f1(yB - h)}" width="${hb}" height="${f1(h)}" rx="3" fill="${ACCENT}" opacity="0.22" filter="url(#blur)"/>`;
    out += `<rect x="${f1(x)}" y="${f1(yB - h)}" width="${hb}" height="${f1(h)}" rx="3" fill="${pk ? "url(#barHot)" : "url(#bar)"}" fill-opacity="${pk ? 1 : v === 0 ? 0.15 : (0.3 + 0.7 * (v / hmax)).toFixed(2)}"/>`;
  });
  [0, 6, 12, 18, 23].forEach((h) => (out += T(572 + h * hp + hp / 2, yB + 16, pad2(h), { size: 10, anchor: "middle", fill: h === hpeak ? "#fff" : "#71717a" })));

  const defs =
    NUMGRAD +
    `<linearGradient id="barDim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4363"/><stop offset="1" stop-color="#2d2840"/></linearGradient>` +
    `<filter id="blur" x="-80%" y="-40%" width="260%" height="180%"><feGaussianBlur stdDeviation="4"/></filter>` +
    `<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ACCENT_LIGHT}"/><stop offset="1" stop-color="${ACCENT}"/></linearGradient>` +
    `<linearGradient id="barHot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${ACCENT_LIGHT}"/></linearGradient>` +
    `<linearGradient id="barH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT_LIGHT}"/></linearGradient>`;
  return wrap(W, H, out, defs);
}

function cityCard({ days }) {
  const W = 840, H = 420, C = 20, TX = 13, TY = 7.5, F = 0.86, MAXH = 120;
  const maxC = Math.max(...days.map((d) => d.count), 1);
  const cells = days.map((d, i) => ({ ...d, i, c: i % C, r: Math.floor(i / C) }));
  const P = (c, r) => [(c - r) * TX, (c + r) * TY];
  const order = [...cells].sort((a, b) => a.c + a.r - (b.c + b.r) || a.r - b.r);
  const poly = (pts, fill, extra = "") => `<polygon points="${pts.map((q) => q.map(f1).join(",")).join(" ")}" fill="${fill}" ${extra}/>`;
  let shapes = "", minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const track = (q) => { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); };
  const scale = (t) => lerp("#2b2547", ACCENT_LIGHT, t);
  for (const k of order) {
    const a = P(k.c, k.r), b = P(k.c + F, k.r), c2 = P(k.c + F, k.r + F), d2 = P(k.c, k.r + F);
    [a, b, c2, d2].forEach(track);
    if (k.count === 0) { shapes += poly([a, b, c2, d2], "#121217", 'stroke="#1a1a21" stroke-width="0.6"'); continue; }
    const t = Math.pow(k.count / maxC, 0.38), h = Math.max(3, MAXH * Math.pow(k.count / maxC, 0.5));
    const up = (q) => [q[0], q[1] - h];
    const top = k.i === days.length - 1 ? "#F5D0FE" : scale(t);
    [a, b, c2, d2].map(up).forEach(track);
    shapes += poly([d2, c2, up(c2), up(d2)], shade(top, 0.68));
    shapes += poly([b, c2, up(c2), up(b)], shade(top, 0.46));
    shapes += poly([up(a), up(b), up(c2), up(d2)], top);
  }
  const bw = maxX - minX, bh = maxY - minY;
  const s = Math.min(1.2, 500 / bw, (H - 48) / bh);
  const tx = 310 + (500 - bw * s) / 2 - minX * s, ty = 24 + (H - 48 - bh * s) / 2 - minY * s;

  let out = T(32, 52, "contribution city", { size: 17, weight: 700, fill: "#fff" });
  out += T(32, 74, "one block per day · last 365 days", { size: 12 });
  const cs = stats(days);
  out += T(32, 150, fmt(cs.best.count), { size: 30, weight: 800, fill: "#fff" }) + T(32, 172, `best day · ${dayLabel(cs.best.date)}`, { size: 12 });
  out += T(32, 226, fmt(cs.active), { size: 30, weight: 800, fill: "#fff" }) + T(32, 248, "active days", { size: 12 });
  out += T(32, 302, `${cs.cur} days`, { size: 30, weight: 800, fill: ACCENT_LIGHT }) + T(32, 324, "current streak", { size: 12 });
  out += T(32, H - 44, "less", { size: 11, fill: "#71717a" });
  [0, 0.25, 0.5, 0.75, 1].forEach((t, i) => {
    out += `<rect x="${62 + i * 16}" y="${H - 54}" width="12" height="12" rx="3" fill="${i === 0 ? "#1c1b26" : scale(t)}"/>`;
  });
  out += T(150, H - 44, "more", { size: 11, fill: "#71717a" });
  out += `<g transform="translate(${f1(tx)},${f1(ty)}) scale(${f1(s)})">${shapes}</g>`;
  return wrap(W, H, out);
}

function techCard() {
  const items = [];
  for (const t of cfg.tech) {
    const icon = Object.values(si).find((i) => i && i.slug === t.slug);
    if (!icon) { console.warn("icon not found:", t.slug); continue; }
    items.push({ label: t.label, path: icon.path });
  }
  const COLS = 10, TW = 72, TH = 76, GX = 8, GY = 10, W = 840;
  const rows = Math.ceil(items.length / COLS), H = 48 + rows * TH + (rows - 1) * GY;
  let out = "";
  items.forEach((it, i) => {
    const row = Math.floor(i / COLS), col = i % COLS, inRow = Math.min(COLS, items.length - row * COLS);
    const x0 = (W - (inRow * TW + (inRow - 1) * GX)) / 2, x = x0 + col * (TW + GX), y = 24 + row * (TH + GY);
    out += `<rect x="${f1(x)}" y="${y}" width="${TW}" height="${TH}" rx="14" fill="${PANEL}" stroke="${PANEL_STROKE}"/>`;
    out += `<g transform="translate(${f1(x + (TW - 30) / 2)},${y + 13}) scale(1.25)"><path d="${it.path}" fill="#e4e4e7"/></g>`;
    out += T(x + TW / 2, y + 62, it.label, { size: 11, weight: 500, anchor: "middle", fill: "#a1a1aa" });
  });
  return wrap(W, H, out);
}

function star(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    pts.push(`${f1(cx + rr * Math.cos(a))},${f1(cy + rr * Math.sin(a))}`);
  }
  return pts.join(" ");
}
function profileCard() {
  const p = cfg.profile || {};
  const W = 840, H = 292;
  let out = `<text x="32" y="66" font-size="40" font-weight="800" fill="url(#numGrad)">${esc(p.name || USER)}</text>`;
  out += T(32, 90, p.tagline || "", { size: 13 });
  const discord = Object.values(si).find((i) => i && i.slug === "discord");
  const iconFor = (kind, x, y) =>
    kind === "eye"
      ? `<g transform="translate(${x},${y}) scale(0.7083)" fill="none" stroke="${ACCENT_LIGHT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3.2"/></g>`
      : discord ? `<g transform="translate(${x},${y}) scale(0.7083)"><path d="${discord.path}" fill="${ACCENT_LIGHT}"/></g>` : "";
  let px = 808;
  [...(p.pills || [])].reverse().forEach((pill) => {
    const w = Math.round(pill.label.length * 6.6 + 54), x = px - w;
    out += `<rect x="${x + 0.5}" y="35.5" width="${w - 1}" height="33" rx="16.5" fill="${PANEL}" stroke="${ACCENT}" stroke-opacity="0.45"/>`;
    out += iconFor(pill.icon, x + 15, 44);
    out += T(x + 39, 57, pill.label, { size: 12.5, weight: 600, fill: ACCENT_LIGHT });
    px = x - 10;
  });
  out += `<rect x="32" y="112" width="392" height="156" rx="14" fill="${PANEL}" stroke="${PANEL_STROKE}"/>`;
  out += `<rect x="436" y="112" width="372" height="156" rx="14" fill="${PANEL}" stroke="${PANEL_STROKE}"/>`;
  out += T(48, 138, "education", { size: 12, weight: 600 });
  const ed = p.education || [];
  ed.forEach((e, i) => {
    const y = 168 + i * 52;
    if (i < ed.length - 1) out += `<line x1="56" y1="${y + 8}" x2="56" y2="${y + 52 - 6}" stroke="#2a2540" stroke-width="2"/>`;
    out += `<circle cx="56" cy="${y + 2}" r="5" fill="${e.active ? ACCENT : "#3f3f46"}"/>`;
    out += T(76, y + 7, e.school, { size: 14, weight: 700, fill: "#fff" });
    out += T(76, y + 25, e.title, { size: 12 });
    const w = Math.round(e.status.length * 5.8 + 22), x = 408 - w;
    out += `<rect x="${x}" y="${y - 9}" width="${w}" height="20" rx="10" fill="${e.active ? ACCENT : "none"}" fill-opacity="0.1" stroke="${e.active ? ACCENT : "#3f3f46"}" stroke-opacity="${e.active ? 0.7 : 1}"/>`;
    out += T(x + w / 2, y + 5, e.status, { size: 10, weight: 600, anchor: "middle", fill: e.active ? ACCENT_LIGHT : "#a1a1aa" });
  });
  out += T(452, 138, "achievements", { size: 12, weight: 600 });
  (p.achievements || []).forEach((a, i) => {
    const y = 152 + i * 36;
    out += `<rect x="452" y="${y}" width="340" height="28" rx="10" fill="#121216" stroke="${PANEL_STROKE}"/>`;
    out += `<polygon points="${star(471, y + 14, 7)}" fill="${ACCENT_LIGHT}"/>`;
    out += T(488, y + 18, a, { size: 13, weight: 500, fill: "#fff" });
  });
  return wrap(W, H, out, NUMGRAD);
}

const data = demo ? demoData() : await liveData();
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "stats.svg"), statsCard(data));
fs.writeFileSync(path.join(outDir, "city.svg"), cityCard(data));
fs.writeFileSync(path.join(outDir, "tech.svg"), techCard());
fs.writeFileSync(path.join(outDir, "profile.svg"), profileCard());
const s = stats(data.days);
console.log(`${demo ? "[demo] " : ""}wrote 4 cards to ${outDir} — ${s.total} contributions, streak ${s.cur}/${s.longest}`);
