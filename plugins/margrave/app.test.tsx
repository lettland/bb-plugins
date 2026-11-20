// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  component: null as unknown,
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: (app: unknown) => void) => {
    setup({
      slots: {
        navPanel: (entry: { component: unknown }) => {
          state.component = entry.component;
        },
      },
    });
    return {};
  },
  experimental_useRpcQuery: () => state.query,
}));
import "./app.js";
const skills = Array.from({ length: 27 }, (_, index) => ({
  id: `${index % 2 ? "beta" : "alpha"}/id${index}`,
  name: `Skill ${index}`,
  description: `Detail ${index}`,
}));
const refetch = vi.fn();
beforeEach(() => {
  state.query = {
    data: { ok: true, skills },
    error: null,
    isFetching: false,
    refetch,
  };
  refetch.mockReset();
});
afterEach(cleanup);
function show() {
  return render(React.createElement(state.component as React.ComponentType));
}

it("searches, filters, pages and refreshes without fetching on filter changes", () => {
  show();
  expect(screen.getByText("27 skills")).toBeTruthy();
  fireEvent.click(screen.getByText("Next"));
  expect(screen.getByText("26–27 of 27")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search skills"), {
    target: { value: "DETAIL 1" },
  });
  expect(screen.getByText("11 skills")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Source"), {
    target: { value: "beta" },
  });
  expect(screen.getByText("6 skills")).toBeTruthy();
  expect(refetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Refresh"));
  expect(refetch).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Search skills"), {
    target: { value: "no match" },
  });
  expect(screen.getByText("No skills match your filters.")).toBeTruthy();
});
it("shows loading, empty and actionable errors", () => {
  state.query = { ...state.query, data: undefined, isFetching: true };
  const view = show();
  expect(screen.getByText("Loading Margrave skills…")).toBeTruthy();
  state.query = {
    ...state.query,
    data: { ok: true, skills: [] },
    isFetching: false,
  };
  view.rerender(React.createElement(state.component as React.ComponentType));
  expect(screen.getByText("No skills installed in Margrave.")).toBeTruthy();
  state.query = { ...state.query, data: { ok: false, error: "missing" } };
  view.rerender(React.createElement(state.component as React.ComponentType));
  expect(screen.getByRole("alert").textContent).toContain("server PATH");
  fireEvent.click(screen.getByText("Try again"));
  expect(refetch).toHaveBeenCalledOnce();
});

it("clamps a refreshed page and keeps applicable filters", () => {
  const view = show();
  fireEvent.click(screen.getByText("Next"));
  state.query = {
    ...state.query,
    data: { ok: true, skills: skills.slice(0, 10) },
  };
  view.rerender(React.createElement(state.component as React.ComponentType));
  expect(screen.getByText("1–10 of 10")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Source"), {
    target: { value: "beta" },
  });
  fireEvent.change(screen.getByLabelText("Search skills"), {
    target: { value: "Skill" },
  });
  state.query = {
    ...state.query,
    data: { ok: true, skills: skills.slice(0, 6) },
  };
  view.rerender(React.createElement(state.component as React.ComponentType));
  expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe(
    "beta",
  );
  expect(
    (screen.getByLabelText("Search skills") as HTMLInputElement).value,
  ).toBe("Skill");
  expect(screen.getByText("3 skills")).toBeTruthy();
});

it("makes populated skill results keyboard focusable", () => {
  // Safari can skip scroll containers without focusable descendants: https://bugs.webkit.org/show_bug.cgi?id=277290
  show();
  const results = screen.getByRole("region", { name: "Skill results" });
  expect(results.tabIndex).toBe(0);
  fireEvent.change(screen.getByLabelText("Search skills"), {
    target: { value: "no match" },
  });
  expect(results.hasAttribute("tabindex")).toBe(false);
});

it("keeps paging above the scrollable list and resets scroll on page changes", () => {
  show();
  const list = screen.getByRole("list");
  const scroller = list.parentElement as HTMLDivElement;
  const next = screen.getByRole("button", { name: "Next" });
  expect(scroller.className).toContain("overflow-y-auto");
  expect(scroller.contains(next)).toBe(false);
  expect(screen.getByRole("status").textContent).toContain("27 skills");
  scroller.scrollTop = 500;
  fireEvent.click(next);
  expect(scroller.scrollTop).toBe(0);
  scroller.scrollTop = 400;
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(scroller.scrollTop).toBe(0);
});

it("disables retry during a pending read", () => {
  state.query = {
    ...state.query,
    data: { ok: false, error: "failed" },
    isFetching: true,
  };
  show();
  expect(
    (screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText("Refreshing…")).toBeTruthy();
});
