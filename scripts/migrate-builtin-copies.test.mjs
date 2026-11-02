import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  MigrationRefusal,
  PLUGIN_ID_PAIRS,
  lsofProcessIds,
  main,
  migrate,
  parseArgs,
} from "./migrate-builtin-copies.mjs";

const SCHEMA = `
CREATE TABLE \`plugin_kv\` (
  \`plugin_id\` text NOT NULL,
  \`key\` text NOT NULL,
  \`value\` text NOT NULL,
  \`updated_at\` integer NOT NULL,
  PRIMARY KEY(\`plugin_id\`, \`key\`)
);
CREATE TABLE \`plugin_settings\` (
  \`plugin_id\` text NOT NULL,
  \`key\` text NOT NULL,
  \`value\` text NOT NULL,
  \`updated_at\` integer NOT NULL,
  PRIMARY KEY(\`plugin_id\`, \`key\`)
);
CREATE TABLE \`ui_preferences\` (
  \`key\` text PRIMARY KEY NOT NULL,
  \`value_json\` text NOT NULL,
  \`revision\` integer NOT NULL,
  \`updated_at\` integer NOT NULL
);
`;

const scratchRoot = mkdtempSync(path.join(tmpdir(), "migrate-copies-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const none = async () => [];
const silent = () => {};

function makeDataDir(name, { rowActions, provider, extraKv = [], extraSettings = [] } = {}) {
  const dataDir = path.join(scratchRoot, name);
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "bb.db"));
  db.exec(SCHEMA);
  const kv = db.prepare("INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)");
  const settings = db.prepare("INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)");
  kv.run("thread-list", "preference:sortBy", '"recent"', 11);
  kv.run("thread-list", "preference:rowActions", rowActions ?? '["bb--core/archive","thread-list/move","other-plugin/thread-list/x"]', 12);
  kv.run("thread-list", "migration:ui-preferences:v1", "true", 13);
  kv.run("github", "sync-cursor", '"2026-01-01"', 14);
  kv.run("github", "link:thr_1", '{"pr":1}', 15);
  kv.run("unrelated", "keep", '"me"', 16);
  for (const row of extraKv) kv.run(...row);
  settings.run("github", "extraRepos", '["a/b"]', 21);
  settings.run("github", "defaultProject", '"proj_1"', 22);
  settings.run("unrelated", "x", "1", 23);
  for (const row of extraSettings) settings.run(...row);
  if (provider !== undefined) {
    db.prepare("INSERT INTO ui_preferences (key, value_json, revision, updated_at) VALUES (?, ?, 3, 30)").run(
      "sidebar.threadListProvider",
      provider,
    );
  }
  db.close();
  return dataDir;
}

