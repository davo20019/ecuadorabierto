// Live clients for upstream APIs, shared by REST (src/index.ts) and MCP (src/mcp.ts).
//
// - SERCOP OCDS API: search procurement processes and read one record by ocid.
// - datosabiertos.gob.ec CKAN API: search and describe Ecuador's open-data catalog.
//
// Upstream servers are slow and sometimes return 503, so every call has a timeout,
// responses are cached at the edge for an hour, and failures surface as UpstreamError
// with a message that says which source is down (never a silent empty result).

const SERCOP = "https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/api";
const CKAN = "https://www.datosabiertos.gob.ec/api/3/action";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

async function getJson(url: string, source: string): Promise<unknown> {
  const get = () =>
    fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      // Cache answers, never rate limits or outages.
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": 3600, "404": 3600, "400-599": 0 },
      },
    });
  let res: Response;
  try {
    res = await get();
    // SERCOP rate-limits shared Cloudflare egress IPs now and then: retry once.
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 1, 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await get();
    }
  } catch {
    throw new UpstreamError(`${source} did not respond. Try again later.`, 504);
  }
  if (res.status === 404) throw new UpstreamError("Not found", 404);
  if (!res.ok)
    throw new UpstreamError(
      `${source} returned HTTP ${res.status}. Try again later.`,
    );
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(`${source} returned an unexpected response.`);
  }
}

const num = (v: unknown) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n)
    ? null
    : n;
};

// ---------- SERCOP ----------

export const SERCOP_SOURCE = {
  source: "SERCOP, Contrataciones Abiertas Ecuador (OCDS API)",
  sourceUrl: "https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA",
  license: "CC BY 3.0 EC",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0/ec/",
};

export const processUrl = (ocid: string) =>
  `https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/ocds/${encodeURIComponent(ocid)}`;

type SearchRow = {
  ocid: string;
  year: number;
  month: number;
  method: string | null;
  internal_type: string | null;
  locality: string | null;
  region: string | null;
  buyer: string | null;
  amount: string | null;
  budget: string | null;
  date: string | null;
  title: string | null;
  description: string | null;
};

export async function searchProcesses(p: {
  year: number;
  query?: string;
  buyer?: string;
  supplier?: string;
  page: number;
}) {
  const qs = new URLSearchParams({ year: String(p.year), page: String(p.page) });
  if (p.query) qs.set("search", p.query);
  if (p.buyer) qs.set("buyer", p.buyer);
  if (p.supplier) qs.set("supplier", p.supplier);
  const d = (await getJson(`${SERCOP}/search_ocds?${qs}`, "SERCOP")) as {
    total: number;
    page: number;
    pages: number;
    data: SearchRow[];
  };
  if (!Array.isArray(d?.data))
    throw new UpstreamError("SERCOP returned an unexpected response.");
  return {
    total: d.total,
    page: d.page,
    pages: d.pages,
    nextPage: d.page < d.pages ? d.page + 1 : null,
    results: d.data.map((r) => ({
      ocid: r.ocid,
      title: r.title,
      description: r.description,
      buyer: r.buyer,
      type: r.internal_type,
      method: r.method,
      locality: r.locality,
      province: r.region,
      amount: num(r.amount),
      budget: num(r.budget),
      date: r.date,
      url: processUrl(r.ocid),
    })),
  };
}

type Party = { name?: string };
type Release = {
  ocid: string;
  date?: string;
  tag?: string[];
  buyer?: { id?: string; name?: string };
  tender?: {
    title?: string;
    description?: string;
    status?: string;
    procurementMethod?: string;
    procurementMethodDetails?: string;
    value?: { amount?: number; currency?: string };
    tenderPeriod?: { startDate?: string; endDate?: string };
  };
  awards?: {
    date?: string;
    status?: string;
    description?: string;
    value?: { amount?: number; currency?: string };
    suppliers?: Party[];
    items?: { description?: string; quantity?: number }[];
  }[];
  contracts?: {
    dateSigned?: string;
    status?: string;
    value?: { amount?: number; currency?: string };
  }[];
};

