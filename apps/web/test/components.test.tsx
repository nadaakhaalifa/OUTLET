import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../src/components/EmptyState";
import { SkeletonGrid } from "../src/components/SkeletonGrid";

describe("EmptyState", () => {
  it("renders the default title without a hint", () => {
    const { container } = render(<EmptyState locale="en-EG" />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
  it("renders title and hint keys in Arabic", () => {
    render(<EmptyState locale="ar-EG" titleKey="village.heroTitle" hintKey="village.heroSubtitle" />);
    expect(screen.getByText("اختر متجرًا. اكتشف صفقة.")).toBeTruthy();
    expect(screen.getByText("تصفّح المتاجر وشوف الخصومات المؤكدة فقط.")).toBeTruthy();
  });
});

describe("SkeletonGrid", () => {
  it("renders `count` structural tiles with no style attribute and no data", () => {
    const { container } = render(<SkeletonGrid locale="en-EG" count={4} />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(4);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.getAllByText("Loading…").length).toBe(4);
  });
});
