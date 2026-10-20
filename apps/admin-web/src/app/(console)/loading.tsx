/**
 * Route-level fallback for every console page (the group has one loading boundary), so it stays generic: a title bar,
 * a line and a block. The home page streams its own tile skeletons inside page.tsx.
 */
export default function Loading() {
  return (
    <div aria-busy="true">
      <div className="skeleton h" />
      <div className="skeleton row-s" />
      <div className="skeleton block" />
    </div>
  );
}
