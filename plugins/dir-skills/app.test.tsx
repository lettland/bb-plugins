// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSettingsSectionRegistration } from "@get-bb/plugin-sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DirSkillsRpcContract, FileScope, ScopesSnapshot, UiScope } from "./rpc-contract";

// The test rpc harness wraps every handler throw in an Error subclass, so a
// rejection that is not an Error can only reach the app by intercepting useRpc
// itself. Quirk learned under @get-bb/plugin-sdk 0.6.79 (dist/testing/app.js);
// the same approach is used in plugins/auto-review/app.test.tsx.
const rpcStringRejection = vi.hoisted(() => ({
  current: null as { method: string; message: string } | null,
}));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const { useMemo } = await import("react");
  return {
    ...actual,
    useRpc: () => {
      const rpc = actual.useRpc();
      // Stable across renders, like the real client: a new object per render would re-run the load effect.
      return useMemo(
        () => ({
          ...rpc,
          call: (method: string, input: unknown) =>
            rpcStringRejection.current?.method === method
              ? Promise.reject(rpcStringRejection.current.message)
              : (rpc.call as (method: string, input: unknown) => Promise<unknown>)(method, input),
        }),
        [rpc],
      ) as typeof rpc;
    },
  };
});

let section: PluginSettingsSectionRegistration;

beforeAll(async () => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app"));
  section = app.settingsSections.find((entry) => entry.id === "scopes")!;
});

// Vitest globals are off, so Testing Library does not clean up by itself.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  rpcStringRejection.current = null;
});

const PROFILE_NOTE = "Claude profile — edit in ~/.bb/dir-skills/scopes.json";
const IGNORED_NOTE =
  "will be ignored: a scope with a Claude profile can only be changed in ~/.bb/dir-skills/scopes.json";

function fileScope(overrides: Partial<FileScope> = {}): FileScope {
  return {
    name: "work",
    paths: ["/src/work"],
    skills: ["work-*"],
    source: "shipped",
    hasProfile: false,
    replacedByUi: false,
    ...overrides,
  };
}

function uiScope(overrides: Partial<UiScope> = {}): UiScope {
  return { name: "docs", paths: ["/src/docs"], skills: ["docs-style"], ...overrides };
}

function snapshot(overrides: Partial<ScopesSnapshot> = {}): ScopesSnapshot {
  return {
    fileScopes: [],
    uiScopes: [],
    skills: [
      { name: "docs-style", description: "Docs rules" },
      { name: "work-conventions", description: "Work rules" },
    ],
    skipped: [],
    settingError: null,
    ...overrides,
  };
}

type Handlers = Partial<PluginRpcTestHandlers<DirSkillsRpcContract>>;

function render(initial: ScopesSnapshot = snapshot(), handlers: Handlers = {}) {
  const view = renderSlot<object, DirSkillsRpcContract>(
    section,
    {},
    {
      rpc: {
        getScopes: () => initial,
        saveScopes: (input) => ({ ...initial, uiScopes: input.scopes }),
        ...handlers,
      } as PluginRpcTestHandlers<DirSkillsRpcContract>,
    },
  );
  return view;
}

const calls = (view: { rpcCalls: Array<{ method: string }> }, method: string) =>
  view.rpcCalls.filter((call) => call.method === method);

const card = (name: string) => screen.getByRole("group", { name });
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

describe("registration", () => {
  it("registers the Directory scopes settings section", () => {
    expect(section.title).toBe("Directory scopes");
    expect(section.description).toContain("Scopes from your files are shown read-only");
  });
});

