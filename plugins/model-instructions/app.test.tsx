// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSettingsSectionRegistration } from "@get-bb/plugin-sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as ui from "./src/ui";
import type { ConfigState, ModelInstructionsRpcContract, RawConfig } from "./rpc-contract";

// The test rpc harness wraps every handler throw in an Error subclass, so a
// rejection that is not an Error can only reach the app by intercepting useRpc
// itself. Quirk learned under @get-bb/plugin-sdk 0.6.79 (dist/testing/app.js);
// the same approach is used in plugins/dir-skills/app.test.tsx.
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
  section = app.settingsSections.find((entry) => entry.id === "instructions")!;
});

// Vitest globals are off, so Testing Library does not clean up by itself.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  rpcStringRejection.current = null;
});

type Rule = RawConfig["rules"][number];

const IGNORED_NOTE = "Ignored: a profile scope with this name comes from profiles.json";
const PROFILE_NOTE = "Claude profile — edit ~/.bb/model-instructions/profiles.json";

function rule(overrides: Partial<Rule> = {}): Rule {
  return { threads: "any", instructions: "hello", ...overrides };
}

function config(overrides: Partial<RawConfig> = {}): RawConfig {
  return { vars: {}, scopes: [], rules: [], ...overrides };
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
  return {
    config: config(),
    providers: [
      { id: "claude-code", models: ["opus", "sonnet"] },
      { id: "codex", models: ["gpt-5"] },
    ],
    projects: [
      { id: "p1", name: "alpha" },
      { id: "p2", name: "beta" },
    ],
    skills: [
      { name: "model-instructions", description: "Change rules" },
      { name: "other-skill", description: "Other things" },
    ],
    profileScopes: [],
    ignoredScopes: [],
    cache: { providers: { loaded: true, failed: false }, projects: { loaded: true, failed: false } },
    overBudget: [],
    loadError: null,
    ...overrides,
  };
}

const withRules = (...rules: Rule[]) => state({ config: config({ rules }) });

type Handlers = Partial<PluginRpcTestHandlers<ModelInstructionsRpcContract>>;

function render(initial: ConfigState = state(), handlers: Handlers = {}) {
  return renderSlot<object, ModelInstructionsRpcContract>(
    section,
    {},
    {
      rpc: {
        getState: () => initial,
        saveConfig: (input: { config: RawConfig }) => ({ ...initial, config: input.config }),
        keepSavedRules: () => ({ ...initial, loadError: null }),
        ...handlers,
      } as PluginRpcTestHandlers<ModelInstructionsRpcContract>,
    },
  );
}

const calls = (view: { rpcCalls: Array<{ method: string }> }, method: string) =>
  view.rpcCalls.filter((call) => call.method === method);
const savedConfig = (view: { rpcCalls: Array<{ method: string; input?: unknown }> }, index = 0) =>
  (calls(view, "saveConfig")[index] as unknown as { input: { config: RawConfig } }).input.config;

const ruleCard = (name: string) => screen.getByRole("group", { name });
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const discard = () => screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement;
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });
const region = (name: string) => screen.getByRole("region", { name });
const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("button", { name }) as HTMLButtonElement;
const field = (scope: HTMLElement, label: string) =>
  within(scope).getByLabelText(label) as HTMLInputElement;
const tagList = (scope: HTMLElement, label: string) =>
  field(scope, label).closest("[data-tag-list]") as HTMLElement;
const addTag = (scope: HTMLElement, label: string, value: string) => {
  type(field(scope, label), value);
  fireEvent.click(button(tagList(scope, label), "Add"));
};
const tags = (scope: HTMLElement, label: string) =>
  within(tagList(scope, label))
    .queryAllByRole("listitem")
    .map((item) => item.querySelector("span")!.textContent);
const subgroup = (card: HTMLElement, name: string) => within(card).getByRole("group", { name });
/** The wrapper of a label and its control: a column, so the label sits above the control and does not run into it. */
const wrapperOf = (scope: HTMLElement, label: string) => field(scope, label).parentElement as HTMLElement;
const isField = (element: HTMLElement) =>
  element.className === ui.field && element.classList.contains("flex-col");

describe("registration", () => {
  it("registers the Instructions settings section with its description", () => {
    expect(section.title).toBe("Instructions");
    expect(section.description).toBe(
      "Instructions and skills that bb adds to agent threads, by directory, project, provider, model and thread type. Checked when you save: a rule set that would push a known thread past bb's 4096-character limit is rejected.",
    );
  });
});

