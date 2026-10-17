# Flicker (闪传) — UI Design + Open-Source and Evolution Recommendations

Companion files: `设计文档.md` (architecture and cryptography), `ui-prototype.html` (a real, clickable prototype)

---

## 0. First, give the project a name

An open-source project's name is something you live with for a long time; my advice is to settle it now.

| Candidate | Meaning | Assessment |
|---|---|---|
| **Flicker / 闪传** | A spark of fire, gone in an instant — exactly "destroyed once used" | ⭐ **Recommended.** Short, easy to read, easy to search, available on npm, and both the English and the Chinese name fit the point |
| Meteor / 流星 | Gone in a flash | A fallback, but a lot of it is already taken on npm |
| Ember / 余烬 | The warmth left after the fire goes out | A fallback, though the meaning drifts slightly off target |
| OneShot | One-shot | Too generic; SEO would drown it |

**Suggestion**: repository name `flicker-transfer`, npm package name `flicker-transfer`, short command `flicker`, Chinese name "闪传".
(The name is already used in `ui-prototype.html`; you can just look at the result and decide.)

---

## 1. The core tension in the UI

This project has two interfaces, but **their importance is completely unequal**:

| | Sender | Receiver |
|---|---|---|
| User | **You** (installed the program, comfortable with a command line) | **The other person** (installed nothing, possibly not technical) |
| Form | Command-line terminal | Single browser page |
| How often | Looked at on every transfer | Possibly looked at exactly once in a lifetime |
| Design goal | **Information density + a sense of control** | **Zero learning curve + building trust** |

**Conclusion: the receiver is the face of the product.** A sender done well is just "handy"; a receiver done well is what makes you "dare to let other people use it".
So in the design below the receiver takes up more space than the sender, and that is deliberate.

There is one more constraint running through everything: **the receiver must be a single file, with zero external dependencies and zero CDN**.
No font, no icon library, no CSS framework may be pulled in — because:
1. In LAN mode the receiver may have **no internet access at all**, and any CDN dependency leads straight to a blank page
2. This is a security tool, and loading JS from a third party destroys trust by itself

→ So the UI can only be built from **hand-written CSS + a little inline SVG + Unicode symbols**.

---

## 2. Receiver design (browser)

### 2.1 State machine: six screens, one action per screen

```
  ① Password entry ──> ② Connecting ──> ③ Transferring ──> ④ Done
       │                                      │                 │
       └──────── ⑤ Error <────────────────────┘                 └──> ⑥ Cancel/destroy
```

Iron rule of the design: **every screen has exactly one primary button.** The other person may be very nervous ("did I click the wrong thing", "will I catch a virus"),
and the fewer choices the better.

### 2.2 Design points for each screen

**① Password entry**
- It has to answer three questions at first glance: **who sent this to me**, **how big is it**, **what am I supposed to do**
- ⚠️ **The file manifest cannot be obtained before the password is entered; this has been corrected here to match the implementation (2026-10).**
  This section originally said "the file manifest must be shown **before** the password is entered (no contents, only names and sizes)".
  But **the entire manifest (including the file count and total size) is encrypted**, and the key is derived from the password —
  before authentication the server simply has nothing it could hand to the page to look at.
- So this screen now **says outright that "you can't see it"** instead of glossing over it: `File list is encrypted` +
  `Visible only after the correct password is entered`. Users will wonder "why is there nothing here", so answer it up front.
- Why not make the count/total size plaintext (which would make this screen look nicer): then **anyone who has the link would know
  "how many files this is and how big"**. And links get forwarded. The promise made to users in `使用手册.md` §10.4 is
  "you can't even see the file names or the number of files", and that promise is worth more than "seeing a number early".
  See `PROTOCOL.md` §4.5.
- Password field: `type=password` + an eye toggle; monospace font + letter spacing (passwords contain hyphens and spaces, so monospace is easier to check)
- One small line at the bottom of the page: **"The password never leaves your computer — it is only used to confirm that both sides match"**
  - This line matters: while typing the password, users will certainly have the worry "where is this password being sent", so answer it up front
- Strength bar: `4 segments`, using color to tell you the generated default password is a good one

**② Connecting** (merged into the initial state of ③ instead of taking a screen of its own, to avoid flicker)

