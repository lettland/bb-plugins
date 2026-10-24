// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

afterEach(() => {
  cleanup();
});

// button tests.
describe("Button", () => {
  it("renders a default-variant button with the variant and size classes", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toContain("bg-foreground");
    expect(button.className).toContain("h-9");
    expect(button.className).toContain("cursor-pointer");
  });

  it("renders ghost and outline variants with their classes", () => {
    render(
      <div>
        <Button variant="ghost">Ghost</Button>
        <Button variant="outline" size="sm">
          Outline
        </Button>
        <Button variant="destructive" size="lg">
          Destructive
        </Button>
        <Button variant="secondary" size="icon">
          Secondary
        </Button>
        <Button variant="link">Link</Button>
      </div>,
    );
    expect(screen.getByText("Ghost").className).toContain("hover:bg-state-hover");
    expect(screen.getByText("Outline").className).toContain("border-input");
    expect(screen.getByText("Outline").className).toContain("h-8");
    expect(screen.getByText("Destructive").className).toContain("bg-destructive");
    expect(screen.getByText("Secondary").className).toContain("w-9");
    expect(screen.getByText("Link").className).toContain("text-primary");
  });

  it("renders asChild through a slot element and keeps the variant classes", () => {
    render(
      <Button asChild variant="outline">
        <a href="#target">Open</a>
      </Button>,
    );
    const link = screen.getByText("Open");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#target");
    expect(link.className).toContain("border-input");
  });

  it("exposes buttonVariants for callers that style foreign elements", () => {
    expect(buttonVariants({ variant: "destructive", size: "lg", className: "extra" })).toContain(
      "bg-destructive",
    );
    expect(buttonVariants({ variant: "destructive", size: "lg", className: "extra" })).toContain("extra");
    expect(buttonVariants()).toContain("h-9");
  });

  it("forwards the ref and extra props through the slotted element", () => {
    const ref = React.createRef<HTMLAnchorElement>();
    render(
      <Button asChild data-kept="yes">
        <a ref={ref} href="#kept">
          Slotted
        </a>
      </Button>,
    );
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
    expect(ref.current?.getAttribute("href")).toBe("#kept");
    expect(screen.getByText("Slotted").getAttribute("data-kept")).toBe("yes");
  });
});

// badge tests.
describe("Badge", () => {
  it("renders the default variant", () => {
    render(<Badge>New</Badge>);
    const badge = screen.getByText("New");
    expect(badge.className).toContain("bg-foreground");
    expect(badge.className).toContain("rounded-md");
  });

  it("renders each variant and merges extra classes", () => {
    render(
      <div>
        <Badge variant="secondary">Sec</Badge>
        <Badge variant="destructive">Bad</Badge>
        <Badge variant="outline" className="tracking-widest">
          Line
        </Badge>
      </div>,
    );
    expect(screen.getByText("Sec").className).toContain("bg-secondary");
    expect(screen.getByText("Bad").className).toContain("bg-destructive");
    expect(screen.getByText("Line").className).toContain("tracking-widest");
    expect(screen.getByText("Line").className).not.toContain("bg-foreground");
  });

  it("exposes badgeVariants for callers that style foreign elements", () => {
    expect(badgeVariants({ variant: "outline" })).toContain("text-foreground");
    expect(badgeVariants()).toContain("bg-foreground");
  });
});
