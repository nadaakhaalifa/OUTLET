import type { ReactNode } from "react";

/** Page title (the only h1), one plain sentence about the page, and its main actions. */
export function PageHeader({ title, description, actions, back, info }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode; info?: ReactNode }) {
  return (
    <header className="pageHeader">
      {back ? <div>{back}</div> : null}
      <div className="pageHeaderRow">
        <div>
          <div className="pageHeaderTitle"><h1 className="pageTitle">{title}</h1>{info}</div>
          {description ? <p className="lead">{description}</p> : null}
        </div>
        {actions ? <div className="withActions">{actions}</div> : null}
      </div>
    </header>
  );
}