function rows(dataDir, sql, ...params) {
  const db = new DatabaseSync(path.join(dataDir, "bb.db"));
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function snapshot(dataDir) {
  return {
    kv: rows(dataDir, "SELECT * FROM plugin_kv ORDER BY plugin_id, key"),
    settings: rows(dataDir, "SELECT * FROM plugin_settings ORDER BY plugin_id, key"),
    prefs: rows(dataDir, "SELECT * FROM ui_preferences ORDER BY key"),
  };
}

function backups(dataDir) {
  return readdirSync(dataDir).filter((name) => name.startsWith("bb.db.pre-fork-copies-"));
}

function mode(file) {
  return statSync(file).mode & 0o777;
}

test("refuses while a process has the database open, and writes nothing", async () => {
  const dataDir = makeDataDir("running");
  const before = snapshot(dataDir);
  await assert.rejects(
    migrate({ dataDir, checkRunning: async () => ["4242", "4243"], log: silent }),
    (error) => error instanceof MigrationRefusal && /4242, 4243/u.test(error.message),
  );
  assert.deepEqual(snapshot(dataDir), before);
  assert.deepEqual(backups(dataDir), []);
});

test("the running check receives the database and its WAL file", async () => {
  const dataDir = makeDataDir("running-args");
  let seen;
  await migrate({
    dataDir,
    checkRunning: async (files) => {
      seen = files;
      return [];
    },
    log: silent,
  });
  assert.deepEqual(seen, [path.join(dataDir, "bb.db"), path.join(dataDir, "bb.db-wal")]);
});

test("the default running check reports this process while it holds the database", async () => {
  const dataDir = makeDataDir("lsof");
  const dbPath = path.join(dataDir, "bb.db");
  assert.deepEqual(await lsofProcessIds([dbPath, `${dbPath}-wal`]), []);
  const held = new DatabaseSync(dbPath);
  try {
    held.exec("PRAGMA journal_mode=WAL");
    assert.ok((await lsofProcessIds([dbPath, `${dbPath}-wal`])).includes(String(process.pid)));
  } finally {
    held.close();
  }
});

test("refuses when bb.db is missing", async () => {
  const dataDir = path.join(scratchRoot, "missing");
  mkdirSync(dataDir);
  await assert.rejects(migrate({ dataDir, checkRunning: none, log: silent }), /does not exist/u);
});

test("proceeds when the running check reports none, and copies plugin_kv and plugin_settings", async () => {
  const dataDir = makeDataDir("copy");
  const before = snapshot(dataDir);
  await migrate({ dataDir, checkRunning: none, log: silent });
  const after = snapshot(dataDir);

  for (const { from, to } of PLUGIN_ID_PAIRS) {
    for (const table of ["kv", "settings"]) {
      const original = before[table].filter((row) => row.plugin_id === from);
      const copied = after[table].filter((row) => row.plugin_id === to);
      assert.deepEqual(
        copied.map(({ key, updated_at }) => ({ key, updated_at })),
        original.map(({ key, updated_at }) => ({ key, updated_at })),
      );
    }
  }
  const copiedKv = after.kv.filter((row) => row.plugin_id === "thread-list-fork");
  assert.ok(copiedKv.some((row) => row.key === "migration:ui-preferences:v1" && row.value === "true"));
  const github = after.settings.filter((row) => row.plugin_id === "github-fork");
  assert.deepEqual(
    github.map((row) => [row.key, row.value]),
    [
      ["defaultProject", '"proj_1"'],
      ["extraRepos", '["a/b"]'],
    ],
  );
  assert.equal(after.kv.filter((row) => row.plugin_id === "tasks-fork").length, 0);
  assert.deepEqual(
    after.kv.filter((row) => row.plugin_id === "unrelated"),
    before.kv.filter((row) => row.plugin_id === "unrelated"),
  );
});

test("leaves the old rows unchanged and rewrites thread-list/<action> keys in the copied rows only", async () => {
  const dataDir = makeDataDir("rewrite");
  const before = snapshot(dataDir);
  await migrate({ dataDir, checkRunning: none, log: silent });
  const after = snapshot(dataDir);

  assert.deepEqual(
    after.kv.filter((row) => row.plugin_id === "thread-list"),
    before.kv.filter((row) => row.plugin_id === "thread-list"),
  );
  assert.deepEqual(
    after.kv.filter((row) => row.plugin_id === "github"),
    before.kv.filter((row) => row.plugin_id === "github"),
  );
  const rowActions = after.kv.find(
    (row) => row.plugin_id === "thread-list-fork" && row.key === "preference:rowActions",
  );
  assert.deepEqual(JSON.parse(rowActions.value), [
    "bb--core/archive",
    "thread-list-fork/move",
    "other-plugin/thread-list/x",
  ]);
  const sortBy = after.kv.find((row) => row.plugin_id === "thread-list-fork" && row.key === "preference:sortBy");
  assert.equal(sortBy.value, '"recent"');
});

test("rewrites sidebar.threadListProvider only when it is exactly the old thread list", async () => {
  const cases = [
    ['"thread-list/thread-list"', '"thread-list-fork/thread-list"', 4],
    ['"__automatic__"', '"__automatic__"', 3],
    ['"other/thread-list"', '"other/thread-list"', 3],
    ['"thread-list/thread-list-x"', '"thread-list/thread-list-x"', 3],
  ];
  for (const [index, [stored, expected, revision]] of cases.entries()) {
    const dataDir = makeDataDir(`provider-${index}`, { provider: stored });
    await migrate({ dataDir, checkRunning: none, log: silent });
    const [row] = rows(dataDir, "SELECT * FROM ui_preferences WHERE key = 'sidebar.threadListProvider'");
    assert.equal(row.value_json, expected);
    assert.equal(row.revision, revision);
  }
  const absent = makeDataDir("provider-absent");
  await migrate({ dataDir: absent, checkRunning: none, log: silent });
  assert.deepEqual(rows(absent, "SELECT * FROM ui_preferences"), []);
});

test("refuses a rowActions value that is not a JSON array of strings, and writes nothing", async () => {
  for (const [index, rowActions] of ["not json", '{"a":1}', '["ok", 1]'].entries()) {
    const dataDir = makeDataDir(`bad-row-actions-${index}`, { rowActions });
    const before = snapshot(dataDir);
    await assert.rejects(migrate({ dataDir, checkRunning: none, log: silent }), MigrationRefusal);
    assert.deepEqual(snapshot(dataDir), before);
    assert.deepEqual(backups(dataDir), []);
  }
});

test("refuses when rows for a new id already exist, and writes nothing", async () => {
  for (const [index, extra] of [
    { extraKv: [["tasks-fork", "k", "1", 1]] },
    { extraSettings: [["github-fork", "extraRepos", "[]", 1]] },
  ].entries()) {
    const dataDir = makeDataDir(`existing-${index}`, extra);
    const before = snapshot(dataDir);
    await assert.rejects(
      migrate({ dataDir, checkRunning: none, log: silent }),
      (error) => error instanceof MigrationRefusal && /already has rows/u.test(error.message),
    );
    assert.deepEqual(snapshot(dataDir), before);
    assert.deepEqual(backups(dataDir), []);
  }
});

test("refuses when the new plugin database already exists", async () => {
  const dataDir = makeDataDir("existing-db");
  const sourceDir = path.join(dataDir, "plugins", "github");
  mkdirSync(sourceDir, { recursive: true });
  const source = new DatabaseSync(path.join(sourceDir, "data.db"));
  source.exec("CREATE TABLE t (x)");
  source.close();
  mkdirSync(path.join(dataDir, "plugins", "github-fork"), { recursive: true });
  const existing = new DatabaseSync(path.join(dataDir, "plugins", "github-fork", "data.db"));
  existing.exec("CREATE TABLE t (x)");
  existing.close();
  await assert.rejects(migrate({ dataDir, checkRunning: none, log: silent }), /already exists/u);
  assert.deepEqual(backups(dataDir), []);
});

test("copies a plugin database that has un-checkpointed WAL content, and sets mode 600 on the copy and the backup", async () => {
  const dataDir = makeDataDir("wal");
  const sourceDir = path.join(dataDir, "plugins", "github");
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "data.db");
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    writer.exec("INSERT INTO notes (body) VALUES ('alpha'), ('beta'), ('gamma')");
    assert.ok(statSync(`${sourcePath}-wal`).size > 0);

    const logged = [];
    await migrate({ dataDir, checkRunning: none, log: (line) => logged.push(line) });

    const copyPath = path.join(dataDir, "plugins", "github-fork", "data.db");
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    try {
      assert.deepEqual(
        copy.prepare("SELECT body FROM notes ORDER BY id").all().map((row) => row.body),
        ["alpha", "beta", "gamma"],
      );
    } finally {
      copy.close();
    }
    assert.equal(mode(copyPath), 0o600);
    const [backup] = backups(dataDir);
    assert.equal(mode(path.join(dataDir, backup)), 0o600);
    assert.ok(logged.some((line) => line.includes(backup)));
    assert.ok(logged.some((line) => line.includes("no plugin database for tasks")));
    assert.ok(logged.some((line) => /github\/data\.db notes\tgithub\t3\tgithub-fork\t3/u.test(line)));
    assert.ok(existsSync(sourcePath));
  } finally {
    writer.close();
  }
});

