import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import {
  ALLOW,
  HARD,
  SOFT,
  cleanup,
  makeGitRepo,
  makeProjectDir,
  runHook,
} from "./run-hook.mjs";

const project = makeGitRepo({
  ignored: ["/.env", "/secret space.env", "/ignored-file"],
  tracked: ["config/settings.yml"],
});
mkdirSync(path.join(project, "subdir"));
afterAll(() => cleanup(project));
const run = (command: string, options: Record<string, unknown> = {}) =>
  runHook("guard-bash.sh", { command }, { projectDir: project, ...options });

const original = `fixture_dir=$(mktemp -d "${"${TMPDIR:-/tmp}"}/vbb-launchd-sandbox.XXXXXX")
fixture_label="app.vbb.sandbox-probe.$$.${"${RANDOM}"}"
fixture_plist="$fixture_dir/job.plist"
printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict>' "<key>Label</key><string>$fixture_label</string>" '<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>' '<key>RunAtLoad</key><false/>' '</dict></plist>' > "$fixture_plist"
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny mach*)(deny network*)' /bin/launchctl bootstrap "gui/$(id -u)" "$fixture_plist" > "$fixture_dir/output" 2>&1
fixture_status=$?
printf 'bootstrap status=%s\\n' "$fixture_status"
cat "$fixture_dir/output"
if [ "$fixture_status" -eq 0 ]; then /bin/launchctl bootout "gui/$(id -u)/$fixture_label"; printf 'fixture cleanup status=%s\\n' "$?"; fi
rm -rf "$fixture_dir"`;

