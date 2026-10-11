import type { FlagWire } from "../api/schemas";
import type { ConsoleContext } from "../server/console";
import { switchLabel, stateFor } from "../view-models/killswitch";
import { Badge } from "./ui";

/** Read-only state of selected switches, always worded Allowed / Blocked (ADR-0028). Missing = Blocked. */
export function SwitchStrip({ items, keys, c }: { items: readonly FlagWire[] | null; keys: readonly string[]; c: ConsoleContext }) {
  if (items === null) return null;
  return (
    <ul className="strip">
      {keys.map((k) => {
        const s = stateFor(items, k);
        return (
          <li key={k}>
            {switchLabel(k, c.locale)}: <Badge tone={s.state === "allowed" ? "ok" : "bad"}>{c.t(s.state === "allowed" ? "sw.allowed" : "sw.blocked")}</Badge>
            {s.reported ? null : <span className="muted"> ({c.t("sw.notReported")})</span>}
          </li>
        );
      })}
    </ul>
  );
}
