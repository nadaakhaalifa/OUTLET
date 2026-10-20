#!/usr/bin/env node
// Deterministic in-process simulator for the T9 load scenarios. It drives the REAL reference model
// (packages/domain/src/inventory: StockModel, planReservation, DEFAULT_TTL_POLICIES) with a seeded PRNG and a
// simulated clock, so the invariants hold without k6 or a server.
//
// What it proves: allocation logic, no oversell, <= stock claimed, idempotent replay, FIFO of the admission model.
// What it does NOT prove: Postgres lock behaviour, network, PSP, real latency (use k6 + tooling/db/inventory-concurrency.sh).
// There is no waiting-room domain module in packages/domain yet (spec phase2/07), so the FIFO queue + waitlist below is a
// MODEL OF THE SPEC (FIFO by arrival, admit_per_sec, waitlist on release), not production code.
//
// Usage: node tooling/load/simulate.mjs [--scenario all|drop|checkout|reserve|webhook] [--users 50000] [--units 500]
//        [--seed 42] [--json]
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as presolve } from "node:path";
import { createHmac, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

// The domain uses TS parameter properties, which need transform mode: re-exec once with the flag.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// Node can strip TS types but the domain uses extensionless relative imports: resolve them to .ts / index.ts.
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.endsWith(".ts")) {
      const base = presolve(dirname(fileURLToPath(ctx.parentURL)), spec);
      for (const c of [`${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const inv = await import(pathToFileURL(join(here, "../../packages/domain/src/inventory/index.ts")).href);
const { StockModel, planReservation, DEFAULT_TTL_POLICIES } = inv;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const scenario = arg("scenario", "all");
const USERS = Number(arg("users", 50000));
const UNITS = Number(arg("units", 500));
const SEED = Number(arg("seed", 42));
const asJson = process.argv.includes("--json");

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const hex = (n, w) => n.toString(16).padStart(w, "0");
const uuid = (ns, n) => `${hex(ns, 8)}-0000-4000-8000-${hex(n, 12)}`;

const STD = uuid(0xa, 1);
const FAWRY = uuid(0xa, 2);
const LOC = uuid(0xb, 1);
const STORE = uuid(0xc, 1);
const ctxFor = (dropPools) => ({ policies: DEFAULT_TTL_POLICIES, standardPoolId: STD, fawryPoolId: FAWRY, dropPoolIds: dropPools });

function newModel() {
  let n = 0;
  return new StockModel({ newUnitId: () => uuid(0xd, (n += 1)) });
}
function seedStock(model, skuId, poolId, qty, key) {
  const out = model.applySync({
    skuId, locationId: LOC, poolId, storeId: STORE, mode: "set", quantity: qty, reason: "received",
    idempotencyKey: key, actorType: "system", actorId: "load-sim", nowMs: 0,
  });
  if (out.status !== "applied") throw new Error(`seed failed: ${out.status}`);
  model.rebalance(skuId, LOC, poolId);
}
function planFor(method, skuId, qty, dropId) {
  const r = planReservation(method, [{ skuId, locationId: LOC, storeId: STORE, qty, dropId }], ctxFor(new Map(dropId ? [[dropId, uuid(0xe, 1)]] : [])));
  if (!r.ok) throw new Error(`plan failed ${r.error.code}`);
  return r.plan;
}

class Heap {
  a = [];
  push(t, seq, v) {
    const a = this.a;
    a.push({ t, seq, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t < a[i].t || (a[p].t === a[i].t && a[p].seq < a[i].seq)) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const lt = (x, y) => a[x].t < a[y].t || (a[x].t === a[y].t && a[x].seq < a[y].seq);
        if (l < a.length && lt(l, m)) m = l;
        if (r < a.length && lt(r, m)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// ---------------------------------------------------------------------------------------------------------------
function simDrop() {
  const rnd = prng(SEED);
  const model = newModel();
  const SKU = uuid(0x1, 1);
  const DROP = uuid(0x2, 1);
  const POOL = uuid(0xe, 1);
  seedStock(model, SKU, POOL, UNITS, "seed-drop");
  const ADMIT_PER_SEC = 500, TICK = 100, ARRIVAL_WINDOW = 60_000, JITTER = 80, PAY_OK = 0.95, ABANDON = 0.03;

  // Users: arrival time uniform over the window; rank = FIFO order by (arrival, id).
  const users = Array.from({ length: USERS }, (_, i) => ({ id: i, arrival: Math.floor(rnd() * ARRIVAL_WINDOW) }));
  users.sort((x, y) => x.arrival - y.arrival || x.id - y.id);
  users.forEach((u, r) => {
    u.rank = r;
    const x = rnd();
    u.behaviour = x < ABANDON ? "abandon" : x < ABANDON + (1 - ABANDON) * (1 - PAY_OK) ? "pay_fails" : "pays";
    u.payDelay = 5_000 + Math.floor(rnd() * 115_000);
    u.jitter = Math.floor(rnd() * JITTER);
  });

  const heap = new Heap();
  let seq = 0;
  let queueHead = 0; // next user to admit
  const waitlist = []; // users refused for stock, FIFO by rank
  let waitHead = 0;
  const claimed = new Set();
  const attemptOrder = [];
  const reserveMs = [];
  let released = 0, soldOutRefusals = 0, lateClaims = 0;
  let now;
  const holders = new Map(); // userId -> true while holding

  const tryReserve = (u, t) => {
    attemptOrder.push(u.rank);
    const t0 = performance.now();
    const out = model.reserve({
      reservationId: `r-${u.id}`, orderGroupId: `og-${u.id}`, userId: `u-${u.id}`,
      plan: planFor("CARD", SKU, 1, DROP), nowMs: t,
    });
    reserveMs.push((performance.now() - t0) * 1000);
    if (out.status === "reserved") {
      holders.set(u.id, true);
      if (u.behaviour === "abandon") return true; // never pays: TTL sweep will free it
      heap.push(t + u.payDelay, seq++, { k: "pay", u });
      return true;
    }
    return false;
  };
  const drainWaitlist = (t) => {
    while (waitHead < waitlist.length) {
      const u = waitlist[waitHead];
      if (model.level(SKU, LOC, POOL).available <= 0) return;
      if (tryReserve(u, t)) waitHead += 1;
      else return;
    }
  };

  const END = 20 * 60_000;
  for (now = 0; now <= END; now += TICK) {
    // admit up to ADMIT_PER_SEC * tick users that have ARRIVED by now, in rank order
    const budget = Math.floor((ADMIT_PER_SEC * TICK) / 1000);
    for (let n = 0; n < budget && queueHead < users.length && users[queueHead].arrival <= now; n += 1) {
      const u = users[queueHead++];
      heap.push(now + u.jitter, seq++, { k: "reserve", u });
    }
    while (heap.size > 0 && heap.a[0].t <= now) {
      const { t, v } = heap.pop();
      if (v.k === "reserve") {
        if (!tryReserve(v.u, t)) {
          soldOutRefusals += 1;
          // waitlist is FIFO by QUEUE RANK (spec 16), not by network arrival: insert sorted after the head
          let lo = waitHead, hi = waitlist.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (waitlist[mid].rank < v.u.rank) lo = mid + 1; else hi = mid; }
          waitlist.splice(lo, 0, v.u);
        }
      } else if (v.k === "pay") {
        holders.delete(v.u.id);
        if (v.u.behaviour === "pays") {
          const c = model.claim(`og-${v.u.id}`, t);
          if (c.status === "claimed" || c.status === "claimed_late") { claimed.add(v.u.rank); if (c.status === "claimed_late") lateClaims += 1; }
        } else {
          const r = model.release(`og-${v.u.id}`, "payment_failed", t);
          if (r.status === "released") { released += 1; drainWaitlist(t); }
        }
      }
    }
    if (now % 1000 === 0) {
      const sw = model.sweepExpired(now);
      if (sw.expiredReservations > 0) { released += sw.expiredReservations; drainWaitlist(now); }
    }
    if (queueHead >= users.length && heap.size === 0 && waitHead >= waitlist.length) break;
    if (queueHead >= users.length && heap.size === 0) { // only sweeps remain: jump to next TTL boundary
      const sw = model.sweepExpired(now + 600_000);
      if (sw.expiredReservations > 0) { released += sw.expiredReservations; drainWaitlist(now + 600_000); } else break;
    }
  }

  const ideal = new Set(users.filter((u) => u.behaviour === "pays").slice(0, UNITS).map((u) => u.rank));
  let outside = 0;
  for (const r of claimed) if (!ideal.has(r)) outside += 1;
  let inv = 0;
  for (let i = 1; i < attemptOrder.length; i += 1) if (attemptOrder[i] < attemptOrder[i - 1]) inv += 1;
  const level = model.level(SKU, LOC, POOL);
  const violations = model.checkInvariants();
  return {
    users: USERS, units: UNITS, claimed: claimed.size, committed: level.committed, onHand: level.onHand,
    oversoldRecords: model.oversellRecords.length, invariantViolations: violations,
    fifoDeviationPct: (outside / UNITS) * 100, adjacentInversionPct: (inv / Math.max(1, attemptOrder.length - 1)) * 100,
    releasedHolds: released, lateClaims, soldOutRefusals,
    reserveAttempts: reserveMs.length, reserveLogicP95us: pct(reserveMs, 95), reserveLogicP99us: pct(reserveMs, 99),
    pass: claimed.size <= UNITS && level.committed <= UNITS && model.oversellRecords.length === 0 && violations.length === 0 &&
      (outside / UNITS) * 100 <= 1,
  };
}

// ---------------------------------------------------------------------------------------------------------------
function simCheckout(multiplier = 20) {
  const rnd = prng(SEED + 1);
  const model = newModel();
  const SKUS = 4, PER = 4000;
  for (let i = 0; i < SKUS; i += 1) {
    seedStock(model, uuid(0x3, i + 1), STD, PER, `seed-${i}`);
    seedStock(model, uuid(0x3, i + 1), FAWRY, 600, `seedf-${i}`);
  }
  const ATTEMPTS = 250 * multiplier; // 5k attempts at 20x (the reference model scans O(units) per op, so volume is kept small)
  const mix = ["CARD", "CARD", "CARD", "CARD", "CARD", "COD", "COD", "WALLET", "FAWRY", "CARD"];
  const DECLINE = 0.03, PSP_FAIL = 0.002, CRASH = 0.005, RETRIES = 3;
  let ok = 0, declined = 0, failed = 0, stockOut = 0, replays = 0;
  const lat = [];
  for (let i = 0; i < ATTEMPTS; i += 1) {
    const now = i * 10;
    const method = mix[i % mix.length];
    const sku = uuid(0x3, 1 + Math.floor(rnd() * SKUS));
    const og = `og-${i}`;
    const plan = planFor(method, sku, 1 + Math.floor(rnd() * (method === "FAWRY" ? 2 : 3)), null);
    const t0 = performance.now();
    const cmd = { reservationId: `r-${i}`, orderGroupId: og, userId: `u-${i}`, plan, nowMs: now };
    let r = model.reserve(cmd);
    lat.push((performance.now() - t0) * 1000);
    if (r.status === "insufficient") { stockOut += 1; failed += 1; continue; }
    if (r.status !== "reserved") { failed += 1; continue; }
    if (rnd() < CRASH) { // process killed after reserve: client retries with the same idempotency key / order group
      r = model.reserve(cmd);
      if (r.status === "reserved" && r.replayed) replays += 1; else { failed += 1; continue; }
    }
    if (rnd() < DECLINE) { model.release(og, "payment_failed", now + 1000); declined += 1; continue; }
    let psp = false;
    for (let a = 0; a < RETRIES && !psp; a += 1) psp = rnd() >= PSP_FAIL; // idempotent retry, same intent key
    if (!psp) { model.release(og, "payment_failed", now + 1000); failed += 1; continue; }
    const c = model.claim(og, now + 2000);
    if (c.status === "claimed" || c.status === "claimed_late") ok += 1; else failed += 1;
  }
  const violations = model.checkInvariants();
  const eligible = ATTEMPTS - declined;
  return {
    attempts: ATTEMPTS, multiplier, ok, declinedExcluded: declined, failed, stockOut, crashesRecovered: replays,
    successPct: (ok / eligible) * 100, invariantViolations: violations, oversoldRecords: model.oversellRecords.length,
    reserveLogicP95us: pct(lat, 95), reserveLogicP99us: pct(lat, 99),
    pass: (ok / eligible) * 100 >= 99.5 && violations.length === 0 && model.oversellRecords.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
function simReserveContention() {
  // 10k reserve attempts on 100 units interleaved with releases: exactly 100 claimed, 0 oversold (spec 20.2 acceptance
  // shape; single-threaded model, so this checks allocation logic, not lock behaviour).
  const rnd = prng(SEED + 2);
  const results = [];
  const RUNS = 50;
  for (let run = 0; run < RUNS; run += 1) {
    const model = newModel();
    const sku = uuid(0x4, 1);
    seedStock(model, sku, STD, 100, "s");
    const order = Array.from({ length: 10000 }, (_, i) => i).sort(() => rnd() - 0.5);
    let claimed = 0;
    for (const i of order) {
      const r = model.reserve({ reservationId: `r${i}`, orderGroupId: `o${i}`, userId: `u${i}`, plan: planFor("CARD", sku, 1, null), nowMs: 0 });
      if (r.status === "reserved") {
        if (rnd() < 0.3) model.release(`o${i}`, "abandoned", 1);
        else if (model.claim(`o${i}`, 1).status.startsWith("claimed")) claimed += 1;
      }
    }
    const lv = model.level(sku, LOC, STD);
    results.push({ claimed, committed: lv.committed, v: model.checkInvariants().length, os: model.oversellRecords.length });
  }
  const bad = results.filter((r) => r.claimed > 100 || r.committed > 100 || r.v > 0 || r.os > 0);
  const lowest = Math.min(...results.map((r) => r.claimed));
  return { runs: RUNS, attemptsPerRun: 10000, units: 100, minClaimed: lowest, maxClaimed: Math.max(...results.map((r) => r.claimed)), badRuns: bad.length,
    note: "30% of holders release; stock freed by release is re-sold so claimed converges to 100", pass: bad.length === 0 && lowest === 100 };
}

// ---------------------------------------------------------------------------------------------------------------
function simWebhook() {
  const EVENTS = 5000, REPLAYS = 5, SECRET = "sim-secret";
  const rnd = prng(SEED + 3);
  const build = () => {
    const m = newModel();
    seedStock(m, uuid(0x5, 1), STD, EVENTS, "s");
    for (let i = 0; i < EVENTS; i += 1) {
      const r = m.reserve({ reservationId: `r${i}`, orderGroupId: `og${i}`, userId: `u${i}`, plan: planFor("CARD", uuid(0x5, 1), 1, null), nowMs: 0 });
      if (r.status !== "reserved") throw new Error("setup");
    }
    return m;
  };
  const sign = (b) => createHmac("sha256", SECRET).update(b).digest("hex");
  const snapshot = (m) => {
    const lv = m.level(uuid(0x5, 1), LOC, STD);
    const h = createHash("sha256");
    for (let i = 0; i < EVENTS; i += 1) h.update(`${i}:${m.reservationStatus(`og${i}`)};`);
    return { committed: lv.committed, reserved: lv.reserved, digest: h.digest("hex") };
  };
  const handle = (m, seen, ledger, ev, body, sig) => {
    if (sign(body) !== sig) return "rejected";
    if (seen.has(ev.id)) return "duplicate_200";
    seen.add(ev.id);
    const c = m.claim(ev.og, 10);
    if (c.status === "claimed" || c.status === "claimed_late") ledger.count += 1;
    return "applied";
  };
  // baseline: one delivery each
  const base = build();
  { const seen = new Set(); const l = { count: 0 };
    for (let i = 0; i < EVENTS; i += 1) { const ev = { id: `e${i}`, og: `og${i}` }; const b = JSON.stringify(ev); handle(base, seen, l, ev, b, sign(b)); } }
  // storm: each event REPLAYS times, shuffled, 1/17 tampered
  const storm = build();
  const seen = new Set();
  const ledger = { count: 0 };
  const msgs = [];
  for (let i = 0; i < EVENTS; i += 1) for (let r = 0; r < REPLAYS; r += 1) msgs.push(i);
  for (let i = msgs.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [msgs[i], msgs[j]] = [msgs[j], msgs[i]]; }
  let applied = 0, dup = 0, rejected = 0, tamperAccepted = 0, tamperSent = 0;
  msgs.forEach((i, k) => {
    const ev = { id: `e${i}`, og: `og${i}` };
    const body = JSON.stringify(ev);
    const tamper = k % 17 === 0;
    const out = handle(storm, seen, ledger, ev, tamper ? `${body} ` : body, sign(body));
    if (tamper) { tamperSent += 1; if (out === "rejected") rejected += 1; else tamperAccepted += 1; }
    else if (out === "applied") applied += 1; else if (out === "duplicate_200") dup += 1;
  });
  // second stage: tampered messages dropped some first deliveries; redeliver clean copies once (provider retry)
  for (let i = 0; i < EVENTS; i += 1) { const ev = { id: `e${i}`, og: `og${i}` }; const b = JSON.stringify(ev); const o = handle(storm, seen, ledger, ev, b, sign(b)); if (o === "applied") applied += 1; else dup += 1; }
  // and replay the whole thing directly against claim() with NO dedup layer: model itself must stay idempotent
  let directBad = 0;
  for (let i = 0; i < EVENTS; i += 1) if (storm.claim(`og${i}`, 20).status !== "already_claimed") directBad += 1;
  const a = snapshot(base), b = snapshot(storm);
  const violations = storm.checkInvariants();
  return { events: EVENTS, replaysPerEvent: REPLAYS, applied, duplicates200: dup, tamperedSent: tamperSent, tamperedRejected: rejected,
    tamperedAccepted: tamperAccepted, ledgerPostings: ledger.count, directReplayNotIdempotent: directBad,
    stateEqualsSingleDelivery: a.digest === b.digest && a.committed === b.committed && a.reserved === b.reserved,
    invariantViolations: violations,
    pass: applied === EVENTS && ledger.count === EVENTS && tamperAccepted === 0 && directBad === 0 && a.digest === b.digest && violations.length === 0 };
}

const runs = {
  drop: simDrop,
  checkout: () => simCheckout(20),
  reserve: simReserveContention,
  webhook: simWebhook,
};
const names = scenario === "all" ? Object.keys(runs) : [scenario];
const out = {};
let ok = true;
for (const n of names) {
  if (!runs[n]) { console.error(`unknown scenario ${n}`); process.exit(2); }
  const t0 = performance.now();
  out[n] = runs[n]();
  out[n].wallMs = Math.round(performance.now() - t0);
  ok &&= out[n].pass;
}
out.scope = { seed: SEED, search: "not simulated: search p95 needs a real engine (k6/search-p95.js)", latencyNote: "reserve*Us values are in-memory model logic cost, NOT a DB latency" };
if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  for (const n of names) console.log(`${out[n].pass ? "PASS" : "FAIL"} ${n}: ${JSON.stringify(out[n])}`);
  console.log(`seed=${SEED}; search not simulated; latencies are model logic cost only`);
}
process.exit(ok ? 0 : 1);
