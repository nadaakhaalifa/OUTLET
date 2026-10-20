import { drops } from "@outlet/domain";
import { QueueUnavailableError, type QueuePort } from "../../../modules/waiting-room";
import { RedisUnavailableError, keyHash, type RedisConnection } from "./connection";

type Ticket = drops.Ticket;
type JoinResult = drops.JoinResult;

/**
 * Lua for the waiting-room queue (one atomic script per QueuePort operation). Data model per drop,
 * all keys share the prefix P = <prefix>:q:{<dropId>}: so a Redis Cluster hashes them to one slot
 * (the {drop} hash tag); KEYS[1] is P and the scripts derive the sibling keys from it.
 *
 *   P.."wait"   ZSET waiting ticket ids, score = arrival seq     (FIFO, ZRANK = O(log n) position)
 *   P.."seen"   ZSET waiting ticket ids, score = last heartbeat   (expiry scan by score range)
 *   P.."t:"..id HASH ticket (id,uid,dev,uh,dh,seq,j,l,st,a)
 *   P.."u:"..uh STRING active ticket of an account (hashed user id)
 *   P.."d:"..dh STRING active ticket of a device   (hashed device id)
 *   P.."lazy"   LIST   tickets abandoned as a side effect, reported by the next expire()
 *   P.."seq"    STRING arrival counter
 *
 * Semantics mirror packages/domain FifoWaitingQueue exactly (asserted by the equivalence property
 * test). Numbers are never concatenated into strings (Lua 5.3 would print floats as "1.0").
 */
const PRELUDE = `
local P = KEYS[1]
local FS = string.char(31)
local RS = string.char(30)
local function tk(id) return P..'t:'..id end
-- Redis nil is false in real Redis; ioredis-mock's Lua bridge yields userdata. Normalise both.
local function nz(v)
  if v == nil or v == false or type(v) == 'userdata' then return nil end
  return v
end
local function hget(id, f) return nz(redis.call('HGET', tk(id), f)) end
-- Replies are strings (fields joined by US, rows by RS): array replies built by index assignment do not survive ioredis-mock's bridge.
local function row(id, extra)
  local v = redis.call('HMGET', tk(id), 'id', 'uid', 'dev', 'seq', 'j', 'l', 'st', 'a')
  local function g(i)
    local x = nz(v[i])
    if x == nil then return '-' end
    return x
  end
  local r = g(1)..FS..g(2)..FS..g(3)..FS..g(4)..FS..g(5)..FS..g(6)..FS..g(7)..FS..g(8)
  if extra then r = extra..FS..r end
  return r
end
local function rows(ids)
  local out = {}
  for _, id in ipairs(ids) do table.insert(out, row(id)) end
  return table.concat(out, RS)
end
local function clearPtr(id)
  local f = redis.call('HMGET', tk(id), 'uh', 'dh')
  local uh = nz(f[1]); local dh = nz(f[2])
  if uh and redis.call('GET', P..'u:'..uh) == id then redis.call('DEL', P..'u:'..uh) end
  if dh and redis.call('GET', P..'d:'..dh) == id then redis.call('DEL', P..'d:'..dh) end
end
local function release(id, state, now)
  local st = hget(id, 'st')
  if st == 'waiting' then
    redis.call('ZREM', P..'wait', id)
    redis.call('ZREM', P..'seen', id)
  end
  redis.call('HSET', tk(id), 'st', state)
  if state == 'admitted' then
    redis.call('HSET', tk(id), 'a', string.format('%.0f', now))
  else
    clearPtr(id)
    redis.call('PEXPIRE', tk(id), 600000)
  end
end
local function lazyExpire(id, now, hb)
  if not nz(id) then return end
  local f = redis.call('HMGET', tk(id), 'st', 'l')
  if nz(f[1]) == 'waiting' and now - tonumber(f[2]) > hb then
    release(id, 'abandoned', now)
    redis.call('RPUSH', P..'lazy', id)
  end
end
local function scan(now, hb)
  local ids = redis.call('ZRANGEBYSCORE', P..'seen', '-inf', string.format('(%.0f', now - hb))
  for _, id in ipairs(ids) do
    release(id, 'abandoned', now)
    redis.call('RPUSH', P..'lazy', id)
  end
end
`;

