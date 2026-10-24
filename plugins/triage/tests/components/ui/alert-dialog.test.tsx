// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

afterEach(() => {
  cleanup();
});

// alert-dialog tests.
describe("AlertDialog", () => {
  it("opens from its trigger and shows overlay, content, and text parts", () => {
    function Confirm() {
      const [open, setOpen] = React.useState(false);
      return (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger>Delete</AlertDialogTrigger>
          <AlertDialogContent className="extra-content">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete thread?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );
    }
    render(<Confirm />);
    expect(screen.queryByText("Delete thread?")).toBeNull();

    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete thread?")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    const overlay = document.querySelector(".fixed.inset-0");
    expect(overlay).toBeTruthy();
    expect(overlay?.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(document.querySelector(".extra-content")).toBeTruthy();
  });

  it("closes when the action button is chosen", () => {
    const onOpenChange = vi.fn();
    function Confirm() {
      const [open, setOpen] = React.useState(true);
      return (
        <AlertDialog open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next); }}>
          <AlertDialogContent>
            <AlertDialogTitle>Delete thread?</AlertDialogTitle>
            <AlertDialogAction>Action</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      );
    }
    render(<Confirm />);
    fireEvent.click(screen.getByText("Action"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes when the cancel button is chosen", () => {
    const onOpenChange = vi.fn();
    function Confirm() {
      const [open, setOpen] = React.useState(true);
      return (
        <AlertDialog open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next); }}>
          <AlertDialogContent>
            <AlertDialogTitle>Delete thread?</AlertDialogTitle>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      );
    }
    render(<Confirm />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