**③ Transferring**
- The three layers of progress are a deliberate design: **overall progress bar → current file → live speed**
  - With only the overall bar, it barely moves while a large file is transferring, and users think it has frozen
  - Add the current file + speed + time remaining, and the feeling that **"it's moving"** appears
- Speed uses a monospace font + the accent color — so the digits don't jitter sideways as they tick
- Say plainly "**written to disk as it arrives, without using memory**" — this is the technical selling point, and the guarantee that large files don't crash it
- Two buttons: `Pause` / `Cancel and destroy`
  - **"Cancel and destroy" must be written in full**, not just "Cancel". Users need to know exactly what this button means

**④ Done**
- The success animation is restrained (one checkmark + a soft halo; no confetti)
- **Show the verification result for every file individually**: `✓ Verified · SHA-256 matches`
  - That line is the final evidence that "the transfer can be trusted", and cannot be left out
- The **destruction manifest** (the single most important piece in this design):
  ```
  Session destruction manifest
  ✓ Password and session key zeroed
  ✓ Sender service closed
  ✓ One-time link invalidated
  ✓ This page will be unreachable after a refresh
  ```
  - Other programs treat "destroyed once used" as a marketing phrase; you should **make it a visible manifest**
  - This is the most distinctive trust asset of the whole product, and the piece of UI most likely to be screenshotted and passed around once it is open source
- The primary button `Open folder` cannot use the handle obtained from `showSaveFilePicker` — browsers **do not allow a web page to open the local file manager**.
  - At implementation time this became an `Open containing location` fallback: show the full save path + one-click copy, and note that "the file is already in your downloads folder"
  - This has to be verified during implementation; don't promise things in the UI that can't be done

**⑤ Error**
- **Security-class errors must say plainly that "nothing happened"**: `No data was transferred and no files were written to disk`
  - That sentence reduces the user's panic by an order of magnitude
- The failure count must be visible: `2 failures in a row — after 3 more, this session will be destroyed automatically`
- Offer exactly one action: `Retry`. Don't offer three buttons — "Back", "Cancel", "Help"

**⑥ Cancel/destroy**: one sentence that makes clear what has been destroyed and what was not saved, and then the page can simply be closed.

### 2.3 Layout: the card width must follow the screen, and it must be **vertically centered**

Originally it was `.wrap{max-width:520px}` + `body{justify-content:center}`. On a 1920 screen:

- About 700px left empty on each side (a hard-coded narrow width)
- `justify-content` **only handles the horizontal axis** — so all the surplus **vertical** space piled up below the card,
  and the whole page looked like "content floating in the top-left corner", which felt emptier than the whitespace itself

The fix (`web/receiver.html`):

```css
body{display:flex;justify-content:center;align-items:center;padding:28px 16px}  /* added align-items */
.wrap{width:100%;max-width:520px}
@media (min-width:1200px){ .wrap{max-width:640px} }
@media (min-width:1600px){ .wrap{max-width:720px} }
```

The receiver only goes up to 720px: it is the interface for **one thing** (enter password → wait → done receiving),
and any wider just leaves the inside of the card empty, which actually looks worse. The sender has more content (manifest, password, options, progress),
so it goes to 860–1000px in two columns, see §3.5.

> ⚠️ This one was **spotted in a screenshot**, not reasoned out: `_lab/screenshot.mjs`
> one 1920×1080 shot with headless Edge is enough to see it. When you change the layout, take a shot along the way before drawing conclusions.
>
> Screenshots are not enough for interaction changes (whether a click actually takes effect): `_lab/verify-remove-ui.mjs`
> opens a headless Edge and **really clicks** the ✕ and the language button in the manifest, then goes back and checks the backend state —
> for features like these that "live on the DOM", only a real click counts as verified.

### 2.3 Visual design tokens

```css
/* dark-first (file transfers usually happen at night, usually in front of a big screen); light follows the system automatically */
--bg: #0b0e14         /* page background */
--bg-elev: #121722    /* card */
--border: #232c3d
--text: #e6ebf5
--text-dim: #8c9ab4   /* secondary text */
--accent: #4d9fff     /* primary color: blue (trustworthy, calm) */
--ok: #2fbf71         /* success / verification passed */
--warn: #f0a83c       /* warning / notice */
--danger: #ff5f57     /* danger / destruction */
--mono: ui-monospace, "Cascadia Mono", Consolas  /* numbers, passwords, paths, hashes */
--sans: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC"  /* body text */
```

