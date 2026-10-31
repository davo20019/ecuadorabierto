// Builds the presupuesto module from the Ministerio de Economía y Finanzas (MEF)
// monthly "Ejecución de Gasto del PGE" files on datosabiertos.gob.ec.
//
//   node scripts/build-presupuesto.mjs                    # latest year and month published
//   node scripts/build-presupuesto.mjs --year 2025        # latest month published for 2025
//   node scripts/build-presupuesto.mjs --year 2025 --month 3
//
// The files are found through the portal's CKAN API (package_search), not hardcoded
// links, so new months are picked up as MEF publishes them. Each file is cumulative
// for the year up to its cut-off month. The cut-off month gives the full detail;
// earlier months of the same year give the year-to-date curve.
//
// Output (public/data/presupuesto/):
//   meta.json      cut-off, totals, source dataset, license
//   entities.json  one row per UDAF (financial administration unit)
//   groups.json    national totals by spending group (grupo de gasto)
//   e/<code>.json  detail per UDAF: groups, budget types, units, items, monthly curve
//
// The build fails, and leaves the previous snapshot in place, if the portal cannot be
// reached or a file is missing the expected columns.

import { mkdir, writeFile, readFile, rm, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const CACHE = path.join(ROOT, ".cache", "presupuesto");
const OUT = path.join(ROOT, "public", "data", "presupuesto");
const CKAN = "https://www.datosabiertos.gob.ec/api/3/action";
const PREFIX = "mef-ejecucion-de-gasto-del-presupuesto-general-del-estado-pge-";
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const COLUMNS = [
  "EJERCICIO",
  "MES",
  "SECTOR",
  "NOMBRE_SECTOR",
  "CODIGO_UDAF",
  "NOMBRE_UDAF",
  "CODIGO_EOD",
  "NOMBRE_EOD",
  "GRUPO_GASTO",
  "NOMBRE_GRUPO",
  "TIPO_PRESUPUESTO",
  "ITEM",
  "NOMBRE_ITEM",
  "INICIAL",
  "CODIFICADO",
  "COMPROMETIDO",
  "DEVENGADO",
  "PAGADO",
];
const AMOUNTS = ["inicial", "codificado", "comprometido", "devengado", "pagado"];

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);