export const QUEUE_LUA = {
  // ARGV: now, ticketId, userId, uh, deviceHash, dh, ttlMs, hbMs
  join: `${PRELUDE}
local now = tonumber(ARGV[1]); local ttl = tonumber(ARGV[7]); local hb = tonumber(ARGV[8])
local uh = ARGV[4]; local dh = ARGV[6]
lazyExpire(redis.call('GET', P..'u:'..uh), now, hb)
lazyExpire(redis.call('GET', P..'d:'..dh), now, hb)
local mine = nz(redis.call('GET', P..'u:'..uh))
if mine then
  local st = hget(mine, 'st')
  if st then
    if st == 'waiting' then
      redis.call('HSET', tk(mine), 'l', ARGV[1])
      redis.call('ZADD', P..'seen', ARGV[1], mine)
    end
    return row(mine, 'existing')
  end
  redis.call('DEL', P..'u:'..uh)
end
local dv = nz(redis.call('GET', P..'d:'..dh))
if dv then
  if redis.call('EXISTS', tk(dv)) == 1 then return 'device_busy' end
  redis.call('DEL', P..'d:'..dh)
end
local n = redis.call('INCR', P..'seq')
local seq = string.format('%.0f', n - 1)
local id = ARGV[2]
redis.call('HSET', tk(id), 'id', id, 'uid', ARGV[3], 'dev', ARGV[5], 'uh', uh, 'dh', dh, 'seq', seq, 'j', ARGV[1], 'l', ARGV[1], 'st', 'waiting', 'a', '-')
redis.call('ZADD', P..'wait', seq, id)
redis.call('ZADD', P..'seen', ARGV[1], id)
redis.call('SET', P..'u:'..uh, id, 'PX', ttl)
redis.call('SET', P..'d:'..dh, id, 'PX', ttl)
redis.call('PEXPIRE', tk(id), ttl)
redis.call('PEXPIRE', P..'wait', ttl)
redis.call('PEXPIRE', P..'seen', ttl)
redis.call('PEXPIRE', P..'seq', ttl)
return row(id, 'joined')`,
  // ARGV: now, uh, ttlMs, hbMs
  heartbeat: `${PRELUDE}
local now = tonumber(ARGV[1]); local ttl = tonumber(ARGV[3]); local hb = tonumber(ARGV[4])
lazyExpire(redis.call('GET', P..'u:'..ARGV[2]), now, hb)
local id = nz(redis.call('GET', P..'u:'..ARGV[2]))
if not id then return '' end
local st = hget(id, 'st')
if not st then return '' end
local pos = -1
if st == 'waiting' then
  redis.call('HSET', tk(id), 'l', ARGV[1])
  redis.call('ZADD', P..'seen', ARGV[1], id)
  redis.call('PEXPIRE', tk(id), ttl)
  pos = redis.call('ZRANK', P..'wait', id) + 1
end
return row(id)..FS..string.format('%.0f', pos)`,
  // ARGV: limit
  peek: `${PRELUDE}
local lim = tonumber(ARGV[1])
if lim < 1 then return '' end
return rows(redis.call('ZRANGE', P..'wait', 0, lim - 1))`,
  // ARGV: ticketId, now
  reject: `${PRELUDE}
local id = ARGV[1]
if hget(id, 'st') ~= 'waiting' then return '' end
release(id, 'rejected', tonumber(ARGV[2]))
return row(id)`,
  // ARGV: n, now, hbMs. Expiry first, then the n earliest waiting tickets leave the ZSET in one step.
  admit: `${PRELUDE}
local n = tonumber(ARGV[1]); local now = tonumber(ARGV[2]); local hb = tonumber(ARGV[3])
scan(now, hb)
if n < 1 then return '' end
local ids = redis.call('ZRANGE', P..'wait', 0, n - 1)
local out = {}
for _, id in ipairs(ids) do
  release(id, 'admitted', now)
  table.insert(out, row(id))
end
return table.concat(out, RS)`,
  // ARGV: now, hbMs
  expire: `${PRELUDE}
scan(tonumber(ARGV[1]), tonumber(ARGV[2]))
local ids = redis.call('LRANGE', P..'lazy', 0, -1)
redis.call('DEL', P..'lazy')
return rows(ids)`,
  // ARGV: ticketId
  finish: `${PRELUDE}
local id = ARGV[1]
if hget(id, 'st') == 'admitted' then
  clearPtr(id)
  redis.call('PEXPIRE', tk(id), 600000)
end
return 'ok'`,
  // ARGV: uh
  position: `${PRELUDE}
local id = nz(redis.call('GET', P..'u:'..ARGV[1]))
if not id then return '-1' end
if hget(id, 'st') ~= 'waiting' then return '-1' end
return string.format('%.0f', redis.call('ZRANK', P..'wait', id) + 1)`,
} as const;