Three typography rules (this is where a security tool gets its character):
1. **All numbers, passwords, paths and hashes → monospace** (no jitter, easy to check)
2. Body text uses system fonts; **never load a web font** (LAN availability + no external requests)
3. In mixed Chinese/English text leave `letter-spacing: 0` for the Chinese, and never use italics (synthetic Chinese italics are fake and look terrible)

---

## 3. Sender design (terminal)

### 3.1 The boundaries of a terminal UI

A command-line UI has one natural limitation: **no TUI library may be used** (that would be a third-party dependency). So we only use:
- ANSI escape codes (color, cursor movement, clearing lines)
- Unicode box-drawing characters (`┌ ─ ┐ │ └ ┘`)
- Block characters for the progress bar (`█ ░`)

These render well in Windows Terminal / PowerShell 7 / macOS / Linux.
Old-style `cmd.exe` needs to be detected and downgraded to pure ASCII (`+ - |` and `# .`).

### 3.2 The five stages in the terminal

```
① Startup + manifest    see what is being sent and how big
② Hashing               progress bar (needed for big files, otherwise users think it is stuck)
③ Password              generate a strong password + double confirmation
④ Share                 link + QR code + timeout countdown
⑤ Transfer              live progress + speed + "Ctrl+C destroys immediately"
```

### 3.3 Three key decisions in the terminal

**1. Double confirmation applies only to a password you set yourself, not to a generated one**

The other person has to type the password by hand on another computer, character for character. If the sender mistypes it, the other person can never get in, and **there is no way to tell why** — so the act of setting a password needs double confirmation.

**But the scope of that confirmation has to be precise**, and this only became clear after measuring it:

| What the user does | Double confirmation? | Why |
|---|---|---|
| **Just press Enter** (accept the generated password) | ❌ **No confirmation** | The generated password is 26 characters long. Forcing the user to copy it out by hand to "confirm accepting the default" is both absurd and extremely error-prone, and it was a zero-risk action to begin with — if you don't want it, just generate another |
| **Type your own password** | ✅ **Confirmation required** | A typo means the other side can never get in, and neither side can see why. This is the mistake genuinely worth guarding against |

> This rule was forced out by `test/password.test.js`: the first version said "always confirm twice",
> and only when the test ran did it become clear that the design was forcing users to hand-copy random words. **Tests expose not just code bugs, but design flaws.**

**2. Generate a strong password by default, instead of letting the user think one up**
A 4-word password like `correct-horse-battery-staple`:
- About 52 bits of entropy — plenty for a session that lives a few minutes (and there is a rate limit + automatic destruction after 5 failures)
- **Readable, sayable and typeable by a human** — the user can read it out over the phone, or send it over WeChat
- A reminder: the default password can be accepted with a plain Enter; type your own if you want to set one

> Don't use a random string like `aB3#xK9!`. It has about the same entropy, but **it can't be spoken or typed by hand**, which forces users to copy and paste,
> and the channel people copy-paste through is often exactly the channel that is being eavesdropped on.

**3. A QR code is a must-have, but it must have fallbacks**
Drawing a QR code in the terminal (half-block characters `▀▄█`, two pixels apiece) lets the other person **open it with a single scan**, saving them from typing a long URL by hand.
- It takes about 250 lines of pure JS to implement QR encoding (zero dependencies, no npm package)
- **But the fonts/encoding of some Windows consoles garble it** → so two fallbacks are mandatory:
  - `--card=share.png`: export a share-card image (see screen 7 of the prototype) that can be sent straight over WeChat
  - `--no-qr`: plain-text mode that prints only the link + password, suited to remote SSH sessions

### 3.4 The graphical interface (station page): fill the window + pick files by clicking

Beyond the terminal, the sender also has a local web interface (`web/station.html`, loopback only).

**Layout: an "application shell" that fills the window** (changed 2026-10)

```css
body{padding:0}                        /* no longer a centered floating card */
.station{min-height:100vh;display:flex;flex-direction:column}   /* the shell fills everything */
.sec{flex:1;max-width:1180px;margin:0 auto}                     /* content centered with a width cap */
.foot{border-top:1px solid …;flex:none}                         /* keep the footer inside the viewport */
```

