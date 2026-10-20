import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCatalogs, flatten } from "./i18n-check.mjs";

test("flatten produces dotted paths", () => {
  assert.deepEqual(flatten({ a: { b: "x" }, c: "y" }), { "a.b": "x", c: "y" });
});

test("identical key sets pass", () => {
  const r = compareCatalogs({ a: "Hi {{n}}" }, { a: "مرحبا {{n}}" });
  assert.deepEqual(r.errors, []);
});

test("missing Arabic key fails", () => {
  const r = compareCatalogs({ a: "x", b: "y" }, { a: "س" });
  assert.deepEqual(r.errors, ["missing in ar: b"]);
});

test("extra Arabic key fails", () => {
  const r = compareCatalogs({ a: "x" }, { a: "س", z: "ص" });
  assert.deepEqual(r.errors, ["missing in en: z"]);
});

test("empty string fails", () => {
  const r = compareCatalogs({ a: "x" }, { a: " " });
  assert.ok(r.errors.some((e) => e.includes("empty string")));
});

test("placeholder mismatch fails", () => {
  const r = compareCatalogs({ a: "{{count}} items" }, { a: "عناصر" });
  assert.ok(r.errors.some((e) => e.includes("placeholder mismatch")));
});

test("identical text warns but does not fail", () => {
  const r = compareCatalogs({ a: "OK" }, { a: "OK" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
});
