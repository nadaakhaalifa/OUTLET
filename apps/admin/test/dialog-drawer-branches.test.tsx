import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/eg-en", useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));

import { Dialog } from "../src/components/kit/Dialog";
import { MobileNav } from "../src/components/shell/MobileNav";
import { visibleGroups } from "../src/components/shell/navigation";

const proto = HTMLDialogElement.prototype as { showModal?: () => void; close?: () => void };
const original = { showModal: proto.showModal, close: proto.close };

/** jsdom's dialog support varies by version: install a faithful minimal implementation, or remove it, so each branch is exercised on purpose. */
const withNativeDialog = (): { shown: number; closed: number } => {
  const calls = { shown: 0, closed: 0 };
  proto.showModal = function (this: HTMLDialogElement) { calls.shown += 1; this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { calls.closed += 1; this.removeAttribute("open"); };
  return calls;
};
const withoutNativeDialog = (): void => { delete proto.showModal; };

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => {
  cleanup();
  if (original.showModal === undefined) delete proto.showModal; else proto.showModal = original.showModal;
  if (original.close === undefined) delete proto.close; else proto.close = original.close;
});

describe("Dialog", () => {
  it("opens as a modal when asked, closes when open flips back, and is not re-opened by an unrelated re-render", () => {
    const calls = withNativeDialog();
    const el = (open: boolean) => <Dialog open={open} title="Sure?" actions={<button type="button">ok</button>}>Body text</Dialog>;
    const { rerender, container } = render(el(false));
    const dlg = container.querySelector("dialog");
    expect(dlg?.hasAttribute("open")).toBe(false);
    expect(screen.queryByText("Body text")).toBeNull(); // closed dialogs render no content
    rerender(el(true));
    expect(calls.shown).toBe(1);
    expect(dlg?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Body text")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sure?" })).toBeTruthy();
    rerender(el(true));
    expect(calls.shown).toBe(1);
    rerender(el(false));
    expect(calls.closed).toBe(1);
    expect(dlg?.hasAttribute("open")).toBe(false);
  });

  it("without native dialog support it toggles the open attribute instead of throwing", () => {
    withoutNativeDialog();
    const el = (open: boolean) => <Dialog open={open} title="T" actions={null}>B</Dialog>;
    const { rerender, container } = render(el(false));
    const dlg = container.querySelector("dialog");
    expect(dlg?.hasAttribute("open")).toBe(false);
    rerender(el(true));
    expect(dlg?.hasAttribute("open")).toBe(true);
    rerender(el(false));
    expect(dlg?.hasAttribute("open")).toBe(false);
  });

  it("Esc (cancel) is intercepted and reported through onClose; with no onClose nothing happens and the dialog stays open", () => {
    withNativeDialog();
    const onClose = vi.fn();
    const { container, rerender } = render(<Dialog open onClose={onClose} title="T" actions={null}>B</Dialog>);
    const dlg = container.querySelector("dialog");
    if (dlg === null) throw new Error("no dialog");
    const ev = new Event("cancel", { cancelable: true, bubbles: false });
    dlg.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Dialog open title="T" actions={null}>B</Dialog>);
    const ev2 = new Event("cancel", { cancelable: true });
    dlg.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true);
    expect(dlg.hasAttribute("open")).toBe(true);
  });
});

describe("MobileNav", () => {
  const groups = visibleGroups(["kyc", "recon", "price"]);
  const nav = (drawerInfo?: React.ReactNode) => <MobileNav locale="en-EG" base="/eg-en" groups={groups} current="overview" {...(drawerInfo === undefined ? {} : { drawerInfo })} />;

  it("the Menu tab opens the drawer (aria-expanded follows), shows the info only while open, and the close button closes it", () => {
    const calls = withNativeDialog();
    const { container } = render(nav(<p>Signed in as staff</p>));
    const tab = container.querySelector("button.tab");
    if (tab === null) throw new Error("no tab");
    expect(tab.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Signed in as staff")).toBeNull();
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-expanded")).toBe("true");
    expect(calls.shown).toBe(1);
    expect(screen.getByText("Signed in as staff")).toBeTruthy();
    const close = container.querySelector("dialog button.btnGhost");
    if (close === null) throw new Error("no close");
    fireEvent.click(close);
    expect(tab.getAttribute("aria-expanded")).toBe("false");
    expect(calls.closed).toBe(1);
    expect(screen.queryByText("Signed in as staff")).toBeNull();
  });

  it("Esc closes the drawer through state (default prevented) and a native close event keeps state in sync; without drawerInfo nothing extra renders", () => {
    withNativeDialog();
    const { container } = render(nav());
    const tab = container.querySelector("button.tab");
    const dlg = container.querySelector("dialog");
    if (tab === null || dlg === null) throw new Error("missing");
    fireEvent.click(tab);
    expect(container.querySelector(".drawerInfo")).toBeNull();
    const ev = new Event("cancel", { cancelable: true });
    act(() => { dlg.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(tab.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-expanded")).toBe("true");
    fireEvent(dlg, new Event("close"));
    expect(tab.getAttribute("aria-expanded")).toBe("false");
  });

  it("without native dialog support the drawer still opens and closes by attribute", () => {
    withoutNativeDialog();
    const { container } = render(nav());
    const tab = container.querySelector("button.tab");
    const dlg = container.querySelector("dialog");
    if (tab === null || dlg === null) throw new Error("missing");
    fireEvent.click(tab);
    expect(dlg.hasAttribute("open")).toBe(true);
    const close = container.querySelector("dialog button.btnGhost");
    if (close === null) throw new Error("no close");
    fireEvent.click(close);
    expect(dlg.hasAttribute("open")).toBe(false);
  });

  it("the Menu tab is marked active only when the current page is outside the bottom tabs", () => {
    withNativeDialog();
    const { container, rerender } = render(nav());
    const tab = container.querySelector("button.tab");
    expect(tab?.hasAttribute("data-active")).toBe(false);
    rerender(<MobileNav locale="en-EG" base="/eg-en" groups={groups} current="access" />);
    expect(container.querySelector("button.tab")?.hasAttribute("data-active")).toBe(true);
  });
});
