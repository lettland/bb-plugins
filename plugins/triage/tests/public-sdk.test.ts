import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("plugin imports use public SDK and declared dependencies", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allow = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .map((name) => new RegExp(`^${escape(name)}(?:/.*)?$`));
  // These aliases resolve inside the plugin through tsconfig paths.
  allow.push(/^@\/(?:components|lib|hooks)\//);
  const result = experimental_scanPublicSdkOnly(root, { allow });
  expect(result.privateDependencies).toStrictEqual([]);
  expect(result.violations).toStrictEqual([]);
});
