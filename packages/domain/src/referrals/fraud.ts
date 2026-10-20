/**
 * Referral fraud graph rules (spec 15.4). Pure functions over identifiers (device hashes,
 * payment fingerprint hashes). Two users are linked when they share any identifier; a cluster is
 * a connected component of that graph, computed with union-find.
 */

export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly size = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
    }
  }

  find(x: string): string {
    this.add(x);
    let root = x;
    for (;;) {
      const p = this.parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    // path compression
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur);
      if (next === undefined) break;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const sa = this.size.get(ra) ?? 1;
    const sb = this.size.get(rb) ?? 1;
    const [big, small] = sa >= sb ? [ra, rb] : [rb, ra];
    this.parent.set(small, big);
    this.size.set(big, sa + sb);
  }

  componentSize(x: string): number {
    return this.size.get(this.find(x)) ?? 1;
  }

  /** Components as sorted member lists, sorted by first member (deterministic). */
  components(): readonly (readonly string[])[] {
    const groups = new Map<string, string[]>();
    for (const n of this.parent.keys()) {
      const r = this.find(n);
      const g = groups.get(r);
      if (g === undefined) groups.set(r, [n]);
      else g.push(n);
    }
    return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  }
}

export interface IdentityEntry {
  readonly userId: string;
  /** Opaque, already hashed identifiers: "dev:<hash>", "fp:<hash>". */
  readonly identifiers: readonly string[];
}

/** Union-find over users, linking any two that share an identifier. */
export function linkUsersByIdentifiers(entries: readonly IdentityEntry[]): UnionFind {
  const uf = new UnionFind();
  const owner = new Map<string, string>();
  for (const e of entries) {
    uf.add(e.userId);
    for (const id of e.identifiers) {
      const first = owner.get(id);
      if (first === undefined) owner.set(id, e.userId);
      else uf.union(first, e.userId);
    }
  }
  return uf;
}

/** Size of the suspicious-link component the user belongs to (1 when unlinked). */
export function clusterSizeOf(userId: string, entries: readonly IdentityEntry[]): number {
  return linkUsersByIdentifiers(entries).componentSize(userId);
}

export function isClusterSuspicious(size: number, threshold: number): boolean {
  return size > threshold;
}

/** Connected components strictly larger than the threshold. */
export function suspiciousClusters(entries: readonly IdentityEntry[], threshold: number): readonly (readonly string[])[] {
  return linkUsersByIdentifiers(entries)
    .components()
    .filter((c) => c.length > threshold);
}

export interface SelfReferralInput {
  readonly referrerId: string;
  readonly refereeId: string;
  readonly referrerDeviceHashes: readonly string[];
  readonly refereeDeviceHashes: readonly string[];
}

/** Self-referral: same account, or any shared device. The caller rejects SILENTLY and logs. */
export function detectSelfReferral(i: SelfReferralInput): "self_referral" | "same_device" | null {
  if (i.referrerId === i.refereeId) return "self_referral";
  const mine = new Set(i.referrerDeviceHashes);
  if (i.refereeDeviceHashes.some((d) => mine.has(d))) return "same_device";
  return null;
}

export function sharesPaymentFingerprint(
  refereeFingerprint: string | null,
  referrerFingerprints: readonly string[],
): boolean {
  return refereeFingerprint !== null && referrerFingerprints.includes(refereeFingerprint);
}
