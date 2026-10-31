import { handleMcp } from "./mcp";
import {
  UpstreamError,
  getDataset,
  getProcess,
  listPublishers,
  searchDatasets,
  searchProcesses,
} from "./live";
// Worker for Ecuador Abierto. Each data module lives under /<module>/ for the
// website and /api/<module>/ for REST. Snapshot modules (compras, presupuesto)
// read prebuilt JSON from /data/<module>/ through the ASSETS binding; live
// endpoints (compras processes, datos) call the upstream APIs in src/live.ts.

type BuyerRow = {
  ruc: string;
  name: string;
  kind: string;
  province: string;
  total: number;
  processes: number;
  signals: number;
};

type BudgetRow = {
  code: string;
  name: string;
  sector: string;
  codificado: number;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600",
};

const json = (data: unknown, status = 200, maxAge = 3600) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": `public, max-age=${maxAge}` },
  });

// Live endpoints: shorter browser cache, and upstream failures keep their status.
async function live(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn(), 200, 600);
  } catch (e) {
    if (e instanceof UpstreamError)
      return json({ error: e.message }, e.status, 0);
    throw e;
  }
}

// Accent- and case-insensitive matching ("Cañar" == "canar").
const fold = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const int = (v: string | null, def: number, min: number, max: number) => {
  const n = Number(v ?? def);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : def;
};

async function asset<T>(
  env: Env,
  req: Request,
  path: string,
): Promise<T | null> {
  const res = await env.ASSETS.fetch(new URL(path, req.url));
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    // Pre-module API paths (/api/meta, /api/buyers…) keep working as compras.
    const p = url.pathname.replace(
      /^\/api\/(?=meta$|buyers(\/|$)|provinces$)/,
      "/api/compras/",
    );

    if (p === "/mcp" || p === "/mcp/") return handleMcp(req, env);

    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    // ---------- compras (snapshot) ----------

    // GET /api/compras/meta
    if (p === "/api/compras/meta")
      return json(await asset(env, req, "/data/compras/meta.json"));

    // GET /api/compras/buyers?q=cuenca&kind=municipio&province=Azuay&limit=20
    if (p === "/api/compras/buyers") {
      const rows =
        (await asset<BuyerRow[]>(env, req, "/data/compras/buyers.json")) ?? [];
      const kind = q.get("kind");
      const province = q.get("province");
      const limit = int(q.get("limit"), 20, 1, 200);
      const terms = fold(q.get("q") ?? "").split(/\s+/).filter(Boolean);
      const out = rows.filter(
        (r) =>
          (!kind || r.kind === kind) &&
          (!province || fold(r.province) === fold(province)) &&
          terms.every((t) => fold(r.name).includes(t)),
      );
      return json({ total: out.length, results: out.slice(0, limit) });
    }

    // GET /api/compras/buyers/:ruc
    const m = p.match(/^\/api\/compras\/buyers\/(\d{13})$/);
    if (m) {
      const detail = await asset(env, req, `/data/compras/b/${m[1]}.json`);
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }

    // GET /api/compras/provinces
    if (p === "/api/compras/provinces")
      return json(await asset(env, req, "/data/compras/provinces.json"));

    // ---------- compras (live, SERCOP OCDS API) ----------

    // GET /api/compras/processes?q=hospital&buyer=…&supplier=…&year=2026&page=1
    if (p === "/api/compras/processes") {
      const thisYear = new Date().getUTCFullYear();
      return live(() =>
        searchProcesses({
          year: int(q.get("year"), thisYear, 2015, thisYear),
          query: q.get("q")?.slice(0, 200) || undefined,
          buyer: q.get("buyer")?.slice(0, 200) || undefined,
          supplier: q.get("supplier")?.slice(0, 200) || undefined,
          page: int(q.get("page"), 1, 1, 10000),
        }),
      );
    }

    // GET /api/compras/processes/:ocid
    const po = p.match(/^\/api\/compras\/processes\/(ocds-[\w.-]{1,120})$/);
    if (po) return live(() => getProcess(po[1]));

    // ---------- presupuesto (snapshot) ----------

    // GET /api/presupuesto/meta
    if (p === "/api/presupuesto/meta")
      return json(await asset(env, req, "/data/presupuesto/meta.json"));

    // GET /api/presupuesto/entities?q=salud&sector=…&limit=20
    if (p === "/api/presupuesto/entities") {
      const rows =
        (await asset<BudgetRow[]>(
          env,
          req,
          "/data/presupuesto/entities.json",
        )) ?? [];
      const sector = q.get("sector");
      const limit = int(q.get("limit"), 20, 1, 200);
      const terms = fold(q.get("q") ?? "").split(/\s+/).filter(Boolean);
      const out = rows.filter(
        (r) =>
          (!sector || fold(r.sector) === fold(sector)) &&
          terms.every((t) => fold(r.name).includes(t)),
      );
      return json({ total: out.length, results: out.slice(0, limit) });
    }

    // GET /api/presupuesto/entities/:code
    const pe = p.match(/^\/api\/presupuesto\/entities\/(\d{1,6})$/);
    if (pe) {
      const detail = await asset(env, req, `/data/presupuesto/e/${pe[1]}.json`);
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }

    // GET /api/presupuesto/groups
    if (p === "/api/presupuesto/groups")
      return json(await asset(env, req, "/data/presupuesto/groups.json"));

    // ---------- datos (live, datosabiertos.gob.ec CKAN API) ----------

    // GET /api/datos/datasets?q=presupuesto&publisher=…&limit=20&offset=0
    if (p === "/api/datos/datasets")
      return live(() =>
        searchDatasets({
          query: q.get("q")?.slice(0, 200) ?? "",
          publisher: q.get("publisher")?.slice(0, 100) || undefined,
          limit: int(q.get("limit"), 20, 1, 100),
          offset: int(q.get("offset"), 0, 0, 10000),
        }),
      );

    // GET /api/datos/datasets/:id
    const dd = p.match(/^\/api\/datos\/datasets\/([\w-]{1,200})$/);
    if (dd) return live(() => getDataset(dd[1]));

    // GET /api/datos/publishers
    if (p === "/api/datos/publishers") return live(listPublishers);

    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