// A compiled OCDS record, reduced to what a reader needs. Supplier and party
// identifiers are dropped: a natural person's RUC contains their cédula.
export async function getProcess(ocid: string) {
  const d = (await getJson(
    `${SERCOP}/record?ocid=${encodeURIComponent(ocid)}`,
    "SERCOP",
  )) as { releases?: Release[] };
  const r = d?.releases?.at(-1);
  if (!r) throw new UpstreamError("Not found", 404);
  const buyerRuc = (r.buyer?.id?.match(/(\d{13})/) || [])[1] ?? null;
  return {
    ocid: r.ocid,
    date: r.date ?? null,
    stages: r.tag ?? [],
    buyer: {
      name: r.buyer?.name ?? null,
      // Buyer RUCs are public entities, not people; they link to compras_get_entity.
      ruc: buyerRuc,
    },
    tender: r.tender
      ? {
          title: r.tender.title ?? null,
          description: r.tender.description ?? null,
          status: r.tender.status ?? null,
          method: r.tender.procurementMethod ?? null,
          type: r.tender.procurementMethodDetails ?? null,
          amount: num(r.tender.value?.amount),
          period: r.tender.tenderPeriod ?? null,
        }
      : null,
    awards: (r.awards ?? []).map((a) => ({
      date: a.date ?? null,
      status: a.status ?? null,
      amount: num(a.value?.amount),
      suppliers: (a.suppliers ?? []).map((s) => s.name ?? "").filter(Boolean),
      description: a.description ?? null,
      items: (a.items ?? []).slice(0, 25).map((i) => ({
        description: i.description ?? null,
        quantity: i.quantity ?? null,
      })),
    })),
    contracts: (r.contracts ?? []).map((c) => ({
      dateSigned: c.dateSigned ?? null,
      status: c.status ?? null,
      amount: num(c.value?.amount),
    })),
    url: processUrl(r.ocid),
  };
}

// ---------- CKAN (datosabiertos.gob.ec) ----------

export const CKAN_SOURCE = {
  source: "Portal de Datos Abiertos del Ecuador (CKAN API)",
  sourceUrl: "https://www.datosabiertos.gob.ec",
  license: "Varies by dataset; see each dataset's license field",
};

type CkanResource = {
  id: string;
  name?: string;
  format?: string;
  url?: string;
  last_modified?: string | null;
  created?: string;
};
type CkanPackage = {
  id: string;
  name: string;
  title: string;
  notes?: string;
  metadata_modified: string;
  metadata_created: string;
  license_title?: string;
  license_url?: string;
  organization?: { name: string; title: string } | null;
  tags?: { name: string }[];
  resources?: CkanResource[];
};

async function ckan<T>(action: string, qs: URLSearchParams): Promise<T> {
  const d = (await getJson(`${CKAN}/${action}?${qs}`, "datosabiertos.gob.ec")) as {
    success?: boolean;
    result?: T;
  };
  if (!d?.success || d.result === undefined)
    throw new UpstreamError("Not found", 404);
  return d.result;
}

const datasetUrl = (name: string) =>
  `https://www.datosabiertos.gob.ec/dataset/${encodeURIComponent(name)}`;

const summary = (p: CkanPackage) => ({
  id: p.name,
  title: p.title?.trim(),
  publisher: p.organization?.title?.trim() ?? null,
  publisherId: p.organization?.name ?? null,
  modified: p.metadata_modified?.slice(0, 10) ?? null,
  formats: [
    ...new Set(
      (p.resources ?? [])
        .map((r) => (r.format ?? "").toLowerCase().replace(/^\./, ""))
        .filter(Boolean),
    ),
  ],
  url: datasetUrl(p.name),
});

export async function searchDatasets(p: {
  query: string;
  publisher?: string;
  limit: number;
  offset: number;
}) {
  const qs = new URLSearchParams({
    q: p.query || "*:*",
    rows: String(p.limit),
    start: String(p.offset),
    // Relevance first when searching; newest first when browsing.
    sort: p.query ? "score desc, metadata_modified desc" : "metadata_modified desc",
  });
  // Solr filter values are quoted, so a publisher id cannot inject query syntax.
  if (p.publisher)
    qs.set("fq", `organization:"${p.publisher.replace(/["\\]/g, "")}"`);
  const r = await ckan<{ count: number; results: CkanPackage[] }>(
    "package_search",
    qs,
  );
  return {
    total: r.count,
    offset: p.offset,
    limit: p.limit,
    nextOffset: p.offset + p.limit < r.count ? p.offset + p.limit : null,
    results: r.results.map(summary),
  };
}

export async function getDataset(id: string) {
  const p = await ckan<CkanPackage>(
    "package_show",
    new URLSearchParams({ id }),
  );
  return {
    ...summary(p),
    description: p.notes?.slice(0, 4000) ?? null,
    created: p.metadata_created?.slice(0, 10) ?? null,
    license: p.license_title ?? null,
    licenseUrl: p.license_url ?? null,
    tags: (p.tags ?? []).map((t) => t.name),
    files: (p.resources ?? []).map((r) => ({
      name: r.name ?? null,
      format: (r.format ?? "").replace(/^\./, "") || null,
      url: r.url ?? null,
      modified: (r.last_modified ?? r.created ?? "").slice(0, 10) || null,
    })),
  };
}

export async function listPublishers() {
  const r = await ckan<
    { name: string; title: string; package_count: number }[]
  >(
    "organization_list",
    new URLSearchParams({ all_fields: "true", limit: "1000" }),
  );
  return r
    .map((o) => ({ id: o.name, name: o.title.trim(), datasets: o.package_count }))
    .sort((a, b) => b.datasets - a.datasets);
}
