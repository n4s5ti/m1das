import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Sandbox } from "@vercel/sandbox";

const NAME = "amati-oracle";
const LOCK_NAME = "amati-oracle-coordinator";
const DAY = 24 * 60 * 60 * 1000;
const ROTATE_AFTER = 22 * 60 * 60 * 1000;
const LEASE_SECONDS = 1800; // Longer than the 800-second function deadline.
const DEFAULT_MODEL = "vercel-ai-gateway/anthropic/claude-sonnet-4.5";
const CREATE = { name: NAME, persistent: true, timeout: DAY, resources: { vcpus: 2 }, image: "vercel/sandbox/universal:latest" };

function required(name: string): string {
  const value = process.env[name];
  if (!value || /[\r\n]/.test(value)) throw new Error(`${name} must be set to a single-line value`);
  return value;
}

export function authorized(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function lookup(name: string): Promise<{ sandbox: Sandbox; status: string; sessionId: string } | undefined> {
  const sandboxes = await Sandbox.list({ namePrefix: name, sortBy: "name" });
  for await (const item of sandboxes) {
    if (item.name === name) return { sandbox: await Sandbox.get({ name }), status: item.status, sessionId: item.currentSessionId };
  }
  return undefined;
}

async function run(sandbox: Sandbox, cmd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await sandbox.runCommand({ cmd, args, env });
  if (result.exitCode !== 0) throw new Error(`${cmd} failed (${result.exitCode}): ${await result.stderr()}`);
  return result.stdout();
}

// The coordinator is a separate persistent named sandbox. Its filesystem lock survives
// gateway snapshots and concurrent invocations. flock serializes acquisition/expiry.
async function withLock<T>(work: () => Promise<T>): Promise<T | undefined> {
  let coordinator = (await lookup(LOCK_NAME))?.sandbox;
  if (!coordinator) {
    try {
      coordinator = await Sandbox.create({ name: LOCK_NAME, persistent: true, timeout: DAY });
    } catch (error) {
      coordinator = (await lookup(LOCK_NAME))?.sandbox;
      if (!coordinator) throw error;
    }
  }
  const owner = randomUUID();
  const acquire = `flock /tmp/oracle-lock-guard sh -c 'now=$(date +%s); if [ -f "$HOME/oracle-lease" ]; then read expires old < "$HOME/oracle-lease"; [ "$expires" -gt "$now" ] && exit 1; fi; echo "$((now + ${LEASE_SECONDS})) $1" > "$HOME/oracle-lease"' sh "$1"`;
  const result = await coordinator.runCommand({ cmd: "sh", args: ["-c", acquire, "sh", owner] });
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw new Error("Could not acquire coordinator lock");
  try {
    return await work();
  } finally {
    await run(coordinator, "sh", ["-c", `flock /tmp/oracle-lock-guard sh -c 'if [ -f "$HOME/oracle-lease" ]; then read expires old < "$HOME/oracle-lease"; [ "$old" != "$1" ] || rm "$HOME/oracle-lease"; fi' sh "$1"`, "sh", owner]);
  }
}

// Optional: a model signed in to with /api/login needs no key.
const gatewayKey = (): Record<string, string> => (process.env.AI_GATEWAY_API_KEY ? { AI_GATEWAY_API_KEY: required("AI_GATEWAY_API_KEY") } : {});

// prepare builds the package on npm ci; install from this checkout so unpublished
// channel changes are included. The marker holds the installed ref, so a new
// POTS_GIT_REF reinstalls on the next start, rotation or login, and a gateway that
// still runs the old build is stopped so the next start runs the new one.
async function install(sandbox: Sandbox): Promise<void> {
  const ref = required("POTS_GIT_REF");
  if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error("POTS_GIT_REF must be a full commit SHA");
  const url = process.env.POTS_GIT_URL || "https://github.com/n4s5ti/p0ts.git";
  const result = await sandbox.runCommand({ cmd: "sh", args: ["-c", `set -eu
export PATH="$HOME/.local/bin:$PATH"
marker="$HOME/pots-repo/.oracle-installed"
if [ "$(cat "$marker" 2>/dev/null || true)" != "$POTS_GIT_REF" ]; then
  if [ ! -d "$HOME/pots-repo/.git" ]; then git clone "$POTS_GIT_URL" "$HOME/pots-repo"; fi
  cd "$HOME/pots-repo"
  git fetch origin "$POTS_GIT_REF"
  git checkout --detach "$POTS_GIT_REF"
  npm ci
  mkdir -p "$HOME/.local/bin"
  chmod +x "$HOME/pots-repo/dist/cli/pots.js"
  ln -sf "$HOME/pots-repo/dist/cli/pots.js" "$HOME/.local/bin/pots"
  printf '%s\\n' "$POTS_GIT_REF" > "$marker"
  echo ORACLE_REINSTALLED
fi`], env: { POTS_GIT_URL: url, POTS_GIT_REF: ref } });
  if (result.exitCode !== 0) throw new Error(`Installing Pots in the sandbox failed: ${(await result.stderr()).slice(-2000)}`);
  if ((await result.stdout()).includes("ORACLE_REINSTALLED") && (await gatewayAlive(sandbox))) {
    await run(sandbox, "sh", ["-c", "pid=$(export PATH=\"$HOME/.local/bin:$PATH\"; pots status | sed -n 's/^gateway: running (process \\([0-9]*\\))$/\\1/p'); [ -z \"$pid\" ] || { kill \"$pid\"; while kill -0 \"$pid\" 2>/dev/null; do sleep 1; done; }"]);
  }
}

// pots init refuses a model pi cannot use, so this fails until ORACLE_MODEL has a key or a login.
async function configure(sandbox: Sandbox): Promise<void> {
  const env = { ...gatewayKey(), IMESSAGE_PROJECT_ID: required("IMESSAGE_PROJECT_ID"), IMESSAGE_PROJECT_SECRET: required("IMESSAGE_PROJECT_SECRET"), ORACLE_MODEL: process.env.ORACLE_MODEL || DEFAULT_MODEL };
  const result = await sandbox.runCommand({ cmd: "sh", args: ["-c", `set -eu
export PATH="$HOME/.local/bin:$PATH"
if [ ! -f "$HOME/.pots/bots/oracle/bot.json" ]; then
  pots init --yes --name Oracle --model "$ORACLE_MODEL" --about "AMATI's oracle" --no-service --no-chat
fi
node -e '
const fs = require("node:fs"), path = require("node:path");
const home = process.env.HOME, dir = path.join(home, ".pots/secrets"), config = path.join(home, ".pots/bots/oracle/bot.json");
fs.mkdirSync(dir, {recursive:true, mode:0o700});
fs.writeFileSync(path.join(dir, "imessage-oracle.env"), "IMESSAGE_PROJECT_ID=" + process.env.IMESSAGE_PROJECT_ID + "\\nIMESSAGE_PROJECT_SECRET=" + process.env.IMESSAGE_PROJECT_SECRET + "\\n", {mode:0o600});
fs.chmodSync(path.join(dir, "imessage-oracle.env"), 0o600);
const bot = JSON.parse(fs.readFileSync(config, "utf8"));
bot.model = process.env.ORACLE_MODEL;
if (!bot.channels.some(c => c.id === "imessage")) bot.channels.push({id:"imessage", type:"imessage", secrets:"~/.pots/secrets/imessage-oracle.env"});
fs.writeFileSync(config, JSON.stringify(bot, null, 2) + "\\n");
'`], env });
  if (result.exitCode !== 0) throw new Error(`Configuring the sandbox failed: ${(await result.stderr()).slice(-2000)}`);
}

async function gatewayAlive(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.runCommand("sh", ["-c", "export PATH=\"$HOME/.local/bin:$PATH\"; pots status"]);
  if (result.exitCode !== 0) throw new Error("pots status failed");
  return /^gateway: running \(process \d+\)$/m.test(await result.stdout());
}

async function start(sandbox: Sandbox): Promise<void> {
  await install(sandbox);
  await configure(sandbox);
  if (!(await gatewayAlive(sandbox))) {
    await sandbox.runCommand({ cmd: "sh", args: ["-c", "export PATH=\"$HOME/.local/bin:$PATH\"; exec pots start"], env: gatewayKey(), detached: true });
    for (let attempt = 0; attempt < 15; attempt++) {
      await delay(2000);
      if (await gatewayAlive(sandbox)) return;
    }
    throw new Error("Gateway did not start; inspect sandbox command logs");
  }
}

// Serves Pots' login page from the gateway sandbox and returns its link. The person signs in there
// (a subscription such as ChatGPT, or an API key) and pi writes the login to the sandbox's own
// ~/.pi/agent/auth.json: no model credential passes through Vercel, and snapshots carry it on.
export async function login(): Promise<{ url: string } | undefined> {
  return withLock(async () => {
    const existing = await lookup(NAME);
    const sandbox = !existing ? await Sandbox.create(CREATE) : existing.status === "running" ? existing.sandbox : await Sandbox.get({ name: NAME, resume: true });
    await install(sandbox);
    // One login page at a time: a new call ends the page of the call before it. The process ID file
    // outlives a snapshot, so the process is ended only when it still is a login page.
    await run(sandbox, "sh", ["-c", `pid=$(cat "$HOME/oracle-login.pid" 2>/dev/null || true)
if [ -n "$pid" ] && tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'login --link'; then kill "$pid"; fi
rm -f "$HOME/oracle-login.log"`]);
    await sandbox.runCommand({ cmd: "sh", args: ["-c", `export PATH="$HOME/.local/bin:$PATH"
echo $$ > "$HOME/oracle-login.pid"
exec pots login --link > "$HOME/oracle-login.log" 2>&1`], detached: true });
    // The first link waits for cloudflared's download, its tunnel and the tunnel's name in DNS.
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(2000);
      const url = /^\s+(https:\/\/\S+)$/m.exec(await run(sandbox, "sh", ["-c", 'cat "$HOME/oracle-login.log" 2>/dev/null || true']))?.[1];
      if (url) return { url };
    }
    throw new Error("The login page did not start; see ~/oracle-login.log in the sandbox");
  });
}