Why this changed: it used to be a centered card at `max-width:620px`, which left emptiness all around on a 1600/1920 screen —
the card looked like "a slab floating in the top-left corner". Now the shell fills edge to edge (background, border and rounded corners all removed),
and only the **text measure** is capped at 1180px, to avoid a line stretching to two thousand pixels on an ultrawide screen.

- The selection screen's content is **vertically centered**, and the drop zone is given plenty of height (a drop target should be big anyway)
- The file list on the plan screen is `flex:1`; a long list scrolls on its own, so the buttons are always within reach
- ⚠️ That footer line, "This page listens on loopback only — other devices on your LAN cannot reach it", must stay **inside** `.station` —
  the shell is `min-height:100vh`, so putting it outside pushes it below the viewport where it can't be seen without scrolling,
  and it is a security promise

**Choose files / Choose folder: never make the user type a path** (changed 2026-10)

This was the focus of this round of changes. All three of the original buttons (Choose files / Choose folder / Type a path instead) **simply**
exposed a text box and let the user type their own path — that isn't "choosing", that's passing the buck.

Why we can't just use `<input type=file>` like an ordinary web page: **the browser will not hand a web page the absolute path of a local file**
(a basic sandbox constraint; `input[type=file]`, drag-and-drop and the File System Access API all refuse,
`File.path` is an Electron-only thing). And the sender is Node **reading the original file directly**
(no copying, no memory use — the only way tens of GB is feasible), and what it needs is exactly the path.

So: **the local service lists the directory** (`GET /api/browse?path=…`), and the page renders it as a browse window.

```
Choose files / Choose folder → modal (drive → directory → file)
  · Folders first, files after, each sorted by name (same as Explorer)
  · **The two buttons really do behave differently** (see the table below) — at first they were almost identical, which made having two buttons pointless
  · **Multi-select**: click the box on the right to select/deselect, **Shift selects a run of items**
  · **Selections accumulate across directories**: pick two in directory A, go into B and pick one more, then confirm once you have them all
  · Double-clicking an item = send just that one (a fast path when you are adding only one)
  · Symbolic links are not followed (consistent with what scan() does)
  · When something can't be read, say it in human words ("not enough permission / drive is offline"), don't throw a bare EPERM
```

**How the two modes divide the work** (the same spot behaves differently):

| Where you click | Choose-file mode | Choose-folder mode |
|---|---|---|
| A file's name | Selects it | — (files are not listed) |
| A folder's **name** | Goes into it | **Selects it** ("this is the one I want to send") |
| The **▸** to the left of a folder | Goes into it | Goes into it |
| The box on the right | Select/deselect | Select/deselect |
| Double-click | Sends just this one | Sends just this one |

In choose-folder mode `/api/browse?only=dir` **lists folders only** — listing files would be both unselectable and a waste of space.

> ⚠️ **"Up" must use the `parent` the server gives it; it must not be assembled locally by string manipulation.**
>    There was a very typical trap here: taking the parent of `D:\闪传` locally gives `D:` (the backslash is lost),
>    and on Windows `path.resolve('D:')` means "**the current directory of drive D**" = the process's CWD
>    = `D:\闪传` — so "up one level" spun in place and no amount of clicking could get you out.
>    The server's listing response already contains an authoritative `parent`. The server now also **rejects relative paths**
>    (`absolute path required`), so that the implicit behavior of `path.resolve` can't sneak back in from somewhere else.

> ⚠️ **Shift range-selection must be handled first, and must `return`.**
>    The old code said "range-select only when an anchor exists"; with no anchor that branch was skipped and fell through to "clicking a name enters the directory" —
>    the user wanted to select from the top all the way down and ended up inside a folder instead. Now, with no anchor, the current item becomes the anchor,
>    and this branch never enters a directory.

> ⚠️ **The selection must live outside the list data** (`browseSel` is a Map, cleared only when the **window is opened**).
>    If it lived inside the list data it would be wiped out every time the directory is re-rendered — and that is exactly the capability multi-select needs most:
>    "pick a few from each of several folders".

There is only one security precondition, and it already holds: **this service listens only on 127.0.0.1**
(`test/gui.test.js` has a "listens only on loopback" case watching it). Any process that can reach it could already
read the filesystem of the same machine directly, so there is no extra risk. Drag-and-drop takes the same route: the browser likewise gives no path,
so after a drop it opens the browse window directly instead of making the user copy the path by hand.