test("backup holds the pre-migration state", async () => {
  const dataDir = makeDataDir("backup-content");
  const before = snapshot(dataDir);
  await migrate({ dataDir, checkRunning: none, log: silent });
  const [backup] = backups(dataDir);
  const db = new DatabaseSync(path.join(dataDir, backup), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT * FROM plugin_kv ORDER BY plugin_id, key").all(), before.kv);
  } finally {
    db.close();
  }
});

test("a data directory path with spaces and quotes works", async () => {
  const dataDir = path.join(scratchRoot, `odd dir 'q' "d" \\b`);
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "bb.db"));
  db.exec(SCHEMA);
  db.exec("INSERT INTO plugin_kv VALUES ('thread-list','preference:rowActions','[\"thread-list/move\"]',1)");
  db.close();
  const sourceDir = path.join(dataDir, "plugins", "github");
  mkdirSync(sourceDir, { recursive: true });
  const source = new DatabaseSync(path.join(sourceDir, "data.db"));
  source.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
  source.close();

  await migrate({ dataDir, checkRunning: none, log: silent });

  assert.equal(backups(dataDir).length, 1);
  assert.equal(
    rows(dataDir, "SELECT value FROM plugin_kv WHERE plugin_id = 'thread-list-fork'")[0].value,
    '["thread-list-fork/move"]',
  );
  assert.ok(existsSync(path.join(dataDir, "plugins", "github-fork", "data.db")));
});

test("the cleanup commands quote paths that contain a single quote", async () => {
  const dataDir = path.join(scratchRoot, "it's here");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "bb.db"));
  db.exec(SCHEMA);
  db.close();
  const logged = [];
  await migrate({ dataDir, checkRunning: none, log: (line) => logged.push(line) });
  assert.ok(logged.some((line) => line.includes(`'${dataDir.replaceAll("'", "'\\''")}/bb.db'`)));
});

test("main exits 1 on a refusal and 0 on success, and parseArgs accepts only --data-dir", async () => {
  const refused = makeDataDir("main-refused");
  assert.equal(await main(["--data-dir", refused], { checkRunning: async () => ["1"], log: silent }), 1);
  const ok = makeDataDir("main-ok");
  assert.equal(await main(["--data-dir", ok], { checkRunning: none, log: silent }), 0);
  assert.equal(parseArgs(["--data-dir", ok]).dataDir, ok);
  assert.throws(() => parseArgs(["--other"]), MigrationRefusal);
  assert.throws(() => parseArgs(["--data-dir"]), MigrationRefusal);
});

test("the script exits 1 from the command line when bb.db is missing", () => {
  const script = fileURLToPath(new URL("migrate-builtin-copies.mjs", import.meta.url));
  const empty = path.join(scratchRoot, "cli-empty");
  mkdirSync(empty);
  assert.throws(
    () => execFileSync(process.execPath, [script, "--data-dir", empty], { stdio: "pipe" }),
    (error) => error.status === 1 && /does not exist/u.test(String(error.stderr)),
  );
});