describe("environment assignment writes", () => {
  it.each([
    ["printf '%s' NAME=secret; printf '%s' plain > ignored-file", ALLOW],
    ["printf '%s' plain > ignored-file; printf '%s' NAME=secret", ALLOW],
    ["printf '%s' NAME=secret; echo plain > config/settings.yml", ALLOW],
    ["echo plain > config/settings.yml; printf '%s' NAME=secret", ALLOW],
    ["printf '%s' prose; echo NAME=secret >> config/settings.yml", HARD],
    ["echo NAME=secret >> config/settings.yml; printf '%s' prose", HARD],
    ["printf '%s' \"$value\"; echo NAME=secret >> .env", ALLOW],
    ["printf '%s' \"$value\"; echo plain > .env", SOFT],
    ["echo plain > .env; printf '%s' \"$value\"", SOFT],
    ["cd subdir; echo NAME=secret >> .env", HARD],
    ["cd subdir\necho NAME=secret >> .env", HARD],
    ["echo NAME=secret >> .env; cd subdir", ALLOW],
  ])("keeps clause state separate: %s", async (command, expected) => {
    expect((await run(command)).verdict).toBe(expected);
  });

  it("allows the original plist command as inert input", async () => {
    expect(
      (await run(original, { permissionMode: "bypassPermissions" })).verdict,
    ).toBe(ALLOW);
  });

  it.each([
    "printf '%s%s\\n' \"$prefix\" 'SECRET=fixture-only' >> config/settings.yml",
    "echo < /dev/null 'SECRET=fixture-only' >> config/settings.yml",
    "echo $(printf '') 'SECRET=fixture-only' >> config/settings.yml",
    "echo \"$prefix\" 'SECRET=fixture-only' >> config/settings.yml",
    "printf 'Use %s NAME=fixture-only\\n' \"$prefix\" >> config/settings.yml",
    "echo 'Use' \"$prefix\" 'NAME=fixture-only' >> config/settings.yml",
    'echo "$name=value" >> config/settings.yml',
    'echo "${value:-NAME=fixture-only}" >> config/settings.yml',
    `echo "$(printf 'NAME=fixture-only')" >> config/settings.yml`,
    'printf "Example: %s\\n" "${value:-NAME=fixture-only}" >> config/settings.yml',
    "printf 'Use %s=value\\n' \"$name\" >> config/settings.yml",
    "echo * 'SECRET=fixture-only' >> config/settings.yml",
  ])(
    "blocks a possible assignment with an unknown prefix: %s",
    async (command) => {
      for (const permissionMode of ["default", "bypassPermissions"]) {
        expect((await run(command, { permissionMode })).verdict).toBe(HARD);
      }
    },
  );

  it.each([
    'echo "<item value=\\"$var\\"/>" >> config/settings.yml',
    'echo "Example: NAME=$var" >> config/settings.yml',
    'echo "${value:-NAME=fixture-only}" >> .env',
    'echo prose >> "${value:-NAME=fixture-only}"',
    'printf "Example\\n" "${value:-NAME=fixture-only}" >> config/settings.yml',
  ])("allows assembled prose or XML with an expansion: %s", async (command) => {
    for (const permissionMode of ["default", "bypassPermissions"]) {
      expect((await run(command, { permissionMode })).verdict).toBe(ALLOW);
    }
  });

  it.each([
    "cd subdir; echo 'SECRET=fixture-only' >> .env",
    "cd subdir\necho 'SECRET=fixture-only' >> .env",
    "pushd subdir; echo 'SECRET=fixture-only' >> .env",
    "(cd subdir; echo 'SECRET=fixture-only' >> .env)",
  ])(
    "cannot verify the relative destination after directory changes: %s",
    async (command) => {
      for (const permissionMode of ["default", "bypassPermissions"]) {
        const result = await run(command, { permissionMode });
        expect(result.verdict).toBe(HARD);
        expect(result.reason).toBe(
          "HARD BLOCK: Cannot verify the destination of an environment-assignment write.",
        );
      }
    },
  );

  it.each([
    ["echo NAME=fixture-only 01>> config/settings.yml", HARD],
    ["echo NAME=fixture-only 01>> .env", ALLOW],
    ["echo NAME=fixture-only 02> config/settings.yml", ALLOW],
  ])("classifies numeric descriptors: %s", async (command, expected) => {
    for (const permissionMode of ["default", "bypassPermissions"]) {
      expect((await run(command, { permissionMode })).verdict).toBe(expected);
    }
  });

  it("retains the hard block on shell indirection before a write", async () => {
    for (const permissionMode of ["default", "bypassPermissions"]) {
      const result = await run(
        "eval 'cd subdir'; echo 'SECRET=fixture-only' >> .env",
        { permissionMode },
      );
      expect(result.verdict).toBe(HARD);
      expect(result.reason).toMatch(/^HARD BLOCK: shell indirection/);
    }
  });

  it.each([
    ["echo 'SECRET=fixture-only' >> \".env\"", ALLOW],
    ["echo 'SECRET=fixture-only' >> 'secret space.env'", ALLOW],
    ["echo 'SECRET=fixture-only' >> config/settings.yml", HARD],
    [
      "printf '%s\\n' harmless 'SECRET=fixture-only' >> config/settings.yml",
      HARD,
    ],
    ["printf -- '%s\\n' 'SECRET=fixture-only' >> config/settings.yml", HARD],
    [
      "printf -- 'Example: %s\\n' 'SECRET=fixture-only' >> config/settings.yml",
      ALLOW,
    ],
    ["printf '%s\\n' $'SECRET=fixture-only' >> config/settings.yml", HARD],
    ["printf '%s\\n' $'\\'SECRET=fixture-only' >> config/settings.yml", HARD],
    [
      "printf 'Example: %s\\n' $'SECRET=fixture-only' >> config/settings.yml",
      ALLOW,
    ],
    [
      "printf 'Example: %s\\n' 'SECRET=fixture-only' >> config/settings.yml",
      ALLOW,
    ],
    [
      "printf '<item value=\"%s\"/>\\n' 'SECRET=fixture-only' >> config/settings.yml",
      ALLOW,
    ],
    [
      "printf 'prefix\\n%s\\n' 'SECRET=fixture-only' >> config/settings.yml",
      HARD,
    ],
    ["printf '%% %s\\n' 'SECRET=fixture-only' >> config/settings.yml", ALLOW],
    ["printf '<item a=\"b&c;d\"/>\\n' >> config/settings.yml", ALLOW],
    ["echo 'Use' 'SECRET=fixture-only' >> config/settings.yml", ALLOW],
    ["echo -n 'SECRET=fixture-only' >> config/settings.yml", HARD],
    ["echo -e 'header\\nSECRET=fixture-only' >> config/settings.yml", HARD],
    ["echo $'SECRET=fixture-only' >> config/settings.yml", HARD],
    ["echo $'\\'SECRET=fixture-only' >> config/settings.yml", HARD],
    ["if cd subdir; then echo 'SECRET=fixture-only' >> .env; fi", HARD],
    ["eval 'cd subdir'; echo 'SECRET=fixture-only' >> .env", HARD],
    ["echo 'SECRET=fixture-only' > /dev/null", ALLOW],
    ["echo 'SECRET=fixture-only' > '/dev/null'", ALLOW],
    ["echo 'SECRET=fixture-only' 2>/dev/null", ALLOW],
    ["echo 'SECRET=fixture-only' >&1", ALLOW],
    ["echo 'SECRET=fixture-only' >& config/settings.yml", HARD],
    ["echo 'SECRET=fixture-only' &> config/settings.yml", HARD],
    ["echo <<<ignored 'SECRET=fixture-only' >> config/settings.yml", HARD],
    [
      "echo 'Use' \\" + "\n" + " 'SECRET=fixture-only' >> config/settings.yml",
      ALLOW,
    ],
    [
      'echo "Use\\' + "\n" + ' SECRET=fixture-only" >> config/settings.yml',
      ALLOW,
    ],
    ["echo 'SECRET=fixture-only' > .env", SOFT],
    ["cd subdir && echo 'SECRET=fixture-only' >> \".env\"", HARD],
    ["(cd 'subdir'; echo 'SECRET=fixture-only' >> .env)", HARD],
    [
      "echo 'SECRET=fixture-only' >> .env; echo 'SECRET=fixture-only' >> config/settings.yml",
      HARD,
    ],
    ["echo 'SECRET=fixture-only' >> .env; echo prose > .env", SOFT],
    [
      "echo 'SECRET=fixture-only' >> .env; echo 'SECRET=fixture-only' >> \"$dest\"",
      HARD,
    ],
    ["echo 'SECRET=fixture-only' >> \"$dest\"", HARD],
    ["echo 'SECRET=fixture-only' >> config/*.yml", HARD],
    ["echo 'SECRET=fixture-only' >> \"unterminated", HARD],
  ])("checks %s", async (command, expected) => {
    expect((await run(command)).verdict).toBe(expected);
  });

  it("does not exempt a relative destination from a subdirectory", async () => {
    expect(
      (
        await run("echo 'SECRET=fixture-only' >> .env", {
          cwd: path.join(project, "subdir"),
        })
      ).verdict,
    ).toBe(HARD);
  });

  it("verifies an absolute ignored path after a directory change", async () => {
    expect(
      (
        await run(
          `cd subdir && echo 'SECRET=fixture-only' >> '${project}/.env'`,
        )
      ).verdict,
    ).toBe(ALLOW);
  });

  it("does not execute substitutions in destination text", async () => {
    const marker = path.join(project, "executed");
    const result = await run(
      `echo 'SECRET=fixture-only' >> "$(touch '${marker}')"`,
      { permissionMode: "bypassPermissions" },
    );
    expect(result.verdict).toBe(HARD);
    expect(result.reason).toBe(
      "HARD BLOCK: Cannot verify the destination of an environment-assignment write.",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed outside a git repository", async () => {
    const dir = makeProjectDir();
    try {
      const result = await runHook(
        "guard-bash.sh",
        { command: "echo 'SECRET=fixture-only' >> .env" },
        { projectDir: dir },
      );
      expect(result.verdict).toBe(HARD);
      expect(result.reason).toBe(
        "HARD BLOCK: Cannot verify the destination of an environment-assignment write.",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("fails closed when git is unavailable", async () => {
    const dir = makeProjectDir();
    try {
      for (const name of [
        "bash",
        "jq",
        "date",
        "mkdir",
        "tr",
        "sed",
        "grep",
        "cat",
        "awk",
      ]) {
        const executable = (process.env.PATH ?? "")
          .split(path.delimiter)
          .map((part) => path.join(part, name))
          .find((candidate) => existsSync(candidate));
        if (executable) symlinkSync(executable, path.join(dir, name));
      }
      const result = await run("echo 'SECRET=fixture-only' >> .env", {
        env: { PATH: dir },
      });
      expect(result.verdict).toBe(HARD);
      expect(result.reason).toBe(
        "HARD BLOCK: Cannot verify the destination of an environment-assignment write.",
      );
    } finally {
      cleanup(dir);
    }
  });
});