**The file manifest is grouped by "added item"** (changed 2026-10)

Add a folder → the list shows **a single folder row** (name + N files + total size + full path),
click it to expand and see what is inside; paths in the detail rows drop the folder prefix so it isn't repeated on every line.

```
📁 web                        4 files · 245 KB
   D:\闪传\web
   └ i18n-runtime.js   10 KB
     receiver.html    135 KB
     …
```

- The backend groups by `srcIndex` (which entry of `inputs` it came from) rather than guessing from the first segment of `rel` —
  when two cards each contain a `Photos`, deduplication renames them, and guessing mixes the groups up
- Details are **fetched on demand** (`/api/group?p=<路径>`): `/api/state` is polled every 400ms,
  and with tens of thousands of files the details can't be pushed into the page on every poll
- ⚠️ **Always locate by path, never by index** (`?p=`, not the old `?i=N`).
  After deleting an item in the middle, the index of everything after it shifts forward; and the page remembers "which item is expanded" by path,
  so if the two sides disagree it expands the wrong item. The same goes for the group DOM fingerprint, which uses `path:fileCount`
- ⚠️ Group DOM is rebuilt only when the **structure changes**: rebuilding blindly wipes out the user's expanded state,
  which shows up as "it opens and then closes itself a second later"

**Removing a single item** (added 2026-10): every group row has an `✕` on the right (always visible but understated,
turning red on hover); clicking it removes only that **one item** from the manifest.

The user's exact words were "if I pick the wrong file or folder I can only clear everything; there should be an option to clear just one" —
at the time there was only "Clear all", so one wrong folder meant selecting everything again from scratch (especially painful for a manifest of tens of GB).

- Backend: `POST /api/remove {path}` → `removePath()`, matching on **the path it was added with in the first place**
- Adding an item and removing an item go through the **same** `applyPaths()`: both paths must produce the same state shape,
  otherwise after a delete the group index, total byte count and phase would disagree with what they were when it was added
- Deleting down to empty → `phase` returns to `idle` (the interface goes back to the "Send files" screen),
  rather than sitting on an empty manifest waiting for someone to click "Start transfer"
- Removing a path that was never in the manifest → 404 with human words ("this item is no longer in the manifest"),
  **state unchanged**; no `path` given → 400
- ⚠️ The `✕` must be **always visible** (`.7` opacity); it must not be "appears on hover" —
  that way nobody knows the feature exists. The user originally couldn't find a single-item clear and had to use "Clear all" —
  that is what prompted this request

**The language switch button needs to stand out** (changed 2026-10): it used to be a small pill with gray text, a transparent background and a thin border,
which blended into the page header and was almost invisible — and **the people who need it are exactly the people who can't read the current interface**,
so hiding the button is as good as not having it. Both pages are now unified as: `🌐` + the target language name + `▾`,
with accent-colored text, a pale accent background and an accent border, filling solid with the accent color on hover.

- The icons go through `::before`/`::after` and **must not be written into the HTML**: the button text is set at runtime
  with `set textContent` (it has to show the name of "the other language"), so anything put in the markup gets overwritten
- The button text shows the name of the **other language** and has to change along with the switch —
  otherwise after switching to English the button still says "English", which is a button that can't click itself

**The rate limit option** (added 2026-10): in `Options`, besides "Also send them Flicker itself", there is "Speed limit".
- Presets: `No limit / 1 / 2 / 5 / 10 MB/s`, plus "Custom…" which expands a text box
- The accepted syntax is **exactly the same** as the command line's `--rate` (the same `parseRate`): `512K` / `5M` / `2G`,
  a plain number counts as bytes/second; empty = no limit
- ⚠️ **A value that can't be parsed must raise an error, and must never be treated as "no limit".** The whole point of this option is "don't saturate your uplink",
  and silently letting it through makes users think they have capped it while actually eating the whole bandwidth — a misunderstanding that only gets
  found when someone else complains the network is slow (the comment in `src/rate.js` records this). In the interface this shows up as: the input box turns red + a popup
  with the correct syntax, and **the backend state stays as it was**
- Input is debounced 500ms before submitting: `5` is a legal 5 bytes/second, and submitting on every keystroke would actually take effect

