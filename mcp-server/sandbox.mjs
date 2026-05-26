// Sandboxed shell for the query_docs_filesystem_ton_docs tool.
//
// Each invocation spawns `bwrap` with a fresh mount namespace whose root is a
// tmpfs. We bind-mount the docs corpus entries onto `/` so the LLM sees a
// filesystem that contains only the documentation, plus the minimum system
// paths needed for ripgrep/jq/coreutils to execute. Everything is read-only,
// the network is disabled, and there is a hard wall-clock + output-size cap.

import {spawn} from "node:child_process"
import {readdirSync} from "node:fs"
import {join} from "node:path"

const CORPUS_ROOT = process.env.CORPUS_ROOT ?? "/root/ton-docs-private"
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 10_000)
const MAX_OUTPUT_BYTES = Number(process.env.SANDBOX_MAX_BYTES ?? 30 * 1024)

// Anything in the corpus that is not actually documentation. Hidden dotfiles
// are filtered out separately so we do not have to enumerate every one.
const BLACKLIST = new Set([
  "node_modules",
  "orama-server",
  "scripts",
  "package.json",
  "package-lock.json",
  "unzip.js",
  "extra.css",
  "extra.js",
])

function buildCorpusBinds() {
  const args = []
  for (const name of readdirSync(CORPUS_ROOT)) {
    if (BLACKLIST.has(name)) continue
    if (name.startsWith(".")) continue
    args.push("--ro-bind", join(CORPUS_ROOT, name), `/${name}`)
  }
  return args
}

// Cache the bind list at startup. The corpus is updated by an out-of-band
// rsync/git pull, after which the systemd unit can be restarted to refresh.
const CORPUS_BINDS = buildCorpusBinds()

// All shell utilities live in a single dot-prefixed mount `/.tools` so they
// stay invisible to `ls /` (which hides dotfiles by default). That folder
// holds a static toolset prepared at deploy time: busybox-static for sh +
// coreutils + find/grep/sed/awk/sort/uniq/cut/wc/etc, plus standalone
// ripgrep (musl static-pie), jq (statically linked), and tree (dynamic,
// patchelf'd to look up its interpreter + libc inside /.tools/lib).
//
// `/tmp` is given a hidden tmpfs at `/.tmp`; TMPDIR points there so heredocs
// and other shell temp writes have somewhere to go without exposing a /tmp
// node at the visible root. No /proc, no /dev, no /etc, no /bin, no /lib —
// the LLM sees a pristine docs-only filesystem.
const SYSTEM_BINDS = [
  "--tmpfs", "/",
  "--tmpfs", "/.tmp",
  "--ro-bind", "/opt/ton-mcp/sandbox-tools", "/.tools",
]

// We deliberately do NOT pass --unshare-net (Ubuntu 24's AppArmor blocks the
// loopback setup), and we do NOT pass --unshare-pid (it requires mounting a
// fresh /proc which collides with this service's kernel hardening).
// Network isolation is enforced at the systemd cgroup level instead
// (IPAddressDeny=any with only 127.0.0.0/8 + ::1/128 allowed).
const NAMESPACE_FLAGS = [
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-cgroup-try",
  "--die-with-parent",
  "--new-session",
]

const ENV_FLAGS = [
  "--clearenv",
  "--setenv", "PATH", "/.tools",
  "--setenv", "HOME", "/.tmp",
  "--setenv", "TMPDIR", "/.tmp",
  "--setenv", "LANG", "C.UTF-8",
  "--setenv", "LC_ALL", "C.UTF-8",
  "--setenv", "TERM", "dumb",
]

export async function runSandboxedCommand(command) {
  if (typeof command !== "string" || command.length === 0) {
    return "[error: command must be a non-empty string]"
  }
  if (command.length > 4096) {
    return "[error: command exceeds 4096 character limit]"
  }

  const args = [
    ...SYSTEM_BINDS,
    ...CORPUS_BINDS,
    ...NAMESPACE_FLAGS,
    ...ENV_FLAGS,
    "--chdir", "/",
    "--",
    "/.tools/sh", "-c", command,
  ]

  return new Promise(resolve => {
    const proc = spawn("bwrap", args, {stdio: ["ignore", "pipe", "pipe"]})

    let bytes = 0
    let truncated = false
    let timedOut = false
    const chunks = []

    const collect = data => {
      if (truncated) return
      const remaining = MAX_OUTPUT_BYTES - bytes
      if (remaining <= 0) return
      if (data.length > remaining) {
        chunks.push(data.subarray(0, remaining))
        bytes = MAX_OUTPUT_BYTES
        truncated = true
        proc.kill("SIGKILL")
      } else {
        chunks.push(data)
        bytes += data.length
      }
    }
    proc.stdout.on("data", collect)
    proc.stderr.on("data", collect)

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGKILL")
    }, TIMEOUT_MS)

    let settled = false
    const settle = (suffix = "") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let out = Buffer.concat(chunks).toString("utf8")
      if (suffix) out += suffix
      resolve(out || "[no output]")
    }

    proc.on("error", err => settle(`\n[bwrap spawn error: ${err.message}]`))
    proc.on("close", (code, signal) => {
      let suffix = ""
      if (truncated) suffix += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`
      if (timedOut) suffix += `\n[killed after ${TIMEOUT_MS} ms]`
      if (!truncated && !timedOut && code && code !== 0) {
        suffix += `\n[exit ${code}]`
      }
      settle(suffix)
    })
  })
}
