// Builds the static data for the prototype from SERCOP's monthly OCDS bulk files.
//
//   node scripts/build-data.mjs                 # all months of the current year so far
//   node scripts/build-data.mjs --year 2025     # a full past year
//   node scripts/build-data.mjs --year 2026 --months 1-9
//
// Output (public/data/compras/):
//   meta.json           period covered, totals, generated date, source + license
//   buyers.json         one row per buying entity (search index + ranking)
//   provinces.json      totals per province (from the province code in the entity's RUC)
//   b/<ruc>.json        detail per entity: monthly totals, top suppliers, largest awards
//
// Source: https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/datos-abiertos
// License: CC BY 3.0 Ecuador. Credit SERCOP on every page that shows this data.

import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const CACHE = path.join(ROOT, ".cache");
const OUT = path.join(ROOT, "public", "data", "compras");
const BULK = "https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/download";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const now = new Date();
const YEAR = Number(args.year ?? now.getFullYear());
let months;
if (args.months) {
  const [a, b] = String(args.months).split("-").map(Number);
  months = Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
} else {
  const last = YEAR === now.getFullYear() ? now.getMonth() + 1 : 12;
  months = Array.from({ length: last }, (_, i) => i + 1);
}

// ---------- reference data ----------
// First two digits of an Ecuadorian RUC = province where it was registered.
const PROVINCES = {
  "01": "Azuay",
  "02": "Bolívar",
  "03": "Cañar",
  "04": "Carchi",
  "05": "Cotopaxi",
  "06": "Chimborazo",
  "07": "El Oro",
  "08": "Esmeraldas",
  "09": "Guayas",
  10: "Imbabura",
  11: "Loja",
  12: "Los Ríos",
  13: "Manabí",
  14: "Morona Santiago",
  15: "Napo",
  16: "Pastaza",
  17: "Pichincha",
  18: "Tungurahua",
  19: "Zamora Chinchipe",
  20: "Galápagos",
  21: "Sucumbíos",
  22: "Orellana",
  23: "Santo Domingo de los Tsáchilas",
  24: "Santa Elena",
};

function buyerKind(name) {
  const n = name.toUpperCase();
  const gad =
    n.includes("DESCENTRALIZADO") || n.startsWith("GAD") || n.includes(" GAD ");
  if (
    n.includes("EMPRESA PUBLICA") ||
    n.includes("EMPRESA PÚBLICA") ||
    /\bEP\b/.test(n)
  )
    return "empresa";
  if (gad && n.includes("PARROQUIA")) return "parroquia";
  if (gad && (n.includes("PROVINCIA") || n.includes("PREFECTURA")))
    return "prefectura";
  if (
    gad ||
    n.includes("MUNICIPIO") ||
    n.includes("MUNICIPALIDAD") ||
    n.includes("METROPOLITANO")
  )
    return "municipio";
  return "otro";
}

// "EC-RUC-1360000200001-2332" -> "1360000200001"
const rucOf = (id) => (String(id).match(/(\d{13})/) || [])[1] || null;

// Persons natural have a RUC whose 3rd digit is 0-5; companies 9; public entities 6.
// We never publish RUCs (a natural person's RUC contains their cédula).
const isPerson = (ruc) => ruc && Number(ruc[2]) < 6;

// ---------- CSV ----------
function* parseCsv(text) {
  let i = 0,
    field = "",
    row = [],
    inQ = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      yield row;
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    yield row;
  }
}
function rows(text) {
  const it = parseCsv(text);
  const header = it.next().value;
  const out = [];
  for (const r of it) {
    if (r.length === 1 && r[0] === "") continue;
    const o = {};
    header.forEach((h, k) => (o[h] = r[k] ?? ""));
    out.push(o);
  }
  return out;
}

