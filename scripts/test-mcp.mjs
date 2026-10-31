import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const base = process.argv[2] || "http://localhost:8787";
const client = new Client({
  name: "ecuador-gasto-integration-test",
  version: "1.0.0",
});
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
try {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return r.structuredContent;
  };
  const info = await call("get_dataset_info");
  assert.ok(Number.isInteger(info.data.entities) && info.data.entities > 1);
  assert.ok(info.caveats.includes("not total budgets"));
  const search = await call("search_entities", {
    query: "cuenca",
    kind: "municipio",
  });
  assert.ok(search.data.results.length);
  const buyer = search.data.results[0];
  const detail = await call("get_entity", { ruc: buyer.ruc });
  assert.equal(detail.data.entity.name, buyer.name);
  assert.ok(detail.data.entity.largest.length);
  const a = await call("search_entities", { limit: 1, offset: 0 });
  const b = await call("search_entities", { limit: 1, offset: 1 });
  assert.notEqual(a.data.results[0].ruc, b.data.results[0].ruc);
  assert.equal(a.data.nextOffset, 1);
  const accented = await call("search_entities", { province: "canar" });
  assert.ok(accented.data.results.length);
  assert.ok(accented.data.results.every((b) => b.province === "Cañar"));
  const provinces = await call("list_provinces");
  const all = await call("list_provinces", { local_only: false });
  assert.ok(provinces.data.provinces.length > 0);
  assert.equal(provinces.data.provinces.length, all.data.provinces.length);
  assert.ok(
    all.data.provinces[0].rankedAmount >
      provinces.data.provinces[0].rankedAmount,
  );
  const resource = await client.readResource({
    uri: "ecuador-gasto://dataset/info",
  });
  assert.equal(
    JSON.parse(resource.contents[0].text).metadata.entities,
    info.data.entities,
  );
  for (const args of [{ ruc: "invalid" }, { ruc: "0000000000000" }])
    assert.equal(
      (await client.callTool({ name: "get_entity", arguments: args })).isError,
      true,
    );
  assert.equal(
    (
      await client.callTool({
        name: "search_entities",
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
    "/styles.css",
    "/developers",
    "/llms.txt",
    "/api/meta",
    "/api/buyers?q=cuenca",
    "/api/provinces",
  ])
    assert.equal((await fetch(base + path)).status, 200, path);
  console.log(
    "PASS: MCP initialization, 4 tools, metadata resource, search, accent matching, pagination, details, province scopes, invalid input, missing entity, unknown tool, CORS, malformed and oversized requests, and website/API routes.",
  );
} finally {
  await client.close();
}
