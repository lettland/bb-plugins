// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { BoardSkeleton, ToolbarSkeleton } from "@/components/triage/board-skeleton";

// board tests.
test("board skeleton mirrors the real board geometry", () => {
  render(<BoardSkeleton />);
  const board = screen.getByRole("status", { name: "Loading Triage" });
  const columns = board.querySelectorAll(".triage-column");
  expect(columns).toHaveLength(4);
  expect(board.querySelectorAll(".triage-card-skeleton")).toHaveLength(2 + 3 + 1 + 2);
});

// toolbar tests.
test("toolbar skeleton is hidden from assistive technology", () => {
  const { container } = render(<ToolbarSkeleton />);
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelectorAll(".triage-toolbar-group")).toHaveLength(2);
});
