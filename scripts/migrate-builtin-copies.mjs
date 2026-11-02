#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID_PAIRS = [
  { from: "tasks", to: "tasks-fork" },
  { from: "thread-list", to: "thread-list-fork" },
  { from: "github", to: "github-fork" },
];

export const COPIED_CORE_TABLES = ["plugin_kv", "plugin_settings"];

const ROW_ACTIONS_KEY = "preference:rowActions";
const ROW_ACTION_REWRITES = new Map([
  ["thread-list/move", "thread-list-fork/move"],
]);
const PROVIDER_PREFERENCE_KEY = "sidebar.threadListProvider";
const PROVIDER_PREFERENCE_REWRITES = new Map([
  ["thread-list/thread-list", "thread-list-fork/thread-list"],
]);
const USAGE = "usage: migrate-builtin-copies [--data-dir <dir>]";

export class MigrationRefusal extends Error {}

function runFile(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 1 << 28 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlText(value) {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function dotArgument(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")}"`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function sqliteQuery(dbPath, sql) {
  const stdout = await runFile("sqlite3", ["-json", dbPath, sql]);
  return stdout.trim() === "" ? [] : JSON.parse(stdout);
}

async function sqliteBackup(sourcePath, destinationPath) {
  await writeFile(destinationPath, "", { flag: "wx", mode: 0o600 });
  await runFile("sqlite3", [sourcePath, `.backup ${dotArgument(destinationPath)}`]);
  await chmod(destinationPath, 0o600);
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function lsofProcessIds(files) {
  let stdout;
  try {
    stdout = await runFile("lsof", ["-t", "--", ...files]);
  } catch (error) {
    if (error.code !== 1) throw error;
    stdout = error.stdout;
  }
  return [...new Set(stdout.split("\n").filter((line) => /^\d+$/u.test(line)))];
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function inList(values) {
  return values.map(sqlString).join(", ");
}

async function countRows(dbPath, ids) {
  const counts = new Map();
  for (const table of COPIED_CORE_TABLES) {
    const rows = await sqliteQuery(
      dbPath,
      `SELECT plugin_id AS id, count(*) AS n FROM ${table} WHERE plugin_id IN (${inList(ids)}) GROUP BY plugin_id`,
    );
    for (const id of ids) {
      counts.set(`${table}\u0000${id}`, rows.find((row) => row.id === id)?.n ?? 0);
    }
  }
  return counts;
}

function parseJsonValue(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MigrationRefusal(
      `${description} is not valid JSON (${error.message}); fix or remove it, then run again`,
    );
  }
}

async function planRowActionsRewrite(dbPath) {
  const rows = await sqliteQuery(
    dbPath,
    `SELECT value FROM plugin_kv WHERE plugin_id = 'thread-list' AND key = ${sqlString(ROW_ACTIONS_KEY)}`,
  );
  if (rows.length === 0) return null;
  const description = `plugin_kv thread-list ${ROW_ACTIONS_KEY}`;
  const parsed = parseJsonValue(rows[0].value, description);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new MigrationRefusal(`${description} is not a JSON array of strings`);
  }
  const rewritten = parsed.map((entry) => ROW_ACTION_REWRITES.get(entry) ?? entry);
  const changed = rewritten.some((entry, index) => entry !== parsed[index]);
  return changed ? JSON.stringify(rewritten) : null;
}

async function planProviderPreferenceRewrite(dbPath) {
  const rows = await sqliteQuery(
    dbPath,
    `SELECT value_json FROM ui_preferences WHERE key = ${sqlString(PROVIDER_PREFERENCE_KEY)}`,
  );
  if (rows.length === 0) return null;
  const parsed = parseJsonValue(rows[0].value_json, `ui_preferences ${PROVIDER_PREFERENCE_KEY}`);
  const replacement =
    typeof parsed === "string" ? PROVIDER_PREFERENCE_REWRITES.get(parsed) : undefined;
  if (replacement === undefined) return null;
  return { oldValueJson: rows[0].value_json, newValueJson: JSON.stringify(replacement) };
}

function buildTransactionSql({ rowActions, providerPreference, nowMs }) {
  const statements = ["BEGIN IMMEDIATE;"];
  for (const table of COPIED_CORE_TABLES) {
    for (const { from, to } of PLUGIN_ID_PAIRS) {
      statements.push(
        `INSERT INTO ${table} (plugin_id, key, value, updated_at) SELECT ${sqlString(to)}, key, value, updated_at FROM ${table} WHERE plugin_id = ${sqlString(from)};`,
      );
    }
  }
  if (rowActions !== null) {
    statements.push(
      `UPDATE plugin_kv SET value = ${sqlText(rowActions)} WHERE plugin_id = 'thread-list-fork' AND key = ${sqlString(ROW_ACTIONS_KEY)};`,
    );
  }
  if (providerPreference !== null) {
    statements.push(
      `UPDATE ui_preferences SET value_json = ${sqlText(providerPreference.newValueJson)}, revision = revision + 1, updated_at = ${nowMs} WHERE key = ${sqlString(PROVIDER_PREFERENCE_KEY)} AND value_json = ${sqlText(providerPreference.oldValueJson)};`,
    );
  }
  statements.push("COMMIT;");
  return statements.join("\n");
}

async function userTableCounts(dbPath) {
  const tables = await sqliteQuery(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const counts = new Map();
  for (const { name } of tables) {
    const [row] = await sqliteQuery(dbPath, `SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`);
    counts.set(name, row.n);
  }
  return counts;
}

export async function migrate({
  dataDir,
  checkRunning = lsofProcessIds,
  now = () => new Date(),
  log = console.log,
}) {
  const bbDb = path.join(dataDir, "bb.db");
  if (!(await pathExists(bbDb))) {
    throw new MigrationRefusal(`${bbDb} does not exist`);
  }
  const runningIds = await checkRunning([bbDb, `${bbDb}-wal`]);
  if (runningIds.length > 0) {
    throw new MigrationRefusal(
      `bb is running: process ids ${runningIds.join(", ")} have ${bbDb} open. Stop bb, then run again`,
    );
  }

  const newIds = PLUGIN_ID_PAIRS.map((pair) => pair.to);
  for (const table of COPIED_CORE_TABLES) {
    const existing = await sqliteQuery(
      bbDb,
      `SELECT plugin_id, count(*) AS n FROM ${table} WHERE plugin_id IN (${inList(newIds)}) GROUP BY plugin_id`,
    );
    if (existing.length > 0) {
      throw new MigrationRefusal(
        `${table} already has rows for ${existing.map((row) => `${row.plugin_id} (${row.n})`).join(", ")}; the script only migrates into empty ids`,
      );
    }
  }

  const pluginDatabases = [];
  for (const { from, to } of PLUGIN_ID_PAIRS) {
    const source = path.join(dataDir, "plugins", from, "data.db");
    const destination = path.join(dataDir, "plugins", to, "data.db");
    if (!(await pathExists(source))) {
      log(`skip ${source}: no plugin database for ${from}`);
      continue;
    }
    if (await pathExists(destination)) {
      throw new MigrationRefusal(`${destination} already exists`);
    }
    if (from === "tasks") {
      const [column] = await sqliteQuery(
        source,
        "SELECT count(*) AS n FROM pragma_table_info('tasks') WHERE name = 'archived_at'",
      );
      if (column.n === 0) {
        throw new MigrationRefusal(
          `${source} was created by upstream's built-in tasks plugin: its tasks table has no archived_at column, and its migration numbering differs from tasks-fork. Nothing was copied`,
        );
      }
    }
    pluginDatabases.push({ from, to, source, destination });
  }

  const rowActions = await planRowActionsRewrite(bbDb);
  const providerPreference = await planProviderPreferenceRewrite(bbDb);

  const startedAt = now();
  const backupPath = `${bbDb}.pre-fork-copies-${timestamp(startedAt)}`;
  await sqliteBackup(bbDb, backupPath);
  log(`backup: ${backupPath}`);

  for (const { source, destination } of pluginDatabases) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await sqliteBackup(source, destination);
    log(`copied ${source} -> ${destination}`);
  }

  await runFile(
    "sqlite3",
    ["-bail", bbDb],
    buildTransactionSql({ rowActions, providerPreference, nowMs: startedAt.getTime() }),
  );
  log(
    `rewrote thread-list-fork preference:rowActions: ${rowActions === null ? "no change needed" : "done"}`,
  );
  log(
    `rewrote ui_preferences ${PROVIDER_PREFERENCE_KEY}: ${providerPreference === null ? "no change needed" : "done"}`,
  );

  const mismatches = [];
  const oldCounts = await countRows(bbDb, PLUGIN_ID_PAIRS.map((pair) => pair.from));
  const newCounts = await countRows(bbDb, newIds);
  log("table\told id\told rows\tnew id\tnew rows");
  for (const table of COPIED_CORE_TABLES) {
    for (const { from, to } of PLUGIN_ID_PAIRS) {
      const before = oldCounts.get(`${table}\u0000${from}`);
      const after = newCounts.get(`${table}\u0000${to}`);
      log(`${table}\t${from}\t${before}\t${to}\t${after}`);
      if (before !== after) mismatches.push(`${table}: ${from} has ${before} rows, ${to} has ${after}`);
    }
  }
  for (const { from, to, source, destination } of pluginDatabases) {
    const before = await userTableCounts(source);
    const after = await userTableCounts(destination);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      log(`${from}/data.db ${name}\t${from}\t${before.get(name) ?? 0}\t${to}\t${after.get(name) ?? 0}`);
      if (before.get(name) !== after.get(name)) {
        mismatches.push(`${from}/data.db ${name}: ${before.get(name)} rows, copy has ${after.get(name)}`);
      }
    }
  }
  if (mismatches.length > 0) {
    throw new MigrationRefusal(`row counts differ:\n${mismatches.join("\n")}`);
  }

  const oldIds = PLUGIN_ID_PAIRS.map((pair) => pair.from);
  log("");
  log("Old directories and rows are untouched. After you verify the copies, with bb stopped and the built-in plugins disabled:");
  for (const { from, source } of pluginDatabases) {
    log(`  rm -r ${shellQuote(path.dirname(source))}   # ${from}`);
  }
  for (const table of COPIED_CORE_TABLES) {
    log(
      `  sqlite3 ${shellQuote(bbDb)} ${shellQuote(`DELETE FROM ${table} WHERE plugin_id IN (${inList(oldIds)});`)}`,
    );
  }
  log(`  rm ${shellQuote(backupPath)}   # once you no longer need the backup`);
}

export function parseArgs(argv) {
  let dataDir = path.join(homedir(), ".bb");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--data-dir" || argv[index + 1] === undefined) {
      throw new MigrationRefusal(USAGE);
    }
    dataDir = argv[(index += 1)];
  }
  return { dataDir: path.resolve(dataDir) };
}

export async function main(argv, deps = {}) {
  try {
    const { dataDir } = parseArgs(argv);
    await migrate({ dataDir, ...deps });
    return 0;
  } catch (error) {
    console.error(error instanceof MigrationRefusal ? error.message : error);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
