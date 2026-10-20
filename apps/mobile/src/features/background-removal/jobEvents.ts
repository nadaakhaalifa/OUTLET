/** Tiny pub/sub so the editor route can tell the product form's cutout map that a job changed (no shared React state across routes). */
type Listener = (jobId: string) => void;
const listeners = new Set<Listener>();
export function onJobChanged(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function notifyJobChanged(jobId: string): void {
  listeners.forEach((l) => l(jobId));
}
