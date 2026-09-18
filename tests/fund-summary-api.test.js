import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../src/app/api/fund/route.js";

for (const selection of ["view=unknown", "view=summary&page=2", "view=summary&q=Apple", "view=summary&compare=VTI", "view=summary&format=csv", "view=summary&refresh=invalid", "view=holdings&refresh=1"]) {
  test(`summary selection rejects incompatible parameters: ${selection}`, async () => {
    const response = await GET(new Request(`https://secedgarterminal.com/api/fund?ticker=VOO&${selection}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match((await response.json()).error, /complete portfolio/);
  });
}
