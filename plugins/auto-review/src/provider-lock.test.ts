import { describe, expect, it } from "vitest";
import { withProviderLock } from "./provider-lock.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("withProviderLock", () => {
  it("returns the run's value and chains later runs after it", async () => {
    const order: string[] = [];
    const first = withProviderLock("p", async () => {
      await flush();
      order.push("first");
      return "one";
    });
    const second = withProviderLock("p", async () => {
      order.push("second");
      return "two";
    });
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    expect(order).toEqual(["first", "second"]);
  });

  it("lets a rejected run reject its own caller without poisoning the next", async () => {
    const failure = withProviderLock("p", async () => {
      throw new Error("boom");
    });
    await expect(failure).rejects.toThrow("boom");
    await expect(withProviderLock("p", async () => "after")).resolves.toBe("after");
  });

  it("keeps later runs ordered when an earlier one fails", async () => {
    let fail!: (error: unknown) => void;
    const breaker = withProviderLock("p", () => new Promise<never>((_resolve, reject) => {
      fail = reject;
    }));
    await flush();
    const second = withProviderLock("p", async () => "second");
    fail("kaboom");
    await expect(breaker).rejects.toBe("kaboom");
    await expect(second).resolves.toBe("second");
    await flush();
    await expect(withProviderLock("p", async () => "third")).resolves.toBe("third");
  });

  it("does not drop a newer lock entry while an older run settles", async () => {
    let release!: (value: string) => void;
    const first = withProviderLock(
      "p",
      () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    await flush();
    const second = withProviderLock("p", async () => "two");
    release("one");
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    await flush();
    await expect(withProviderLock("p", async () => "third")).resolves.toBe("third");
  });
});
