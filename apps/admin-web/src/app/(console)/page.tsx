import { Suspense } from "react";
import { EmptyState, PageHeader } from "../../components/ui";
import { AttentionStrip, Tile, TileSection, TileSkeletons } from "../../components/tile";
import { formatLongDate } from "../../lib/format";
import type { ConsoleContext } from "../../server/console";
import { attentionFor, cappedByLimit, FAILED_TILE, NOT_YET_TILE, tileSectionsFor, tileValue, type TileId, type TileSectionView, type TileValue } from "../../view-models/dashboard";
import { getConsole } from "../../server/console";

// Every read is capped by its limit; a capped count is shown as "N+", an exact total would need an API count we do not have.
async function read(c: ConsoleContext, id: TileId): Promise<TileValue> {
  switch (id) {
    case "brandUnassigned": {
      const r = await c.api.brandQueue({ status: "IN_REVIEW", assignee: "unassigned", limit: 50 });
      return r.ok ? tileValue(r.value.data.items.length, r.value.data.page.has_more) : FAILED_TILE;
    }
    case "brandMine": {
      const r = await c.api.brandQueue({ assignee: "me", limit: 50 });
      return r.ok ? tileValue(r.value.data.items.length, r.value.data.page.has_more) : FAILED_TILE;
    }
    case "brandLate": {
      const r = await c.api.brandQueue({ sla_breached: true, limit: 50 });
      return r.ok ? tileValue(r.value.data.items.length, r.value.data.page.has_more) : FAILED_TILE;
    }
    case "approvals": {
      const r = await c.api.approvals({ state: "REQUESTED" });
      return r.ok ? cappedByLimit(r.value.data.items.length, 100) : FAILED_TILE;
    }
    case "suspensions": {
      const r = await c.api.suspensionReviews("OPEN");
      return r.ok ? cappedByLimit(r.value.data.items.length, 100) : FAILED_TILE;
    }
    case "moderation": {
      const r = await c.api.moderationQueue("HELD");
      return r.ok ? tileValue(r.value.data.items.length, r.value.data.page.has_more) : FAILED_TILE;
    }
    case "recon": {
      const r = await c.api.reconciliationBreaks();
      return r.ok ? tileValue(r.value.data.items.length, r.value.data.page.has_more) : FAILED_TILE;
    }
    case "dsarOpen":
    case "dsarOverdue": {
      const r = await c.api.dsarQueue();
      if (!r.ok) return FAILED_TILE;
      return tileValue(id === "dsarOpen" ? r.value.data.summary.open : r.value.data.summary.overdue, false);
    }
    case "killSwitches": {
      // Flag semantics: enabled = running, so a stopped (engaged) kill switch is enabled === false.
      const r = await c.api.killSwitches();
      return r.ok ? tileValue(r.value.data.items.filter((f) => f.kind === "kill_switch" && !f.enabled).length, false) : FAILED_TILE;
    }
    case "kyc": {
      const r = await c.api.kycQueue();
      return r.ok ? cappedByLimit(r.value.data.items.length, 100) : FAILED_TILE;
    }
    case "taxRejected": {
      const r = await c.api.taxDocuments({ state: "REJECTED" });
      return r.ok ? tileValue(r.value.data.items.length, r.value.data.page.has_more) : FAILED_TILE;
    }
    case "refundApprovals": {
      const r = await c.api.approvals({ kind: "refund", state: "REQUESTED" });
      return r.ok ? cappedByLimit(r.value.data.items.length, 100) : FAILED_TILE;
    }
    case "payoutsStuck": {
      const r = await c.api.payoutsSummary();
      if (!r.ok) return r.error.kind === "not_found" ? NOT_YET_TILE : FAILED_TILE;
      const by = r.value.data.by_state;
      return tileValue((by["ON_HOLD"]?.count ?? 0) + (by["FAILED"]?.count ?? 0), false);
    }
  }
}

/** Starts every read once, up front; sections and the strip await the same promises, so nothing is read twice. */
async function safeRead(c: ConsoleContext, id: TileId): Promise<TileValue> {
  try { return await read(c, id); } catch { return FAILED_TILE; }
}

async function Section({ c, section, reads }: { c: ConsoleContext; section: TileSectionView; reads: ReadonlyMap<TileId, Promise<TileValue>> }) {
  const values = await Promise.all(section.tiles.map((t) => reads.get(t.id) ?? Promise.resolve(FAILED_TILE)));
  return (
    <TileSection id={`home-${section.id}`} title={c.t(section.titleKey)}>
      {section.tiles.map((t, i) => <Tile key={t.id} spec={t} value={values[i] ?? FAILED_TILE} t={c.t} />)}
    </TileSection>
  );
}

async function Attention({ c, ids, reads }: { c: ConsoleContext; ids: readonly TileId[]; reads: ReadonlyMap<TileId, Promise<TileValue>> }) {
  const entries = await Promise.all(ids.map(async (id) => [id, await (reads.get(id) ?? Promise.resolve(FAILED_TILE))] as const));
  return <AttentionStrip attention={attentionFor(new Map(entries))} t={c.t} />;
}

export default async function Home() {
  const c = await getConsole();
  const sections = tileSectionsFor(c.roles);
  const ids = sections.flatMap((s) => s.tiles.map((t) => t.id));
  const reads = new Map<TileId, Promise<TileValue>>(ids.map((id) => [id, safeRead(c, id)] as const));
  return (
    <>
      <PageHeader eyebrow={formatLongDate(c.deviceNowMs, c.locale)} title={c.t("home.greeting")} />
      {sections.length === 0 ? <EmptyState title={c.t("home.empty.title")} body={c.t("home.empty.body")} /> : null}
      {sections.length === 0 ? null : (
        <Suspense fallback={<TileSkeletons count={1} />}><Attention c={c} ids={ids} reads={reads} /></Suspense>
      )}
      {sections.map((s) => (
        <Suspense key={s.id} fallback={<section className="tile-section"><h2>{c.t(s.titleKey)}</h2><TileSkeletons count={s.tiles.length} /></section>}>
          <Section c={c} section={s} reads={reads} />
        </Suspense>
      ))}
    </>
  );
}