describe("loading", () => {
  it("shows a loading note while the first load is in flight", () => {
    render(snapshot(), { getScopes: () => new Promise(() => {}) });
    expect(screen.getByText("Loading scopes…")).toBeTruthy();
  });

  it("offers Retry when the first load fails, then shows the form", async () => {
    let attempts = 0;
    render(snapshot(), {
      getScopes: () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return snapshot();
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load scopes: boom");
    expect(screen.queryByRole("button", { name: "Add scope" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Add scope" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("words a rejection that is not an Error as-is", async () => {
    rpcStringRejection.current = { method: "getScopes", message: "boom-not-an-error" };
    render();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load scopes: boom-not-an-error",
    );
  });

  it("keeps the form under a failed reload, with Retry", async () => {
    let attempts = 0;
    render(snapshot({ uiScopes: [uiScope()] }), {
      getScopes: () => {
        attempts++;
        if (attempts === 2) throw new Error("server unavailable");
        return snapshot({ uiScopes: [uiScope()] });
      },
    });
    await screen.findByRole("group", { name: "docs" });
    window.dispatchEvent(new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("server unavailable");
    expect(card("docs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("ignores a response and a failure that a newer load superseded", async () => {
    const pending: Array<{
      resolve: (value: ScopesSnapshot) => void;
      reject: (error: unknown) => void;
    }> = [];
    render(snapshot(), {
      getScopes: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]!.resolve(snapshot({ uiScopes: [uiScope({ name: "new" })] }));
    });
    expect(await screen.findByRole("group", { name: "new" })).toBeTruthy();
    await act(async () => {
      pending[0]!.resolve(snapshot({ uiScopes: [uiScope({ name: "old" })] }));
    });
    expect(screen.queryByRole("group", { name: "old" })).toBeNull();
    expect(screen.getByRole("group", { name: "new" })).toBeTruthy();
  });

  it("ignores a failure that a newer load superseded", async () => {
    const pending: Array<{
      resolve: (value: ScopesSnapshot) => void;
      reject: (error: unknown) => void;
    }> = [];
    render(snapshot(), {
      getScopes: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    await act(async () => { pending[1]!.resolve(snapshot({ uiScopes: [uiScope({ name: "new" })] })); });
    await screen.findByRole("group", { name: "new" });
    await act(async () => { pending[0]!.reject(new Error("late boom")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("group", { name: "new" })).toBeTruthy();
  });

  it("shows the banner for stored scopes that could not be read", async () => {
    render(snapshot({ settingError: "scope 1 needs a name" }));
    expect(await screen.findByText(/Saved scopes could not be read and are ignored: scope 1 needs a name/)).toBeTruthy();
  });
});

describe("From files", () => {
  it("lists file scopes read-only with their sources and notes", async () => {
    render(
      snapshot({
        fileScopes: [
          fileScope(),
          fileScope({ name: "corp", source: "file", hasProfile: true, paths: ["/a", "/b"], skills: ["c-*", "d"] }),
          fileScope({ name: "mine", source: "file", replacedByUi: true }),
        ],
      }),
    );
    const items = within(await screen.findByRole("region", { name: "From files" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("work")).toBeTruthy();
    expect(within(items[0]!).getByText("shipped")).toBeTruthy();
    expect(within(items[0]!).getByText("Directories: /src/work")).toBeTruthy();
    expect(within(items[0]!).getByText("Skills: work-*")).toBeTruthy();
    expect(within(items[0]!).queryByText(PROFILE_NOTE)).toBeNull();
    expect(within(items[0]!).queryByText("replaced by your scope")).toBeNull();
    expect(within(items[1]!).getByText("file")).toBeTruthy();
    expect(within(items[1]!).getByText("Directories: /a, /b")).toBeTruthy();
    expect(within(items[1]!).getByText("Skills: c-*, d")).toBeTruthy();
    expect(within(items[1]!).getByText(PROFILE_NOTE)).toBeTruthy();
    expect(within(items[2]!).getByText("replaced by your scope")).toBeTruthy();
    expect(within(items[2]!).queryByText(PROFILE_NOTE)).toBeNull();
    // read-only: no input lives in the file list
    expect(within(screen.getByRole("region", { name: "From files" })).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("says so when no file defines a scope", async () => {
    render();
    expect(await screen.findByText("None.")).toBeTruthy();
  });

  it("renders text from the server as text, never as HTML", async () => {
    render(
      snapshot({
        fileScopes: [fileScope({ name: "<b>x</b>", paths: ["<img src=x onerror=alert(1)>"] })],
        skills: [{ name: "evil", description: "<script>alert(1)</script>" }],
      }),
    );
    expect(await screen.findByText("<b>x</b>")).toBeTruthy();
    expect(screen.getByText("Directories: <img src=x onerror=alert(1)>")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add scope" }));
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(document.querySelector("script, img, b")).toBeNull();
  });
});

describe("Your scopes", () => {
  it("lists stored scopes with checked skills and the other entries as patterns", async () => {
    render(snapshot({ uiScopes: [uiScope({ skills: ["docs-style", "extra-*", "more-*"] })] }));
    const group = await screen.findByRole("group", { name: "docs" });
    expect((within(group).getByRole("checkbox", { name: /docs-style/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group).getByRole("checkbox", { name: /work-conventions/ }) as HTMLInputElement).checked).toBe(false);
    expect(within(group).getByText("Docs rules")).toBeTruthy();
    expect((within(group).getByLabelText("Extra patterns") as HTMLInputElement).value).toBe("extra-*, more-*");
    expect((within(group).getByLabelText("Name") as HTMLInputElement).value).toBe("docs");
    expect((within(group).getByLabelText("Directory 1") as HTMLInputElement).value).toBe("/src/docs");
    expect(within(group).getByText("Absolute or ~/…")).toBeTruthy();
  });

  it("edits one directory and leaves the others alone", async () => {
    const view = render(snapshot({ uiScopes: [uiScope({ paths: ["/a", "/b"] })] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Directory 2"), "/changed");
    expect((within(group).getByLabelText("Directory 1") as HTMLInputElement).value).toBe("/a");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(calls(view, "saveScopes")[0]).toMatchObject({
      input: { scopes: [{ paths: ["/a", "/changed"] }] },
    });
  });

  it("adds a scope, saves the exact payload and drops empty rows and empty patterns", async () => {
    const view = render();
    fireEvent.click(await screen.findByRole("button", { name: "Add scope" }));
    const group = card("New scope 1");
    expect(save().disabled).toBe(false);
    type(within(group).getByLabelText("Name"), "  docs  ");
    type(within(group).getByLabelText("Directory 1"), "  ~/src/docs ");
    fireEvent.click(within(group).getByRole("button", { name: "Add directory" }));
    fireEvent.click(within(card("docs")).getByRole("checkbox", { name: /work-conventions/ }));
    fireEvent.click(within(card("docs")).getByRole("checkbox", { name: /docs-style/ }));
    type(within(card("docs")).getByLabelText("Extra patterns"), " docs-* , ,x ");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(calls(view, "saveScopes")).toEqual([
      {
        method: "saveScopes",
        input: {
          scopes: [
            {
              name: "docs",
              paths: ["~/src/docs"],
              skills: ["work-conventions", "docs-style", "docs-*", "x"],
            },
          ],
        },
      },
    ]);
  });

  it("unchecks a skill again", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const box = within(await screen.findByRole("group", { name: "docs" })).getByRole("checkbox", { name: /docs-style/ });
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(save().disabled).toBe(true);
  });

  it("starts clean, and a scope with checked names then patterns survives an edit elsewhere unchanged", async () => {
    const view = render(
      snapshot({
        uiScopes: [
          uiScope({ name: "a", skills: ["docs-style", "work-conventions", "extra-*", "more-*"] }),
          uiScope({ name: "b", paths: ["/b"], skills: ["docs-style"] }),
        ],
      }),
    );
    await screen.findByRole("group", { name: "a" });
    expect(save().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
    type(within(card("b")).getByLabelText("Name"), "b2");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(calls(view, "saveScopes")[0]).toMatchObject({
      input: {
        scopes: [
          { name: "a", paths: ["/src/docs"], skills: ["docs-style", "work-conventions", "extra-*", "more-*"] },
          { name: "b2", paths: ["/b"], skills: ["docs-style"] },
        ],
      },
    });
  });

  it("is not dirty when the stored skills are not in names-then-patterns order", async () => {
    render(snapshot({ uiScopes: [uiScope({ skills: ["extra-*", "docs-style"] })] }));
    await screen.findByRole("group", { name: "docs" });
    expect(save().disabled).toBe(true);
  });

  it("labels unnamed scopes New scope N, in the legend and in the button labels", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    await screen.findByRole("group", { name: "docs" });
    fireEvent.click(screen.getByRole("button", { name: "Add scope" }));
    fireEvent.click(screen.getByRole("button", { name: "Add scope" }));
    expect(screen.getByRole("group", { name: "New scope 2" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "New scope 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove scope New scope 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove directory 1 from New scope 3" })).toBeTruthy();
    type(within(card("New scope 2")).getByLabelText("Name"), "named");
    expect(screen.getByRole("group", { name: "named" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove scope named" })).toBeTruthy();
  });

  it("offers a nested Skills group with the skills and the Extra patterns input", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const skills = within(await screen.findByRole("group", { name: "docs" })).getByRole("group", { name: "Skills" });
    expect(within(skills).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(skills).getByLabelText("Extra patterns")).toBeTruthy();
    expect(within(skills).getByText("Globs such as docs-*, comma-separated")).toBeTruthy();
  });
});

describe("focus after adding and removing", () => {
  it("moves focus to the new name input after Add scope", async () => {
    render();
    fireEvent.click(await screen.findByRole("button", { name: "Add scope" }));
    expect(document.activeElement).toBe(within(card("New scope 1")).getByLabelText("Name"));
  });

  it("moves focus to the new directory input after Add directory", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    fireEvent.click(within(group).getByRole("button", { name: "Add directory" }));
    expect(document.activeElement).toBe(within(group).getByLabelText("Directory 2"));
  });

  it("moves focus to the next directory after a remove, and to Add directory after the last", async () => {
    render(snapshot({ uiScopes: [uiScope({ paths: ["/a", "/b", "/c"] })] }));
    const group = await screen.findByRole("group", { name: "docs" });
    fireEvent.click(within(group).getByRole("button", { name: "Remove directory 1 from docs" }));
    expect((within(group).getByLabelText("Directory 1") as HTMLInputElement).value).toBe("/b");
    expect(document.activeElement).toBe(within(group).getByLabelText("Directory 1"));
    fireEvent.click(within(group).getByRole("button", { name: "Remove directory 1 from docs" }));
    expect((within(group).getByLabelText("Directory 1") as HTMLInputElement).value).toBe("/c");
    expect(within(group).queryByLabelText("Directory 2")).toBeNull();
    expect(document.activeElement).toBe(within(group).getByLabelText("Directory 1"));
    fireEvent.click(within(group).getByRole("button", { name: "Remove directory 1 from docs" }));
    expect(within(group).queryByLabelText("Directory 1")).toBeNull();
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: "Add directory" }));
  });

  it("moves focus to the next scope after a remove, and to Add scope after the last", async () => {
    render(snapshot({ uiScopes: [uiScope({ name: "a" }), uiScope({ name: "b" })] }));
    await screen.findByRole("group", { name: "a" });
    fireEvent.click(screen.getByRole("button", { name: "Remove scope a" }));
    expect(screen.queryByRole("group", { name: "a" })).toBeNull();
    expect(document.activeElement).toBe(within(card("b")).getByLabelText("Name"));
    fireEvent.click(screen.getByRole("button", { name: "Remove scope b" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add scope" }));
  });
});

describe("Save and Discard", () => {
  it("disables Save and the fields while a save runs, then announces Saved", async () => {
    let done!: (value: ScopesSnapshot) => void;
    render(snapshot({ uiScopes: [uiScope()] }), {
      saveScopes: () => new Promise((resolve) => { done = resolve; }),
    });
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs2");
    fireEvent.click(save());
    expect(save().disabled).toBe(true);
    expect(within(group).getByLabelText("Name").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add scope" }).matches(":disabled")).toBe(true);
    await act(async () => { done(snapshot({ uiScopes: [uiScope({ name: "docs2" })] })); });
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(save().disabled).toBe(true);
    expect(within(card("docs2")).getByLabelText("Name").matches(":disabled")).toBe(false);
  });

  it("clears Saved on the next edit", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs2");
    fireEvent.click(save());
    await screen.findByText("Saved");
    type(within(card("docs2")).getByLabelText("Name"), "docs3");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows a save error in one alert, keeps the edits and stores nothing", async () => {
    const view = render(snapshot({ uiScopes: [uiScope()] }), {
      saveScopes: () => { throw new Error('scope "docs": every directory must be absolute or start with "~/"'); },
    });
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Directory 1"), "relative");
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('scope "docs": every directory must be absolute or start with "~/"');
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect((within(card("docs")).getByLabelText("Directory 1") as HTMLInputElement).value).toBe("relative");
    expect(save().disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(calls(view, "saveScopes")).toHaveLength(1);
  });

  it("words a save rejection that is not an Error as-is", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs2");
    rpcStringRejection.current = { method: "saveScopes", message: "save-not-an-error" };
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe("save-not-an-error");
  });

  it("discards the edits and a save error, restoring the loaded state", async () => {
    render(snapshot({ uiScopes: [uiScope()] }), {
      saveScopes: () => { throw new Error("nope"); },
    });
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "other");
    fireEvent.click(screen.getByRole("button", { name: "Add scope" }));
    fireEvent.click(save());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("group", { name: "other" })).toBeNull();
    expect(screen.queryByRole("group", { name: "New scope 2" })).toBeNull();
    expect((within(card("docs")).getByLabelText("Name") as HTMLInputElement).value).toBe("docs");
    expect(save().disabled).toBe(true);
  });
});

describe("notes while typing", () => {
  const withFiles = () =>
    snapshot({
      fileScopes: [fileScope(), fileScope({ name: "corp", source: "file", hasProfile: true })],
    });

  it("says a scope replaces a file scope without a profile", async () => {
    render(withFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Add scope" }));
    const group = card("New scope 1");
    expect(within(group).queryByText(/replaces file scope/)).toBeNull();
    type(within(group).getByLabelText("Name"), "work");
    expect(within(card("work")).getByText("replaces file scope work")).toBeTruthy();
    expect(within(card("work")).queryByText(IGNORED_NOTE)).toBeNull();
  });

  it("warns before Save that a scope named like a file scope with a profile will be ignored", async () => {
    render(withFiles());
    fireEvent.click(await screen.findByRole("button", { name: "Add scope" }));
    type(within(card("New scope 1")).getByLabelText("Name"), " corp ");
    expect(within(card("corp")).getByText(IGNORED_NOTE)).toBeTruthy();
    expect(within(card("corp")).queryByText(/replaces file scope/)).toBeNull();
  });

  it("confirms with the skipped list after a save", async () => {
    render(snapshot(), {
      saveScopes: (input) => snapshot({ uiScopes: input.scopes, skipped: ["ghost"] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add scope" }));
    type(within(card("New scope 1")).getByLabelText("Name"), "ghost");
    expect(within(card("ghost")).queryByText(IGNORED_NOTE)).toBeNull();
    type(within(card("ghost")).getByLabelText("Directory 1"), "/g");
    fireEvent.click(within(card("ghost")).getByRole("checkbox", { name: /docs-style/ }));
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(within(card("ghost")).getByText(IGNORED_NOTE)).toBeTruthy();
  });
});

describe("reload on focus", () => {
  it("keeps unsaved edits and does not reload", async () => {
    const view = render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "edited");
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getScopes")).toHaveLength(1);
    expect((within(card("edited")).getByLabelText("Name") as HTMLInputElement).value).toBe("edited");
  });

  it("reloads a clean form", async () => {
    let current = snapshot({ uiScopes: [uiScope({ name: "one" })] });
    const view = render(current, { getScopes: () => current });
    await screen.findByRole("group", { name: "one" });
    current = snapshot({ uiScopes: [uiScope({ name: "two" })] });
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("group", { name: "two" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "one" })).toBeNull();
    expect(calls(view, "getScopes")).toHaveLength(2);
  });

  it("keeps an edit made while a reload was in flight", async () => {
    const pending: Array<(value: ScopesSnapshot) => void> = [];
    render(snapshot({ uiScopes: [uiScope()] }), {
      getScopes: () => new Promise((resolve) => { pending.push(resolve); }),
    });
    await act(async () => { pending[0]!(snapshot({ uiScopes: [uiScope()] })); });
    const group = await screen.findByRole("group", { name: "docs" });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(pending).toHaveLength(2);
    type(within(group).getByLabelText("Name"), "typing");
    await act(async () => { pending[1]!(snapshot({ uiScopes: [uiScope({ name: "from-server" })] })); });
    expect((within(card("typing")).getByLabelText("Name") as HTMLInputElement).value).toBe("typing");
    expect(screen.queryByRole("group", { name: "from-server" })).toBeNull();
  });

  it("does not apply a reload response that arrives after a save", async () => {
    const pending: Array<(value: ScopesSnapshot) => void> = [];
    let first = true;
    render(snapshot({ uiScopes: [uiScope()] }), {
      getScopes: () => {
        if (first) {
          first = false;
          return snapshot({ uiScopes: [uiScope()] });
        }
        return new Promise((resolve) => { pending.push(resolve); });
      },
      saveScopes: (input) => snapshot({ uiScopes: input.scopes }),
    });
    const group = await screen.findByRole("group", { name: "docs" });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    type(within(group).getByLabelText("Name"), "saved");
    fireEvent.click(save());
    await screen.findByText("Saved");
    await act(async () => { pending[0]!(snapshot({ uiScopes: [uiScope({ name: "stale" })] })); });
    expect(screen.getByRole("group", { name: "saved" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "stale" })).toBeNull();
  });

  it("stops listening for focus when the section unmounts", async () => {
    const view = render(snapshot());
    await screen.findByRole("button", { name: "Add scope" });
    cleanup();
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getScopes")).toHaveLength(1);
  });
});

describe("an unsaved empty row", () => {
  it("survives a window focus, and Save stays disabled for it", async () => {
    const view = render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    fireEvent.click(within(group).getByRole("button", { name: "Add directory" }));
    expect(save().disabled).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getScopes")).toHaveLength(1);
    expect(within(group).getByLabelText("Directory 2")).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it("survives a window focus for added spaces too", async () => {
    const view = render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs ");
    expect(save().disabled).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getScopes")).toHaveLength(1);
    expect((within(group).getByLabelText("Name") as HTMLInputElement).value).toBe("docs ");
  });

  it("reloads again after the empty row is removed", async () => {
    const view = render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    fireEvent.click(within(group).getByRole("button", { name: "Add directory" }));
    fireEvent.click(within(group).getByRole("button", { name: "Remove directory 2 from docs" }));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calls(view, "getScopes")).toHaveLength(2));
  });
});

describe("stable cards and focus after Save and Discard", () => {
  const scopes = (count: number) =>
    Array.from({ length: count }, (_, index) => uiScope({ name: `s${index}` }));

  it("keeps the same input element, and the focus, across a reload with the same data", async () => {
    const view = render(snapshot({ uiScopes: [uiScope()] }), {
      getScopes: () => snapshot({ uiScopes: [uiScope()] }),
    });
    const input = within(await screen.findByRole("group", { name: "docs" })).getByLabelText("Name");
    (input as HTMLInputElement).focus();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calls(view, "getScopes")).toHaveLength(2));
    await act(async () => {});
    expect(input.isConnected).toBe(true);
    expect(within(card("docs")).getByLabelText("Name")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("moves focus to Add scope after a successful save", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs2");
    within(group).getByLabelText("Name").focus();
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add scope" }));
  });

  it("keeps the focus where it is when the save fails", async () => {
    render(snapshot({ uiScopes: [uiScope()] }), {
      saveScopes: () => { throw new Error("nope"); },
    });
    const group = await screen.findByRole("group", { name: "docs" });
    const name = within(group).getByLabelText("Name");
    type(name, "docs2");
    name.focus();
    fireEvent.click(save());
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(name);
  });

  it("focuses the first card's Name when Add scope is disabled at 32 scopes", async () => {
    render(snapshot({ uiScopes: scopes(32) }));
    await screen.findByRole("group", { name: "s0" });
    type(within(card("s5")).getByLabelText("Name"), "renamed");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(document.activeElement).toBe(within(card("s0")).getByLabelText("Name"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("focuses Add scope after a save below 32 scopes", async () => {
    render(snapshot({ uiScopes: scopes(31) }));
    await screen.findByRole("group", { name: "s0" });
    type(within(card("s5")).getByLabelText("Name"), "renamed");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add scope" }));
  });

  it("focuses the first card's Name after Discard at 32 scopes", async () => {
    render(snapshot({ uiScopes: scopes(32) }));
    await screen.findByRole("group", { name: "s0" });
    type(within(card("s5")).getByLabelText("Name"), "renamed");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(document.activeElement).toBe(within(card("s0")).getByLabelText("Name"));
  });

  it("does nothing for focus when there is no card to fall back to", async () => {
    render(snapshot());
    const add = await screen.findByRole("button", { name: "Add scope" });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: "Remove scope New scope 1" }));
    expect(document.activeElement).toBe(add);
  });

  it("moves focus to Add scope after Discard", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs2");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add scope" }));
  });
});

describe("Discard after any edit", () => {
  it("is enabled for an empty directory row that Save ignores, and removes the row", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const group = await screen.findByRole("group", { name: "docs" });
    const discard = screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: "Add directory" }));
    expect(discard.disabled).toBe(false);
    expect(save().disabled).toBe(true);
    fireEvent.click(discard);
    expect(within(card("docs")).queryByLabelText("Directory 2")).toBeNull();
    expect(discard.disabled).toBe(true);
  });

  it("stays disabled while a save runs", async () => {
    let done!: (value: ScopesSnapshot) => void;
    render(snapshot({ uiScopes: [uiScope()] }), {
      saveScopes: () => new Promise((resolve) => { done = resolve; }),
    });
    const group = await screen.findByRole("group", { name: "docs" });
    type(within(group).getByLabelText("Name"), "docs2");
    fireEvent.click(save());
    expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { done(snapshot({ uiScopes: [uiScope({ name: "docs2" })] })); });
  });
});

describe("a save supersedes loads in flight", () => {
  it("ignores a getScopes response that started during the save and resolves after it", async () => {
    const loads: Array<(value: ScopesSnapshot) => void> = [];
    let first = true;
    let finishSave!: (value: ScopesSnapshot) => void;
    const broken = () => snapshot({ settingError: "old banner" });
    render(broken(), {
      getScopes: () => {
        if (first) {
          first = false;
          return broken();
        }
        return new Promise((resolve) => { loads.push(resolve); });
      },
      saveScopes: () => new Promise((resolve) => { finishSave = resolve; }),
    });
    await screen.findByText(/old banner/);
    // The form is clean (Save is enabled for the setting error), so a window focus starts a load mid-save.
    fireEvent.click(save());
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(loads).toHaveLength(1);
    await act(async () => { finishSave(snapshot({ uiScopes: [uiScope({ name: "saved" })] })); });
    await screen.findByText("Saved");
    await act(async () => { loads[0]!(broken()); });
    expect(screen.queryByText(/old banner/)).toBeNull();
    expect(screen.getByRole("group", { name: "saved" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });
});

describe("saved scopes that could not be read", () => {
  const broken = () => snapshot({ settingError: "scope 1 needs a name" });

  it("words the banner and enables Save on a clean form, Discard stays disabled", async () => {
    render(broken());
    expect(
      await screen.findByText("Saved scopes could not be read and are ignored: scope 1 needs a name. Save to replace them."),
    ).toBeTruthy();
    expect(save().disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves an empty list to replace the stored value, then the banner goes and Save is disabled", async () => {
    const view = render(broken(), { saveScopes: () => snapshot({ settingError: null }) });
    await screen.findByText(/Saved scopes could not be read/);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(calls(view, "saveScopes")).toEqual([{ method: "saveScopes", input: { scopes: [] } }]);
    expect(screen.queryByText(/Saved scopes could not be read/)).toBeNull();
    expect(save().disabled).toBe(true);
  });

  it("keeps Save disabled on a clean form with no setting error", async () => {
    render(snapshot());
    await screen.findByRole("button", { name: "Add scope" });
    expect(save().disabled).toBe(true);
  });
});

describe("accessible notes and hints", () => {
  const described = (element: HTMLElement) =>
    (element.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => document.getElementById(id));

  it("points the Name input at the note while one shows, and at nothing otherwise", async () => {
    render(snapshot({ fileScopes: [fileScope(), fileScope({ name: "corp", hasProfile: true })] }));
    fireEvent.click(await screen.findByRole("button", { name: "Add scope" }));
    const name = within(card("New scope 1")).getByLabelText("Name");
    expect(name.hasAttribute("aria-describedby")).toBe(false);
    type(name, "work");
    expect(described(name).map((node) => node?.textContent)).toEqual(["replaces file scope work"]);
    type(name, "corp");
    expect(described(name).map((node) => node?.textContent)).toEqual([IGNORED_NOTE]);
    type(name, "other");
    expect(name.hasAttribute("aria-describedby")).toBe(false);
  });

  it("points the Name input at the server's skipped note", async () => {
    render(snapshot({ uiScopes: [uiScope()], skipped: ["docs"] }));
    const name = within(await screen.findByRole("group", { name: "docs" })).getByLabelText("Name");
    expect(described(name).map((node) => node?.textContent)).toEqual([IGNORED_NOTE]);
  });

  it("points every directory input at the hint", async () => {
    render(snapshot({ uiScopes: [uiScope({ paths: ["/a", "/b"] })] }));
    const group = await screen.findByRole("group", { name: "docs" });
    for (const label of ["Directory 1", "Directory 2"]) {
      expect(described(within(group).getByLabelText(label)).map((node) => node?.textContent)).toEqual([
        "Absolute or ~/…",
      ]);
    }
  });

  it("points Extra patterns at its hint", async () => {
    render(snapshot({ uiScopes: [uiScope()] }));
    const patterns = within(await screen.findByRole("group", { name: "docs" })).getByLabelText("Extra patterns");
    expect(described(patterns).map((node) => node?.textContent)).toEqual([
      "Globs such as docs-*, comma-separated",
    ]);
  });

  it("builds checkbox ids from the position, not from the skill name", async () => {
    render(snapshot({ uiScopes: [uiScope()], skills: [{ name: "we ird:name", description: "d" }] }));
    const box = within(await screen.findByRole("group", { name: "docs" })).getByRole("checkbox");
    expect(box.id).toMatch(/-skill-0$/);
    expect(box.id).not.toContain("we ird");
  });
});

describe("size limits", () => {
  const scopes = (count: number) =>
    Array.from({ length: count }, (_, index) => uiScope({ name: `s${index}` }));

  it("disables Add scope at 32 scopes and enables it below", async () => {
    render(snapshot({ uiScopes: scopes(31) }));
    const add = (await screen.findByRole("button", { name: "Add scope" })) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(add.disabled).toBe(true);
  });

  it("disables Add directory at 16 rows and enables it below", async () => {
    render(snapshot({ uiScopes: [uiScope({ paths: Array.from({ length: 15 }, (_, i) => `/p${i}`) })] }));
    const group = await screen.findByRole("group", { name: "docs" });
    const add = within(group).getByRole("button", { name: "Add directory" }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(add.disabled).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: "Remove directory 16 from docs" }));
    expect(add.disabled).toBe(false);
  });

  it("limits the name to 128 and each directory to 1024 characters", async () => {
    render(snapshot({ uiScopes: [uiScope({ paths: ["/a", "/b"] })] }));
    const group = await screen.findByRole("group", { name: "docs" });
    expect(within(group).getByLabelText("Name").getAttribute("maxlength")).toBe("128");
    expect(within(group).getByLabelText("Directory 1").getAttribute("maxlength")).toBe("1024");
    expect(within(group).getByLabelText("Directory 2").getAttribute("maxlength")).toBe("1024");
    expect(within(group).getByLabelText("Extra patterns").hasAttribute("maxlength")).toBe(false);
  });
});
