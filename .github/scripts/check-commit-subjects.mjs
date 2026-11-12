import { execFileSync } from "node:child_process";
import { parseSubject } from "./conventional.mjs";

const range = process.argv[2];
if (!range) {
  console.error("Usage: node .github/scripts/check-commit-subjects.mjs <range>");
  process.exit(2);
}

const records = execFileSync(
  "git",
  ["log", "--no-merges", "--format=%H%x1f%s%x1e", "--end-of-options", range],
  { encoding: "utf8" },
)
  .split("\x1e")
  .map((r) => r.replace(/^\n/, ""))
  .filter((r) => r.trim() !== "");

let bad = 0;
for (const record of records) {
  const [sha, subject = ""] = record.split("\x1f");
  if (parseSubject(subject) === null) {
    bad++;
    // The fixed prefix keeps a subject that starts with "::" from being read
    // as a GitHub Actions workflow command.
    console.log(`bad subject ${sha}: ${subject}`);
  }
}

if (bad > 0) {
  console.log(`${bad} of ${records.length} commit subjects are not in type(scope)!: text format`);
  process.exit(1);
}
console.log(`all ${records.length} commit subjects ok`);
