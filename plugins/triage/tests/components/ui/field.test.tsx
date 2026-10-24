// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Field, FieldGroup, FieldHint, FieldLabel, FieldRow } from "@/components/ui/field";
import { Skeleton, SkeletonLine } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

afterEach(() => {
  cleanup();
});

// field tests.
describe("Field", () => {
  it("renders the field stack and merges classes", () => {
    render(<Field className="gap-2" data-testid="field" />);
    expect(screen.getByTestId("field").className).toContain("bb-field");
    expect(screen.getByTestId("field").className).toContain("gap-2");
  });

  it("labels controls and marks optional ones", () => {
    render(
      <div>
        <FieldLabel htmlFor="a">Prompt</FieldLabel>
        <FieldLabel htmlFor="b" optional>
          Prompt
        </FieldLabel>
      </div>,
    );
    const labels = screen.getAllByText("Prompt");
    expect(labels).toHaveLength(2);
    expect(labels[0]!.tagName).toBe("LABEL");
    expect(labels[0]!.textContent).toBe("Prompt");
    expect(labels[1]!.textContent).toBe("Prompt(Optional)");
    expect(labels[1]!.querySelector(".bb-field-optional")?.textContent).toBe("(Optional)");
  });

  it("renders hints, rows, and grouped sections", () => {
    render(
      <div>
        <FieldHint>Keep it short.</FieldHint>
        <FieldRow data-testid="row" />
        <FieldGroup title="Delivery" description="Where updates land.">
          <FieldHint>Inner</FieldHint>
        </FieldGroup>
        <FieldGroup title="Quiet">
          <span>Body</span>
        </FieldGroup>
      </div>,
    );
    expect(screen.getByText("Keep it short.").className).toContain("bb-field-hint");
    expect(screen.getByTestId("row").className).toContain("bb-field-row");
    expect(screen.getByText("Delivery").tagName).toBe("H3");
    expect(screen.getByText("Where updates land.").className).toContain("bb-field-group-description");
    expect(screen.getByText("Inner").closest("section")?.className).toContain("bb-field-group");
    expect(screen.getByText("Quiet").tagName).toBe("H3");
    expect(screen.getByText("Quiet").closest("header")?.querySelector("p")).toBeNull();
  });
});

// skeleton tests.
describe("Skeleton", () => {
  it("renders an aria-hidden placeholder with the block shape by default", () => {
    render(<Skeleton data-testid="bone" />);
    const bone = screen.getByTestId("bone");
    expect(bone.getAttribute("aria-hidden")).toBe("true");
    expect(bone.className).toContain("bb-skeleton");
    expect(bone.className).toContain("rounded-md");
    expect(bone.getAttribute("style")).toBeNull();
  });

  it("shapes corners and staggers the pulse with a delay", () => {
    render(
      <div>
        <Skeleton shape="text" data-testid="text" />
        <Skeleton shape="pill" data-testid="pill" />
        <Skeleton shape="circle" data-testid="circle" />
        <Skeleton shape="block" delay={120} data-testid="delayed" />
      </div>,
    );
    expect(screen.getByTestId("text").className).toContain("rounded-[3px]");
    expect(screen.getByTestId("pill").className).toContain("rounded-full");
    expect(screen.getByTestId("circle").className).toContain("rounded-full");
    expect(screen.getByTestId("delayed").getAttribute("style")).toBe("animation-delay: 120ms;");
  });

  it("keeps caller styles when no delay is set and sizes lines", () => {
    render(
      <div>
        <Skeleton style={{ opacity: 0.5 }} data-testid="styled" />
        <SkeletonLine data-testid="full" />
        <SkeletonLine width="40%" data-testid="short" />
        <SkeletonLine width="2rem" className="h-2" data-testid="tiny" />
      </div>,
    );
    expect(screen.getByTestId("styled").getAttribute("style")).toBe("opacity: 0.5;");
    expect(screen.getByTestId("full").getAttribute("style")).toBe("width: 100%;");
    expect(screen.getByTestId("full").className).toContain("h-3");
    expect(screen.getByTestId("short").getAttribute("style")).toBe("width: 40%;");
    expect(screen.getByTestId("tiny").className).toContain("h-2");
  });
});

// status-dot tests.
describe("StatusDot", () => {
  it("carries the tone and default size, and hides from assistive tech without a label", () => {
    render(<StatusDot tone="ongoing" data-testid="dot" />);
    const dot = screen.getByTestId("dot");
    expect(dot.getAttribute("data-tone")).toBe("ongoing");
    expect(dot.getAttribute("data-size")).toBe("default");
    expect(dot.getAttribute("data-pulse")).toBeNull();
    expect(dot.getAttribute("role")).toBeNull();
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.getAttribute("aria-label")).toBeNull();
  });

  it("announces a label, pulses, and takes a smaller size", () => {
    render(
      <div>
        <StatusDot tone="unread" label="Needs review" pulse size="sm" data-testid="labelled" />
        <StatusDot tone="done" pulse={false} data-testid="still" />
      </div>,
    );
    const labelled = screen.getByTestId("labelled");
    expect(labelled.getAttribute("role")).toBe("img");
    expect(labelled.getAttribute("aria-label")).toBe("Needs review");
    expect(labelled.getAttribute("aria-hidden")).toBeNull();
    expect(labelled.getAttribute("data-size")).toBe("sm");
    expect(labelled.getAttribute("data-pulse")).toBe("");
    expect(screen.getByTestId("still").getAttribute("data-pulse")).toBeNull();
  });
});

// card tests.
describe("Card", () => {
  it("renders the card layout family with merged classes", () => {
    render(
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    const card = screen.getByText("Title").closest(".rounded-lg");
    expect(card?.className).toContain("bg-card");
    expect(card?.className).toContain("border-dashed");
    expect(screen.getByText("Title").className).toContain("font-semibold");
    expect(screen.getByText("Description").className).toContain("text-muted-foreground");
    expect(screen.getByText("Body").className).toContain("p-6");
    expect(screen.getByText("Footer").className).toContain("items-center");
    expect(screen.getByText("Title").parentElement?.className).toContain("space-y-1.5");
  });
});
