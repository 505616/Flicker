# Flicker (闪传)

> One-shot file transfer — gone the moment it's done.
> **The receiving side installs nothing.** Open a browser, type the password, get the files.

> ### ⚠️ Read this before downloading: **verified on Windows only so far**
>
> Development and every measurement were done on **Windows 10/11 with Edge/Chrome**.
> macOS / Linux **run, but have no real-hardware verification** —— certificate *generation* is
> cross-platform pure JS, while installing the CA into the system trust store is Windows-only
> (it is not installed by default; the program prints the manual command instead).
>
> **The receiving side sees a one-time "not secure" warning**: the certificate is installed only on
> the sender's machine, so the other side's browser stops once —— click "Advanced → Proceed" and the
> data is still end-to-end encrypted. See "Platform support" below for the full picture.

```
      ⚡  Flicker
   A spark that lasts one transfer
```

[中文说明](读我.md) · [Security model](docs/SECURITY.md) · [Protocol](docs/PROTOCOL.md) · [Relay deployment](docs/中继部署.md) · [Changelog](CHANGELOG.md)

---

## What problem this solves

Moving a file between two computers is unreasonably annoying:

| Common approach | The annoyance |
|---|---|
| WeChat / QQ | Recompresses images, size limits, files stay on someone else's server |
| Cloud drives | Upload then download, account required, files persist forever |
| USB stick | You have to physically go there |
| SMB / FTP shares | Requires configuring shares and permissions on *their* machine |
| `python -m http.server` | Anyone on the network can download it; no password at all |

**Flicker's approach:** run one command on the sending machine, send the other person a link,
both sides type the same password, and the files go across.
When it finishes, the password, keys, link and server are **all destroyed immediately**.

---

## Features

| Feature | Detail |
|---|---|
| ✅ **Zero install on the receiver** | Any browser. Desktop, phone, tablet — same |
| ✅ **Password never goes on the wire** | Challenge–response handshake; a packet capture won't reveal it |
| ✅ **Both sides must use the same password** | That's a mathematical consequence of the key derivation, not a UI check |
| ✅ **End-to-end encryption** | AES-256-GCM, chunked; handles tens of GB |
| ✅ **Destroyed when done** | Keys wiped, server stopped, link dead, no temp files left behind |
| ✅ **Zero third-party runtime dependencies** | Node.js built-ins only. No `npm install` needed to run it |
| ✅ **CLI + GUI** | Use the terminal if you like terminals; open a window if you don't |
| ✅ **Symmetric** | The same binary sends and receives |
| ✅ **Can hand itself over** | Optionally sends its own program along, so the other side can pass it on |
| ✅ **Unpacks the gifted source package** | `flicker unpack <file.fkz>` unpacks the source package with the program you were given; the container is treated as untrusted input |
| ✅ **Receives with the program itself** | `flicker recv <link>` downloads, verifies every chunk and writes to disk in Node (no browser memory limits). A self-signed certificate is checked by comparing the fingerprint printed on the sender's screen. Direct links only for now —— relay links still go through the browser |

---

## Where it stands next to similar tools

**Let's be clear: this space is crowded.** There are dozens of tools that do something like this.