**The password box must be filled in** (found in the same screenshot session): the backend generates the password at startup and hands it down through
`/api/state`, but the page used to fill it in only when you clicked "New one" — the user saw an empty box, clicked "Start transfer",
and got "the password cannot be empty". The poll now fills it in, but **only when the user hasn't touched it themselves**,
so the password they typed by hand isn't overwritten.

### 3.5 The destruction promise in the terminal

While transferring, one line must be permanently on screen:

```
  Press Ctrl+C to abort immediately and destroy all keys
```

and on `Ctrl+C` it must actually run the destruction flow, then print:

```
✓ Destroyed: session key · password verifier · temporary buffer
✓ Sender service closed
```

**Print the destruction process out**, echoing the receiver's destruction manifest — that is where this project's character lives.

---

## 4. Other recommendations for this project

### 4.1 Open source: six things to do right now

| Item | Why it matters | How to do it |
|---|---|---|
| **Write the protocol spec as its own document** | This is the foundation for adding "more encryption methods" later | Write the handshake, chunking and manifest format into `PROTOCOL.md`, with a version number `FLICKER/1`. Code can be rewritten; the protocol has to carry on |
| **LICENSE** | No license = nobody dares use it | MIT (least hassle) or Apache-2.0 (includes a patent grant, safer) |
| **SECURITY.md + threat model** | A security tool without this gets questioned | State plainly: what the relay can see (metadata) and cannot see (file contents); what is not defended against (a compromised terminal, weak passwords, traffic analysis) |
| **Bilingual** | If a Chinese project wants users, the README must be in English | `README.md` in English + `README.zh-CN.md` in Chinese, and both the code comments and the UI must be i18n-ready |
| **Automated tests + CI** | Cryptography code needs tests before anyone dares contribute | Use Node 24's **built-in** `node --test` (zero dependencies), with GitHub Actions running on all three of Windows/macOS/Linux |
| **Runnable via `npx`** | A lower barrier to use = more stars | `npx flicker-transfer send ./file` just runs, no need to clone first |

### 4.2 Algorithm agility — the right way to "add more encryption methods later"

**Never hard-code the encryption algorithm into the flow.** Build it with this structure from now on:

```
Handshake step 1: both sides exchange "which cipher suites I support"
            ↓
            negotiate the strongest suite both sides support, and write it into the session
            ↓
            from then on all key derivation, encryption and verification go through the "suite interface"

suite = { id, password derivation function, KDF, AEAD, hash, chunk size }
```

So adding an algorithm later is just **adding one more suite object**, without touching any flow code:

| What you want to add | How | Cautions |
|---|---|---|
| **Argon2id** instead of PBKDF2 | Add suite `FLICKER/2` | WebCrypto has no Argon2, so it needs a WASM or pure-JS implementation — size traded for security; make it optional |
| **ChaCha20-Poly1305** | Add a suite | Faster on devices without AES hardware acceleration; the browser's `crypto.subtle` **does not support** it, so it needs WASM |
| **X25519 + a short authentication string** | An enhanced handshake | Authentication currently relies on the password. Adding key exchange + a 6-digit comparison code defends against "the relay tampering with the handshake" |
| **Post-quantum** (ML-KEM) | Longer term | Wait until both browsers and Node support it natively; for now just leave room for it in the suite interface |

**Version negotiation must be compatible in both directions**: a new build meeting an old peer must be able to fall back to `FLICKER/1` automatically, instead of just erroring out.
This has to be written into the protocol from day one, otherwise adding algorithms later creates a split where "if I don't upgrade, I can't use it".

### 4.3 Suggested code structure (preparing for open source and evolution)

```
flicker/
├─ bin/flicker.js            # CLI entry point (kept extremely thin)
├─ src/
│  ├─ suite/                 # ★ encryption suite directory, the only entry point for adding algorithms later
│  │  ├─ index.js            #   registry + negotiation
│  │  └─ flicker1.js         #   FLICKER/1 = PBKDF2 + HKDF + AES-256-GCM
│  ├─ transport/             # channel implementations (LAN / relay / more later)
│  │  ├─ lan.js
│  │  └─ relay.js
│  ├─ protocol/              # handshake, chunking, manifest (decoupled from the suites)
│  ├─ ui/
│  │  ├─ tty.js              # terminal rendering (ASCII fallback handled here)
│  │  └─ qr.js               # zero-dependency QR code
│  └─ destroy.js             # destruction flow (its own module, easy to test and audit)
├─ web/receiver.html         # receiver single page (shared code injected at build time)
├─ relay/worker.js           # Cloudflare Worker
├─ test/                     # node --test
├─ PROTOCOL.md               # ★ protocol specification
├─ SECURITY.md               # threat model
└─ 设计文档.md
```

