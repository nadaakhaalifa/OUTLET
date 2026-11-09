/** First focusable element on every console page: jumps past the chrome to the main region. */
export function SkipLink({ label }: { label: string }) {
  return <a className="skip" href="#content">{label}</a>;
}
