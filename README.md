# Ecuador Abierto

Open data about Ecuador, organized in modules, with a Spanish-language website, JSON API, and one public read-only MCP server for agents.

The first module, **Compras públicas**, explores Ecuador's public procurement: what public entities buy, who supplies it, and how much is awarded. It is built from SERCOP's Open Contracting Data Standard (OCDS) bulk files. Planned modules: budget execution, National Assembly, elections, and INEC indicators.

**[Live website](https://ecuadorabierto.com)** · **[MCP connection guide](https://ecuadorabierto.com/developers)**

## Modules

Each module uses the same layout, so adding one means adding a data script, a page, and a set of prefixed tools:

| Piece        | Path                           | Compras example                          |
| ------------ | ------------------------------ | ---------------------------------------- |
| Website      | `public/<module>/`             | `/compras/`                              |
| Data         | `public/data/<module>/`        | `/data/compras/buyers.json`              |
| REST API     | `/api/<module>/…`              | `/api/compras/buyers?q=cuenca`           |
| MCP tools    | `<module>_<tool>`              | `compras_search_entities`                |
| MCP resource | `ecuador-abierto://<module>/…` | `ecuador-abierto://compras/dataset/info` |

## Features

- Search municipalities, prefectures, parishes, public companies, and other public entities.
- Filter by province and entity type; sort results by name or awarded amount.
- Explore monthly amounts, top suppliers, largest awards, and neutral review signals.
- Query the same data through REST or four MCP tools.
- Deploy on Cloudflare Workers with Static Assets, without a database.

## Run locally

Requires Node.js 22 or newer and npm. No Cloudflare account is needed for local development.

```bash
git clone https://github.com/davo20019/ecuadorabierto.git
cd ecuadorabierto
npm ci --legacy-peer-deps

# Generate the dataset from SERCOP before opening the app.
npm run data -- --year 2026 --months 1-10
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

## Validate

```bash
npm run typecheck
npx wrangler deploy --dry-run

# With the local server running and the full dataset generated:
npm run test:mcp -- http://localhost:8787
```

The MCP integration test uses the official SDK client to verify initialization, tool discovery, resource reads, searches, pagination, province scopes, invalid inputs, CORS, and request-size limits. It expects a dataset with Cuenca and Cañar records and at least two entities. Pass your server's URL if using another port or testing a deployment.

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

Entity types: `municipio`, `prefectura`, `parroquia`, `empresa`, `otro`.

Resource: `ecuador-abierto://compras/dataset/info`. Every tool result includes provenance and interpretation caveats. The server uses the official MCP TypeScript SDK with stateless JSON responses. POST handles protocol requests, OPTIONS supports browser clients, and GET returns 405 because there is no server-initiated SSE stream. Request bodies are limited to 64 KiB.

Example question: “Find Cuenca's municipality, check the available period, and summarize its three largest suppliers with source attribution.”

## JSON API

- `GET /api/compras/meta`
- `GET /api/compras/buyers?q=cuenca&kind=municipio&province=Azuay&limit=20`
- `GET /api/compras/buyers/:ruc`
- `GET /api/compras/provinces`

The pre-module paths (`/api/meta`, `/api/buyers`, `/api/provinces`) remain as aliases of the compras endpoints.

## Project layout

- `public/index.html` — Ecuador Abierto home page listing the modules
- `public/compras/` — public procurement explorer
- `public/` — shared styles, developer guide, and agent discovery notes
- `src/index.ts` — Worker routing and REST API
- `src/mcp.ts` — MCP tools, resource, and transport
- `scripts/build-data.mjs` — SERCOP download and aggregation pipeline for the compras module
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

## License and attribution

Project code and original documentation are licensed under the [MIT License](LICENSE).

SERCOP source data is separately attributed under [CC BY 3.0 Ecuador](https://creativecommons.org/licenses/by/3.0/ec/), as recorded in dataset metadata. The MIT license does not relicense source data or third-party dependencies. Preserve SERCOP attribution and the data license when reusing derived datasets.

Source: [SERCOP — Contrataciones Abiertas Ecuador](https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/datos-abiertos).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and data-handling expectations.
