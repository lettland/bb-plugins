import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readProcessIdentity(pid) {
  try {
    const [bootId, processStat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const statFields = processStat
      .slice(processStat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (statFields.length > 19 && statFields[19] !== "") {
      return `proc:${bootId.trim()}:${statFields[19]}`;
    }
  } catch {
    // /proc is unavailable or unreadable: fall back to ps.
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      const identity = output.trim();
      finish(code === 0 && identity !== "" ? identity : null);
    });
  });
}

async function processStartedAt(identity) {
  if (identity.startsWith("proc:")) {
    const startTicks = Number(identity.slice(identity.lastIndexOf(":") + 1));
    let uptimeSeconds;
    try {
      uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/, 1)[0]);
    } catch {
      return null;
    }
    if (Number.isFinite(startTicks) && Number.isFinite(uptimeSeconds)) {
      return Date.now() - uptimeSeconds * 1_000 + startTicks * 10;
    }
    return null;
  }
  const startedAt = Date.parse(identity);
  return Number.isFinite(startedAt) ? startedAt : null;
}

export async function ownerProcessExists(owner) {
  if (!Number.isInteger(owner?.pid) || !(await processExists(owner.pid))) {
    return false;
  }
  const identity = await readProcessIdentity(owner.pid);
  if (identity === null) {
    return true;
  }
  if (typeof owner.processIdentity === "string" && owner.processIdentity !== "") {
    return owner.processIdentity === identity;
  }
  let startedAt;
  try {
    startedAt = await processStartedAt(identity);
  } catch {
    return true;
  }
  return (
    startedAt === null ||
    !Number.isFinite(owner.createdAt) ||
    owner.createdAt + 2_000 >= startedAt
  );
}
