import { Icon } from "./Icon";
import type { DeltaValue } from "../../lib/charts/format";

/** Change chip: arrow icon + signed percent + a spoken direction (never colour alone). `text` is already formatted. */
export function Delta({ delta, text, noneLabel, labels }: { delta: DeltaValue; text: string | null; noneLabel: string; labels: { up: string; down: string; flat: string } }) {
  const icon = delta.tone === "up" ? "up" : delta.tone === "down" ? "down" : "flat";
  const spoken = delta.tone === "up" ? labels.up : delta.tone === "down" ? labels.down : delta.tone === "flat" ? labels.flat : null;
  return (
    <span className="delta" data-tone={delta.tone}>
      <Icon name={icon} />
      {spoken ? <span className="srOnly">{spoken} </span> : null}
      <bdi dir="ltr">{text ?? noneLabel}</bdi>
    </span>
  );
}