**The key point**: `suite/` and `destroy.js` are directories of their own because those two are **the only genuinely hard parts** of this project,
and the parts that most need to be audited, tested and read on their own. Mixed in with everything else, they would be very hard for anyone to review after open-sourcing.

### 4.4 Mobile: preparation to do now (near-zero cost, huge payoff)

You mentioned "letting a computer send files to a phone later". There are three things that **cost almost no extra time now but save a lot of trouble later**:

**1. Make the receiver a PWA** (add a `manifest.json` + a minimal `sw.js`, about 40 lines)
- A phone browser can "add to home screen", so it looks like an app — but it still **needs no app store and no installation**
- Perfectly matches your core requirement that "the receiver installs nothing"
- Note: a PWA needs HTTPS (restricted under a self-signed LAN certificate, but naturally satisfied when going across networks through the relay)

**2. On mobile, land files with the Web Share API**
- On the desktop it is "download to a folder"; on a phone it should be "**bring up the system share sheet**" → save to the photo library, save to the Files app, or send straight over WeChat
- One line of code — `navigator.share({ files: [...] })` — supported on iOS 15+/Android Chrome
- This is the key step for the "computer → phone" experience; without it, a phone can only save to the downloads directory and users can't find their files

**3. Write the UI as a responsive layout from day one**
- A phone is not a "shrunken desktop"; it is its own scenario (see screen 4 of the prototype)
- One column all the way down in portrait, full-width buttons, bigger progress numbers, path information tucked away
- Catching it with media queries while writing the CSS now is ten times cheaper than refactoring later

> **A phone as the sender** is the genuinely hard problem: a browser cannot read a file at an arbitrary path. That is a platform limitation, not a design problem.
> There are only two viable routes: ① the phone → computer direction (phone uploads, computer receives); ② wrap the program in a mobile shell
> (Capacitor/Tauri Mobile), which is the only way to run the sender on a phone. That belongs to the P4 stage; no need to worry about it now.

### 4.5 Other scattered but important suggestions

| Suggestion | Rationale |
|---|---|
| **A one-click Windows firewall allow script** | The first listen always pops up a dialog and many people click the wrong thing. Ship a `放行防火墙.ps1` (needs administrator) and document it clearly |
| **Rate limiting + failure counter** | The password only lives a few minutes, but these are still mandatory: automatic destruction after 5 failures, a forced delay during the handshake |
| **A `--dry-run` mode** | Print the manifest and sizes that would be sent without starting the service. For debugging and confirming |
| **A transfer speed cap `--rate=N`** | Saturating a gigabit LAN slows everyone else down, and users will want a rate limit during large transfers |
| **UI feedback for resuming** | After a reconnect it must clearly show "resuming from xx%", otherwise users think it started over from the beginning |
| **Log scrubbing** | **Passwords, keys and file contents must never appear** in any log; whether file names are logged should be a switch (off by default)|
| **Don't build "remember password"** | It violates the one-shot principle. Any persistence weakens the product's core promise |
| **Attach prebuilt binaries to GitHub Releases** | Use `node --experimental-sea-config` to package single files for Windows/macOS/Linux, so Mac users without Node installed can still use the sender |

---

## 5. Next steps

The prototype opens by double-clicking: `ui-prototype.html` (with dark/light switching and 7 screens).

Suggested order of work:

1. **Settle the name and the protocol first** (a skeleton `README.md` + `PROTOCOL.md`) — half an hour's work, but it decides how all the code after it is organized
2. **The P0 LAN loop** (chapter 8 of `设计文档.md`) — nail down the cryptography, chunking and destruction, and be able to really transfer a file the same day
3. **Move the UI from the prototype into real code** — `web/receiver.html` should reuse the prototype's design tokens and structure directly; don't redesign it
4. **P2 relay** — do it when you want to cross networks

Just say the word and I'll start on whichever step you want.
