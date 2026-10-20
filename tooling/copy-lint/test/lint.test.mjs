import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { lintSource } from "../lint.mjs";
import { matchText, normalize } from "../rules.mjs";

const fx = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", n), "utf8");
const rules = (src, name = "x.tsx") => lintSource(name, src).map((f) => f.rule);
const s = (text) => `export const a = ${JSON.stringify(text)};`;

test("EN positives", () => {
  const cases = {
    "social-proof-viewing": ["12 people are viewing this", "37 shoppers watching now", "5 viewing"],
    "social-proof-bought": ["237 bought today", "50+ sold in the last 24 hours"],
    "fake-scarcity": ["Only 3 left", "Only 2 left in stock", "last 4 items"],
    "fake-urgency": ["Selling fast", "Hurry up", "Almost gone", "Don't miss out"],
    "fake-countdown": ["Ends in 3 hours", "02:59:59", "15 minutes left"],
    "fake-discount": ["70% off", "Save 50%", "Up to 80% discount"],
    "confirm-shaming": ["No thanks, I hate saving", "No, I'd rather pay full price", "I don't like deals"],
  };
  for (const [rule, texts] of Object.entries(cases))
    for (const t of texts) assert.ok(rules(s(t)).includes(rule), `${rule}: ${t}`);
});

test("AR positives incl. Eastern Arabic digits and diacritics", () => {
  const cases = {
    "social-proof-viewing": ["١٤ شخص يشاهدون الآن"],
    "social-proof-bought": ["تم بيع ٢٣٧ قطعة اليوم"],
    "fake-scarcity": ["متبقي ٣ قطع فقط", "فقط 2 قطع"],
    "fake-urgency": ["يُباع بسرعة", "سارع بالشراء", "لا تفوّت الفرصة"],
    "fake-countdown": ["ينتهي خلال ٢ ساعة", "باقي ١٥ دقيقة"],
    "fake-discount": ["خصم ٧٠٪", "٥٠٪ خصم"],
    "confirm-shaming": ["لا شكرا، أنا أكره التوفير"],
  };
  for (const [rule, texts] of Object.entries(cases))
    for (const t of texts) assert.ok(rules(s(t)).includes(rule), `${rule}: ${t}`);
});

test("negatives EN and AR", () => {
  for (const t of ["Your bag has 2 items", "Step 2 of 4", "Delivery in 2-3 days", "Return within 14 days", "No thanks", "Hello", "Order #123 placed",
    "لا توجد عملات على وشك الانتهاء.", "لا شكرا", "سيتم التوصيل خلال ٢ إلى ٣ أيام", "لديك ٢ منتجات في الحقيبة", "الخطوة ٢ من ٤", "Date: Sun, 11 Oct 2026 10:00:00 GMT"])
    assert.deepEqual(rules(s(t)), [], t);
});

test("templated numbers from props are not false positives; urgency phrases still are", () => {
  assert.deepEqual(rules("export const a = (n:number)=>`${n} people are viewing`;"), []);
  assert.deepEqual(rules("export const a = (n:number)=>`Only ${n} left in stock`;"), []);
  assert.deepEqual(rules("export const a = (n:number)=>`${n}% off`;"), []);
  assert.ok(rules("export const a = (n:number)=>`${n} items selling fast`;").includes("fake-urgency"));
});

test("import specifiers, keys and type literals are ignored", () => {
  assert.deepEqual(rules(`import x from "selling fast"; type T = "only 3 left"; const o = { "selling fast": 1 };`), []);
});

test("JSX text and attributes", () => {
  assert.ok(rules("export const a = () => <Text>Only 3 left</Text>;").includes("fake-scarcity"));
  assert.ok(rules(`export const a = () => <Button title="Selling fast" />;`).includes("fake-urgency"));
  assert.deepEqual(rules(`export const a = () => <View testID="selling fast" />;`), []);
});

test("pre-ticked consent", () => {
  assert.ok(rules("export const c = { marketing_push: { granted: true } };").includes("prechecked-consent"));
  assert.ok(rules(`export const a = () => <Switch value={true} accessibilityLabel="analytics" />;`).includes("prechecked-consent"));
  assert.ok(rules(`export const a = () => { const [marketing, setM] = useState(true); return null; };`).includes("prechecked-consent"));
  assert.deepEqual(rules("export const c = { marketing_push: { granted: false } };"), []);
  assert.deepEqual(rules("export const c = { darkMode: { enabled: true } };"), []);
});

test("countdown without server time", () => {
  assert.ok(rules("export const a = () => <CountdownRing seconds={60} />;").includes("countdown-not-server"));
  assert.deepEqual(rules("const serverTime = 1; export const a = () => <CountdownRing endsAt={serverTime} />;"), []);
});

test("allowlist needs server-derived justification", () => {
  const f = lintSource("allowed.ts", fx("allowed.ts"));
  assert.deepEqual(f.map((x) => x.rule).sort(), ["allow-invalid", "fake-scarcity"]);
  assert.equal(f.find((x) => x.rule === "fake-scarcity").match.includes("4"), true);
});

test("central allowlist entry", () => {
  const al = [{ file: "x.ts", rule: "fake-scarcity", match: "Only 3", justification: "server-derived: GET /v1/products/{id}" }];
  assert.deepEqual(lintSource("x.ts", s("Only 3 left"), { allowlist: al }), []);
  assert.equal(lintSource("x.ts", s("Only 3 left"), { allowlist: [{ ...al[0], justification: "ok" }] }).length, 1);
});

test("fixtures", () => {
  const en = new Set(rules(fx("violations.en.tsx"), "v.tsx"));
  for (const r of ["social-proof-viewing", "social-proof-bought", "fake-scarcity", "fake-urgency", "fake-countdown", "fake-discount", "confirm-shaming", "prechecked-consent"])
    assert.ok(en.has(r), r);
  const ar = new Set(rules(fx("violations.ar.ts"), "v.ts"));
  for (const r of ["social-proof-viewing", "social-proof-bought", "fake-scarcity", "fake-urgency", "fake-countdown", "fake-discount", "confirm-shaming"])
    assert.ok(ar.has(r), r);
  assert.deepEqual(rules(fx("clean.tsx")), []);
});

test("normalize", () => {
  assert.equal(normalize("٣ ۴"), "3 4");
});
test("matchText performance", () => {
  const t = Date.now();
  for (let i = 0; i < 2000; i++) matchText("some ordinary copy about your bag and delivery options");
  assert.ok(Date.now() - t < 2000);
});
