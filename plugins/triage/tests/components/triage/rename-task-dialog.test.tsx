// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { RenameTaskDialog } from "@/components/triage/rename-task-dialog";
import { createFakeRpc, deferred, makeTask, resetSdk, sdk, toasts } from "./helpers";

vi.mock("@get-bb/plugin-sdk/app", async () => {
  const { createSdkAppMock } = await import("./helpers");
  return createSdkAppMock();
});

vi.mock("sonner", async () => {
  const { createSonnerMock } = await import("./helpers");
  return createSonnerMock();
});

afterEach(cleanup);

beforeEach(() => {
  resetSdk();
});

// closed tests.
test("renders nothing while the dialog is closed", () => {
  const { container } = render(
    <RenameTaskDialog task={makeTask()} open={false} onOpenChange={() => {}} />,
  );
  expect(container.childElementCount).toBe(0);
});

// save tests.
test("keeps the save button disabled and skips the rpc when the title is blank", () => {
  const onOpenChange = vi.fn();
  render(<RenameTaskDialog task={makeTask()} open onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  expect(sdk.rpc.call).not.toHaveBeenCalledWith("renameTask", expect.anything());
  expect(onOpenChange).not.toHaveBeenCalled();
});

test("submits the trimmed title while pending, then closes and toasts", async () => {
  const onOpenChange = vi.fn();
  const gate = deferred<void>();
  sdk.rpc = createFakeRpc({ renameTask: () => gate.promise });
  render(<RenameTaskDialog task={makeTask({ number: 4 })} open onOpenChange={onOpenChange} />);

  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "  Better name  " },
  });
  const form = screen.getByRole("dialog").querySelector("form")!;
  fireEvent.submit(form);

  await waitFor(() => {
    expect(sdk.rpc.call).toHaveBeenCalledWith("renameTask", {
      number: 4,
      title: "Better name",
    });
  });
  expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);

  // A second submit while pending must not re-enter the rpc. The other call
  // on the fake is useTriage's background snapshot fetch.
  fireEvent.submit(form);
  const renames = sdk.rpc.call.mock.calls.filter(([method]) => method === "renameTask");
  expect(renames).toHaveLength(1);

  gate.resolve();
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(toasts.success).toHaveBeenCalledWith("Title updated");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});

test("toasts the rpc failure message", async () => {
  sdk.rpc = createFakeRpc({ renameTask: () => Promise.reject(new Error("boom")) });
  render(<RenameTaskDialog task={makeTask()} open onOpenChange={() => {}} />);
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("boom"));
});

test("stringifies non-error rejections", async () => {
  sdk.rpc = createFakeRpc({ renameTask: () => Promise.reject("plain") });
  render(<RenameTaskDialog task={makeTask()} open onOpenChange={() => {}} />);
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("plain"));
});

// typing tests.
test("keeps the draft in sync while typing", () => {
  render(<RenameTaskDialog task={makeTask()} open onOpenChange={() => {}} />);
  const input = screen.getByLabelText("Title") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Next title" } });
  expect(input.value).toBe("Next title");
});
