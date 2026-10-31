import { handleMcp } from "./mcp";
// Worker for the "¿En qué se gasta?" prototype.
// Static files (HTML + prebuilt JSON) are served by Workers Static Assets.
// REST and MCP read the same prebuilt JSON through the ASSETS binding.

type BuyerRow = {
  ruc: string;
  name: string;
  kind: string;
  province: string;
  total: number;
  processes: number;
  signals: number;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

// Accent- and case-insensitive matching ("Cañar" == "canar").
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

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
    const p = url.pathname;

    if (p === "/mcp" || p === "/mcp/") return handleMcp(req, env);

    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    // GET /api/meta
    if (p === "/api/meta")
      return json(await asset(env, req, "/data/meta.json"));

    // GET /api/buyers?q=cuenca&kind=municipio&province=Azuay&limit=20
    if (p === "/api/buyers") {
      const rows =
        (await asset<BuyerRow[]>(env, req, "/data/buyers.json")) ?? [];
      const q = fold(url.searchParams.get("q") ?? "");
      const kind = url.searchParams.get("kind");
      const province = url.searchParams.get("province");
      const limit = Math.min(
        Number(url.searchParams.get("limit") ?? 20) || 20,
        200,
      );
      const terms = q.split(/\s+/).filter(Boolean);
      const out = rows.filter(
        (r) =>
          (!kind || r.kind === kind) &&
          (!province || fold(r.province) === fold(province)) &&
          terms.every((t) => fold(r.name).includes(t)),
      );
      return json({ total: out.length, results: out.slice(0, limit) });
    }

    // GET /api/buyers/:ruc
    const m = p.match(/^\/api\/buyers\/(\d{13})$/);
    if (m) {
      const detail = await asset(env, req, `/data/b/${m[1]}.json`);
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }

    // GET /api/provinces
    if (p === "/api/provinces")
      return json(await asset(env, req, "/data/provinces.json"));

    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
