# Security Model and Threat Model

> This document explains what Flicker **protects and what it does not protect**, and why.
> Every conclusion maps to specific code and tests, so you can verify each one yourself (see §8).
>
> **In one sentence**: file contents are end-to-end encrypted with AES-256-GCM, the key is derived from the password and exists only on the two computers;
> **the relay handles all of the ciphertext, but cannot read the contents and cannot see the file names**. The password never goes online.

---

## 1. Design goals and non-goals

### What we protect

| Goal | Means |
|---|---|
| **File contents** cannot be read by the relay or a network man-in-the-middle | AES-256-GCM, the key exists only in the memory of the two endpoints |
| **File names and directory structure** cannot be read by the relay | The whole manifest is encrypted before it is uploaded |
| The **password** never leaks to any third party | The password never goes online: the two ends each use it for challenge–response |
| The **"both computers must use the same password"** constraint | Room name = HKDF(password-derived key); if you cannot compute it, you cannot find the room |
| **Destroy on use** | The room is deleted as soon as the transfer completes; keys are zeroed; the session certificate is removed |

### What is explicitly **not** a goal

| Not defended against | Why |
|---|---|
| **A weak password being guessed** | See §4.2. The program generates a strong password by default, but does not force one |
| **The two computers themselves being compromised** | Keyloggers, trojans, malicious browser extensions — no software can defend against these |
| **Traffic analysis** | The relay can tell that "someone is transferring something, how big it is, how long it takes" |
| **Denial of service by the relay** | The relay can stop serving at any time (it is untrusted; we only require that it **cannot read**) |
| **Local forensic traces on the receiver** | Files are written to disk where the user chooses; the program is not responsible for erasing them |
| **Quantum computing** | See §6.4 |

---

## 2. Trust boundary

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│  发送端      │         │    中继       │         │  接收端      │
│  (Node)     │         │ (Cloudflare) │         │  (浏览器)    │
├─────────────┤         ├──────────────┤         ├─────────────┤
│ 明文        │         │ 只看到密文     │         │ 明文        │
│ 密码        │  ────▶  │ 房间名         │  ────▶  │ 密码        │
│ 密钥        │  密文    │ 消息长度/时序  │  密文    │ 密钥        │
│ 原始文件(只读)│        │ 两端 IP        │         │ 落盘文件     │
└─────────────┘         └──────────────┘         └─────────────┘
       ▲                                                ▲
       └──────────── 密码只在两端的这条虚线之外 ───────────┘
                  （它从不经过中间那条线）
```

**Core assumption: the relay is completely untrusted.** It can record everything, it can tamper with everything, and it can stop serving at any time.
The design of the encryption does not depend on it being honest.

### 2.1 The sender has two forms (since 2026-10)

In the diagram above the sender is "the Node program". Since 2026-10 the **sender can also be a
relay-hosted web page** (`/send`), which is what makes phone-to-phone work — when both sides only have
a browser there is no other way.

| | Sender = local program | Sender = relay-hosted page |
| --- | --- | --- |
| Where plaintext and keys live | In memory on the user's own computer | In the browser tab's memory |
| Whose code you must trust | The program you downloaded or built | **The page code the relay operator serves your browser** |
| Can the relay see the content | No (ciphertext only) | No (ciphertext only) |
| Does the key cross the network | No (the password stays on both ends) | No (room name and salt sit after `#`, which browsers never send) |

⚠️ **That difference has to be stated plainly**: the web sender widens "the code you trust" from
"the program on your machine" to "the HTML the relay hands your browser". When you deploy the relay
yourself (the default usage of this project) those are the same party; with **someone else's** relay you
are trusting their page code as well —— the same assumption the receiving page already carries, but one
the sender did not previously depend on. The user manual says this explicitly, and anyone unwilling to
accept it can keep sending with their own program only.

Everything else is unchanged: the web sender also **encrypts before anything leaves the tab** (the same
parameters as `src/suite/flicker1.js`, implemented in `web/phone-core.js` and byte-compared against it),
so the relay still only ever sees ciphertext.

---

## 3. Cryptographic construction (exact parameters)