const DROP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FS = "\u001f";
const RS = "\u001e";

function parseTicket(f: readonly string[]): Ticket {
  const s = (i: number): string => f[i] ?? "";
  const state = s(6);
  if (state !== "waiting" && state !== "admitted" && state !== "abandoned" && state !== "rejected") {
    throw new RedisUnavailableError("command", new Error("corrupt ticket state"));
  }
  return {
    id: s(0),
    userId: s(1),
    deviceHash: s(2),
    seq: Number(s(3)),
    joinedAtMs: Number(s(4)),
    lastSeenMs: Number(s(5)),
    state,
    admittedAtMs: s(7) === "-" || s(7) === "" ? null : Number(s(7)),
  };
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const parseRows = (v: unknown): readonly Ticket[] =>
  str(v) === "" ? [] : str(v).split(RS).map((r) => parseTicket(r.split(FS)));

export interface RedisQueueOptions {
  readonly heartbeatTtlMs?: number;
  /** Key TTL for a drop's queue; refreshed on every join. */
  readonly keyTtlMs?: number;
}

/** Redis-backed waiting-room queue. Every Redis failure surfaces as QueueUnavailableError (fail closed). */
export class RedisWaitingQueue implements QueuePort {
  private readonly heartbeatTtlMs: number;
  private readonly keyTtlMs: number;
  private readonly s: { readonly [K in keyof typeof QUEUE_LUA]: (keys: readonly string[], args: readonly (string | number)[]) => Promise<unknown> };

  constructor(
    private readonly conn: RedisConnection,
    opts: RedisQueueOptions = {},
  ) {
    this.heartbeatTtlMs = opts.heartbeatTtlMs ?? drops.HEARTBEAT_TTL_MS;
    this.keyTtlMs = opts.keyTtlMs ?? 6 * 3600_000;
    const reg = (n: keyof typeof QUEUE_LUA) => conn.script(`wr_${n}`, QUEUE_LUA[n], 1);
    this.s = {
      join: reg("join"),
      heartbeat: reg("heartbeat"),
      peek: reg("peek"),
      reject: reg("reject"),
      admit: reg("admit"),
      expire: reg("expire"),
      finish: reg("finish"),
      position: reg("position"),
    };
  }

  private base(dropId: string): string {
    if (!DROP_ID.test(dropId)) throw new RangeError("invalid drop id");
    return this.conn.key("q", `{${dropId}}`) + ":";
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RedisUnavailableError) throw new QueueUnavailableError();
      throw e;
    }
  }

  async join(dropId: string, ticketId: string, userId: string, deviceHash: string, nowMs: number): Promise<JoinResult> {
    return this.guarded(async () => {
      const r = (await this.s.join(
        [this.base(dropId)],
        [nowMs, ticketId, userId, keyHash("u", userId), deviceHash, keyHash("d", deviceHash), this.keyTtlMs, this.heartbeatTtlMs],
      ));
      if (str(r) === "device_busy") return { kind: "device_busy" };
      const [tag, ...rest] = str(r).split(FS);
      const ticket = parseTicket(rest);
      return tag === "joined" ? { kind: "joined", ticket } : { kind: "existing", ticket };
    });
  }

  async heartbeat(dropId: string, userId: string, nowMs: number): Promise<{ ticket: Ticket; position: number | null } | null> {
    return this.guarded(async () => {
      const raw = str(await this.s.heartbeat([this.base(dropId)], [nowMs, keyHash("u", userId), this.keyTtlMs, this.heartbeatTtlMs]));
      if (raw === "") return null;
      const f = raw.split(FS);
      const pos = Number(f[8]);
      return { ticket: parseTicket(f), position: pos > 0 ? pos : null };
    });
  }

  async peek(dropId: string, limit: number): Promise<readonly Ticket[]> {
    return this.guarded(async () => parseRows(await this.s.peek([this.base(dropId)], [Math.max(0, Math.trunc(limit))])));
  }

  async reject(dropId: string, ticketId: string, nowMs: number): Promise<Ticket | null> {
    return this.guarded(async () => {
      const raw = str(await this.s.reject([this.base(dropId)], [ticketId, nowMs]));
      return raw === "" ? null : parseTicket(raw.split(FS));
    });
  }

  async admit(dropId: string, n: number, nowMs: number): Promise<readonly Ticket[]> {
    return this.guarded(async () =>
      parseRows(await this.s.admit([this.base(dropId)], [Math.min(10_000, Math.max(0, Math.trunc(n))), nowMs, this.heartbeatTtlMs])),
    );
  }

  async expire(dropId: string, nowMs: number): Promise<readonly Ticket[]> {
    return this.guarded(async () => parseRows(await this.s.expire([this.base(dropId)], [nowMs, this.heartbeatTtlMs])));
  }

  async finish(dropId: string, ticketId: string): Promise<void> {
    await this.guarded(() => this.s.finish([this.base(dropId)], [ticketId]));
  }

  async size(dropId: string): Promise<number> {
    return this.guarded(async () => Number(await this.conn.exec("zcard", (c) => this.zcard(c, dropId))));
  }

  /** 1-based position of an account's waiting ticket (ZRANK, O(log n)); null when not waiting. */
  async position(dropId: string, userId: string): Promise<number | null> {
    return this.guarded(async () => {
      const p = Number(str(await this.s.position([this.base(dropId)], [keyHash("u", userId)])));
      return p > 0 ? p : null;
    });
  }

  /** Queue depth and a rough ETA in ms for a position at the drop's admit rate (null when rate is 0). */
  async depth(dropId: string, admitPerSec: number): Promise<{ readonly waiting: number; readonly drainMs: number | null }> {
    const waiting = await this.size(dropId);
    return { waiting, drainMs: admitPerSec > 0 ? Math.ceil((waiting / admitPerSec) * 1000) : null };
  }

  private async zcard(c: RedisConnection["client"], dropId: string): Promise<number> {
    const z = (c as unknown as { zcard(k: string): Promise<number> }).zcard;
    return z.call(c, this.base(dropId) + "wait");
  }
}

/** Single-use admission-token marker with TTL. The Postgres AdmissionStore stays authoritative; this is the fast pre-check. */
export class RedisSingleUseTokens {
  constructor(private readonly conn: RedisConnection) {}

  /** "used" for the first caller within the TTL, "already_used" for every later one. Throws RedisUnavailableError. */
  async consumeOnce(jti: string, ttlMs: number): Promise<"used" | "already_used"> {
    const r = await this.conn.exec("setnx", (c) => c.set(this.conn.key("adm", keyHash("jti", jti)), "1", "PX", Math.max(1, Math.trunc(ttlMs)), "NX"));
    return r === "OK" ? "used" : "already_used";
  }
}
