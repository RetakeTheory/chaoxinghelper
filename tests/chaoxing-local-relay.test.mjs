import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createChaoxingRelayServer } from "../scripts/chaoxing-local-relay.mjs";

test("local Chaoxing relay requires auth and only forwards allowlisted targets", async (context) => {
  const token = "x".repeat(32);
  const seen = [];
  const server = createChaoxingRelayServer({ token, fetchImpl: async (url, init) => {
    seen.push({ url: String(url), cookie: init.headers.get("cookie"), ignored: init.headers.get("x-ignore") });
    return new Response("upstream", { headers: { "content-type": "text/plain", "set-cookie": "vc3=updated; Path=/" } });
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/internal/chaoxing-relay`;
  assert.equal((await fetch(endpoint, { headers: { "x-chaoxing-target": "https://mooc1-api.chaoxing.com/ananas/status/1" } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${token}`, "x-chaoxing-target": "https://evil.example/" } })).status, 403);
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}`, "x-chaoxing-target": "https://mooc1-api.chaoxing.com/ananas/status/1", cookie: "vc3=session", "x-ignore": "no" } });
  assert.equal(await response.text(), "upstream");
  assert.deepEqual(seen, [{ url: "https://mooc1-api.chaoxing.com/ananas/status/1", cookie: "vc3=session", ignored: null }]);
});