| Item | Value |
|---|---|
| Suite identifier | `FLICKER/1` |
| Key derivation | `V = PBKDF2-HMAC-SHA256(密码, salt, 600000 次, 32 字节)` |
| salt | 16 bytes random, **placed after the `#` in the URL** (browsers do not send the fragment to the server) |
| Three keys are derived | `HKDF-SHA256(V, label)`, where label is `flicker/1/room`, `/auth`, `/enc` respectively |
| Content encryption | AES-256-GCM |
| Chunk size | 1 MiB (configurable) |
| Per-chunk IV | 12 bytes = `[4 字节 0][8 字节大端块序号]`. **Deterministic**, not randomized per chunk |
| Per-chunk AAD | 28 bytes = `文件序号‖块序号‖总块数‖明文长度` (all big-endian) |
| Authentication tag | 16 bytes (independent per chunk) |
| Manifest AAD | 18-byte ASCII `flicker/1/manifest` (**the length is deliberately different from the chunk's 28 bytes**) |
| Per-chunk integrity | The SHA-256 of each chunk's plaintext goes into the (encrypted) manifest |
| Whole-file integrity | SHA-256 of the whole file; the receiver computes an incremental digest as it receives |
| Mutual authentication | HMAC-SHA256 challenge–response, domain separation strings `flk1-recv` / `flk1-send`, also bound to the suite number |

### Why the IV is deterministic (this point is often questioned)

Chunk sequence numbers are unique, so the `(密钥, IV)` combination **never repeats** — and that is exactly what GCM's security requires.
The receiver must be able to **recompute** the IV of any chunk on its own (during a resume it may only get part of a chunk),
so if the IV were random it would have to be transmitted with every packet and stored separately. Determinism here is a **necessity**, not laziness.

Cost: two chunks with the same content (the same sequence number) produce identical ciphertext — but sequence numbers are unique,
and each chunk's AAD binds its length, so this "equality" does not leak meaningful information.

### Why the manifest's AAD length differs from a chunk's

A different AAD length **prevents cross-type confusion attacks**: treat a chunk's ciphertext as a manifest, or the other way round,
and authentication fails. 18 and 28 were chosen deliberately — there is a self-check in `src/suite/flicker1.js`
(it throws if `MANIFEST_AAD.length === 28`), which ensures this difference cannot be removed by accident by someone later.

---

## 4. Threat analysis

### 4.1 Malicious relay (the primary threat)

What the relay can see and what it cannot see:

| The relay can see | The relay **cannot** see |
|---|---|
| The room name (64 hex digits, 128 bit) | File contents (ciphertext only) |
| The size and the timing of every message | File names, directory structure |
| The total number of messages | The number of files, the total size |
| The IP addresses of both ends | The **password** (it never goes online) |
| The salt? **It cannot see it** — it is in the URL fragment | The key (only in the memory of the two ends) |

**Attacks the relay can mount, and why they fail:**

| Attack | Result |
|---|---|
| Read messages | It gets ciphertext. Without the key, AES-256-GCM cannot be decrypted |
| **Tamper with** messages | Every chunk has a 16-byte authentication tag; verification fails at the receiver → it aborts and **does not write to disk** |
| **Drop** messages | The transfer stalls and the user sees "waiting for the next chunk". Availability suffers, **confidentiality does not** |
| Replay old messages | Chunk sequence numbers are unique and are part of the AAD, so a replay will not match the expected sequence number |
| Impersonate the receiver | The room name is itself a capability credential (see below); if you cannot compute the room name you cannot find the room; and the password is not part of the transfer |
| Lure both ends into the **wrong room** | The room name is derived from the password, so the relay cannot construct a situation where "the password is the same but the room is different" |

**"The room name is a capability credential" is a deliberate design choice.** Early versions gave the relay an "authorization key registration",
and the tests immediately exposed a **first-come-first-served race**: when a room does not exist, the first request to arrive decides which key is registered —
an attacker could create a room with the same name first using a key derived from its own password, and lock the real sender out.
Switching to "the room name is the capability" made the problem disappear by itself: the room name is 128 bit,
one-way and not enumerable, and being able to compute it is equivalent to knowing the password.

### 4.2 Password guessing

One derivation costs **600,000 PBKDF2 iterations**, which is meant to raise the cost of an offline brute-force attack.

| Password strength | Risk |
|---|---|
| A random password generated by the program (the default) | Practically unguessable |
| A long passphrase the user chooses (≥ 5 random words) | Very safe |
| A short password / a common word the user chooses | **Risky** — once an attacker has the ciphertext they can brute-force it offline |

Online attempts are limited: **after 5 consecutive wrong passwords the session is destroyed automatically** (this is not a bug, it is a feature).
But offline attacks are not subject to this limit — if the relay recorded the ciphertext, an attacker can work it out locally at leisure.

> **So: do not use "123456".** The program generates a strong password by default; just use it.

### 4.3 Network man-in-the-middle

| Scenario | Safe? |
|---|---|
| LAN mode (HTTPS + self-signed certificate) | Encrypted, but the certificate is **session self-signed**; the browser trusts it because the program installed it into the current user's trust store |
| A man-in-the-middle replaces the certificate | Installing the certificate is a **local** step (it writes into the current user's Root store), so a man-in-the-middle on the network cannot replace a certificate that is already installed |
| Cross-network mode | Each end sets up HTTPS with the relay separately; **the content is still end-to-end encrypted**, so even if TLS is broken the file contents remain safe |

**Note**: in LAN mode, if the user manually accepts a **forged** certificate warning, that protection is lost.
What the program installs is a session-level self-signed certificate, and it is removed on exit (see §5.3).

### 4.4 Compromised endpoints

If the sender's or the receiver's computer is already compromised, **none of this holds** —
the attacker can simply read the plaintext, the password and the key. This is not a weakness of this program; it is the shared boundary of all encryption software.

### 4.5 Traffic analysis

The relay (and any observer on the path) can infer: **that someone is transferring, roughly how big it is, how long it takes, and the IPs of both ends**.
This cannot be eliminated without sacrificing availability. If that is unacceptable to you, use LAN mode
(data does not leave the local network), or run your own relay.

### 4.6 Local residue

| Item | Handling |
|---|---|
| Session certificate | Removed from the current user's Root store on exit; the intermediate certificate under `Cert:\CurrentUser\My` is cleared too |
| Temporary directory | The `flicker-cert-*` directories the program creates are cleaned up at startup and on exit |
| Messages on the relay | Each one is deleted once acknowledged (prefix deletion); the room is deleted when the transfer completes; everything expires after 15 minutes of inactivity |
| Keys | Explicitly zeroed as part of the destroy flow |
| **The original files** | **Read-only; never modified, deleted or moved** |
| **Received files** | Written to disk at the location the user chooses; the program is **not** responsible for erasing them |
| JS strings | **Cannot be reliably zeroed** (a language limitation). All we can do is keep the window as small as possible |

---

## 5. Known weaknesses and unmitigated risks

### 5.1 JS strings cannot be reliably zeroed

The password exists as a string inside V8, and copies may remain until garbage collection.
This is a language-level limitation; we have already kept the exposure window as small as possible (the reference is dropped as soon as derivation finishes), but it **cannot be guaranteed**.

### 5.2 In extreme cases a certificate may be left behind

If the process is force-killed, or there is a power cut or a blue screen, the destroy flow does not run and the certificate store may keep one extra harmless certificate.
The program cleans it up on the next start; you can also use `--no-cert-install` to not touch the certificate store at all.

### 5.3 In `--no-cert-install` mode the browser shows a warning

This is **intentional**: without installing the certificate there is no man-in-the-middle protection. It suits the case of "I just want to transfer once inside a network I trust".

### 5.4 The receiver cannot verify the sender's identity

The password is the only shared secret. Anyone who knows the password can impersonate the sender.
This is an inherent limitation of the "two computers + one password" model, and there are no plans to add a PKI.

### 5.5 The relay can deny service

The relay can drop every message. The transfer will fail, but it **will not silently corrupt** —
every chunk has an authentication tag, so anything missing or tampered with will be detected.

### 5.6 It is not a PAKE: a weak password can be brute-forced offline

Flicker's key derivation is **shared password → PBKDF2-SHA256 (600k rounds) → HKDF**,
not a **PAKE** such as SPAKE2 (magic-wormhole uses SPAKE2).

The difference is this: an attacker who has the session parameters (salt, room name) and a piece of ciphertext
**can guess passwords locally over and over, each attempt costing only one PBKDF2 run**, without interacting with either end.
600k rounds raise the cost of a single attempt by about three orders of magnitude, but **they do not change the fact that it can be brute-forced offline**.

| Password source | Real risk |
|---|---|
| The 4-word passphrase the program generates by default | Enough entropy (offline brute force costs far more than it is worth); usable |
| A short password / birthday / phone number the user sets themselves | **Genuinely brute-forceable**. This is the one point in this project that most needs the user's attention |

Mitigations (already implemented): the password is generated by the program by default, 5 failures destroy the session, and the password never goes over the wire.
**What was not done** is switching to a real PAKE — that is a protocol-level change, recorded in
[`路线图.md`](路线图.md) chapter 7, "the gaps we must honestly admit". Do not assume it has already been mitigated.

### 5.7 There has been no third-party audit

"End-to-end encrypted" is currently **our own claim**. The code is open source, the cryptography is concentrated in its own module,
and the tests contain targeted assertions — all of which make an audit easier, but **none of which can replace one**.
Before you use this for high-value data, factor that into your judgement.

### 5.8 What others have that we do not (an honest comparison)

There are a few things comparable tools do better than us, and they should be considered as part of any evaluation:

| Capability | Who has it | Our status |
|---|---|---|
| A real PAKE (SPAKE2) | magic-wormhole | ❌ See 5.6 |
| Cross-session resume (including at chunk granularity) | croc, dropwire and others | ⚠️ Only within the same session and at file granularity (`createWritable()` writes sequentially and truncates; chunk granularity is impossible at the browser level) |
| Using a phone as the sender | LocalSend, PairDrop | ❌ The sender has to run Node |
| The other side can fetch even while offline | Wormhole.app, Send, cloud drives | ❌ Deliberately not done: that would require storing the file somewhere (see [`路线图.md`](路线图.md) chapter 6) |
| Anonymous delivery | One-time-link services | ❌ The relay knows the IPs of both ends |

---

## 6. Edge cases

### 6.1 The file is modified mid-transfer

If the sender finds that the number of bytes it read does not match the manifest, it aborts and reports exactly which file and which chunk.

### 6.2 Disk full / write failure

The receiver aborts; data already received is not written to disk (or is written, but the whole-file verification will fail).
It will **not** produce a file that "looks successful but has incomplete contents".

### 6.3 Clocks

It does not depend on the two sides' clocks being synchronised. The timeout criterion is **idle time** (whether there is progress), not wall-clock time.

### 6.4 Post-quantum

AES-256 still has 128 bit of effective strength against Grover's algorithm (good enough).
But **the strength of PBKDF2/HKDF is broken by Shor's algorithm** — at that point it will need to be replaced with a post-quantum KEM.
It is not provided today, and no such claim is made.

---

## 7. Reporting security issues

Please **do not** open a public issue. Use GitHub's private vulnerability reporting (Security → Report a vulnerability),
or find a contact address in the repository and get in touch privately.

When you report, please include: reproduction steps, the scope of the impact, and how you verified it.
Once we have confirmed it, we will:
1. Reply as quickly as we can (usually within a few days; this is a hobby project, please be patient)
2. Fix it and record it in `SECURITY.md`
3. Credit you in the release notes, if you are willing

**Explicitly out of scope** (see the non-goals in §1): weak passwords being guessed, compromised endpoints, traffic analysis, denial of service.

---

## 8. Self-verification checklist

Do not trust the conclusions in this document; go and verify them. Every item can be done by hand:

| # | How to verify | Expected result |
|---|---|---|
| 1 | Capture packets (Wireshark) during a transfer and look at the relay traffic | You see a lot of bytes, but you cannot find any plaintext fragment of the files, nor any file name |
| 2 | Read "中继上流动的永远是密文" in `test/relay-e2e.test.js` | The test case inspects the bytes passing through the relay directly, and asserts that neither plaintext markers nor file names appear |
| 3 | Read `src/suite/flicker1.js` | Compare the suite parameters, the IV/AAD construction and the domain separation strings item by item with the table in §3 |
| 4 | Look at `test/suite.test.js` | It covers IV determinism, the AAD length difference, and tag verification failure |
| 5 | After the transfer completes, check `certmgr.msc` → Trusted Root Certification Authorities | No `Flicker` residue |
| 6 | Compare the number of entries under `Cert:\CurrentUser\Root` before and after a run | Identical (the test suite itself asserts this) |
| 7 | Monitor `%TEMP%` during a transfer | It does not grow |
| 8 | Search the source for `fs.write` / `createWriteStream` | They appear only in the `--card` export and in the receiver's save path |
| 9 | Unplug the network cable and run LAN mode | Completely normal (proof that it does not depend on any external service) |
| 10 | Read `中继部署.md` §3 | "What the relay can see" should match the corresponding section of this document |

### Security assertions covered by the test suite

| Assertion | Location |
|---|---|
| The relay only ever holds ciphertext (neither plaintext nor file names appear) | `test/relay-e2e.test.js` |
| With the wrong password you cannot even compute the room | Same as above |
| Tampering with any chunk is rejected | `test/suite.test.js` (GCM tag) |
| The AAD lengths differ, so cross-type confusion fails | Same as above |
| The certificate store is back to its original state after the process ends | The whole suite asserts this at the end of every test case |
| The relay writes nothing to disk (no KV/D1/R2/Durable Objects) | `test/relay-protocol.test.js` |
| 5 consecutive wrong passwords destroy the session | The `test/session` related cases |

---

## 9. Relationship to the other documents

| Document | Contents |
|---|---|
| **This document** | Security guarantees, threat model, known weaknesses |
| [`PROTOCOL.md`](PROTOCOL.md) | The byte-by-byte wire format definition (§3 rendezvous, §3R relay forwarding) |
| [`中继部署.md`](中继部署.md) | The relay protocol and "what the relay can see" |
| [`行为与运行.md`](行为与运行.md) | Runtime behaviour, the destroy flow, the audit checklist |
| [`架构决策.md`](架构决策.md) | Why it was built this way (including rejected alternatives) |
