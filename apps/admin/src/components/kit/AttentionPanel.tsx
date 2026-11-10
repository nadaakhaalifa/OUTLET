import Link from "next/link";
import { Icon, type IconName } from "./Icon";

export interface AttentionItem {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly hint: string;
  /** Already formatted (Arabic digits in ar-EG). */
  readonly count: string;
  readonly href: string;
  readonly urgent?: boolean;
}

/** "Needs your attention": most urgent first, with a plain all-clear state. Each row links to the list behind it. */
export function AttentionPanel({ items, title, allClear, openLabel }: { items: readonly AttentionItem[]; title: string; allClear: string; openLabel: string }) {
  return (
    <section className="attention" aria-labelledby="attention-title" data-attention-panel>
      <h2 id="attention-title" className="panelTitle">{title}</h2>
      {items.length === 0 ? (
        <p className="attentionClear" data-testid="attention-clear"><Icon name="check" /><span>{allClear}</span></p>
      ) : (
        <ul className="attentionList">
          {items.map((i) => (
            <li key={i.key} data-urgent={i.urgent === true ? true : undefined}>
              <Link href={i.href} className="attentionLink">
                <span className="attentionIcon"><Icon name={i.icon} /></span>
                <span className="attentionText"><span className="attentionTitle">{i.title}</span><span className="hint">{i.hint}</span></span>
                <span className="attentionCount"><bdi>{i.count}</bdi></span>
                <span className="attentionGo">{openLabel}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
