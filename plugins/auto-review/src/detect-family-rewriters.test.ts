import { describe, expect, it } from "vitest";
import { siblingWrittenPaths } from "./detect-sibling-writes.js";

const ROOT = "/w";

/** Whether the family text names `path`, which a sibling wrote by name: the sibling's credit is withheld. */
function names(family: string, path = "lib/a.ts"): boolean {
  const sibling = [{ threadId: "sib-1", text: `echo x > "${path}"`, cwd: ROOT }];
  return siblingWrittenPaths([path], sibling, [family], ROOT).size === 0;
}

describe("a family command that names every path", () => {
  it.each([
    "git ls-files | xargs sed -i s/a/b/",
    "xargs rm",
    "find . -name '*.orig' -exec rm {} +",
    "find . -execdir fmt {} +",
    "find . -ok rm {} +",
    "find . -name '*.orig' -delete",
    "fd -e ts -x fmt",
    "fd -e ts -X fmt",
    "fdfind -e ts --exec fmt",
    "parallel fmt ::: a b",
  ])("(indirect writer) `%s`", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each(["find . -name '*.orig'", "find src -type f", "fd -e ts", "fd src"])(
    "(indirect writer) not the reader `%s`",
    (command) => {
      expect(names(command)).toBe(false);
    },
  );

  it.each([
    "sed -i s/a/b/ $(git ls-files '*.ts')",
    "echo x > $p/a.ts",
    "sed -i s/a/b/ $F",
    "sed -i s/a/b/ `git ls-files`",
    "tee $OUT",
    "rm -f $F",
  ])("(hidden write target) `%s`", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each(["echo x > out.txt", "sed -i s/a/b/ other.ts", "echo $HOME > out.txt", "git ls-files | head"])(
    "(hidden write target) not `%s`, whose target is plain",
    (command) => {
      expect(names(command)).toBe(false);
    },
  );

  it.each([
    "patch -p1 < x.diff",
    "rsync -a x/ y/",
    "tar xf a.tar",
    "tar -xzf a.tgz",
    "tar --extract -f a.tar",
    "tar -C x --extract -f a.tar",
    "unzip a.zip",
    "git clean -fd",
    "git am x.patch",
    "go generate ./...",
  ])("(archive or sync tool) `%s`", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each(["tar cf a.tar src", "tar -tf a.tar", "tar czf a.tgz --exclude=x src", "go build ./...", "go test ./..."])(
    "(archive or sync tool) not `%s`",
    (command) => {
      expect(names(command)).toBe(false);
    },
  );

  it.each([
    "jscodeshift -t t.js src",
    "npx tsx scripts/x.ts",
    "npx ts-node x.ts",
    "deno run -A x.ts",
    "deno run --allow-read x.ts",
    "bun x.ts",
    "tsx scripts/x.ts",
    "uv run x.py",
    "php x.php",
  ])("(codemod) `%s`", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each(["npx tsx", "deno fmt --check", "deno test", "bun test lib/a.test.ts", "uv run pytest"])(
    "(codemod) not `%s`",
    (command) => {
      expect(names(command)).toBe(false);
    },
  );

  it.each([
    "timeout 300 npm install",
    "timeout -s KILL 300 npm install",
    "env CI=1 npm run format",
    "env -i FOO=1 npm install",
    "nohup git checkout main",
    "nice -n 5 npm install",
    "nice npm install",
    "exec npm install",
    "command npm install",
    "sudo -u deploy npm install",
    "time npm install",
    "stdbuf -oL npm install",
    "stdbuf -o L npm install",
    "npx eslint --fix",
    "npx -y prettier --write",
    "bunx prettier --write",
    "pnpm exec eslint --fix",
    "pnpm --filter x exec eslint --fix",
    "pnpm dlx prettier --write",
    "yarn dlx prettier --write",
    "uv run ruff format",
    "uv run --with x ruff format",
    "poetry run black",
    "pipenv run black .",
    "bundle exec rubocop --fix",
    "env FOO=1 timeout 5 nohup npm run format",
  ])("(wrapper) `%s` is judged as its inner command", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each([
    "timeout 300 npm test",
    "env CI=1 npm run build",
    "nohup git status",
    "nice -n 5 npm run lint",
    "npx eslint lib/b.ts",
    "pnpm exec jest lib/react",
    "yarn dlx x",
    "uv run pytest",
    "sudo -u deploy ls",
    "env",
  ])("(wrapper) `%s` names nothing unrelated", (command) => {
    expect(names(command)).toBe(false);
  });

  it.each([
    "bash -lc 'git stash pop'",
    'sh -c "npm install"',
    "zsh -c 'prettier --write'",
    "env X=1 bash -c 'git checkout main'",
    `bash -c "bash -c 'git stash pop'"`,
    "bash -c 'cd x && npm install'",
  ])("(shell string) `%s` is read as commands", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each(["bash -lc 'git status'", "bash -c 'ls lib'", 'sh -c "npm test"'])("(shell string) `%s` names nothing unrelated", (command) => {
    expect(names(command)).toBe(false);
  });

  it("(heredoc) a `<<` inside quotes does not hide the commands after it", () => {
    expect(names('grep -n "<<EOF" x.sh\nnpm install')).toBe(true);
    expect(names("grep -n '<<EOF' x.sh\ngit stash pop")).toBe(true);
    expect(names('grep -n "<<EOF" x.sh\ngit status')).toBe(false);
    expect(names('echo "a << b" && npm install')).toBe(true);
  });

  it("(heredoc) one with no terminator line names every path; a closed one does not", () => {
    expect(names("cat > notes.md <<EOF\nbody")).toBe(true);
    expect(names("cat <<EOF")).toBe(true);
    expect(names("cat > notes.md <<EOF\nbody\nEOF")).toBe(false);
    expect(names("cat > notes.md <<\\EOF\nbody\nEOF")).toBe(false);
  });

  it("(comment) a path in a comment is still named", () => {
    expect(names("git status # compare with lib/a.ts")).toBe(true);
    expect(names("git status # compare with lib/b.ts")).toBe(false);
  });
});

describe("a family command that names a directory by a pattern", () => {
  it.each([
    ["sed -i s/a/b/ src/*", "src/a.ts"],
    ["sed -i s/a/b/ src/**", "src/deep/a.ts"],
    ["prettier --write src/{a,b}.ts", "src/c.ts"],
    ["sed -i s/a/b/ src/foo{a,b}.ts", "src/c.ts"],
    ["cp tpl /w/src/*", "src/a.ts"],
  ])("`%s` names %s", (command, path) => {
    expect(names(command, path)).toBe(true);
  });

  it.each([
    ["ls src/*", "src/a.ts"],
    ["sed -i s/a/b/ other/*", "src/a.ts"],
    ["prettier --write other/{a,b}.ts", "src/a.ts"],
    ["sed -i s/a/b/ *", "src/a.ts"],
    ["sed -i s/a/b/ {a,b}.ts", "src/c.ts"],
  ])("`%s` does not name %s", (command, path) => {
    expect(names(command, path)).toBe(false);
  });
});

describe("fixer flags", () => {
  it.each(["jest --update", "jest --updateSnapshot", "vitest --update"])("`%s` with no path names every path", (command) => {
    expect(names(command)).toBe(true);
  });

  it("with a path names that directory only", () => {
    expect(names("jest --updateSnapshot lib/react", "lib/react/a.ts")).toBe(true);
    expect(names("jest --updateSnapshot other/react", "lib/react/a.ts")).toBe(false);
  });
});

describe("a quoted word with a blank", () => {
  it("names the whole path", () => {
    expect(names('cat "dir/my file.ts"', "dir/my file.ts")).toBe(true);
    expect(names("cat 'dir/my file.ts'", "dir/my file.ts")).toBe(true);
    expect(names('cat "dir/other file.ts"', "dir/my file.ts")).toBe(false);
  });
});