export async function rotate(): Promise<{ action: string; sandboxId?: string }> {
  // Refuse to stop a working gateway if the next session cannot be configured.
  for (const name of ["IMESSAGE_PROJECT_ID", "IMESSAGE_PROJECT_SECRET", "POTS_GIT_REF"]) required(name);
  if (!/^[0-9a-f]{40}$/i.test(required("POTS_GIT_REF"))) throw new Error("POTS_GIT_REF must be a full commit SHA");
  return (await withLock(async () => {
    const existing = await lookup(NAME);
    if (!existing) {
      const sandbox = await Sandbox.create(CREATE);
      await start(sandbox);
      return { action: "bootstrapped", sandboxId: sandbox.currentSession().sessionId };
    }
    let sandbox = existing.sandbox;
    if (existing.status !== "running") {
      // A persistent named sandbox resumes from its latest snapshot on demand.
      sandbox = await Sandbox.get({ name: NAME, resume: true });
      await start(sandbox);
      return { action: "resumed", sandboxId: sandbox.currentSession().sessionId };
    }
    const age = Date.now() - sandbox.currentSession().createdAt.getTime();
    if (age >= ROTATE_AFTER) {
      await sandbox.snapshot({ expiration: 0 });
      sandbox = await Sandbox.get({ name: NAME, resume: true });
      await start(sandbox);
      return { action: "rotated", sandboxId: sandbox.currentSession().sessionId };
    }
    await start(sandbox);
    return { action: "unchanged", sandboxId: sandbox.currentSession().sessionId };
  })) ?? { action: "already-running" };
}

export async function health(): Promise<object> {
  const existing = await lookup(NAME);
  if (!existing) return { sandboxId: null, ageMs: null, gatewayAlive: false, status: "missing" };
  if (existing.status !== "running") return { sandboxId: existing.sessionId, ageMs: null, gatewayAlive: false, status: existing.status };
  const session = existing.sandbox.currentSession();
  // The models pi can use in the sandbox: empty until a key or a login from /api/login is there.
  const models = (await run(existing.sandbox, "sh", ["-c", "export PATH=\"$HOME/.local/bin:$PATH\"; pots login --list"])).match(/^ {2}\S+\/\S+$/gm)?.map((line) => line.trim()) ?? [];
  return { sandboxId: session.sessionId, ageMs: Date.now() - session.createdAt.getTime(), gatewayAlive: await gatewayAlive(existing.sandbox), status: existing.status, models };
}
