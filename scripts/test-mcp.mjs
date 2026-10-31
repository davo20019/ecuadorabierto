import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const base = process.argv[2] || "http://localhost:8787";
const client = new Client({
  name: "ecuador-abierto-integration-test",
  version: "1.0.0",
});
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
try {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
  assert.ok(
    tools.every((t) => /^(compras|presupuesto|datos)_/.test(t.name)),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return r.structuredContent;
  };
  const info = await call("compras_get_dataset_info");
  assert.ok(Number.isInteger(info.data.entities) && info.data.entities > 1);
  assert.ok(info.caveats.includes("not total budgets"));
  const search = await call("compras_search_entities", {
    query: "cuenca",
    kind: "municipio",
  });
  assert.ok(search.data.results.length);
  const buyer = search.data.results[0];
  const detail = await call("compras_get_entity", { ruc: buyer.ruc });
  assert.equal(detail.data.entity.name, buyer.name);
  assert.ok(detail.data.entity.largest.length);
  const a = await call("compras_search_entities", { limit: 1, offset: 0 });
  const b = await call("compras_search_entities", { limit: 1, offset: 1 });
  assert.notEqual(a.data.results[0].ruc, b.data.results[0].ruc);
  assert.equal(a.data.nextOffset, 1);
  const accented = await call("compras_search_entities", { province: "canar" });
  assert.ok(accented.data.results.length);
  assert.ok(accented.data.results.every((b) => b.province === "Cañar"));
  const provinces = await call("compras_list_provinces");
  const all = await call("compras_list_provinces", { local_only: false });
  assert.ok(provinces.data.provinces.length > 0);
  assert.equal(provinces.data.provinces.length, all.data.provinces.length);
  assert.ok(
    all.data.provinces[0].rankedAmount >
      provinces.data.provinces[0].rankedAmount,
  );
  const budget = await call("presupuesto_get_dataset_info");
  assert.ok(budget.data.entities > 1 && budget.data.codificado > 0);
  assert.ok(budget.caveats.includes("devengado"));
  const units = await call("presupuesto_search_entities", { query: "salud" });
  assert.ok(units.data.results.length);
  const unit = await call("presupuesto_get_entity", {
    code: units.data.results[0].code,
  });
  assert.equal(unit.data.entity.name, units.data.results[0].name);
  assert.ok(unit.data.entity.byGroup.length && unit.data.entity.monthly.length);
  const groups = await call("presupuesto_list_groups");
  assert.ok(groups.data.length);
  assert.equal(
    (
      await client.callTool({
        name: "presupuesto_get_entity",
        arguments: { code: "999999" },
      })
    ).isError,
    true,
  );
  // Live tools reach SERCOP and datosabiertos.gob.ec; SKIP_LIVE=1 skips them offline.
  if (!process.env.SKIP_LIVE) {
    const procs = await call("compras_search_processes", { query: "hospital" });
    assert.ok(procs.data.total > 0 && procs.data.results[0].ocid);
    assert.equal(procs.metadata.live, true);
    const proc = await call("compras_get_process", {
      ocid: procs.data.results[0].ocid,
    });
    assert.equal(proc.data.ocid, procs.data.results[0].ocid);
    const sets = await call("datos_search_datasets", { query: "presupuesto" });
    assert.ok(sets.data.results.length);
    const set = await call("datos_get_dataset", {
      id: sets.data.results[0].id,
    });
    assert.ok(Array.isArray(set.data.files));
    const pubs = await call("datos_list_publishers");
    assert.ok(pubs.data.length > 1);
  }
  const resource = await client.readResource({
    uri: "ecuador-abierto://compras/dataset/info",
  });
  assert.equal(
    JSON.parse(resource.contents[0].text).metadata.entities,
    info.data.entities,
  );
  for (const args of [{ ruc: "invalid" }, { ruc: "0000000000000" }])
    assert.equal(
      (await client.callTool({ name: "compras_get_entity", arguments: args }))
        .isError,
      true,
    );
  assert.equal(
    (
      await client.callTool({
        name: "compras_search_entities",
        arguments: { limit: -1 },
      })
    ).isError,
    true,
  );
  const unknown = await client.callTool({
    name: "unknown_tool",
    arguments: {},
  });
  assert.equal(unknown.isError, true);
  const preflight = await fetch(base + "/mcp", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(base + "/mcp")).status, 405);
  const malformed = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: " ".repeat(65537),
  });
  assert.equal(oversized.status, 413);
  for (const path of [
    "/",
    "/compras/",
    "/styles.css",
    "/developers",
    "/llms.txt",
    "/api/compras/meta",
    "/api/compras/buyers?q=cuenca",
    "/api/compras/provinces",
    "/presupuesto/",
    "/datos/",
    "/api/presupuesto/meta",
    "/api/presupuesto/entities?q=salud",
    "/api/presupuesto/groups",
    // Pre-module aliases.
    "/api/meta",
    "/api/buyers?q=cuenca",
    "/api/provinces",
  ])
    assert.equal((await fetch(base + path)).status, 200, path);
  console.log(
    "PASS: MCP initialization, 13 tools, metadata resource, compras and presupuesto search, accent matching, pagination, details, province scopes, live SERCOP and CKAN tools (unless SKIP_LIVE), invalid input, missing entity, unknown tool, CORS, malformed and oversized requests, and website/API routes (including legacy aliases).",
  );
} finally {
  await client.close();
}