Browser-to-browser P2P: [PairDrop](https://github.com/schlagmichdoch/PairDrop),
[FilePizza](https://github.com/kern/filepizza). Command line: [croc](https://github.com/schollz/croc),
[magic-wormhole](https://github.com/magic-wormhole/magic-wormhole). LAN transfer:
[LocalSend](https://github.com/localsend/localsend). Encrypt-then-upload services:
[Wormhole.app](https://wormhole.app/) (10 GB cap, links die after 24 h),
[Send](https://github.com/timvisee/send). Newer P2P desktop apps:
[dropwire](https://github.com/muhamadjawdatsalemalakoum/dropwire) and friends.

Flicker is not "the only tool that can do this". It sits at one particular intersection:

| Where it is genuinely stronger | Why |
|---|---|
| **Zero install on the receiver, and it streams to disk** | Most browser P2P tools receive over WebRTC into memory and assemble a Blob — tens of GB is physically impossible (PairDrop's tracker has a 200 MB limit for iPhone transfers). Flicker writes as it receives; memory stays flat |
| **The two sides share only a password** | No account, no room code, no "upload first, they download later". The password never goes on the wire, and even the room name is derived from it |
| **One-shot, and the relay stores nothing** | The relay forwards from RAM with a 15-minute TTL. It is not "encrypted, sitting on someone's server, waiting for you" |
| **Zero runtime deps, single file, self-hostable relay** | "You can host it yourself and trust no company" — a commercial product cannot offer that |
| **A written protocol** | [`docs/PROTOCOL.md`](docs/PROTOCOL.md) is byte-level, so a third party can implement a client |

**When you should use something else** (this list is more useful than "we're the best"):

| Your situation | Better fit |
|---|---|
| You want to send **from a phone** | ✅ **A phone can send directly**: a phone cannot be the server (browser limitation), so it is turned around —— the computer starts the service and the phone pushes from its browser. `flicker recv` prints a QR code; the phone scans it and picks photos (**not yet verified on real phone hardware**, and the graphical-interface entry is still being built; see [`_lab/设计草稿-手机发送端.md`](_lab/设计草稿-手机发送端.md), Chinese). If you need "phone ↔ someone else's phone", or "phone sends to a person who installs nothing", LocalSend / PairDrop are still a better fit |
| The other side is **offline right now** and you want them to fetch it in a few days | Store-and-forward services (Wormhole.app, Send, cloud drives). Flicker requires **both sides online at the same time** |
| You need **anonymous delivery** | Flicker is not anonymous: the relay sees both IPs and the receiver gets an explicit room link |
| You need **audited cryptography** | Flicker has no third-party audit. It is shared-password + PBKDF2 (600k rounds) + HKDF, **not a PAKE** like SPAKE2 — if the password is guessable, offline cracking is feasible |
| You want to **close the tab and resume tomorrow** | Only file-granularity resume *within one session*; chunk-level resume is impossible at the browser-API level. **Cross-session resumption is explicitly not being done** (decided 2026-10: it would relax three promises already written into the docs — see [`docs/路线图.md`](docs/路线图.md) item 5) |
| You don't even want to download a **90 MB binary** | Use a pure-web tool (nothing to install on either side — at the cost of your files passing through someone's server, or memory limits) |

One sentence: **if you need "receiver installs nothing + tens of GB + truly one-shot + self-hostable" all at once, Flicker is that choice.**
Give up any one of those four, and something else is probably less trouble.

---

## Status

> **P0 / P1 / P2 / P3 complete.** LAN direct transfer, relay across networks, GUI, CLI,
> single-file packaging, and the destroy-on-completion flow all work and are covered by tests.
> Cross-network (relay) is **implemented and verified against a real relay**.

**Tests: 687 cases — 683 pass, 0 fail, 4 skipped.** Each skip says why: three need a working
**git** (they guard *repository metadata* such as "are the launch scripts executable in git?" ——
they are skipped where git is not on PATH, e.g. this machine's PowerShell, and do run in CI), and one
needs a symlink (creating one on Windows requires developer mode or admin rights — an environment
limitation, not a missing feature). On macOS / Linux a further four test *files* are
skipped, because installing the CA into the **system trust store** is Windows-only so far
(see [`docs/路线图.md`](docs/路线图.md)).
Every run asserts that the user's certificate stores are restored to their pre-run state.

```powershell
npm test                # full suite (serial; most stable)
npm run test:fast       # logic-only tests (no processes, no certificates — seconds)

node bin/flicker.js --gui                                  # GUI
node bin/flicker.js send "D:\file.zip"                     # LAN direct
node bin/flicker.js send "D:\file.zip" --relay=https://... # across networks
```

### Platform support

| Platform | Status |
|---|---|
| **Windows 10/11 + Edge/Chrome** | ✅ Verified: certificate trust, headless / visible / app-window modes, LAN IP. ⚠️ **On the sender's machine only**: the session CA is installed there, so the *receiver's* browser shows a one-time "not secure" warning — they click "Advanced → Proceed" and the data is still end-to-end encrypted (see [`docs/使用手册.md`](docs/使用手册.md) §10.3, Chinese) |
| macOS, Linux | ⚠️ **Not verified.** Certificate **generation** is one pure-JS code path shared by every platform (covered by real-TLS-handshake tests), but installing the CA into the **system trust store** is Windows-only. Use `--no-cert-install`, or run the exact command the program prints for you |
| Firefox / Safari | ⚠️ Works, but cannot stream to disk; large files may fail. See below |

---

## How the two connection modes work

### LAN mode (default)

The sender starts a local HTTPS server with a **session-scoped self-signed certificate**
(installed into the *current user's* trust store, removed on exit). The receiver opens the
link directly. **No data leaves your local network.**

### Across networks (`--relay=<url>`)

Both sides connect outward to a relay you deploy. **The relay forwards all the file bytes** —
which is the honest description, and worth stating plainly:

| The relay can see | The relay cannot see |
|---|---|
| That a transfer is happening, and when | File contents (ciphertext only — no key) |
| Each message's size and count | File names, directory structure, file count |
| Both endpoints' IP addresses | **The password** (it is never transmitted) |

It cannot *read* anything, and it cannot *change* anything: every chunk carries its own
authentication tag, so a single flipped bit is rejected by the receiver.

> **Why not peer-to-peer hole punching?** The sender would need an address the receiver can
> reach (public IPv6, same subnet, or a port forward). Measured on the development machine,
> all three were unavailable — the connection is behind CGNAT with no global IPv6.
> So this project relays instead, which always works, and documents the trade-off.
>
> If you don't want any third party involved: use LAN mode, or deploy the relay to your own
> Cloudflare account (one command, see [`docs/中继部署.md`](docs/中继部署.md) — Chinese).

### The other direction: phone → computer (`flicker recv`)

A phone cannot start a server (browser limitation), so receiving *from* a phone turns the roles
around: **the computer opens the HTTPS service and the phone pushes files up from its browser**.
The phone side stays a zero-install web page, and the same password check, encryption and destroy
machinery is reused — only the direction of the bytes differs.

⚠️ **Status, stated honestly**: the whole path works — `flicker recv` on the computer, the phone page
in the browser (password check → pick photos/videos → checksum → upload → finish), byte-for-byte
verified in a real browser against a real server (`_lab/e2e-phone-browser.mjs`). **Not yet verified
on real phone hardware**, and the "Receive files" entry in the graphical interface is still being
built. The phone page is bilingual and self-contained (protocol core, path rules and strings are all
inlined at build time).

---

## Security model (short version)

**What's protected**
- **File contents** — AES-256-GCM, keys derived from the password, existing only in the two endpoints' memory
- **Password** — never transmitted; both sides derive keys from it independently
- **File names** — the manifest itself is encrypted before upload
- **The "same password" property** — the room name is `HKDF(password-derived key)`; without the password you cannot even locate the room

**What it does NOT protect against**
- **Weak passwords** (the program generates a strong one by default; 5 failed attempts destroy the session)
- **A compromised endpoint** — keyloggers, malware, hostile browser extensions
- **Traffic analysis** — an observer learns *that* you transferred, and roughly how much
- **Relay denial of service** — the relay can refuse to work; it just cannot *understand* your data

Crypto parameters, threat analysis, known weaknesses and a self-verification checklist are in
[`docs/SECURITY.md`](docs/SECURITY.md). Please read it before relying on this for anything sensitive.

---

## Zero-dependency, and why that matters

There are **no runtime dependencies**. Not a stylistic choice:

- `node:crypto` for everything cryptographic (PBKDF2, HKDF, AES-GCM, HMAC, SHA-256)
- A hand-written **incremental SHA-256** in the receiver page, because `crypto.subtle.digest`
  has no streaming API — buffering a 40 GB file to hash it would defeat the whole point
- `node:sea` + `postject` for single-file packaging (build-time only)

The only build-time dependency is `postject`. To audit this project you can read all of it.

---

## Documentation

Every document exists **in two languages**: Chinese in [`中文文档/`](中文文档) and English in
[`docs/`](docs), with matching file names (`中文文档/使用手册.md` ↔ `docs/使用手册.md`).
A check (`node gen/check-doc-pairs.mjs`) fails if one side drifts.

> ⚠️ **One honest caveat:** the *interface* is bilingual (both pages have a language switch),
> but the **command-line output is currently Chinese only**. Where a document quotes terminal
> output, the quote is kept exactly as the program prints it, with the meaning explained in
> English around it.

This table says what's where (links go to the English copies):

| Document | Contents |
|---|---|
| **[SECURITY.md](docs/SECURITY.md)** | **Threat model, crypto parameters, known weaknesses, verification checklist** |
| [使用手册.md](docs/使用手册.md) | User manual: GUI walkthrough, CLI reference, troubleshooting |
| [行为与运行.md](docs/行为与运行.md) | Runtime behaviour: startup sequence, destroy flow, what touches your system |
| [设计文档.md](docs/设计文档.md) | Architecture, connection strategy, crypto scheme, and why |
| [架构决策.md](docs/架构决策.md) | Why it's built this way, including rejected alternatives |
| [PROTOCOL.md](docs/PROTOCOL.md) | Wire format, byte by byte (`FLICKER/1`) |
| [中继部署.md](docs/中继部署.md) | Relay deployment and protocol |
| [插件.md](docs/插件.md) | Writing a plugin: events and contribution points for the initiator / relay / page / receiving-side planes, capability limits, and **what is not done yet** |
| [构建单文件.md](docs/构建单文件.md) | Building the single-file executable |
| [UI设计.md](docs/UI设计.md) | Interface design notes, screen by screen |
| [路线图.md](docs/路线图.md) | Roadmap, release criteria, measured performance |
| [原始需求以及作者的话.md](docs/原始需求以及作者的话.md) | Why this program exists —— the author's original request, verbatim |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release, plus the **measured numbers and lessons** |
| [读我.md](读我.md) | The Chinese README |

---

## Performance

Measured on the development machine (Windows, ~195 ms RTT to Cloudflare):

| Scenario | Throughput |
|---|---|
| Relay, in-flight window = 1 (stop-and-wait) | 4.7 MB/s |
| **Relay, window = 8 + batched delivery (default)** | **18–24 MB/s** |
| Relay, window = 32 | 27.7 MB/s (saturating) |

Throughput **saturates around 28–30 MB/s**, which matches the measured link capacity
(29.5 MB/s). In other words the implementation is no longer the bottleneck — the network is.
Making the window larger does not help; the remaining lever would be larger chunks.

```powershell
node _lab/bench-window-sweep.mjs    # the measurements above
node _lab/verify-relay.mjs          # end-to-end relay verification
```

---

## Building and releasing

> **Taking this project over? Start with [`_lab/交接.md`](_lab/交接.md)** (Chinese) —— it holds the current
> state, how to verify things, the traps, and what is still undone.

```powershell
npm test              # run the tests (files are picked per platform)
npm run check         # static checks: zero-dependency promise, line endings/BOM,
                      #   doc links and structure, "the options and manifest fields in
                      #   the docs match the code", and "every temporary-directory
                      #   prefix is registered" (see below)
npm run build         # build the single-file artifact for this platform → dist/
npm run smoke         # prove the artifact really runs (--version / --help / dry run)
npm run release       # arrange it into a publishable shape → dist/release/
```

> **The development tooling leaves nothing on your machine.** Every temporary directory a tool
> creates goes through `gen/tmp.mjs`: one place deletes them all on exit (Ctrl+C included), and
> anything it cannot delete is **reported** rather than swallowed.
> To check for leftovers: `node gen/clean-temp.mjs` (report) → `node gen/clean-temp.mjs --yes`
> (actually delete). This exists because in 2026-10 a user found 2.8 GB of our leftovers in their
> `%TEMP%` — see [`docs/行为与运行.md`](docs/行为与运行.md) §1.1.1 (Chinese).

`npm run release` produces `SHA256SUMS` and `RELEASE.md` (download table, usage,
**known limitations**, checksums) and prints a ready-to-copy `gh release create` command.
It also pairs every artifact with a **zip** (94.5 MB → 36.1 MB, **62% smaller**): 89.2 MB of the
artifact is the Node runtime and cannot be removed, so what we compress is the *download*, not the size.
The ZIP writer is our own, zero-dependency one (`gen/zip.mjs`).

SEA builds **must run on the target platform** — there is no cross-compilation.
The CI matrix builds each platform's artifact on that platform; if a platform is
missing, build it and **run `npm run release` again**, so that one release covers
every platform. See [`docs/构建单文件.md`](docs/构建单文件.md).

---

## Licence

[MIT](LICENSE).

## Reporting security issues

Please **do not** open a public issue. See [`docs/SECURITY.md`](docs/SECURITY.md) §7.
