import { describe, expect, it } from "vitest";
import { askOnce, shouldAskNotificationPermission, unconfiguredNotificationPermission, type NotificationPermissionPort } from "./notification-prompt";

const port: NotificationPermissionPort = { request: async () => "granted" };
const store = () => { let v: string | null = null; return { read: async () => v, write: async (x: string) => { v = x; } }; };

describe("notification prompt after the first purchase", () => {
  it("is never asked before a purchase", async () => {
    expect(shouldAskNotificationPermission({ purchaseCompleted: false, alreadyAsked: false, adapterConfigured: true })).toBe(false);
    expect(await askOnce({ port, ...store() }, false)).toBe("skipped");
  });
  it("asks once after a purchase, then never again", async () => {
    const s = store();
    expect(await askOnce({ port, ...s }, true)).toBe("granted");
    expect(await askOnce({ port, ...s }, true)).toBe("skipped");
  });
  it("fails closed without a push adapter", async () => {
    expect(await askOnce({ port: unconfiguredNotificationPermission, ...store() }, true)).toBe("skipped");
  });
});
