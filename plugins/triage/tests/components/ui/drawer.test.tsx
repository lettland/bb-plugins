// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

afterEach(() => {
  cleanup();
});

// drawer tests.
describe("Drawer", () => {
  it("opens from its trigger and shows the portaled overlay, content, and text parts", () => {
    function Shell() {
      const [open, setOpen] = React.useState(false);
      return (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerTrigger className="px-2">Open drawer</DrawerTrigger>
          <DrawerContent className="extra-content">
            <DrawerTitle>Drawer title</DrawerTitle>
            <DrawerDescription>Drawer description</DrawerDescription>
          </DrawerContent>
        </Drawer>
      );
    }
    render(<Shell />);
    expect(screen.queryByText("Drawer title")).toBeNull();

    fireEvent.click(screen.getByText("Open drawer"));
    expect(screen.getByText("Drawer title")).toBeTruthy();
    expect(screen.getByText("Drawer description")).toBeTruthy();
    const overlay = document.querySelector(".fixed.inset-0");
    expect(overlay).toBeTruthy();
    expect(overlay?.className).toContain("bg-black/40");
    expect(overlay?.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(document.querySelector(".extra-content")).toBeTruthy();
    expect(screen.getByText("Open drawer").className).toContain("select-none");
  });

  it("closes from the close button and passes an explicit shouldScaleBackground through", () => {
    const onOpenChange = vi.fn();
    function Shell() {
      const [open, setOpen] = React.useState(true);
      return (
        <Drawer shouldScaleBackground={false} open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next); }}>
          <DrawerContent>
            <DrawerTitle>Drawer title</DrawerTitle>
            <DrawerClose>Close drawer</DrawerClose>
          </DrawerContent>
        </Drawer>
      );
    }
    render(<Shell />);
    expect(screen.getByText("Drawer title")).toBeTruthy();
    fireEvent.click(screen.getByText("Close drawer"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape while open", () => {
    const onOpenChange = vi.fn();
    function Shell() {
      const [open, setOpen] = React.useState(true);
      return (
        <Drawer open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next); }}>
          <DrawerContent>
            <DrawerTitle>Drawer title</DrawerTitle>
          </DrawerContent>
        </Drawer>
      );
    }
    render(<Shell />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
