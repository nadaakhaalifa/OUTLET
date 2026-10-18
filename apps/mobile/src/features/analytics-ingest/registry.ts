import { IngestEmitter, type IngestEmitterDeps } from "./emitter";
import { ImpressionTracker } from "./impressions";

let emitter: IngestEmitter | null = null;
let tracker: ImpressionTracker | null = null;

/** Registered once by createServices. Null disables emission (the default in tests and previews). */
export function configureIngest(deps: IngestEmitterDeps | null): IngestEmitter | null {
  emitter?.clear("withdrawn");
  tracker?.reset();
  if (deps === null) {
    emitter = null;
    tracker = null;
    return null;
  }
  emitter = new IngestEmitter(deps);
  tracker = new ImpressionTracker(emitter);
  return emitter;
}

export function getIngestEmitter(): IngestEmitter | null {
  return emitter;
}
export function getImpressionTracker(): ImpressionTracker | null {
  return tracker;
}
