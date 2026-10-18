#!/usr/bin/env node
// Dev-only route bridge: lets a script navigate the running app on a simulator without `simctl openurl`
// (which shows the iOS "Open in Expo Go?" dialog every time). The app polls this server in __DEV__.
//
//   node tooling/dev/route-bridge.mjs                 # start (port 8089)
//   curl 'localhost:8089/set?d=B&path=/shop-all'      # navigate device B (alias) or an exact device name
//   curl 'localhost:8089/devices'                     # which devices polled recently
//
// Binds to loopback only: the iOS Simulator shares the Mac's network stack, so the app reaches it as
// localhost and nothing is exposed on the LAN.
import { createServer } from "node:http";

const PORT = Number(process.env.BRIDGE_PORT ?? 8089);
const ALIASES = { A: "iPhone 16 Pro", B: "Z-OUTLET B" };
/** @type {Map<string, string>} */
const pending = new Map();
/** @type {Map<string, number>} */
const seen = new Map();

const resolveName = (d) => ALIASES[d] ?? d ?? "unknown";

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const device = resolveName(url.searchParams.get("d"));
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/next") {
    seen.set(device, Date.now());
    const path = pending.get(device);
    pending.delete(device);
    res.end(JSON.stringify(path === undefined ? {} : { path }));
  } else if (url.pathname === "/set") {
    const path = url.searchParams.get("path");
    if (path === null || !path.startsWith("/")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "path must start with /" }));
      return;
    }
    pending.set(device, path);
    res.end(JSON.stringify({ ok: true, device, path }));
  } else if (url.pathname === "/devices") {
    res.end(JSON.stringify(Object.fromEntries([...seen].map(([k, t]) => [k, `${Math.round((Date.now() - t) / 1000)}s ago`]))));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`route bridge on 127.0.0.1:${PORT}`));