describe("loading", () => {
  it("shows a loading note while the first load is in flight", () => {
    render(state(), { getState: () => new Promise(() => {}) });
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("offers Retry when the first load fails, then shows the form", async () => {
    let attempts = 0;
    render(state(), {
      getState: () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return state();
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the configuration: boom",
    );
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Add rule" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("words a rejection that is not an Error as-is", async () => {
    rpcStringRejection.current = { method: "getState", message: "boom-not-an-error" };
    render();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load the configuration: boom-not-an-error",
    );
  });

  it("keeps the form under a failed reload, with Retry", async () => {
    let attempts = 0;
    render(withRules(rule()), {
      getState: () => {
        attempts++;
        if (attempts === 2) throw new Error("server unavailable");
        return withRules(rule());
      },
    });
    await screen.findByRole("group", { name: "Rule 1" });
    window.dispatchEvent(new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("server unavailable");
    expect(ruleCard("Rule 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("ignores a response and a failure that a newer load superseded", async () => {
    const pending: Array<{ resolve: (value: ConfigState) => void; reject: (error: unknown) => void }> = [];
    render(state(), {
      getState: () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]!.resolve(withRules(rule({ name: "new" })));
    });
    expect(await screen.findByRole("group", { name: "new" })).toBeTruthy();
    await act(async () => {
      pending[0]!.resolve(withRules(rule({ name: "old" })));
    });
    expect(screen.queryByRole("group", { name: "old" })).toBeNull();
    expect(screen.getByRole("group", { name: "new" })).toBeTruthy();
  });

  it("ignores a failure that a newer load superseded", async () => {
    const pending: Array<{ resolve: (value: ConfigState) => void; reject: (error: unknown) => void }> = [];
    render(state(), {
      getState: () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    await act(async () => {
      pending[1]!.resolve(withRules(rule({ name: "new" })));
    });
    await screen.findByRole("group", { name: "new" });
    await act(async () => {
      pending[0]!.reject(new Error("late boom"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("group", { name: "new" })).toBeTruthy();
  });

  it("renders the three blocks with their headings and notes", async () => {
    render();
    await screen.findByRole("button", { name: "Add rule" });
    expect(within(region("Shared texts")).getByText("Use a shared text as {{name}} in a rule's instructions.")).toBeTruthy();
    expect(
      within(region("Directories")).getByText(
        "A rule limited to a directory applies when the thread's workspace or its project's checkout is inside it.",
      ),
    ).toBeTruthy();
    expect(
      within(region("Rules")).getByText(
        "Every matching rule applies, top first. When the text is over the limit, earlier rules are kept first.",
      ),
    ).toBeTruthy();
  });
});

describe("the label and its control", () => {
  it("sit in a field column in every rule, scope and shared text field", async () => {
    render(
      state({
        config: config({
          vars: { gchat: "Use gchat" },
          scopes: [{ name: "work", paths: ["/w"] }],
          rules: [rule({ name: "a" })],
        }),
      }),
    );
    const card = await screen.findByRole("group", { name: "a" });
    for (const label of ["Name (optional)", "Provider", "Model", "Thread", "Instructions"]) {
      expect(isField(wrapperOf(card, label))).toBe(true);
    }
    for (const label of ["Projects", "Skip projects", "Skip titles"]) {
      expect(isField(tagList(card, label))).toBe(true);
    }
    expect(isField(tagList(subgroup(card, "Skills"), "Other patterns"))).toBe(true);
    const vars = within(region("Shared texts")).getAllByRole("listitem")[0]!;
    expect(isField(wrapperOf(vars, "Name"))).toBe(true);
    expect(isField(wrapperOf(vars, "Text"))).toBe(true);
    const scope = within(region("Directories")).getAllByRole("listitem")[0]!;
    expect(isField(wrapperOf(scope, "Name"))).toBe(true);
  });

  it("have full-width, bordered controls", async () => {
    render(withRules(rule({ name: "a" })));
    const card = await screen.findByRole("group", { name: "a" });
    for (const label of ["Name (optional)", "Provider", "Thread"]) {
      expect(field(card, label).classList.contains("w-full")).toBe(true);
      expect(field(card, label).classList.contains("border-input")).toBe(true);
    }
    expect(field(card, "Instructions").classList.contains("min-h-32")).toBe(true);
  });
});

describe("Shared texts", () => {
  it("lists the vars as name and text rows", async () => {
    render(state({ config: config({ vars: { gchat: "Use gchat", b: "B text" } }) }));
    const rows = within(await screen.findByRole("region", { name: "Shared texts" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(field(rows[0]!, "Name").value).toBe("gchat");
    expect(field(rows[0]!, "Text").value).toBe("Use gchat");
    expect(field(rows[1]!, "Name").value).toBe("b");
  });

  it("adds a row, saves it trimmed by name and untrimmed by text, and drops a blank row", async () => {
    const view = render();
    const shared = await screen.findByRole("region", { name: "Shared texts" });
    fireEvent.click(button(shared, "Add shared text"));
    expect(document.activeElement).toBe(field(shared, "Name"));
    expect(save().disabled).toBe(true);
    type(field(shared, "Name"), "  gchat ");
    type(field(shared, "Text"), " Use gchat\n");
    fireEvent.click(button(shared, "Add shared text"));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(calls(view, "saveConfig")).toEqual([
      { method: "saveConfig", input: { config: { vars: { gchat: " Use gchat\n" }, scopes: [], rules: [] } } },
    ]);
  });

  it("sends a row that has a text but no name, so the server can reject it", async () => {
    const view = render();
    const shared = await screen.findByRole("region", { name: "Shared texts" });
    fireEvent.click(button(shared, "Add shared text"));
    type(field(shared, "Text"), "orphan");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).vars).toEqual({ "": "orphan" });
  });

  it("keeps a __proto__ name as an own key for the server to reject", async () => {
    const view = render();
    const shared = await screen.findByRole("region", { name: "Shared texts" });
    fireEvent.click(button(shared, "Add shared text"));
    type(field(shared, "Name"), "__proto__");
    type(field(shared, "Text"), "x");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(Object.hasOwn(savedConfig(view).vars, "__proto__")).toBe(true);
  });

  it("edits a text and removes rows, moving focus to the next row and then to Add shared text", async () => {
    const view = render(state({ config: config({ vars: { a: "1", b: "2", c: "3" } }) }));
    const shared = await screen.findByRole("region", { name: "Shared texts" });
    type(field(within(shared).getAllByRole("listitem")[1]!, "Text"), "two");
    fireEvent.click(button(shared, "Remove shared text a"));
    expect(document.activeElement).toBe(field(within(shared).getAllByRole("listitem")[0]!, "Name"));
    expect(field(within(shared).getAllByRole("listitem")[0]!, "Name").value).toBe("b");
    fireEvent.click(button(shared, "Remove shared text c"));
    expect(document.activeElement).toBe(button(shared, "Add shared text"));
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).vars).toEqual({ b: "two" });
  });
});

describe("Directories", () => {
  const scoped = () =>
    state({
      config: config({
        scopes: [
          { name: "work", paths: ["/src/work", "~/work"] },
          { name: "docs", paths: ["/src/docs"] },
        ],
      }),
    });

  it("lists the saved scopes with a row per path and the hint", async () => {
    render(scoped());
    const cards = within(await screen.findByRole("region", { name: "Directories" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(field(cards[0]!, "Name").value).toBe("work");
    const rows = within(subgroup(cards[0]!, "Directories")).getAllByRole("textbox") as HTMLInputElement[];
    expect(rows.map((row) => row.value)).toEqual(["/src/work", "~/work"]);
    expect(within(cards[0]!).getByText("Absolute or ~/…")).toBeTruthy();
    expect(within(cards[0]!).queryByText(IGNORED_NOTE)).toBeNull();
  });

  it("adds a scope, focuses its name, and saves the trimmed payload without empty rows", async () => {
    const view = render();
    const block = await screen.findByRole("region", { name: "Directories" });
    fireEvent.click(button(block, "Add directory scope"));
    const card = within(block).getAllByRole("listitem")[0]!;
    expect(document.activeElement).toBe(field(card, "Name"));
    expect(save().disabled).toBe(false);
    type(field(card, "Name"), "  work ");
    type(within(card).getAllByRole("textbox")[1]!, "  ~/src/work ");
    fireEvent.click(button(card, "Add directory"));
    expect(document.activeElement).toBe(within(card).getAllByRole("textbox")[2]);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).scopes).toEqual([{ name: "work", paths: ["~/src/work"] }]);
  });

  it("edits one path and leaves the others alone", async () => {
    const view = render(scoped());
    const card = within(await screen.findByRole("region", { name: "Directories" })).getAllByRole("listitem")[0]!;
    type(within(card).getAllByRole("textbox")[2]!, "/changed");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).scopes[0]).toEqual({ name: "work", paths: ["/src/work", "/changed"] });
  });

  it("moves focus to the next path after a remove, and to Add directory after the last", async () => {
    render(state({ config: config({ scopes: [{ name: "work", paths: ["/a", "/b", "/c"] }] }) }));
    const card = within(await screen.findByRole("region", { name: "Directories" })).getAllByRole("listitem")[0]!;
    const paths = () => within(subgroup(card, "Directories")).getAllByRole("textbox") as HTMLInputElement[];
    const remove = (path: string) =>
      fireEvent.click(within(subgroup(card, "Directories")).getByRole("button", { name: `Remove directory ${path}` }));
    remove("/a");
    expect(paths().map((path) => path.value)).toEqual(["/b", "/c"]);
    expect(document.activeElement).toBe(paths()[0]);
    remove("/c");
    expect(paths().map((path) => path.value)).toEqual(["/b"]);
    expect(document.activeElement).toBe(button(card, "Add directory"));
  });

  it("moves focus to the next scope after a remove, and to Add directory scope after the last", async () => {
    render(scoped());
    const block = await screen.findByRole("region", { name: "Directories" });
    const cards = () => within(block).getAllByRole("listitem");
    const removeCard = (name: string) => fireEvent.click(button(block, `Remove directory scope ${name}`));
    removeCard("work");
    expect(cards()).toHaveLength(1);
    expect(document.activeElement).toBe(field(cards()[0]!, "Name"));
    expect(field(cards()[0]!, "Name").value).toBe("docs");
    removeCard("docs");
    expect(document.activeElement).toBe(button(block, "Add directory scope"));
  });

  it("marks a saved scope that the server lists as ignored", async () => {
    render(state({ config: scoped().config, ignoredScopes: ["docs"] }));
    const cards = within(await screen.findByRole("region", { name: "Directories" })).getAllByRole("listitem");
    expect(within(cards[0]!).queryByText(IGNORED_NOTE)).toBeNull();
    expect(within(cards[1]!).getByText(IGNORED_NOTE)).toBeTruthy();
    const described = document.getElementById(field(cards[1]!, "Name").getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe(IGNORED_NOTE);
    expect(field(cards[0]!, "Name").hasAttribute("aria-describedby")).toBe(false);
  });

  it("marks a scope as ignored while its name is typed, when a profile scope has that name", async () => {
    render(state({ profileScopes: [{ name: "corp", paths: ["/corp"] }] }));
    const block = await screen.findByRole("region", { name: "Directories" });
    fireEvent.click(button(block, "Add directory scope"));
    const card = within(block).getAllByRole("listitem")[0]!;
    expect(within(card).queryByText(IGNORED_NOTE)).toBeNull();
    type(field(card, "Name"), " corp ");
    expect(within(card).getByText(IGNORED_NOTE)).toBeTruthy();
    type(field(card, "Name"), "other");
    expect(within(card).queryByText(IGNORED_NOTE)).toBeNull();
  });

  it("lists profile scopes read-only, with the note, under From profiles.json", async () => {
    render(
      state({
        profileScopes: [
          { name: "corp", paths: ["/a", "/b"] },
          { name: "lab", paths: ["~/lab"] },
        ],
      }),
    );
    const block = await screen.findByRole("region", { name: "Directories" });
    expect(within(block).getByRole("heading", { name: "From profiles.json" })).toBeTruthy();
    const items = within(block).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("corp")).toBeTruthy();
    expect(within(items[0]!).getByText("/a, /b")).toBeTruthy();
    expect(within(items[0]!).getAllByText(PROFILE_NOTE)).toHaveLength(1);
    expect(within(items[1]!).getByText("~/lab")).toBeTruthy();
    expect(within(block).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows no From profiles.json heading when there are no profile scopes", async () => {
    render();
    await screen.findByRole("region", { name: "Directories" });
    expect(screen.queryByRole("heading", { name: "From profiles.json" })).toBeNull();
  });
});

describe("card titles and accessible names", () => {
  it("titles an unnamed directory scope Directory scope <n> and follows the name once typed", async () => {
    render(state({ config: config({ scopes: [{ name: "", paths: ["/a"] }, { name: "work", paths: ["/w"] }, { name: " ", paths: ["/c"] }] }) }));
    const block = await screen.findByRole("region", { name: "Directories" });
    const titles = () =>
      within(block)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(":scope > fieldset > legend")!.textContent);
    expect(titles()).toEqual(["Directory scope 1", "work", "Directory scope 3"]);
    type(field(within(block).getAllByRole("listitem")[0]!, "Name"), "  first ");
    expect(titles()).toEqual(["first", "work", "Directory scope 3"]);
  });

  it("names the Remove buttons of directory scopes: unnamed or named", async () => {
    render(state({ config: config({ scopes: [{ name: "", paths: ["/a"] }, { name: " work ", paths: ["/w"] }] }) }));
    const block = await screen.findByRole("region", { name: "Directories" });
    expect(button(block, "Remove Directory scope 1").textContent).toBe("Remove");
    expect(button(block, "Remove directory scope work").textContent).toBe("Remove");
  });

  it("names the Remove button of a path row by its path, or as an empty row", async () => {
    render(state({ config: config({ scopes: [{ name: "work", paths: [" /w ", ""] }] }) }));
    const block = await screen.findByRole("region", { name: "Directories" });
    expect(button(block, "Remove directory /w").textContent).toBe("Remove");
    fireEvent.click(button(block, "Remove empty directory row"));
    expect(screen.queryByRole("button", { name: "Remove empty directory row" })).toBeNull();
  });

  it("names the Remove button of a shared text by its name, or by its position when unnamed", async () => {
    render(state({ config: config({ vars: { a: "1" } }) }));
    const shared = await screen.findByRole("region", { name: "Shared texts" });
    fireEvent.click(button(shared, "Add shared text"));
    expect(button(shared, "Remove shared text a").textContent).toBe("Remove");
    expect(button(shared, "Remove shared text 2").textContent).toBe("Remove");
    type(field(within(shared).getAllByRole("listitem")[1]!, "Name"), " b ");
    expect(button(shared, "Remove shared text b")).toBeTruthy();
  });

  it("names Delete after the rule title, unnamed or named", async () => {
    render(withRules(rule(), rule({ name: "Mine" })));
    await screen.findByRole("group", { name: "Rule 1" });
    expect(button(ruleCard("Rule 1"), "Delete Rule 1").textContent).toBe("Delete");
    expect(button(ruleCard("Mine"), "Delete Mine").textContent).toBe("Delete");
  });
});

describe("duplicate shared text names", () => {
  const NOTE = "This name is already used above; rename one of them.";
  const rows = () => within(region("Shared texts")).getAllByRole("listitem");

  it("shows the note under the later row and keeps Save disabled until one is renamed", async () => {
    const view = render(state({ config: config({ vars: { a: "1", b: "2" } }) }));
    await screen.findByRole("region", { name: "Shared texts" });
    expect(save().disabled).toBe(true);
    type(field(rows()[1]!, "Name"), " a ");
    expect(within(rows()[0]!).queryByText(NOTE)).toBeNull();
    expect(within(rows()[1]!).getByText(NOTE)).toBeTruthy();
    expect(field(rows()[1]!, "Name").getAttribute("aria-describedby")).toBe(
      within(rows()[1]!).getByText(NOTE).id,
    );
    expect(save().disabled).toBe(true);
    type(field(rows()[1]!, "Text"), "changed");
    expect(save().disabled).toBe(true);
    type(field(rows()[1]!, "Name"), "c");
    expect(within(rows()[1]!).queryByText(NOTE)).toBeNull();
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).vars).toEqual({ a: "1", c: "changed" });
  });

  it("notes only the later rows of a name used three times", async () => {
    render(state({ config: config({ vars: { a: "1", b: "2", c: "3" } }) }));
    await screen.findByRole("region", { name: "Shared texts" });
    type(field(rows()[1]!, "Name"), "a");
    type(field(rows()[2]!, "Name"), "a");
    expect(screen.getAllByText(NOTE)).toHaveLength(2);
    expect(within(rows()[0]!).queryByText(NOTE)).toBeNull();
  });

  it("does not count rows that Save would drop as blank, but does count a nameless row with a text", async () => {
    render(state({ config: config({ vars: { a: "1" } }) }));
    const shared = await screen.findByRole("region", { name: "Shared texts" });
    fireEvent.click(button(shared, "Add shared text"));
    fireEvent.click(button(shared, "Add shared text"));
    type(field(rows()[0]!, "Name"), "");
    type(field(rows()[0]!, "Text"), "");
    expect(screen.queryByText(NOTE)).toBeNull();
    type(field(rows()[1]!, "Text"), "x");
    type(field(rows()[2]!, "Text"), "y");
    expect(within(rows()[1]!).queryByText(NOTE)).toBeNull();
    expect(within(rows()[2]!).getByText(NOTE)).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it("lets Discard remove the duplicate and re-enables nothing to save", async () => {
    render(state({ config: config({ vars: { a: "1", b: "2" } }) }));
    await screen.findByRole("region", { name: "Shared texts" });
    type(field(rows()[1]!, "Name"), "a");
    fireEvent.click(discard());
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(save().disabled).toBe(true);
  });
});

describe("Rules: rendering", () => {
  it("renders every field of a stored rule", async () => {
    render(
      state({
        config: config({
          vars: { x: "y" },
          scopes: [{ name: "work", paths: ["/w"] }],
          rules: [
            rule({
              name: "Mine",
              provider: "claude-*",
              model: "opus",
              threads: "child",
              project: ["alpha", "b*"],
              skipProjects: ["beta"],
              skipTitles: ["wip*"],
              scope: ["work", "~/x*"],
              skills: ["model-instructions", "docs-*"],
              instructions: "do {{x}}",
            }),
          ],
        }),
        profileScopes: [{ name: "corp", paths: ["/corp"] }],
      }),
    );
    const card = await screen.findByRole("group", { name: "Mine" });
    expect(field(card, "Name (optional)").value).toBe("Mine");
    const applies = subgroup(card, "Applies to");
    expect(field(applies, "Provider").value).toBe("claude-*");
    expect(field(applies, "Model").value).toBe("opus");
    expect((field(applies, "Thread") as unknown as HTMLSelectElement).value).toBe("child");
    expect(within(applies).getAllByText("Empty for any. * matches any characters.")).toHaveLength(2);
    expect(tags(applies, "Projects")).toEqual(["alpha", "b*"]);
    expect(tags(applies, "Skip projects")).toEqual(["beta"]);
    expect(tags(applies, "Skip titles")).toEqual(["wip*"]);
    expect(within(applies).getAllByText("Project names; * matches any characters.")).toHaveLength(2);
    expect(within(applies).getByText("Thread titles; * matches any characters.")).toBeTruthy();
    const directories = subgroup(applies, "Directories");
    expect((within(directories).getByRole("checkbox", { name: "work" }) as HTMLInputElement).checked).toBe(true);
    expect((within(directories).getByRole("checkbox", { name: "corp" }) as HTMLInputElement).checked).toBe(false);
    expect(tags(directories, "Other patterns")).toEqual(["~/x*"]);
    const skills = subgroup(card, "Skills");
    expect((within(skills).getByRole("checkbox", { name: /model-instructions/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(skills).getByRole("checkbox", { name: /other-skill/ }) as HTMLInputElement).checked).toBe(false);
    expect(within(skills).getByText("Change rules")).toBeTruthy();
    expect(tags(skills, "Other patterns")).toEqual(["docs-*"]);
    expect(field(card, "Instructions").value).toBe("do {{x}}");
    expect(within(card).getByText("4 / 4096 characters")).toBeTruthy();
    expect(Array.from((field(applies, "Thread") as unknown as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      "Any",
      "Top-level",
      "Child",
    ]);
  });

  it("titles unnamed rules Rule <n> and follows the name once typed", async () => {
    render(withRules(rule(), rule()));
    await screen.findByRole("group", { name: "Rule 1" });
    expect(ruleCard("Rule 2")).toBeTruthy();
    type(field(ruleCard("Rule 2"), "Name (optional)"), "  Second ");
    expect(screen.getByRole("group", { name: "Second" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Rule 2" })).toBeNull();
  });

  it("shows the Skills group with only Other patterns when no skills are bundled", async () => {
    render(state({ skills: [], config: config({ rules: [rule({ skills: ["old-*"] })] }) }));
    const skills = subgroup(await screen.findByRole("group", { name: "Rule 1" }), "Skills");
    expect(within(skills).queryAllByRole("checkbox")).toHaveLength(0);
    expect(tags(skills, "Other patterns")).toEqual(["old-*"]);
  });

  it("renders text from the server as text, never as HTML", async () => {
    render(
      state({
        skills: [{ name: "evil", description: "<script>alert(1)</script>" }],
        config: config({ rules: [rule({ name: "<b>x</b>", instructions: "<img src=x onerror=alert(1)>" })] }),
        loadError: { kind: "stored", message: "<i>bad</i>", text: "<script>alert(2)</script>" },
      }),
    );
    expect(await screen.findByRole("group", { name: "<b>x</b>" })).toBeTruthy();
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(screen.getByText("<i>bad</i>")).toBeTruthy();
    expect(screen.getByText("<script>alert(2)</script>")).toBeTruthy();
    expect(document.querySelector("script, img, b, i")).toBeNull();
  });
});

describe("Directories: Other patterns that match no scope", () => {
  const NOTE = "Matches no directory scope";
  const directoriesOf = async () => subgroup(await screen.findByRole("group", { name: "Rule 1" }), "Directories");
  const others = (directories: HTMLElement) => tagList(directories, "Other patterns");

  it("notes an entry that matches no saved or profile scope name, and only that entry", async () => {
    render(
      state({
        config: config({
          scopes: [{ name: "work", paths: ["/w"] }],
          rules: [rule({ scope: ["~/x*", "wor*", "co*", "*", "plain", "w.rk"] })],
        }),
        profileScopes: [{ name: "corp", paths: ["/c"] }],
      }),
    );
    const list = others(await directoriesOf());
    const items = within(list).getAllByRole("listitem");
    const noted = (value: string) =>
      within(items.find((item) => item.querySelector("span")!.textContent === value)!).queryAllByText(NOTE).length;
    expect(noted("~/x*")).toBe(1);
    expect(noted("plain")).toBe(1);
    // A dot is not a wildcard: "w.rk" matches no name, "work" does not match it.
    expect(noted("w.rk")).toBe(1);
    expect(noted("wor*")).toBe(0);
    expect(noted("co*")).toBe(0);
    expect(noted("*")).toBe(0);
    expect(within(list).getAllByText(NOTE)).toHaveLength(3);
  });

  it("follows the scope names as they are typed, and the note leaves with a matching name", async () => {
    render(state({ config: config({ scopes: [{ name: "work", paths: ["/w"] }], rules: [rule({ scope: ["team*"] })] }) }));
    const directories = await directoriesOf();
    expect(within(others(directories)).getAllByText(NOTE)).toHaveLength(1);
    type(screen.getAllByLabelText("Name").find((input) => (input as HTMLInputElement).value === "work")!, "teamwork");
    expect(within(others(await directoriesOf())).queryAllByText(NOTE)).toHaveLength(0);
  });

  it("notes a newly added entry too", async () => {
    render(withRules(rule()));
    const directories = await directoriesOf();
    addTag(directories, "Other patterns", "nothing-*");
    expect(within(others(directories)).getAllByText(NOTE)).toHaveLength(1);
  });

  it("is not shown for the Skills patterns or any other list", async () => {
    render(
      state({
        config: config({
          rules: [rule({ skills: ["no-such-*"], project: ["zzz"], skipProjects: ["zzz"], skipTitles: ["zzz"] })],
        }),
      }),
    );
    const card = await screen.findByRole("group", { name: "Rule 1" });
    expect(within(card).queryAllByText(NOTE)).toHaveLength(0);
  });
});

describe("Typed text that was not added", () => {
  const lists = [
    ["Projects", "project", (card: HTMLElement) => within(card).getByRole("group", { name: "Applies to" })],
    ["Skip projects", "skipProjects", (card: HTMLElement) => within(card).getByRole("group", { name: "Applies to" })],
    ["Skip titles", "skipTitles", (card: HTMLElement) => within(card).getByRole("group", { name: "Applies to" })],
    ["Other patterns", "scope", (card: HTMLElement) => subgroup(subgroup(card, "Applies to"), "Directories")],
    ["Other patterns", "skills", (card: HTMLElement) => subgroup(card, "Skills")],
  ] as const;

  it.each(lists)("in %s (%s) enables Save, is saved as if added, and is cleared by Discard", async (label, key, within_) => {
    const view = render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    type(field(within_(card), label), "  typed* ");
    expect(save().disabled).toBe(false);
    expect(discard().disabled).toBe(false);
    // Discard first: the typed text goes, and the form is clean again.
    fireEvent.click(discard());
    expect(field(within_(card), label).value).toBe("");
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    type(field(within_(card), label), "  typed* ");
    fireEvent.click(save());
    await waitFor(() => expect(calls(view, "saveConfig")).toHaveLength(1));
    expect(savedConfig(view).rules[0]![key]).toEqual(["typed*"]);
  });

  it("is sent after the entries already added, and not twice when it was added first", async () => {
    const view = render(withRules(rule({ project: ["alpha"] })));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    const applies = subgroup(card, "Applies to");
    type(field(applies, "Projects"), "beta");
    fireEvent.click(save());
    await waitFor(() => expect(calls(view, "saveConfig")).toHaveLength(1));
    expect(savedConfig(view).rules[0]!.project).toEqual(["alpha", "beta"]);
  });

  it("adds it once when Add is used, and Save then sends it once", async () => {
    const view = render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    const applies = subgroup(card, "Applies to");
    addTag(applies, "Projects", "beta");
    expect(field(applies, "Projects").value).toBe("");
    fireEvent.click(save());
    await waitFor(() => expect(calls(view, "saveConfig")).toHaveLength(1));
    expect(savedConfig(view).rules[0]!.project).toEqual(["beta"]);
  });

  it("does not enable Save when only spaces were typed, but Discard can still clear them", async () => {
    render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    const applies = subgroup(card, "Applies to");
    type(field(applies, "Projects"), "   ");
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(false);
    fireEvent.click(discard());
    expect(field(applies, "Projects").value).toBe("");
  });

  it("stays on its own rule: a second rule's box is not touched", async () => {
    render(withRules(rule(), rule()));
    await screen.findByRole("group", { name: "Rule 1" });
    type(field(subgroup(ruleCard("Rule 1"), "Applies to"), "Projects"), "only-first");
    expect(field(subgroup(ruleCard("Rule 2"), "Applies to"), "Projects").value).toBe("");
  });

  it("is dropped by a successful save, so the next save has nothing pending", async () => {
    const view = render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(subgroup(card, "Applies to"), "Projects"), "beta");
    fireEvent.click(save());
    await waitFor(() => expect(calls(view, "saveConfig")).toHaveLength(1));
    await waitFor(() => expect(save().disabled).toBe(true));
    expect(field(subgroup(ruleCard("Rule 1"), "Applies to"), "Projects").value).toBe("");
  });
});

describe("Rules: editing and the save payload", () => {
  it("adds a rule, focuses its name and saves exactly what was filled in", async () => {
    const view = render(
      state({ config: config({ scopes: [{ name: "work", paths: ["/w"] }] }), profileScopes: [{ name: "corp", paths: ["/c"] }] }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    const card = ruleCard("Rule 1");
    expect(document.activeElement).toBe(field(card, "Name (optional)"));
    expect(save().disabled).toBe(false);
    type(field(card, "Name (optional)"), " Mine ");
    type(field(card, "Provider"), " claude-code ");
    type(field(card, "Model"), "opus");
    type(field(card, "Thread"), "top-level");
    addTag(card, "Projects", "alpha");
    addTag(card, "Skip projects", "beta");
    addTag(card, "Skip titles", "wip*");
    const directories = subgroup(card, "Directories");
    fireEvent.click(within(directories).getByRole("checkbox", { name: "work" }));
    fireEvent.click(within(directories).getByRole("checkbox", { name: "corp" }));
    fireEvent.click(within(directories).getByRole("checkbox", { name: "corp" }));
    addTag(directories, "Other patterns", "~/x*");
    const skills = subgroup(card, "Skills");
    fireEvent.click(within(skills).getByRole("checkbox", { name: /other-skill/ }));
    addTag(skills, "Other patterns", "docs-*");
    type(field(card, "Instructions"), "  do it\n");
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(calls(view, "saveConfig")).toEqual([
      {
        method: "saveConfig",
        input: {
          config: {
            vars: {},
            scopes: [{ name: "work", paths: ["/w"] }],
            rules: [
              {
                name: "Mine",
                provider: "claude-code",
                model: "opus",
                project: ["alpha"],
                skipProjects: ["beta"],
                skipTitles: ["wip*"],
                scope: ["work", "~/x*"],
                skills: ["other-skill", "docs-*"],
                threads: "top-level",
                instructions: "  do it\n",
              },
            ],
          },
        },
      },
    ]);
  });

  it("starts clean and keeps a glob in scope and skills, in order, when an unrelated field is saved", async () => {
    const stored = rule({
      scope: ["~/x*", "work", "y-*"],
      skills: ["docs-*", "model-instructions", "z-*"],
      project: ["alpha"],
    });
    const view = render(
      state({ config: config({ scopes: [{ name: "work", paths: ["/w"] }], rules: [stored] }) }),
    );
    const card = await screen.findByRole("group", { name: "Rule 1" });
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    type(field(card, "Name (optional)"), "renamed");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).rules).toEqual([{ ...stored, name: "renamed" }]);
  });

  it("leaves out an empty Provider, an empty tag list, a cleared Skills group and blank instructions", async () => {
    const view = render(
      withRules(
        rule({
          name: "n",
          provider: "claude-code",
          model: "opus",
          project: ["alpha"],
          skipProjects: ["beta"],
          skipTitles: ["t"],
          scope: ["work"],
          skills: ["model-instructions"],
          instructions: "text",
        }),
      ),
    );
    const card = await screen.findByRole("group", { name: "n" });
    type(field(card, "Name (optional)"), "  ");
    type(field(card, "Provider"), "  ");
    type(field(card, "Model"), "");
    fireEvent.click(within(tagList(card, "Projects")).getByRole("button", { name: "Remove alpha" }));
    fireEvent.click(within(tagList(card, "Skip projects")).getByRole("button", { name: "Remove beta" }));
    fireEvent.click(within(tagList(card, "Skip titles")).getByRole("button", { name: "Remove t" }));
    fireEvent.click(within(tagList(subgroup(card, "Directories"), "Other patterns")).queryAllByRole("button", { name: "Add" })[0]!);
    fireEvent.click(within(subgroup(card, "Skills")).getByRole("checkbox", { name: /model-instructions/ }));
    type(field(card, "Instructions"), "  \n ");
    fireEvent.click(save());
    await screen.findByText("Saved");
    // scope names a scope that is not saved: it stays as a pattern entry, and is still sent
    expect(savedConfig(view).rules).toEqual([{ scope: ["work"], threads: "any" }]);
    expect(Object.keys(savedConfig(view).rules[0]!)).toEqual(["scope", "threads"]);
  });

  it("sends neither an empty string nor an empty array for any field of a blank rule", async () => {
    const view = render();
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).rules).toEqual([{ threads: "any" }]);
  });

  it("turns a checked directory into a pattern when its scope is renamed, and back when the name returns", async () => {
    render(
      state({
        config: config({ scopes: [{ name: "work", paths: ["/w"] }], rules: [rule({ scope: ["work"] })] }),
      }),
    );
    const card = await screen.findByRole("group", { name: "Rule 1" });
    const directories = () => subgroup(card, "Directories");
    expect((within(directories()).getByRole("checkbox", { name: "work" }) as HTMLInputElement).checked).toBe(true);
    const block = region("Directories");
    type(field(within(block).getAllByRole("listitem")[0]!, "Name"), "work2");
    expect((within(directories()).getByRole("checkbox", { name: "work2" }) as HTMLInputElement).checked).toBe(false);
    expect(tags(directories(), "Other patterns")).toEqual(["work"]);
    type(field(within(block).getAllByRole("listitem")[0]!, "Name"), "work");
    expect((within(directories()).getByRole("checkbox", { name: "work" }) as HTMLInputElement).checked).toBe(true);
    expect(tags(directories(), "Other patterns")).toEqual([]);
  });

  it("lists a scope name once even when a saved scope and a profile scope share it", async () => {
    render(
      state({
        config: config({ scopes: [{ name: "corp", paths: ["/a"] }] }),
        profileScopes: [{ name: "corp", paths: ["/c"] }],
        ...{},
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    expect(within(subgroup(ruleCard("Rule 1"), "Directories")).getAllByRole("checkbox")).toHaveLength(1);
  });

  it("ignores blank scope names in the directory checkboxes", async () => {
    render();
    fireEvent.click(await screen.findByRole("button", { name: "Add directory scope" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(within(subgroup(ruleCard("Rule 1"), "Directories")).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("unchecks a skill again", async () => {
    render(withRules(rule({ skills: ["model-instructions"] })));
    const box = within(subgroup(await screen.findByRole("group", { name: "Rule 1" }), "Skills")).getByRole("checkbox", {
      name: /model-instructions/,
    }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(save().disabled).toBe(true);
  });
});

describe("tag lists", () => {
  const open = async () => {
    render(withRules(rule({ project: ["alpha"] })));
    return screen.findByRole("group", { name: "Rule 1" });
  };

  it("adds with the Add button, trims, ignores a blank value and clears the input", async () => {
    const card = await open();
    addTag(card, "Projects", "  beta  ");
    expect(tags(card, "Projects")).toEqual(["alpha", "beta"]);
    expect(field(card, "Projects").value).toBe("");
    fireEvent.click(button(tagList(card, "Projects"), "Add"));
    type(field(card, "Projects"), "   ");
    fireEvent.click(button(tagList(card, "Projects"), "Add"));
    expect(tags(card, "Projects")).toEqual(["alpha", "beta"]);
  });

  it("adds with Enter, and other keys do nothing", async () => {
    const card = await open();
    type(field(card, "Projects"), "beta");
    fireEvent.keyDown(field(card, "Projects"), { key: "a" });
    expect(tags(card, "Projects")).toEqual(["alpha"]);
    fireEvent.keyDown(field(card, "Projects"), { key: "Enter" });
    expect(tags(card, "Projects")).toEqual(["alpha", "beta"]);
  });

  it("adds a value that was typed but not added when the input loses focus, so Save does not drop it", async () => {
    const card = await open();
    type(field(card, "Projects"), "beta");
    fireEvent.blur(field(card, "Projects"));
    expect(tags(card, "Projects")).toEqual(["alpha", "beta"]);
    expect(save().disabled).toBe(false);
  });

  it("removes a tag by its Remove <value> button", async () => {
    const card = await open();
    addTag(card, "Projects", "b*");
    fireEvent.click(within(tagList(card, "Projects")).getByRole("button", { name: "Remove alpha" }));
    expect(tags(card, "Projects")).toEqual(["b*"]);
  });

  it("suggests project names for the project fields and provider ids for Provider", async () => {
    const card = await open();
    const options = (input: HTMLElement) =>
      Array.from(document.getElementById(input.getAttribute("list")!)!.querySelectorAll("option")).map(
        (option) => option.value,
      );
    expect(options(field(card, "Projects"))).toEqual(["alpha", "beta"]);
    expect(options(field(card, "Skip projects"))).toEqual(["alpha", "beta"]);
    expect(options(field(card, "Provider"))).toEqual(["claude-code", "codex"]);
    expect(field(card, "Skip titles").hasAttribute("list")).toBe(false);
    expect(field(card, "Instructions").hasAttribute("list")).toBe(false);
  });

  it("suggests all models, or the models of the provider that is typed", async () => {
    render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    const models = () =>
      Array.from(document.getElementById(field(card, "Model").getAttribute("list")!)!.querySelectorAll("option")).map(
        (option) => option.value,
      );
    expect(models()).toEqual(["opus", "sonnet", "gpt-5"]);
    type(field(card, "Provider"), "codex");
    expect(models()).toEqual(["gpt-5"]);
    type(field(card, "Provider"), "claude-*");
    expect(models()).toEqual(["opus", "sonnet", "gpt-5"]);
  });
});

describe("Rules: order, duplicate and delete", () => {
  const three = () => withRules(rule({ name: "a" }), rule({ name: "b" }), rule({ name: "c" }));
  const order = () =>
    screen
      .getAllByRole("group")
      .map((group) => group.querySelector(":scope > legend")?.textContent ?? "")
      .filter((title) => ["a", "b", "c", "a2"].includes(title));

  it("disables Move up on the first rule and Move down on the last", async () => {
    render(three());
    await screen.findByRole("group", { name: "a" });
    expect(button(ruleCard("a"), "Move up").disabled).toBe(true);
    expect(button(ruleCard("a"), "Move down").disabled).toBe(false);
    expect(button(ruleCard("c"), "Move down").disabled).toBe(true);
    expect(button(ruleCard("c"), "Move up").disabled).toBe(false);
  });

  it("moves a rule down and up, saves the new order, and keeps the focus on the used button", async () => {
    const view = render(three());
    await screen.findByRole("group", { name: "a" });
    fireEvent.click(button(ruleCard("a"), "Move down"));
    expect(order()).toEqual(["b", "a", "c"]);
    expect(document.activeElement).toBe(button(ruleCard("a"), "Move down"));
    fireEvent.click(button(ruleCard("a"), "Move down"));
    expect(order()).toEqual(["b", "c", "a"]);
    // now last: Move down is disabled, so the focus goes to Move up
    expect(document.activeElement).toBe(button(ruleCard("a"), "Move up"));
    fireEvent.click(button(ruleCard("a"), "Move up"));
    expect(order()).toEqual(["b", "a", "c"]);
    expect(document.activeElement).toBe(button(ruleCard("a"), "Move up"));
    fireEvent.click(button(ruleCard("a"), "Move up"));
    expect(order()).toEqual(["a", "b", "c"]);
    // first again: Move up is disabled, so the focus goes to Move down
    expect(document.activeElement).toBe(button(ruleCard("a"), "Move down"));
    expect(save().disabled).toBe(true);
    fireEvent.click(button(ruleCard("c"), "Move up"));
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).rules.map((entry) => entry.name)).toEqual(["a", "c", "b"]);
  });

  it("duplicates a rule right below it and focuses the copy's name", async () => {
    const view = render(three());
    await screen.findByRole("group", { name: "a" });
    fireEvent.click(button(ruleCard("a"), "Duplicate"));
    expect(screen.getAllByRole("group", { name: "a" })).toHaveLength(2);
    const copy = screen.getAllByRole("group", { name: "a" })[1]!;
    expect(document.activeElement).toBe(field(copy, "Name (optional)"));
    type(field(copy, "Name (optional)"), "a2");
    expect(order()).toEqual(["a", "a2", "b", "c"]);
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).rules.map((entry) => entry.name)).toEqual(["a", "a2", "b", "c"]);
  });

  it("copies the arrays, so editing the copy leaves the original alone", async () => {
    render(withRules(rule({ name: "a", project: ["alpha"] })));
    await screen.findByRole("group", { name: "a" });
    fireEvent.click(button(ruleCard("a"), "Duplicate"));
    const [original, copy] = screen.getAllByRole("group", { name: "a" });
    addTag(copy!, "Projects", "beta");
    expect(tags(original!, "Projects")).toEqual(["alpha"]);
    expect(tags(copy!, "Projects")).toEqual(["alpha", "beta"]);
  });

  it("deletes a rule, focusing the next rule's name and then Add rule", async () => {
    const view = render(withRules(rule({ name: "a" }), rule({ name: "b" })));
    await screen.findByRole("group", { name: "a" });
    fireEvent.click(button(ruleCard("a"), "Delete a"));
    expect(screen.queryByRole("group", { name: "a" })).toBeNull();
    expect(document.activeElement).toBe(field(ruleCard("b"), "Name (optional)"));
    fireEvent.click(button(ruleCard("b"), "Delete b"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(savedConfig(view).rules).toEqual([]);
  });
});

describe("the character count", () => {
  const open = async (vars: Record<string, string> = {}, instructions = "") => {
    render(state({ config: config({ vars, rules: [rule({ instructions })] }) }));
    return screen.findByRole("group", { name: "Rule 1" });
  };

  it("counts after trimming and expanding, like the server", async () => {
    const card = await open({ x: "12345" });
    type(field(card, "Instructions"), "  a{{x}}b  ");
    expect(within(card).getByText("7 / 4096 characters")).toBeTruthy();
    expect(within(card).queryByText(/Unknown shared text/)).toBeNull();
  });

  it("follows the shared texts as they are edited, and ignores a var row without a name", async () => {
    const card = await open({ x: "12345" }, "{{x}}");
    expect(within(card).getByText("5 / 4096 characters")).toBeTruthy();
    const shared = region("Shared texts");
    type(field(within(shared).getAllByRole("listitem")[0]!, "Text"), "12");
    expect(within(card).getByText("2 / 4096 characters")).toBeTruthy();
    type(field(within(shared).getAllByRole("listitem")[0]!, "Name"), "  y ");
    expect(within(card).getByText("Unknown shared text {{x}}")).toBeTruthy();
    expect(within(card).getByText("5 / 4096 characters")).toBeTruthy();
    type(field(within(shared).getAllByRole("listitem")[0]!, "Name"), "");
    type(field(within(shared).getAllByRole("listitem")[0]!, "Text"), "");
    expect(within(card).getByText("Unknown shared text {{x}}")).toBeTruthy();
  });

  it("notes each unknown shared text once", async () => {
    const card = await open({}, "{{y}} {{y}} {{z}}");
    expect(within(card).getByText("Unknown shared text {{y}}")).toBeTruthy();
    expect(within(card).getByText("Unknown shared text {{z}}")).toBeTruthy();
    expect(within(card).getAllByText(/Unknown shared text/)).toHaveLength(2);
  });

  it("says when the text is over the limit, and not at the limit", async () => {
    const card = await open();
    type(field(card, "Instructions"), "a".repeat(4096));
    expect(within(card).getByText("4096 / 4096 characters")).toBeTruthy();
    type(field(card, "Instructions"), "a".repeat(4097));
    expect(within(card).getByText("4097 / 4096 characters — over the limit")).toBeTruthy();
  });

  it("styles the count with errorHint when over the limit and with hint otherwise, never both", async () => {
    const card = await open();
    type(field(card, "Instructions"), "a".repeat(4096));
    const within4096 = within(card).getByText("4096 / 4096 characters");
    expect(within4096.className).toBe(ui.hint);
    type(field(card, "Instructions"), "a".repeat(4097));
    const over = within(card).getByText("4097 / 4096 characters — over the limit");
    expect(over.className).toBe(ui.errorHint);
    expect(over.classList.contains("text-muted-foreground")).toBe(false);
  });

  it("points the Instructions field at its hint-less count and keeps the count outside the textarea", async () => {
    const card = await open();
    expect(field(card, "Instructions").tagName).toBe("TEXTAREA");
    expect(field(card, "Instructions").hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("Save and Discard", () => {
  it("disables Save and the fields while a save runs, then announces Saved", async () => {
    let done!: (value: ConfigState) => void;
    render(withRules(rule()), {
      saveConfig: () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    });
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(card, "Name (optional)"), "n");
    fireEvent.click(save());
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    expect(field(ruleCard("n"), "Name (optional)").matches(":disabled")).toBe(true);
    await act(async () => {
      done(withRules(rule({ name: "n" })));
    });
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(save().disabled).toBe(true);
    expect(field(ruleCard("n"), "Name (optional)").matches(":disabled")).toBe(false);
  });

  it("clears Saved on the next edit", async () => {
    render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(card, "Name (optional)"), "n");
    fireEvent.click(save());
    await screen.findByText("Saved");
    type(field(ruleCard("n"), "Name (optional)"), "m");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows a save error in one alert, keeps the edits and stores nothing", async () => {
    const view = render(withRules(rule()), {
      saveConfig: () => {
        throw new Error("rule 1 would push claude-code/opus over 4096");
      },
    });
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(card, "Instructions"), "changed");
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("rule 1 would push claude-code/opus over 4096");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(field(ruleCard("Rule 1"), "Instructions").value).toBe("changed");
    expect(save().disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(calls(view, "saveConfig")).toHaveLength(1);
  });

  it("adds the hint when the error starts with budget not checkable yet, and only then", async () => {
    let message = "budget not checkable yet: the project list is not loaded";
    render(withRules(rule()), {
      saveConfig: () => {
        throw new Error(message);
      },
    });
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(card, "Name (optional)"), "n");
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "budget not checkable yet: the project list is not loaded" +
        "bb is still loading the provider and project lists; try again in a moment.",
    );
    message = "a budget not checkable yet in the middle";
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
    expect(screen.queryByText(/still loading the provider/)).toBeNull();
  });

  describe("the save error", () => {
    const failWith = async (message: string) => {
      render(withRules(rule()), {
        saveConfig: () => {
          throw new Error(message);
        },
      });
      const card = await screen.findByRole("group", { name: "Rule 1" });
      type(field(card, "Name (optional)"), "n");
      fireEvent.click(save());
      return (await screen.findByRole("alert")).firstElementChild as HTMLElement;
    };

    // Both messages are what the server sends (rules.ts) for an unknown variable in rule 2 and a relative path in scope 2.
    it("names a rule and a directory scope as the cards do, and keeps its line breaks", async () => {
      const rule = await failWith("rules[1]: unknown variable {{nope}}");
      expect(rule.textContent).toBe("Rule 2: unknown variable {{nope}}");
      expect(rule.classList.contains("whitespace-pre-wrap")).toBe(true);
      cleanup();
      const scope = await failWith(
        '✖ expected an absolute path or a path starting with "~/"\n  → at scopes[1].paths[0]',
      );
      expect(scope.textContent).toBe(
        '✖ expected an absolute path or a path starting with "~/"\n  → at Directory scope 2.paths[0]',
      );
      expect(scope.classList.contains("whitespace-pre-wrap")).toBe(true);
    });

    it("replaces every position in one message, and only a whole rules[n] or scopes[n]", async () => {
      const element = await failWith("rules[0] and rules[11]: scopes[2] twice scopes[3]; myrules[1], rules[x], scopes[]");
      expect(element.textContent).toBe(
        "Rule 1 (n) and Rule 12: Directory scope 3 twice Directory scope 4; myrules[1], rules[x], scopes[]",
      );
    });

    it("adds the name of a named rule card or directory scope card, and leaves an unnamed or blank-named one without", async () => {
      render(
        state({
          config: config({
            scopes: [
              { name: "work", paths: ["/w"] },
              { name: "", paths: ["/x"] },
            ],
            rules: [rule({ name: "guard" }), rule(), rule({ name: "  " })],
          }),
        }),
        {
          saveConfig: () => {
            throw new Error("rules[0]: a; rules[1]: b; rules[2]: c; scopes[0] and scopes[1]");
          },
        },
      );
      await screen.findByRole("group", { name: "guard" });
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      fireEvent.click(save());
      const element = (await screen.findByRole("alert")).firstElementChild as HTMLElement;
      expect(element.textContent).toBe(
        "Rule 1 (guard): a; Rule 2: b; Rule 3: c; Directory scope 1 (work) and Directory scope 2",
      );
    });

    it("uses the name the card had when Save was pressed, not a later edit", async () => {
      render(withRules(rule({ name: "guard" })), {
        saveConfig: () => {
          throw new Error("rules[0]: a");
        },
      });
      const card = await screen.findByRole("group", { name: "guard" });
      type(field(card, "Name (optional)"), "guard2");
      fireEvent.click(save());
      await screen.findByRole("alert");
      type(field(screen.getByRole("group", { name: "guard2" }), "Name (optional)"), "other");
      expect((screen.getByRole("alert").firstElementChild as HTMLElement).textContent).toBe("Rule 1 (guard2): a");
    });

    it("leaves a message with neither as it is", async () => {
      const element = await failWith("over the 4096-character limit");
      expect(element.textContent).toBe("over the 4096-character limit");
    });
  });

  it("words a save rejection that is not an Error as-is", async () => {
    render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(card, "Name (optional)"), "n");
    rpcStringRejection.current = { method: "saveConfig", message: "save-not-an-error" };
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe("save-not-an-error");
  });

  it("discards the edits and a save error, restoring the loaded state", async () => {
    render(withRules(rule({ name: "a" })), {
      saveConfig: () => {
        throw new Error("nope");
      },
    });
    const card = await screen.findByRole("group", { name: "a" });
    type(field(card, "Name (optional)"), "other");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.click(save());
    await screen.findByRole("alert");
    fireEvent.click(discard());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("group", { name: "other" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Rule 2" })).toBeNull();
    expect(field(ruleCard("a"), "Name (optional)").value).toBe("a");
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
  });

  it("moves focus to Add rule after a successful save, and keeps it where it is when the save fails", async () => {
    let fail = true;
    render(withRules(rule()), {
      saveConfig: (input: { config: RawConfig }) => {
        if (fail) throw new Error("nope");
        return withRules(...input.config.rules);
      },
    });
    const card = await screen.findByRole("group", { name: "Rule 1" });
    const name = field(card, "Name (optional)");
    type(name, "n");
    name.focus();
    fireEvent.click(save());
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(name);
    fail = false;
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add rule" }));
  });

  it("is enabled for an empty row that Save ignores, and removes the row", async () => {
    render(state({ config: config({ scopes: [{ name: "work", paths: ["/w"] }] }) }));
    const card = within(await screen.findByRole("region", { name: "Directories" })).getAllByRole("listitem")[0]!;
    expect(discard().disabled).toBe(true);
    fireEvent.click(button(card, "Add directory"));
    expect(discard().disabled).toBe(false);
    expect(save().disabled).toBe(true);
    fireEvent.click(discard());
    expect(within(card).getAllByRole("textbox")).toHaveLength(2);
    expect(discard().disabled).toBe(true);
  });
});

describe("reload on focus", () => {
  it("keeps unsaved edits and does not reload", async () => {
    const view = render(withRules(rule()));
    const card = await screen.findByRole("group", { name: "Rule 1" });
    type(field(card, "Name (optional)"), "edited");
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getState")).toHaveLength(1);
    expect(field(ruleCard("edited"), "Name (optional)").value).toBe("edited");
  });

  it("reloads a clean form", async () => {
    let current = withRules(rule({ name: "one" }));
    const view = render(current, { getState: () => current });
    await screen.findByRole("group", { name: "one" });
    current = withRules(rule({ name: "two" }));
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("group", { name: "two" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "one" })).toBeNull();
    expect(calls(view, "getState")).toHaveLength(2);
  });

  it("keeps an edit made while a reload was in flight", async () => {
    const pending: Array<(value: ConfigState) => void> = [];
    render(withRules(rule()), {
      getState: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    });
    await act(async () => {
      pending[0]!(withRules(rule()));
    });
    const card = await screen.findByRole("group", { name: "Rule 1" });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(pending).toHaveLength(2);
    type(field(card, "Name (optional)"), "typing");
    await act(async () => {
      pending[1]!(withRules(rule({ name: "from-server" })));
    });
    expect(field(ruleCard("typing"), "Name (optional)").value).toBe("typing");
    expect(screen.queryByRole("group", { name: "from-server" })).toBeNull();
  });

  it("does not apply a reload response that arrives after a save", async () => {
    const pending: Array<(value: ConfigState) => void> = [];
    let first = true;
    render(withRules(rule()), {
      getState: () => {
        if (first) {
          first = false;
          return withRules(rule());
        }
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      },
      saveConfig: (input: { config: RawConfig }) => withRules(...input.config.rules),
    });
    const card = await screen.findByRole("group", { name: "Rule 1" });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    type(field(card, "Name (optional)"), "saved");
    fireEvent.click(save());
    await screen.findByText("Saved");
    await act(async () => {
      pending[0]!(withRules(rule({ name: "stale" })));
    });
    expect(screen.getByRole("group", { name: "saved" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "stale" })).toBeNull();
  });

  it("survives a window focus for an empty row and for added spaces", async () => {
    const view = render(withRules(rule({ name: "a" })));
    const card = await screen.findByRole("group", { name: "a" });
    type(field(card, "Name (optional)"), "a ");
    expect(save().disabled).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getState")).toHaveLength(1);
    expect(field(card, "Name (optional)").value).toBe("a ");
  });

  it("reloads again once the edit is discarded", async () => {
    const view = render(withRules(rule({ name: "a" })));
    const card = await screen.findByRole("group", { name: "a" });
    type(field(card, "Name (optional)"), "b");
    fireEvent.click(discard());
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calls(view, "getState")).toHaveLength(2));
  });

  it("keeps the same input element, and the focus, across a reload with the same data", async () => {
    const view = render(withRules(rule()));
    const input = field(await screen.findByRole("group", { name: "Rule 1" }), "Name (optional)");
    input.focus();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calls(view, "getState")).toHaveLength(2));
    await act(async () => {});
    expect(input.isConnected).toBe(true);
    expect(field(ruleCard("Rule 1"), "Name (optional)")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("stops listening for focus when the section unmounts", async () => {
    const view = render();
    await screen.findByRole("button", { name: "Add rule" });
    cleanup();
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(calls(view, "getState")).toHaveLength(1);
  });
});

describe("a save supersedes loads in flight", () => {
  it("ignores a getState response that started during the save and resolves after it", async () => {
    const loads: Array<(value: ConfigState) => void> = [];
    let first = true;
    let finishSave!: (value: ConfigState) => void;
    render(withRules(rule({ name: "a" })), {
      getState: () => {
        if (first) {
          first = false;
          return withRules(rule({ name: "a" }));
        }
        return new Promise((resolve) => {
          loads.push(resolve);
        });
      },
      saveConfig: () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    });
    const card = await screen.findByRole("group", { name: "a" });
    type(field(card, "Name (optional)"), "saved");
    fireEvent.click(save());
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    // edited: the focus does not start a load
    expect(loads).toHaveLength(0);
    await act(async () => {
      finishSave(withRules(rule({ name: "saved" })));
    });
    await screen.findByText("Saved");
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(loads).toHaveLength(1);
    fireEvent.click(button(ruleCard("saved"), "Delete saved"));
    await act(async () => {
      loads[0]!(withRules(rule({ name: "late" })));
    });
    expect(screen.queryByRole("group", { name: "late" })).toBeNull();
  });
});

describe("the saved configuration banner", () => {
  const MESSAGE = "the saved config could not be loaded: ✖ Invalid input\n  → at rules[0]";
  const TEXT = '{\n  "rules": [\n    {\n      "name": "<b>r</b>"\n    }\n  ]\n}';
  const stored = (text = TEXT) => state({ loadError: { kind: "stored", message: MESSAGE, text } });
  const NAME = "The saved configuration could not be loaded";

  it("shows the heading, message, stored text and the line to keep it, in that order, with no button", async () => {
    render(stored());
    const banner = await screen.findByRole("region", { name: NAME });
    expect(Array.from(banner.children).map((child) => child.tagName)).toEqual(["H4", "P", "PRE", "DIV"]);
    expect(banner.children[1]!.textContent).toBe(MESSAGE);
    expect(banner.querySelector("pre")!.textContent).toBe(TEXT);
    expect(banner.children[3]!.textContent).toBe(
      "Saving here replaces it. To keep it, run bb model-instructions export, fix the file, and import it.",
    );
    expect(within(banner).queryAllByRole("button")).toHaveLength(0);
    expect(banner.querySelector("b")).toBeNull();
  });

  it("scrolls the stored text sideways, so compact JSON with no spaces does not overflow the banner", async () => {
    render(stored());
    const banner = await screen.findByRole("region", { name: NAME });
    expect(banner.querySelector("pre")!.classList.contains("overflow-auto")).toBe(true);
  });

  it("shows the heading, message and the line when the stored value has no text", async () => {
    render(stored(""));
    const banner = await screen.findByRole("region", { name: NAME });
    expect(Array.from(banner.children).map((child) => child.tagName)).toEqual(["H4", "P", "DIV"]);
    expect(banner.querySelector("pre")).toBeNull();
  });

  it("is not shown for the other kinds", async () => {
    render(state({ loadError: { kind: "migration", message: "m", backupPath: null } }));
    await screen.findByRole("region", { name: "Your rules from the previous version were not moved" });
    expect(screen.queryByRole("region", { name: NAME })).toBeNull();
    expect(screen.queryByText(/Saving here replaces it/)).toBeNull();
  });
});

describe("the storage banner", () => {
  const MESSAGE =
    "the plugin's storage could not be read: disk gone. Reload the plugin (bb plugin reload model-instructions) before saving.";
  const NAME = "The plugin's storage could not be read";

  it("shows the heading and the message, with no text block and no button", async () => {
    render(state({ loadError: { kind: "storage", message: MESSAGE } }));
    const banner = await screen.findByRole("region", { name: NAME });
    expect(Array.from(banner.children).map((child) => child.tagName)).toEqual(["H4", "P"]);
    expect(banner.children[1]!.textContent).toBe(MESSAGE);
    expect(within(banner).queryAllByRole("button")).toHaveLength(0);
    expect(banner.querySelector("pre")).toBeNull();
    expect(screen.queryByRole("region", { name: "The saved configuration could not be loaded" })).toBeNull();
  });

  it("is not shown for the other kinds", async () => {
    render(state({ loadError: { kind: "migration", message: "m", backupPath: null } }));
    await screen.findByRole("region", { name: "Your rules from the previous version were not moved" });
    expect(screen.queryByRole("region", { name: NAME })).toBeNull();
  });
});

describe("a banner kind the form does not know", () => {
  it("fails loudly instead of showing a wrong banner", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const uncaught = vi.fn((event: ErrorEvent) => event.preventDefault());
    window.addEventListener("error", uncaught);
    try {
      render(state({ loadError: { kind: "bogus", message: "m" } as never }));
      await waitFor(() => expect(uncaught).toHaveBeenCalled());
      expect(uncaught.mock.calls[0]![0].error.message).toBe('unexpected load error {"kind":"bogus","message":"m"}');
    } finally {
      window.removeEventListener("error", uncaught);
      errors.mockRestore();
    }
  });
});

describe("the migration banner", () => {
  const NAME = "Your rules from the previous version were not moved";
  const WITH_COPY =
    "rules[2]: bad glob. A copy is in /h/.bb/model-instructions/backups/rules-1.txt. Fix it there and run bb model-instructions import /h/.bb/model-instructions/backups/rules-1.txt.";
  const NO_COPY =
    "EACCES: permission denied. No copy could be made; the rules are still in the plugin's settings and the move is tried again at the next start.";

  it("shows the heading and the message with a copy, with no button", async () => {
    render(
      state({ loadError: { kind: "migration", message: WITH_COPY, backupPath: "/h/.bb/model-instructions/backups/rules-1.txt" } }),
    );
    const banner = await screen.findByRole("region", { name: NAME });
    expect(Array.from(banner.children).map((child) => child.tagName)).toEqual(["H4", "P"]);
    expect(banner.children[1]!.textContent).toBe(WITH_COPY);
    expect(within(banner).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows the heading and the message without a copy", async () => {
    render(state({ loadError: { kind: "migration", message: NO_COPY, backupPath: null } }));
    const banner = await screen.findByRole("region", { name: NAME });
    expect(banner.children[1]!.textContent).toBe(NO_COPY);
    expect(within(banner).queryAllByRole("button")).toHaveLength(0);
  });

  it("is not shown when there is no load error", async () => {
    render();
    await screen.findByRole("button", { name: "Add rule" });
    expect(screen.queryByRole("region", { name: NAME })).toBeNull();
  });
});

describe("the conflict banner", () => {
  const NAME = "Your rules from the previous version differ from the rules saved here";
  const MESSAGE =
    "A copy of the previous rules is in /b/rules-1.txt. To use them, run bb model-instructions import /b/rules-1.txt; to keep the rules saved here, press Keep the rules saved here.";
  const conflict = () => state({ loadError: { kind: "conflict", message: MESSAGE, backupPath: "/b/rules-1.txt" } });

  it("shows the heading, the message and the button, in that order", async () => {
    render(conflict());
    const banner = await screen.findByRole("region", { name: NAME });
    expect(Array.from(banner.children).map((child) => child.tagName)).toEqual(["H4", "P", "BUTTON"]);
    expect(banner.children[1]!.textContent).toBe(MESSAGE);
    expect(banner.children[2]!.textContent).toBe("Keep the rules saved here");
  });

  it("keeps the saved rules without replacing unsaved edits", async () => {
    const view = render(conflict());
    await screen.findByRole("button", { name: "Keep the rules saved here" });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    type(field(ruleCard("Rule 1"), "Name (optional)"), "kept");
    fireEvent.click(screen.getByRole("button", { name: "Keep the rules saved here" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Keep the rules saved here" })).toBeNull());
    expect(calls(view, "keepSavedRules")).toHaveLength(1);
    expect(field(ruleCard("kept"), "Name (optional)").value).toBe("kept");
    expect(save().disabled).toBe(false);
  });

  it("shows an error when keeping fails, and keeps the banner", async () => {
    render(conflict(), {
      keepSavedRules: () => {
        throw new Error("storage busy");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Keep the rules saved here" }));
    expect((await screen.findByRole("alert")).textContent).toBe("storage busy");
    expect(screen.getByRole("button", { name: "Keep the rules saved here" })).toBeTruthy();
  });
});
