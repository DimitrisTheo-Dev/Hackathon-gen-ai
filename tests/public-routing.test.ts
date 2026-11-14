import { test } from "node:test";
import assert from "node:assert/strict";
import proxy from "../proxy";

test("public root negotiates Markdown without affecting HTML or private routes", async () => {
  const md = proxy(
    new Request("https://castroom.test/", {
      headers: { Accept: "text/markdown" },
    }),
  );
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type")!, /text\/markdown/);
  assert.equal(md.headers.get("vary"), "Accept");
  assert.match(await md.text(), /not integrated yet/);
  const html = proxy(
    new Request("https://castroom.test/", {
      headers: { Accept: "text/html,text/markdown;q=0.1" },
    }),
  );
  assert.equal(html.headers.get("x-middleware-next"), "1");
  assert.equal(html.headers.get("vary"), "Accept");
  const privateRoute = proxy(
    new Request("https://castroom.test/studio/", {
      headers: { Accept: "text/markdown" },
    }),
  );
  assert.equal(privateRoute.headers.get("x-middleware-next"), "1");
});
test("unknown public paths return actual recoverable 404s in negotiated format", async () => {
  for (const accept of ["text/html", "text/markdown"]) {
    const response = proxy(
      new Request("https://castroom.test/absent", {
        headers: { Accept: accept },
      }),
    );
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type")!, new RegExp(accept));
    assert.match(await response.text(), /\/docs\//);
  }
});
