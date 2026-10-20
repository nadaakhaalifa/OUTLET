import { useEffect } from "react";
import Constants from "expo-constants";
import { useRouter } from "expo-router";

type Target = Parameters<ReturnType<typeof useRouter>["navigate"]>[0];

/**
 * Development-only remote navigation (tooling/dev/route-bridge.mjs). Polls localhost:8089 and
 * navigates when a path is queued for this device. Renders nothing; the call site is guarded by __DEV__, and
 * the effect re-checks it so a release bundle can never poll.
 */
export function DevRouteBridge() {
  const router = useRouter();
  useEffect(() => {
    if (!__DEV__) return undefined;
    // Simulator only: it shares the Mac's network, so loopback reaches the bridge. A physical device
    // cannot, and simply never connects.
    const host = "localhost";
    const device = encodeURIComponent(Constants.deviceName ?? "unknown");
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`http://${host}:8089/next?d=${device}`);
        const body = (await res.json()) as { path?: string };
        if (alive && typeof body.path === "string" && body.path.startsWith("/")) router.navigate(body.path as Target);
      } catch {
        // bridge not running: ignore
      }
    };
    const id = setInterval(() => { void tick(); }, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [router]);
  return null;
}