async function retry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.warn(`  ${label} attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 10_000));
    }
  }
  throw lastErr;
}

async function ckan(action, params) {
  const url = `${CKAN}/${action}?${new URLSearchParams(params)}`;
  return retry(action, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (!d.success) throw new Error(d.error?.message || "CKAN error");
    return d.result;
  });
}

// Every published monthly spending file, as { year, month, pkg }.
async function catalog() {
  const found = [];
  for (let start = 0; ; start += 100) {
    const r = await ckan("package_search", {
      q: `name:${PREFIX}*`,
      rows: "100",
      start: String(start),
    });
    for (const pkg of r.results) {
      const m = pkg.name.match(new RegExp(`^${PREFIX}(\\d{4})-([a-z]+)$`));
      const month = m ? MONTHS.indexOf(m[2]) + 1 : 0;
      if (month) found.push({ year: Number(m[1]), month, pkg });
    }
    if (start + 100 >= r.count) break;
  }
  return found;
}

async function download(entry) {
  const { year, month, pkg } = entry;
  const res = pkg.resources.find(
    (r) => /csv/i.test(r.format || "") && /conjunto/i.test(r.name || ""),
  );
  if (!res) throw new Error(`${pkg.name}: no data CSV in the dataset`);
  const file = path.join(CACHE, `${year}-${String(month).padStart(2, "0")}.csv`);
  const fresh =
    existsSync(file) && Date.now() - (await stat(file)).mtimeMs < 12 * 3600e3;
  if (!fresh)
    await retry(`${year}-${month}`, async () => {
      const r = await fetch(res.url, { signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
    });
  const bytes = await readFile(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("latin1").decode(bytes);
  }
  return parse(text, `${year}-${month}`);
}

// Semicolon-separated, optional double quotes.
function splitLine(line) {
  if (!line.includes('"')) return line.split(";");
  const out = [];
  let f = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ";") out.push(f), (f = "");
    else f += c;
  }
  out.push(f);
  return out;
}

function parse(text, label) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitLine(lines[0]).map((h) => h.trim().toUpperCase());
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    throw new Error(`${label}: missing columns ${missing.join(", ")}`);
  const at = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)]));
  const rows = [];
  let bad = 0;
  for (const line of lines.slice(1)) {
    const f = splitLine(line);
    if (f.length !== header.length) {
      bad++;
      continue;
    }
    const row = Object.fromEntries(
      COLUMNS.map((c) => [c, (f[at[c]] ?? "").trim()]),
    );
    for (const c of ["INICIAL", "CODIFICADO", "COMPROMETIDO", "DEVENGADO", "PAGADO"])
      row[c] = Number(row[c].replace(",", ".")) || 0;
    rows.push(row);
  }
  if (bad > rows.length * 0.01)
    throw new Error(`${label}: ${bad} malformed rows out of ${lines.length - 1}`);
  if (!rows.length) throw new Error(`${label}: no rows`);
  return rows;
}

const round = (x) => Math.round(x * 100) / 100;
const zero = () => Object.fromEntries(AMOUNTS.map((k) => [k, 0]));
const add = (acc, r) => {
  for (const k of AMOUNTS) acc[k] += r[k.toUpperCase()];
  return acc;
};
const fin = (acc) => Object.fromEntries(AMOUNTS.map((k) => [k, round(acc[k])]));
const rate = (t) => (t.codificado > 0 ? round(t.devengado / t.codificado) : null);

function groupBy(rows, key, name) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    const g = m.get(k) || { code: k, name: r[name], ...zero() };
    add(g, r);
    m.set(k, g);
  }
  return [...m.values()]
    .map((g) => ({ code: g.code, name: g.name, ...fin(g) }))
    .sort((a, b) => b.codificado - a.codificado);
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const all = await catalog();
  if (!all.length) throw new Error("No MEF spending datasets found on the portal");
  const year = Number(args.year ?? Math.max(...all.map((e) => e.year)));
  const ofYear = all
    .filter((e) => e.year === year && (!args.month || e.month <= Number(args.month)))
    .sort((a, b) => a.month - b.month);
  if (!ofYear.length) throw new Error(`No MEF spending datasets for ${year}`);
  const latest = ofYear.at(-1);
  console.log(
    `MEF PGE spending ${year}, months ${ofYear.map((e) => e.month).join(", ")} (cut-off ${latest.month})`,
  );

  // Year-to-date curve: one total per UDAF per published month.
  const curve = new Map(); // code -> [{ month, codificado, devengado, pagado }]
  const national = [];
  let rows;
  for (const e of ofYear) {
    process.stdout.write(`  ${year}-${String(e.month).padStart(2, "0")} ... `);
    const r = await download(e);
    const wrongPeriod = r.filter(
      (x) => Number(x.EJERCICIO) !== year || Number(x.MES) !== e.month,
    ).length;
    if (wrongPeriod)
      throw new Error(`${year}-${e.month}: ${wrongPeriod} rows from another period`);
    const byUdaf = new Map();
    const tot = zero();
    for (const x of r) {
      const t = byUdaf.get(x.CODIGO_UDAF) || zero();
      add(t, x);
      add(tot, x);
      byUdaf.set(x.CODIGO_UDAF, t);
    }
    for (const [code, t] of byUdaf) {
      if (!curve.has(code)) curve.set(code, []);
      const f = fin(t);
      curve.get(code).push({
        month: e.month,
        codificado: f.codificado,
        devengado: f.devengado,
        pagado: f.pagado,
      });
    }
    const f = fin(tot);
    national.push({
      month: e.month,
      codificado: f.codificado,
      devengado: f.devengado,
      pagado: f.pagado,
    });
    console.log(`${r.length} rows`);
    if (e === latest) rows = r;
  }

  const byUdaf = new Map();
  for (const r of rows) {
    if (!byUdaf.has(r.CODIGO_UDAF)) byUdaf.set(r.CODIGO_UDAF, []);
    byUdaf.get(r.CODIGO_UDAF).push(r);
  }

  // Write to a temp dir, then swap, so a failure never leaves a half-written snapshot.
  const TMP = OUT + ".tmp";
  await rm(TMP, { recursive: true, force: true });
  await mkdir(path.join(TMP, "e"), { recursive: true });

  const index = [];
  for (const [code, list] of byUdaf) {
    const totals = fin(list.reduce(add, zero()));
    const detail = {
      code,
      name: list[0].NOMBRE_UDAF,
      sector: list[0].NOMBRE_SECTOR,
      ...totals,
      execution: rate(totals),
      byGroup: groupBy(list, "GRUPO_GASTO", "NOMBRE_GRUPO"),
      byType: groupBy(list, "TIPO_PRESUPUESTO", "TIPO_PRESUPUESTO").map(
        ({ code, ...g }) => g,
      ),
      units: groupBy(list, "CODIGO_EOD", "NOMBRE_EOD").slice(0, 40),
      unitCount: new Set(list.map((r) => r.CODIGO_EOD)).size,
      topItems: groupBy(list, "ITEM", "NOMBRE_ITEM").slice(0, 20),
      monthly: curve.get(code) ?? [],
    };
    await writeFile(path.join(TMP, "e", `${code}.json`), JSON.stringify(detail));
    index.push({
      code,
      name: detail.name,
      sector: detail.sector,
      codificado: detail.codificado,
      devengado: detail.devengado,
      pagado: detail.pagado,
      execution: detail.execution,
    });
  }
  index.sort((a, b) => b.codificado - a.codificado);

  const totals = fin(rows.reduce(add, zero()));
  const meta = {
    year,
    month: latest.month,
    months: ofYear.map((e) => e.month),
    generated: new Date().toISOString(),
    entities: index.length,
    ...totals,
    execution: rate(totals),
    national,
    source: "Ministerio de Economía y Finanzas, Ejecución de Gasto del PGE (eSIGEF)",
    sourceUrl: `https://www.datosabiertos.gob.ec/dataset/${latest.pkg.name}`,
    dataset: latest.pkg.name,
    datasetModified: latest.pkg.metadata_modified,
    license: latest.pkg.license_title || "Creative Commons Attribution",
    licenseUrl:
      latest.pkg.license_url || "http://www.opendefinition.org/licenses/cc-by",
  };

  await writeFile(path.join(TMP, "entities.json"), JSON.stringify(index));
  await writeFile(
    path.join(TMP, "groups.json"),
    JSON.stringify(groupBy(rows, "GRUPO_GASTO", "NOMBRE_GRUPO")),
  );
  await writeFile(path.join(TMP, "meta.json"), JSON.stringify(meta, null, 2));
  await rm(OUT, { recursive: true, force: true });
  await rename(TMP, OUT);

  console.log(
    `Done: ${index.length} entities, adjusted USD ${Math.round(totals.codificado).toLocaleString("en-US")}, accrued ${Math.round((meta.execution ?? 0) * 100)}%`,
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
