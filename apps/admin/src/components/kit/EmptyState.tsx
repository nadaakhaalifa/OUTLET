import type { ReactNode } from "react";

/** "Nothing here yet" with what to do next. Never fills in stand-in data. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty emptyState">
      {icon ? <span className="emptyIcon" aria-hidden="true">{icon}</span> : null}
      <p className="emptyTitle">{title}</p>
      {children ? <div>{children}</div> : null}
      {action ? <div className="emptyAction">{action}</div> : null}
    </div>
  );
}
