import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const caveats =
  "SERCOP procurement awards only; not total budgets or actual payments. Province is inferred from buyer RUC and may reflect historical boundaries or headquarters. Review signals are not evidence of wrongdoing. Supplier identifiers are omitted. This is a static snapshot; check metadata for coverage and refresh date.";
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
type Buyer = {
  ruc: string;
  name: string;
  kind: string;
  province: string;
  total: number;
};
type Province = {
  province: string;
  total: number;
  entities: number;
  byKind: Record<string, number>;
};

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Public, read-only data: browser clients from any origin are intentionally allowed.
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Session-Id",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  // This stateless server has no server-initiated SSE stream or stored sessions.
  if (request.method !== "POST")
    return new Response(
      "Use an MCP Streamable HTTP client with POST /mcp. Documentation: /developers",
      { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } },
    );
  async function read<T>(path: string): Promise<T> {
    const response = await env.ASSETS.fetch(new URL(path, request.url));
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "Entity not found"
          : "Dataset temporarily unavailable",
      );
    return response.json() as Promise<T>;
  }
  const result = async (data: unknown) => {
    const structuredContent = {
      data,
      metadata: await read("/data/meta.json"),
      caveats,
    };
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  };
  const server = new McpServer(
    { name: "ecuador-gasto", version: "1.0.0" },
    { instructions: caveats },
  );
  server.registerTool(
    "get_dataset_info",
    {
      description:
        "Get coverage dates, update time, source, license, totals and limitations. Check before interpreting procurement data.",
      annotations,
    },
    async () => result(await read("/data/meta.json")),
  );
  server.registerTool(
    "search_entities",
    {
      description:
        "Search Ecuador public buyers by name, province or entity type. Accent-insensitive. Sorted by awarded amount descending. Paginated; use the returned RUC with get_entity.",
      annotations,
      inputSchema: {
        query: z.string().max(200).default(""),
        province: z.string().max(100).optional(),
        kind: z
          .enum(["municipio", "prefectura", "parroquia", "empresa", "otro"])
          .optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).max(10000).default(0),
      },
    },
    async ({ query, province, kind, limit, offset }) => {
      const terms = fold(query).split(/\s+/).filter(Boolean);
      const rows = (await read<Buyer[]>("/data/buyers.json"))
        .filter(
          (b) =>
            (!province || fold(b.province) === fold(province)) &&
            (!kind || b.kind === kind) &&
            terms.every((t) => fold(b.name).includes(t)),
        )
        .sort((a, b) => b.total - a.total);
      return result({
        total: rows.length,
        offset,
        limit,
        nextOffset: offset + limit < rows.length ? offset + limit : null,
        results: rows.slice(offset, offset + limit),
      });
    },
  );
  server.registerTool(
    "get_entity",
    {
      description:
        "Get a public buyer by its 13-digit RUC: monthly award amounts, top suppliers, largest awards and review signals. Includes a link to the entity page. Supplier IDs are excluded.",
      annotations,
      inputSchema: { ruc: z.string().regex(/^\d{13}$/) },
    },
    async ({ ruc }) =>
      result({
        entity: await read(`/data/b/${ruc}.json`),
        url: new URL(`/#/e/${ruc}`, request.url).href,
      }),
  );
  server.registerTool(
    "list_provinces",
    {
      description:
        "Rank provinces by awarded amount. local_only defaults to true and includes municipalities, prefectures, parishes and public companies. False includes central government and other entities. Amounts are USD.",
      annotations,
      inputSchema: { local_only: z.boolean().default(true) },
    },
    async ({ local_only }) => {
      const rows = (await read<Province[]>("/data/provinces.json"))
        .map((p) => ({
          ...p,
          rankedAmount: local_only
            ? ["municipio", "prefectura", "parroquia", "empresa"].reduce(
                (s, k) => s + (p.byKind[k] || 0),
                0,
              )
            : p.total,
        }))
        .sort((a, b) => b.rankedAmount - a.rankedAmount);
      return result({ localOnly: local_only, provinces: rows });
    },
  );
  server.registerResource(
    "dataset-info",
    "ecuador-gasto://dataset/info",
    {
      description: "Dataset provenance, coverage and interpretation limits",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            metadata: await read("/data/meta.json"),
            caveats,
          }),
        },
      ],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 65536,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    // JSON mode allows consuming the response before closing request-scoped resources.
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      headers,
    });
  } finally {
    await server.close();
  }
}