// ---------- download ----------
async function fetchMonth(year, month) {
  const mm = String(month).padStart(2, "0");
  const file = path.join(CACHE, `${year}-${mm}.zip`);
  const fresh =
    existsSync(file) && Date.now() - (await stat(file)).mtimeMs < 12 * 3600e3;
  if (!fresh) {
    const url = `${BULK}?type=csv&year=${year}&month=${mm}&method=all`;
    // The host publishes two addresses and one can hang: time out and retry.
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`  ${year}-${mm} attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3)
          await new Promise((r) => setTimeout(r, attempt * 20_000)); // the server returns 503s under load
      }
    }
    if (lastErr) throw lastErr;
  }
  const files = unzipSync(new Uint8Array(await readFile(file)));
  const pick = (prefix) => {
    const k = Object.keys(files).find((f) =>
      path.basename(f).startsWith(prefix),
    );
    return k ? rows(strFromU8(files[k])) : [];
  };
  return {
    releases: pick("releases_"),
    awards: pick("awards_"),
    suppliers: pick("suppliers_"),
  };
}

// ---------- build ----------
async function main() {
  await mkdir(CACHE, { recursive: true });
  console.log(`SERCOP bulk data, ${YEAR}, months ${months.join(", ")}`);

  // Later months win: a process that reappears with an updated compiled release replaces the old one.
  const buyerByOcid = new Map(); // ocid -> { ruc, name, date }
  const awards = new Map(); // `${ocid}|${awardId}` -> { ocid, amount, date, month, suppliers: [] }
  const supplierNames = new Map(); // supplier key -> name

  for (const m of months) {
    process.stdout.write(`  ${YEAR}-${String(m).padStart(2, "0")} ... `);
    const { releases, awards: aw, suppliers } = await fetchMonth(YEAR, m);
    for (const r of releases) {
      const ruc = rucOf(r.buyer_id);
      if (!ruc) continue;
      buyerByOcid.set(r.ocid, { ruc, name: r.buyer_name.trim(), date: r.date });
    }
    const supByAward = new Map();
    for (const s of suppliers) {
      const key = `${s.ocid}|${s.award_id}`;
      const sruc = rucOf(s.id);
      const sk = sruc || s.name.trim().toUpperCase();
      supplierNames.set(sk, s.name.replace(/\s+/g, " ").trim());
      if (!supByAward.has(key)) supByAward.set(key, []);
      supByAward.get(key).push({ key: sk, person: isPerson(sruc) });
    }
    let n = 0;
    for (const a of aw) {
      if (a.status && a.status !== "active") continue;
      const amount = Number(a.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const key = `${a.ocid}|${a.id}`;
      awards.set(key, {
        ocid: a.ocid,
        amount,
        date: (a.date || "").slice(0, 10),
        month: m,
        suppliers: supByAward.get(key) || [],
      });
      n++;
    }
    console.log(`${releases.length} releases, ${n} awards`);
  }

  // Aggregate per buyer (grouped by RUC so units of one entity roll up together).
  const buyers = new Map();
  const nameVotes = new Map();
  for (const a of awards.values()) {
    const b = buyerByOcid.get(a.ocid);
    if (!b) continue;
    let e = buyers.get(b.ruc);
    if (!e) {
      e = {
        ruc: b.ruc,
        total: 0,
        n: 0,
        monthly: Array(12).fill(0),
        sup: new Map(),
        list: [],
        processes: new Set(),
      };
      buyers.set(b.ruc, e);
      nameVotes.set(b.ruc, new Map());
    }
    const votes = nameVotes.get(b.ruc);
    votes.set(b.name, (votes.get(b.name) || 0) + 1);
    e.total += a.amount;
    e.n++;
    e.processes.add(a.ocid);
    e.monthly[a.month - 1] += a.amount;
    const share = a.amount / Math.max(1, a.suppliers.length);
    for (const s of a.suppliers) {
      const cur = e.sup.get(s.key) || { amount: 0, n: 0, person: s.person };
      cur.amount += share;
      cur.n++;
      e.sup.set(s.key, cur);
    }
    if (!a.date) a.date = (b.date || "").slice(0, 10); // catalog purchases carry no award date
    e.list.push(a);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, "b"), { recursive: true });

  const round = (x) => Math.round(x * 100) / 100;
  const index = [];
  const provinces = new Map();

  for (const e of buyers.values()) {
    const votes = [...nameVotes.get(e.ruc).entries()].sort(
      (x, y) => y[1] - x[1],
    );
    const name = votes[0][0];
    const prov = PROVINCES[e.ruc.slice(0, 2)] || "Sin provincia";
    const kind = buyerKind(name);

    const sups = [...e.sup.entries()]
      .map(([k, v]) => ({
        name: supplierNames.get(k) || k,
        amount: round(v.amount),
        n: v.n,
        person: v.person,
      }))
      .sort((x, y) => y.amount - x.amount);
    const topShare = e.total > 0 && sups.length ? sups[0].amount / e.total : 0;

    // Signals worth a closer look. Neutral wording: none of these is evidence of wrongdoing.
    const signals = [];
    if (e.total >= 100_000 && sups.length >= 1 && topShare >= 0.5) {
      signals.push({
        code: "concentracion",
        text: `Un solo proveedor concentra el ${Math.round(topShare * 100)}% del monto adjudicado.`,
      });
    }
    const repeat = sups.find((s) => s.n >= 15 && s.amount / s.n < 7_000);
    if (repeat) {
      signals.push({
        code: "repetido",
        text: `Un proveedor recibió ${repeat.n} adjudicaciones pequeñas (promedio bajo USD 7.000).`,
      });
    }

    const detail = {
      ruc: e.ruc,
      name,
      kind,
      province: prov,
      total: round(e.total),
      awards: e.n,
      processes: e.processes.size,
      suppliers: sups.length,
      monthly: e.monthly.map(round),
      topSuppliers: sups.slice(0, 15),
      signals,
      largest: e.list
        .sort((x, y) => y.amount - x.amount)
        .slice(0, 40)
        .map((a) => ({
          ocid: a.ocid,
          amount: round(a.amount),
          date: a.date,
          suppliers: a.suppliers.map((s) => supplierNames.get(s.key) || s.key),
        })),
    };
    await writeFile(
      path.join(OUT, "b", `${e.ruc}.json`),
      JSON.stringify(detail),
    );

    index.push({
      ruc: e.ruc,
      name,
      kind,
      province: prov,
      total: detail.total,
      processes: detail.processes,
      signals: signals.length,
    });

    const p = provinces.get(prov) || {
      province: prov,
      total: 0,
      entities: 0,
      byKind: {},
    };
    p.total += e.total;
    p.entities++;
    p.byKind[kind] = (p.byKind[kind] || 0) + e.total;
    provinces.set(prov, p);
  }

  index.sort((x, y) => y.total - x.total);
  const provList = [...provinces.values()]
    .map((p) => ({
      ...p,
      total: round(p.total),
      byKind: Object.fromEntries(
        Object.entries(p.byKind).map(([k, v]) => [k, round(v)]),
      ),
    }))
    .sort((x, y) => y.total - x.total);

  const total = index.reduce((s, b) => s + b.total, 0);
  const meta = {
    year: YEAR,
    months,
    generated: new Date().toISOString(),
    entities: index.length,
    total: round(total),
    awards: awards.size,
    source: "SERCOP, Contrataciones Abiertas Ecuador (OCDS)",
    sourceUrl: "https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA",
    license: "CC BY 3.0 EC",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/ec/",
  };

  await writeFile(path.join(OUT, "buyers.json"), JSON.stringify(index));
  await writeFile(path.join(OUT, "provinces.json"), JSON.stringify(provList));
  await writeFile(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(
    `Done: ${index.length} entities, ${awards.size} awards, USD ${Math.round(total).toLocaleString("en-US")}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
