# Ecuador Abierto

Open data about Ecuador, organized in modules, with a Spanish-language website, JSON API, and one public read-only MCP server for agents.

Modules:

- **Compras públicas** explores Ecuador's public procurement: what public entities buy, who supplies it, and how much is awarded. Entity pages are built from SERCOP's Open Contracting Data Standard (OCDS) bulk files; contract search queries SERCOP's OCDS API live.
- **Presupuesto** shows execution of the Presupuesto General del Estado per central-government unit: initial, adjusted, committed, accrued and paid. It is built from the Ministerio de Economía y Finanzas monthly files, found through the datosabiertos.gob.ec CKAN API.
- **Catálogo de datos** searches Ecuador's national open-data catalog (datosabiertos.gob.ec) live through its CKAN API.

Modules are added only where an upstream API exists to find or query the data. Elections (CNE), INEC census tables, National Assembly and Contraloría were evaluated and are not built: their sources have no API, sit behind bot protection, or publish no machine-readable files.

**[Live website](https://ecuadorabierto.com)** · **[MCP connection guide](https://ecuadorabierto.com/developers)**

## Modules

Each module uses the same layout, so adding one means adding a data script, a page, and a set of prefixed tools:

| Piece        | Path                           | Compras example                          |
| ------------ | ------------------------------ | ---------------------------------------- |
| Website      | `public/<module>/`             | `/compras/`                              |
| Data         | `public/data/<module>/`        | `/data/compras/buyers.json`              |
| Live client  | `src/live.ts`                  | SERCOP and CKAN API calls                |
| REST API     | `/api/<module>/…`              | `/api/compras/buyers?q=cuenca`           |
| MCP tools    | `<module>_<tool>`              | `compras_search_entities`                |
| MCP resource | `ecuador-abierto://<module>/…` | `ecuador-abierto://compras/dataset/info` |

## Features

- Search municipalities, prefectures, parishes, public companies, and other public entities.
- Filter by province and entity type; sort results by name or awarded amount.
- Explore monthly amounts, top suppliers, largest awards, and neutral review signals.
- Search individual contracts live in SERCOP's OCDS API.
- See each ministry's budget, how much it has spent, and in what.
- Search the national open-data catalog and reach the original files.
- Query everything through REST or 13 MCP tools.
- Deploy on Cloudflare Workers with Static Assets, without a database.

## Run locally

Requires Node.js 22 or newer and npm. No Cloudflare account is needed for local development.

```bash
git clone https://github.com/davo20019/ecuadorabierto.git
cd ecuadorabierto
npm ci --legacy-peer-deps

# Generate the dataset from SERCOP before opening the app.
npm run data -- --year 2026 --months 1-10
npm run data:presupuesto
npm run dev
```

Open the address printed by Wrangler (usually `http://localhost:8787`). If that port is occupied, use `npm run dev -- --port 8799`.

**Generated data is not committed.** The website and query tools need `public/data/compras/` to be generated first. Downloading and processing multiple months can take several minutes and requires access to SERCOP's servers. They sometimes return 503; the script retries and caches downloads in `.cache/` for 12 hours. A failed download exits with an error. Source records may change, so rebuilding a historical period may produce different totals.

```bash
npm run data                         # current year through the current month
npm run data -- --year 2025          # full past year
npm run data -- --year 2026 --months 1-3
```

A successful build replaces the previous `public/data/compras/` snapshot. The app serves one snapshot at a time, not multiple selectable years.

```bash
npm run data:presupuesto                      # latest year and month MEF has published
npm run data:presupuesto -- --year 2025 --month 3
```

The presupuesto script asks the CKAN API for every `mef-ejecucion-de-gasto-del-presupuesto-general-del-estado-pge-<year>-<month>` dataset, downloads each month of the chosen year (cached in `.cache/presupuesto/` for 12 hours), and checks the columns and period of every file. If a check fails it exits with an error and the previous `public/data/presupuesto/` snapshot is left untouched. MEF publishes with a lag; check `meta.json` for the cut-off month.

## Validate

```bash
npm run typecheck
npx wrangler deploy --dry-run

# With the local server running and the full dataset generated:
npm run test:mcp -- http://localhost:8787
SKIP_LIVE=1 npm run test:mcp -- http://localhost:8787   # without calling SERCOP or CKAN
```

The MCP integration test uses the official SDK client to verify initialization, tool discovery, resource reads, searches, pagination, province scopes, invalid inputs, CORS, and request-size limits. It expects a compras dataset with Cuenca and Cañar records and at least two entities, and a presupuesto dataset with a health unit. Live tools are tested against SERCOP and datosabiertos.gob.ec unless `SKIP_LIVE=1` is set. Pass your server's URL if using another port or testing a deployment.

`worker-configuration.d.ts` is generated from Wrangler configuration and included for type checking. After changing bindings, run `npm run types`.

## Deploy your own instance

After generating the dataset and running validation:

```bash
npx wrangler login
npm run deploy
```

Wrangler publishes to `https://ecuador-gasto.<your-subdomain>.workers.dev` and to the custom domain in `wrangler.jsonc` (`ecuadorabierto.com`). The Worker keeps the name `ecuador-gasto` so its original workers.dev URL keeps working for existing MCP clients. For a fork, remove the `routes` entry or set your own domain, and replace the endpoint URLs in `public/developers.html` and `public/llms.txt`.

### Domain setup

The custom-domain route requires the `ecuadorabierto.com` zone to be active in the same Cloudflare account; Wrangler creates the DNS record and certificate on deploy. `www.ecuadorabierto.com` and `ecuadorabierto.org` (apex and `www`) are not served by the Worker: give each a proxied placeholder DNS record (`A 192.0.2.1`) and a Redirect Rule that sends `301` to `https://ecuadorabierto.com` with the original path and query.

Authentication is handled by Wrangler outside the repository. Do not commit credentials, `.env` files, or `.dev.vars` files.

## Remote MCP

Endpoint: **`https://ecuadorabierto.com/mcp`** (the original `https://ecuador-gasto.davo20019.workers.dev/mcp` still works)

Transport: **Streamable HTTP**. Public access, read-only, no token required. Add the URL as a remote MCP server in a compatible client. Configuration formats vary by client; see the [connection guide](https://ecuadorabierto.com/developers).

| Tool                       | Purpose                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `compras_get_dataset_info` | Coverage period, update time, source, license, and totals                             |
| `compras_search_entities`  | Search by `query`, `province`, and `kind`; paginate with `limit` (1–100) and `offset` |
| `compras_get_entity`       | Monthly amounts, suppliers, largest awards, and signals for a 13-digit buyer `ruc`    |
| `compras_list_provinces`   | Province rankings; `local_only` defaults to true                                      |
| `compras_search_processes` | Live: search SERCOP processes by `year`, `query`, `buyer`, `supplier`; 10 per `page`  |
| `compras_get_process`      | Live: one process by `ocid` (tender, awards, contracts); supplier IDs removed         |
| `presupuesto_get_dataset_info` | Cut-off month, national totals, year-to-date curve, source dataset, license        |
| `presupuesto_search_entities`  | Search budget units (UDAF) by `query` and `sector`; `limit`, `offset`             |
| `presupuesto_get_entity`   | One unit by `code`: groups, budget types, units, items, monthly curve                 |
| `presupuesto_list_groups`  | National totals by spending group                                                     |
| `datos_search_datasets`    | Live: search datosabiertos.gob.ec by `query` and `publisher`; `limit`, `offset`       |
| `datos_get_dataset`        | Live: one catalog entry by `id` with license and download links                       |
| `datos_list_publishers`    | Live: publishing institutions and their dataset counts                                |

Entity types: `municipio`, `prefectura`, `parroquia`, `empresa`, `otro`.

Resources: `ecuador-abierto://compras/dataset/info`, `ecuador-abierto://presupuesto/dataset/info`. Live tools are annotated `openWorldHint: true`, call upstream with a 20-second timeout and a one-hour edge cache, and return an error naming the source when it is unavailable. Every tool result includes provenance and interpretation caveats. The server uses the official MCP TypeScript SDK with stateless JSON responses. POST handles protocol requests, OPTIONS supports browser clients, and GET returns 405 because there is no server-initiated SSE stream. Request bodies are limited to 64 KiB.

Example question: “Find Cuenca's municipality, check the available period, and summarize its three largest suppliers with source attribution.”

## JSON API

- `GET /api/compras/meta`
- `GET /api/compras/buyers?q=cuenca&kind=municipio&province=Azuay&limit=20`
- `GET /api/compras/buyers/:ruc`
- `GET /api/compras/provinces`
- `GET /api/compras/processes?q=hospital&buyer=…&supplier=…&year=2026&page=1` (live)
- `GET /api/compras/processes/:ocid` (live)
- `GET /api/presupuesto/meta`
- `GET /api/presupuesto/entities?q=salud&sector=…&limit=20`
- `GET /api/presupuesto/entities/:code`
- `GET /api/presupuesto/groups`
- `GET /api/datos/datasets?q=impuestos&publisher=…&limit=20&offset=0` (live)
- `GET /api/datos/datasets/:id` (live)
- `GET /api/datos/publishers` (live)

The pre-module paths (`/api/meta`, `/api/buyers`, `/api/provinces`) remain as aliases of the compras endpoints.

## Project layout

- `public/index.html` — Ecuador Abierto home page listing the modules
- `public/compras/` — public procurement explorer and live contract search
- `public/presupuesto/` — budget execution explorer
- `public/datos/` — live open-data catalog search
- `public/` — shared styles, developer guide, and agent discovery notes
- `src/index.ts` — Worker routing and REST API
- `src/mcp.ts` — MCP tools, resources, and transport
- `src/live.ts` — SERCOP OCDS and datosabiertos.gob.ec CKAN API clients
- `scripts/build-data.mjs` — SERCOP download and aggregation pipeline for the compras module
- `scripts/build-presupuesto.mjs` — MEF budget pipeline (CKAN discovery, download, validation, aggregation)
- `scripts/test-mcp.mjs` — MCP integration checks
- `scripts/brand/` — Open Graph card source and `render.sh`, which regenerates the favicon PNG/ICO files and `public/og*.png` (needs Chrome and ImageMagick)
- `wrangler.jsonc` — Worker and static-asset configuration

## Data and interpretation limits

- This is an independent prototype, not an official government service.
- Figures represent procurement awards, not actual payments or total government budgets. Salaries, pensions, debt, and transfers are excluded.
- Province is inferred from buyer RUC registration, which can reflect historical boundaries or headquarters. For example, some entities in Lago Agrio and Francisco de Orellana appear under Napo.
- Entity categories are inferred from names and can be imperfect.
- Monthly totals group awards by their source bulk-file month. Updated awards appearing in multiple files are deduplicated, with later files taking precedence; the monthly chart is not a cash-flow statement.
- Where an award has multiple suppliers, its value is split equally for supplier aggregation.
- Review signals are patterns worth examining, not evidence of wrongdoing. Verify the original SERCOP record.
- Supplier identifiers are omitted from generated output. Public supplier names remain visible.
- Data is a static snapshot. Check metadata for coverage and generation time.
- Presupuesto covers the Presupuesto General del Estado only. Municipalities, prefectures, parishes, IESS and public companies have their own budgets and are not included, so presupuesto and compras cover different sets of entities. Figures are cumulative year to date; `devengado` (accrued) is the execution measure. Some budget units are accounting units such as debt service or transfers.
- Live results reflect SERCOP and datosabiertos.gob.ec at the time of the request (cached up to an hour). Catalog descriptions are written by each publisher, and each dataset has its own license.

## License and attribution

Project code and original documentation are licensed under the [MIT License](LICENSE).

SERCOP source data is separately attributed under [CC BY 3.0 Ecuador](https://creativecommons.org/licenses/by/3.0/ec/), as recorded in dataset metadata. MEF budget data is published on datosabiertos.gob.ec under Creative Commons Attribution; the exact license and source dataset are recorded in `public/data/presupuesto/meta.json`. The MIT license does not relicense source data or third-party dependencies. Preserve SERCOP attribution and the data license when reusing derived datasets.

Source: [SERCOP — Contrataciones Abiertas Ecuador](https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/datos-abiertos).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and data-handling expectations.
