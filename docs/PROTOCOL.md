# FLICKER/1 — The Flicker Protocol Specification

> **Protocol name**: `FLICKER/1`
> **Status**: Draft — covers every on-the-wire behaviour required by P0–P5; already aligned with `架构决策.md` (station model / GUI / program gift / certificate trust), and **the alignment introduced no protocol change**. Items marked "unverified" must be confirmed by measurement during implementation before they can be treated as final.
> **Companion documents**: `设计文档.md` (architecture, network measurements, connection strategy, cryptographic choices), `架构决策.md` (station model, GUI, self-gift, certificate trust), `UI设计.md` (interface), `行为与运行.md`, `使用手册.md`
> **Where this file sits**: the other documents explain **why it is designed this way**; this file explains **exactly which bytes go on the wire**.
>
> **⚠️ Must read before implementing**: §7.4.2 records the measured certificate-trust result that **directly affects P0 feasibility** (it does not match the expectation in `架构决策.md` §4.3), along with the list of P0 blockers in §12.1.

---

## 0. Document scope and version conventions

### 0.1 Code may be rewritten; the protocol must carry on

`FLICKER/1` is the **only thing in this project that needs long-term compatibility**. The sender can be rewritten in Go or Rust, or packaged into a single-file exe; the receiver page can be redesigned; the relay can move to another cloud vendor. But as long as the wire protocol does not change, old and new implementations must interoperate.

Three hard engineering rules follow from this:

| Rule | Meaning |
|---|---|
| **The protocol version is independent of the program version** | Program version `v0.4.2` has nothing to do with protocol version `FLICKER/1`. Upgrading the program does not necessarily upgrade the protocol |
| **The wire format only grows, never changes** | The **name, type, byte order and semantics** of a published field are never modified. When change is needed, add a new field or add a new suite |
| **Unknown fields must be ignored** | When either end receives a field or message type it does not recognise, it **ignores it and continues**; it must not raise an error and abort (the only means of forward compatibility) |

### 0.2 Notation used in this file

| Notation | Meaning |
|---|---|
| `‖` | Byte-string concatenation, with no separator and no length prefix |
| `BE64(x)` | Encode the integer `x` as **8 unsigned bytes, big-endian** |
| `BE32(x)` | Same, 4 bytes big-endian |
| `BE16(x)` | Same, 2 bytes big-endian |
| `[0x00] * n` | n zero bytes |
| `HMAC(K, m)` | HMAC-SHA-256, 32-byte output |
| `HKDF(K, label)` | HKDF-SHA-256, empty salt, info = the ASCII bytes of `label`, 32-byte output |
| `BASE64` | Standard Base64 (RFC 4648 §4, with `=` padding) |
| `HEX` | Lowercase hexadecimal, no prefix |
| **Unverified** | The item is a design inference, **not measured**; it must be verified during implementation |

> **Global byte order**: **all** integer fields in the protocol are **big-endian** (network byte order). The only exception is numbers inside a `JSON` payload (JSON numbers have no notion of byte order).

---

## 1. Overall layering

### 1.1 Layer diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  L6  Application layer                                               │
│      manifest semantics, path safety, directory-tree rebuild,        │
│      program-gift recognition                                        │
│      Product: files written to disk + UI state (the TTY and the GUI  │
│      front ends share one event stream)                              │
├──────────────────────────────────────────────────────────────────────┤
│  L5  Data plane                                                      │
│      chunk frames, IV/AAD derivation, resume (RESUME), ACK,          │
│      backpressure                                                    │
│      Product: a sequence of fixed-length ciphertext blocks           │
├──────────────────────────────────────────────────────────────────────┤
│  L4  Session layer                                                   │
│      password derivation V, HKDF subkeys, mutual MAC handshake,      │
│      session ID, failure counter                                     │
│      Product: mutual authentication complete + (K_enc, SID)          │
├──────────────────────────────────────────────────────────────────────┤
│  L3  Cipher suite layer                                              │
│      FLICKER/1 = PBKDF2-SHA256 + HKDF-SHA256 + AES-256-GCM + SHA-256 │
│      Product: a **replaceable interface** to every cryptographic     │
│      primitive                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  L2  Transport layer                                                 │
│      https-chunk (the only implementation in P0/P1/P2) /             │
│      wss-stream / webrtc-dc (reserved)                               │
│      Product: a reliable, ordered byte stream, or request-response   │
├──────────────────────────────────────────────────────────────────────┤
│  L1  Rendezvous layer                                                │
│      rooms, long-poll messages, TTL, destroy. **Never touches file   │
│      data**                                                          │
│      Product: both sides learn "where the other side is and which    │
│      suites it supports"                                             │
├──────────────────────────────────────────────────────────────────────┤
│  L0  Page delivery layer                                             │
│      Where the receiver HTML/JS comes from: sender self-hosted /     │
│      relay-hosted / gift-loaded                                      │
│      Product: the receiver runs a piece of code able to execute      │
│      this protocol                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 Ownership of each layer and the direction of dependency

| Layer | Who implements it | Depends on lower layers | Key property |
|---|---|---|---|
| L0 Page delivery | Both parties' sites / relay Worker | — | **The only entry point for a zero-install receiver**; the three sources must produce **behaviourally equivalent** clients |
| L1 Rendezvous | relay Worker (optional) | — | **Can be skipped entirely** (LAN mode); forwards opaque bytes only |
| L2 Transport | Both parties | L1 (only to fetch addresses) | Replaceable: HTTP chunked / WebSocket stream / WebRTC DataChannel |
| L3 Cipher suite | Both parties | — | **The single algorithmic entry point**; adding an algorithm changes only this layer |
| L4 Session | Both parties | L2, L3 | The password never goes on the wire; mutual authentication |
| L5 Data plane | Both parties | L2, L3 | Chunks are authenticated independently; resumable |
| L6 Application | Both parties | L5 | Path safety is a **security boundary**, not a UI detail |

### 1.3 Glossary

| Term | Definition |
|---|---|
| **Initiator** | The party that holds the file and runs the sender program (a Node process). Under the station model, it is the station that actively executes `send` |
| **Responder** | The party that opens the link and runs the browser page; or, under the station model, the station that enters the password to receive |
| **Station** | The unified program shape defined in `架构决策.md`: **one executable, two roles, decided at runtime**. In this protocol "initiator" and "responder" are **session roles**; any station can play either role |
| **Role-neutral** | The protocol messages themselves do not assume who speaks first; the role is expressed by an explicit field. In this specification, L1's `HELLO` and L4's `AUTH_REQ` both carry a `role` field |
| **Session** | The complete lifecycle from password confirmation to destroy, identified by `SID` (16 bytes) |
| **Room** | One message mailbox on the relay, identified by `room_name`, with a TTL |
| **V** | The password verifier, produced by the suite's PDF; **it never goes on the wire** |
| **SID** | The session ID: the first 16 bytes of `SHA-256(nonce_r ‖ nonce_i)` |
| **gift** | A manifest entry marked as a "program", used to hand the receiver program itself to the other side |

---

## 2. Cipher suite layer: cryptographic suite negotiation

### 2.1 Why the suite layer must exist independently

The requirements explicitly demand that "more encryption methods can be added later". If the encryption algorithm were hard-wired into the handshake and chunking flows, every new algorithm would mean editing the flow code again, which would inevitably introduce regressions.

**Therefore: flow code only calls the suite interface and never mentions `AES-GCM`, `PBKDF2` or similar directly.**

### 2.2 Suite ID naming rule

```
suite_id := "FLICKER/" 1*DIGIT
```

| suite_id | Status | Summary of contents |
|---|---|---|
| `FLICKER/1` | **Defined by this specification, must be implemented** | PBKDF2-SHA256/600k → HKDF-SHA256 → AES-256-GCM, 1 MiB chunks, SHA-256 |
| `FLICKER/2` | Reserved: Argon2id | See §2.6 |
| `FLICKER/3` | Reserved: ChaCha20-Poly1305 | See §2.6 |
| `FLICKER/4` | Reserved: X25519 + SAS | See §2.6 |

Numbers **are only added, never reused**. Even if a suite is abandoned, its number is kept forever, so that old implementations cannot misread it.

### 2.3 The suite interface (implementations must provide these 7 members)

Every suite object must expose all of the following members completely. **The field names are part of this specification**; internal naming may differ, but the key names in the suite registry must match.

| Member | Type | Role |
|---|---|---|
| `id` | string | Suite identifier, e.g. `"FLICKER/1"` |
| `pdf` | function | **Password Derivation Function**: `(password: string, salt: bytes) → V: bytes` |
| `kdf` | function | **Key Derivation Function**: `(V: bytes, label: string) → key: bytes` |
| `aead` | object | **AEAD**: `{ seal(key, iv, plaintext, aad) → ciphertext‖tag, open(key, iv, ciphertext‖tag, aad) → plaintext }` |
| `hash` | object | **Hash**: `{ digest(bytes) → bytes }`, used for manifest verification and chunk integrity |
| `chunkSize` | integer | Plaintext chunk size in bytes |
| `tagSize` | integer | AEAD authentication tag size in bytes |

There are three further quantities fixed by the protocol that **do not belong to the suite** (all suites share them, because they are part of the wire format):

| Quantity | Value | Reason |
|---|---|---|
| `SALT_LEN` | 16 | Wire-format field length |
| `NONCE_LEN` | 32 | Wire-format field length |
| `IV_LEN` | 12 | Required by GCM; other AEADs that differ override it in the suite (see the note in §2.4) |

> **Note**: `IV_LEN` may be overridden by a suite. If a suite's AEAD uses a 24-byte nonce (such as XChaCha20), that suite must declare `ivLen` in its own definition, and the IV derivation in L5 follows the suite's declaration. **This is the only wire-format detail that `FLICKER/1` allows a suite to change**; every other wire-format detail is the same for all suites.

### 2.4 Complete parameters of `FLICKER/1`

| Item | Parameter | Value |
|---|---|---|
| **PDF** | Algorithm | `PBKDF2` |
| | Hash | `SHA-256` |
| | Iterations | `600000` |
| | Salt length | `16` bytes (randomly generated for each session) |
| | Output length | `32` bytes → that is, `V` |
| **KDF** | Algorithm | `HKDF` (RFC 5869, extract-then-expand) |
| | Hash | `SHA-256` |
| | salt | **Empty** (an empty byte string, not omitted) |
| | IKM | `V` (32 bytes) |
| | Output length | `32` bytes |
| | label `room` | `K_room = HKDF(V, "room")` |
| | label `auth` | `K_auth = HKDF(V, "auth")` |
| | label `enc` | `K_enc  = HKDF(V, "enc")` |
| **AEAD** | Algorithm | `AES-256-GCM` |
| | Key | `K_enc` (32 bytes, i.e. AES-256) |
| | IV length | `12` bytes |
| | Tag length | `16` bytes |
| | Chunk plaintext length | `1048576` bytes (1 MiB) |
| **Integrity** | Hash | `SHA-256` |
| | Use | File-level verification (`files[].sha256`), chunk-level per-chunk fingerprints (`files[].chunkHashes`) |
| **Session ID** | `SID` | The first `16` bytes of `SHA-256(nonce_r ‖ nonce_i)` |

> **Unverified**: the time `PBKDF2` with 600000 iterations takes on a low-end mobile browser. If it exceeds 2 seconds, the UI needs an explicit waiting indicator, rather than lowering the iteration count. (Candidate measurement target: Chrome on a mid-range Android phone)

#### 2.4.1 The precise definition of `label` (to prevent implementations from diverging)

```
label "room"  := byte sequence 72 6F 6F 6D        (ASCII "room", 4 bytes)
label "auth"  := byte sequence 61 75 74 68        (ASCII "auth", 4 bytes)
label "enc"   := byte sequence 65 6E 63           (ASCII "enc", 3 bytes)

K_room = HKDF-Expand(HKDF-Extract(salt = "", IKM = V), info = "room", L = 32)
```

**Note**: the HKDF `salt` is **empty**, while `info` is the label above. Do not put the label into the salt, and do not put the salt `S` into HKDF —— `S` already influences `V` through the PDF; injecting it again brings no additional benefit but does cause implementations to diverge.

#### 2.4.2 The definition of `room_name`

```
room_name := HEX(K_room)         // 64 lowercase hexadecimal characters
```

`room_name` is a **256-bit unguessable string**. It is used directly as a URL path segment; the relay **does not parse its contents** and treats it purely as an opaque key.

**A property that must be understood**: `room_name` is observable by the relay. However:
- It is derived from `K_room`, which is derived from `V`, which is derived from the password —— **without knowing the password, it cannot be generated**
- It **cannot** be used to work back to the password or to any subkey (HKDF is one-way, and the outputs for the three labels are unrelated to each other)
- Its only purpose is to make "two parties with the same password land in the same mailbox"

> So what the relay learns is: "the mailbox corresponding to some 64-character hexadecimal string received two messages today". Nothing more.

### 2.5 Negotiation flow

```
        Initiator A                                    Responder B
            │                                            │
            │  ← reads the available suite_id list from   │
            │    the link/page                            │
            │                                            │
     A encodes its own supported list into the link fragment or the L0 page
            │                                            │
            │  ① A carries suites: [S_a1, S_a2…] in HELLO │
            │ ─────────────────────────────────────────> │
            │                                            │  ② B intersects with its own
            │                                            │     list, taking the earliest
            │                                            │     common entry in B's list
            │  ③ AUTH_REQ carries suite: <negotiated>     │
            │ <───────────────────────────────────────── │
            │                                            │
            │  ④ A checks: that suite must be in A's list │
            │     otherwise send ERROR(E_SUITE_REJECTED)  │
            │     and abort                               │
```

**The strongest-wins rule (must be implemented strictly, otherwise both sides can silently pick different suites)**:

- Every implementation's suite list is **ordered by descending strength** (newest and strongest first)
- **The responder decides**: it walks its own list and takes the first suite that also appears in the initiator's `HELLO.suites`
- **The initiator only checks, it does not choose**: if the suite the responder picked is not in `HELLO.suites`, the initiator must abort
- The result is written into the session's `suite_id`; from then on **all** PDF/KDF/AEAD/hash/chunkSize come from that suite

### 2.6 Version downgrade rules (critical)

> **A new version meeting an old version must downgrade automatically, and must not raise an error.**

| Situation | Required behaviour |
|---|---|
| The only suite both sides share is `FLICKER/1` | Use `FLICKER/1` normally; **must not** refuse because "I support something better" |
| The initiator only has `FLICKER/1`, the responder has `FLICKER/1,2,3` | Choose `FLICKER/1` |
| The two sides have **no** suite in common | Send `ERROR(E_NO_COMMON_SUITE)` and state clearly in the UI that "the two program versions are too far apart, please upgrade one of them"; do **not** report a wrong password |
| An unrecognised **message type** arrives | Ignore that message and continue (§0.1) |
| An unrecognised **field** arrives | Ignore that field and continue |
| A **higher** `protocol` version number arrives | Parse as far as possible using the known fields; if a required field is missing, send `ERROR(E_PROTOCOL_TOO_NEW)` |

**The trade-off against downgrade attacks (implemented 2026-10, see §4.5.1)**: the rules above allow a man in the middle (the relay) to trim `HELLO.suites` down to `FLICKER/1` only, forcing both sides onto the weaker suite.

- While `FLICKER/1` is the only suite, this attack is meaningless (it was the only one anyway)
- After `FLICKER/2` is introduced, preventing downgrade requires binding `suite_id` **into the authenticated MAC**: `MAC_r = HMAC(K_auth, suite_id ‖ role ‖ nonce)` (details in §4.5.1). Therefore:
  - If the man in the middle changes `HELLO.suites` → the two sides pick different `suite_id` values → **MAC verification necessarily fails** → the attack is detected
  - This is why `suite_id` must go into the MAC, rather than "just agreeing on it"
- **Compatibility** with 0.1.0 is handled by "two named constructions + an echo": a new peer uses the bound construction;
  an old peer (which sends no echo) continues on the old bytes with an **explicit warning**; and "I offered the new one
  but the other side echoed the old one" **aborts** —— see §4.5.1

### 2.7 How to add a suite in the future (add an object only, do not touch the flow)

Adding a suite = adding an object that satisfies the §2.3 interface + registering it in the registry + ordering it by strength in the list. **Not one line of L4/L5/L6 code changes.**

| Planned suite | What has to change | Known obstacles |
|---|---|---|
| **`FLICKER/2`: Argon2id** replacing PBKDF2 | Only the `pdf` member | WebCrypto **does not provide** Argon2; a WASM or pure-JS implementation is needed. Size traded for security → make it an optional suite, off by default (unverified: the effect of the WASM size on the receiver's first paint) |
| **`FLICKER/3`: ChaCha20-Poly1305** | Replace the `aead` member | WebCrypto **does not support** ChaCha20-Poly1305 either, so WASM is likewise needed. Faster on devices without AES hardware acceleration |
| **`FLICKER/4`: X25519 + short authentication string (SAS)** | Replace `kdf` + add a key-exchange message to the handshake | Defends against "the relay tampering with the handshake". A 6-digit number must be shown in the UI for both sides to compare. **This is the only evolution that needs a new handshake message** (adding, not modifying, in line with §0.1) |
| **Post-quantum (ML-KEM and similar)** | Depends on the final shape | Evaluate once WebCrypto/Node ship a stable native implementation; the suite interface has already left room for it |

**Registry shape (implementation constraint)**:

```
SUITES = [ flicker1, flicker3, flicker2, flicker4 ]   // order = descending strength
```

Inserting a new suite in the right place makes it participate in negotiation automatically, with no need to change any flow branch.

---

## 3. Rendezvous layer

> ### ⚠️ First, be clear about how this chapter relates to the implemented relay (otherwise you will read it wrongly)
>
> This file contains **two paths across networks**, and the difference between them is "whether the data goes through the relay":
>
> | | §3 Rendezvous layer (this chapter) | §3R Relay forwarding ([Relay deployment](中继部署.md)) |
> |---|---|---|
> | The relay's role | Only makes the introduction, then **leaves the data path** | **Forwards all data** (ciphertext) |
> | Data path | The receiver connects directly to the sender | Both ends connect to the relay |
> | Precondition | The sender has an address the receiver can reach | None (as long as the relay can be reached) |
> | Current state | **The protocol is retained; neither the relay-side endpoints nor the client are implemented** (see below) | ✅ **The scheme actually used across networks** |
>
> ⚠️ **This chapter is a design, not an implementation guide you can follow (reviewed 2026-10).**
> The original text said "the protocol is fully retained, and so is the code" —— the second half does not hold:
>
> - **Nothing in the code provides this chapter's `/room/{room_name}` endpoints** (the relay implements only §3R's `/r/:room/*`)
> - The client has no rendezvous mode either; the two paths that do run are **direct LAN** (§3.6) and **relay forwarding** (§3R)
>
> Why the chapter is kept: it is a **fully designed** path (the relay only makes the introduction, data never passes through it),
> so if the sender ever gains a public address it becomes usable; and it draws the upper bound on "what the relay can see".
> But **a client written against this chapter will not connect to anything** —— for implementations, follow §3R, §4, §5 and §6.
>
> **Why relay forwarding is what is actually used**: the rendezvous mode requires the sender to have an address "the other side can reach"
> (public IPv6 / same network segment / port forwarding). On this machine all three were measured and none held (CGNAT + no global IPv6),
> so "connect directly after the introduction" had no line to introduce. See the second supplementary chapter of `设计文档.md` and `路线图.md`.
>
> So "**file data never passes through the relay**" in this chapter is a constraint **internal to rendezvous mode**; it holds and is watched by tests;
> but it is **not the whole of what the program promises outwardly** —— in relay-forwarding mode the relay does handle ciphertext.
> For a complete and accurate account of "what the relay can see", see [Relay deployment](中继部署.md) §3.

### 3.1 Boundary of responsibility (must be observed strictly)

| The relay **does** | The relay **never does** |
|---|---|
| Store and forward **opaque messages** by `room_name` | Does not parse message contents |
| Return new messages via long-poll | Does not touch any file data (**within rendezvous mode: file data never passes through the relay**) |
| Delete rooms automatically when the TTL expires | Does not write to disk, does not need a database |
| Support explicit deletion (burn after use) | Needs no login, no account |

**"File data never passes through the relay" is a protocol-level constraint of this section (rendezvous mode)**: the set of L1 message types is a **closed enumeration** (§3.5), and none of them can carry file content. No extension may add a message type that "carries a file block".

> Relay-forwarding mode uses **a different set of endpoints** (`/r/:room/*`); what it moves is ciphertext chunks,
> which have **nothing to do with the L1 rendezvous message type set** in this chapter (their parsers are separate and their byte formats differ).
> Do not assume that relay forwarding does not exist just because "§3.5 has no file-block type" —— it simply is not in this chapter.

### 3.2 Message format (wire format)

All rendezvous messages are **UTF-8 encoded JSON objects**, `Content-Type: application/json`.

```json
{
  "v": 1,
  "type": "HELLO",
  "seq": 1,
  "from": "i",
  "ts": 1765500000000,
  "body": { }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `v` | number | yes | Rendezvous message format version; fixed at `1` for `FLICKER/1` |
| `type` | string | yes | Message type, see §3.5 |
| `seq` | number | yes | Sender's auto-incrementing sequence number, starting at `1`. Used for deduplication, not for ordering |
| `from` | string | yes | `"i"` = initiator, `"r"` = responder |
| `ts` | number | yes | Unix millisecond timestamp of the moment of sending (for information only, **must not be used for security decisions**) |
| `body` | object | yes | Type-dependent payload, see §3.5 |

**Relay receipt format** —— when the relay returns a message to the pulling side it **wraps it in an extra layer**:

```json
{
  "cursor": 7,
  "msg": { "v": 1, "type": "HELLO", "seq": 1, "from": "i", "ts": 1765500000000, "body": { } }
}
```

| Field | Description |
|---|---|
| `cursor` | A **monotonically increasing** integer assigned by the relay, starting at `1`, counted independently per room |
| `msg` | The original message, **unchanged byte for byte** |

**Key point**: `cursor` is assigned by the relay and **does not come from `seq`**. That way, even if the sender resends the same `seq`, the pulling side can tell from `cursor` "whether this is newly arrived or a duplicate", while using `(from, seq)` for deduplication.

### 3.3 HTTP endpoints

The base URL is written `<relay>` (for example `https://flicker.example.workers.dev`).

| Method | Path | Role | Success status code |
|---|---|---|---|
| `POST` | `/room/{room_name}` | Deliver one message to the room (the **initiator's** first delivery also carries create semantics, see §3.3.1) | `202 Accepted` |
| `GET` | `/room/{room_name}?cursor=N` | Long-poll for messages with `cursor > N` | `200 OK` (messages available) / `204 No Content` (timed out, no messages) |
| `DELETE` | `/room/{room_name}` | Destroy the room immediately | `204 No Content` |
| `GET` | `/healthz` | Health check | `200 OK` |

**There is no separate "create room" endpoint**: the room is created implicitly on the **initiator's first `POST`**. This design saves one round trip, at the cost of the creation rule depending on the `from` field of the message body (see §3.3.1).

**Path variable**: `{room_name}` = 64 `[0-9a-f]` characters (§2.4.2). The relay **must** validate that regular expression and return `400` if it does not match.

#### 3.3.1 `POST /room/{room_name}`

```
Request headers:  Content-Type: application/json
Request body:     one rendezvous message (§3.2), UTF-8
Response:         202 Accepted, body { "cursor": 12 }
```

| Error | Status code | Description |
|---|---|---|
| The room was never created | `404` | The delivering side should send `ERROR(E_ROOM_GONE)` and tell the user in the UI "the session has timed out, please start again" |
| The room expired or was destroyed | `404` | The same status code, but a different meaning (destroy is **terminal**, see §3.3.3). The delivering side handles it exactly like the row above |
| The responder delivers to a room that does not exist | `404` | **The responder never creates a room** (otherwise a stranger could flood data into an arbitrary `room_name`). Only the initiator's first delivery has create semantics, see below |
| Body too large | `413` | Over the 8 KiB limit |
| Room message count at the limit | `429` + `Retry-After` | Limit is 100 messages |
| Malformed | `400` | JSON parsing failed or a required field is missing |

**When a room is created (must be explicit, otherwise it is ambiguous)**:

```
Initiator starts →  first POST /room/{rn}  →  the relay finds the room missing, so it **creates** it and delivers
              (a room that has since been DELETEd is never auto-created again —— "destroy is terminal" in §3.3.3 takes precedence)

Responder POST /room/{rn}  →  if the room does not exist, return 404
              (the responder never creates a room, which stops strangers from flooding data into an arbitrary room_name)
```

> The criterion is **the role of the delivering side**: the first `POST` with `from: "i"` has create semantics; a `POST` with `from: "r"` does not create. Implementations distinguish them by the `from` field of the message body.
>
> ✅ **Measured and checked (2026-10): the original reasoning was wrong, and a defect of our own was fixed along the way.**
>
> The original text said: "the room name is 256-bit and unguessable, so the real risk is zero —— to squat it you would have to know the password first."
> **That reasoning does not hold**: the room name is indeed un*guessable*, but it **is in the link** (64 hex characters).
> Someone who has the link but not the password does not need to guess —— and "tell the other side the link and the password separately" is exactly how this product is used.
>
> Measured (`_lab/probe-relay-preempt.mjs`, using the real `RelayClient` + a local relay):
>
> | Situation | Room state | Old behaviour | Now |
> |---|---|---|---|
> | An attacker creates the room and occupies `seq 0` | `nextSeq=1`, all garbage | The sender **silently skipped the manifest** → the receiver failed to decrypt | Report `ROOM_TAKEN` explicitly and tell the user to start again |
> | **The creation response was lost on the way back** (no attacker) | `nextSeq=0`, empty room | The sender **silently skipped the manifest** → the receiver waited 2 minutes and timed out | Deliver the manifest again; the transfer proceeds normally |
>
> The second row is not a security problem, it is a **reliability defect**: the old implementation only checked
> `created.created` inside `open()`, and if it was false it assumed "the room is already ready" and skipped delivery. But "the room already exists" has **two**
> completely opposite meanings —— ① I just created it myself (the response was lost, the room is empty) ② someone else got there first (there is something in the room).
> The trigger condition is quite ordinary: the response to the initial `POST` is lost on the way back. And by then the user has already sent the link out.
>
> **The criterion now is "is there anything in the room"**, see `open()` in `src/relay/client.js`:
> `nextSeq === 0` → case ① (deliver the manifest again); `nextSeq > 0` → case ② (report `ROOM_TAKEN` and abort).
> `ROOM_TAKEN` is not on the retryable list —— retrying ten thousand times still leaves the room someone else's, and only makes the user wait through four pointless backoff rounds.
>
> **The residual, accepted limitation**: whoever has the link can still stop that session from starting (denial of service).
> There is no plan to plug this further, because it requires the attacker to have the link first, and the link is itself a credential;
> anyone who really has the **password** does not need DoS at all —— they can simply decrypt everything.
> Today's improvement is "fail clearly and with guidance", not "impossible to fail".


#### 3.3.2 `GET /room/{room_name}?cursor=N`

**Long polling must be implemented**, rather than returning empty immediately:

- On receiving the request, if there are no messages after `cursor`, the relay **holds it for up to 25000 ms**
- If a new message arrives in that time → return `200` + the message array immediately
- If there is no message within 25000 ms → return `204 No Content`, and the client **immediately re-issues** the same request
- The response body is an **array** of receipts (it may contain zero or more):

```json
[ { "cursor": 1, "msg": { } }, { "cursor": 2, "msg": { } } ]
```

- The client's `cursor` starts at `0` (pulling every message in the room)
- The client **must** process them in ascending `cursor` order and deduplicate by `(from, seq)`

> **Unverified**: whether Cloudflare Workers impose a per-request wall-clock limit on HTTP requests that would cut a 25-second long poll short (the free-tier CPU time limit and wall-clock waiting are two different things, but it needs measuring to confirm that holding for 25 seconds is not disconnected early by the platform). If it is disconnected, lower the hold limit to the measured safe value and keep the semantics "the client retries immediately on receiving `204`" unchanged.

#### 3.3.3 `DELETE /room/{room_name}`

Called by the initiator after a normal transfer ends; the semantics are **immediate destruction**:

- Delete all messages and the room state
- Idempotent: `204` is returned even if the room does not exist
- **Destroy is terminal**: a later `POST` to the same `room_name` returns `404` and **must not** recreate the room automatically

> This rule matters: it guarantees that "burn after use" cannot be quietly undermined by "a later request recreating the room".

### 3.4 Room lifecycle and limits

| Parameter | Value | Description |
|---|---|---|
| `ROOM_TTL` | `900000` ms (15 minutes) | Counted from the **last** `POST` or `GET` |
| `ROOM_MAX_MSGS` | `100` | Above that, `429` |
| `ROOM_MAX_BODY` | `8192` bytes | Limit for a single message |
| `GET_HOLD` | `25000` ms | Long-poll hold limit |
| Rate limiting | 60/minute per IP (`GET`), 20/minute (`POST`) | Above that, `429` + `Retry-After` (**unverified**: the exact thresholds need adjusting to what the Worker platform can do) |

**The relationship between TTL and "destroy when done"**: the TTL is a **backstop**, not the normal path. The normal path is the initiator calling `DELETE` itself once the transfer ends. The TTL only covers "the other side never came back" or "the process was killed".

### 3.5 Message type enumeration (closed set)

`FLICKER/1` defines the following 7 types. **This is a closed set**, and no implementation **may** add a type that carries file content.

| `type` | Direction | Purpose | Key `body` fields |
|---|---|---|---|
| `HELLO` | Both ways | Announce presence, role and suite list | `suites[]`, `token?`, `endpoints[]?` |
| `AUTH_REQ` | Responder → initiator | Challenge + chosen suite | `suite`, `nonce_r`, `mac_r` |
| `AUTH_OK` | Initiator → responder | Response + session confirmation | `nonce_i`, `sid`, `mac_i` |
| `ENDPOINT` | Initiator → responder | Tell the other side how to connect directly to the initiator | `urls[]`, `expires_in` |
| `READY` | Responder → initiator | Connected to the transport layer, requesting the start | `transport`, `resume_at?` |
| `ERROR` | Both ways | Error notification | `code`, `detail?`, `fatal` |
| `BYE` | Both ways | Normal end; the room can be destroyed | `reason` |

#### 3.5.1 `HELLO`

```json
{
  "suites": ["FLICKER/3", "FLICKER/1"],
  "token": "7f3a9c1e4b8d2a60",
  "endpoints": ["https://192.168.1.5:8443"],
  "agent": "flicker/0.1.0 node24 win32"
}
```

| Field | Required | Description |
|---|---|---|
| `suites` | yes | Suite list in **descending strength order** |
| `token` | no | One-time access token. Needed only when L0 serves the receive page from the relay (§4.4.2) |
| `endpoints` | no | The initiator's candidate reachable addresses. Used only in rendezvous mode (§3.6) |
| `agent` | no | Implementation identifier, purely diagnostic. **The responder must not change its behaviour based on it** |

#### 3.5.2 `ENDPOINT`

```json
{
  "urls": ["https://192.168.1.5:8443", "https://[2408:...]:8443"],
  "expires_in": 600
}
```

| Field | Required | Description |
|---|---|---|
| `urls` | yes | Ordered by **descending reachability priority** (public IPv6 → LAN → public IPv4:port) |
| `expires_in` | yes | Seconds. The responder should not try after this |

The responder **tries each of** `urls` **in order**; the first one whose TLS handshake succeeds and whose `GET /session` returns 200 wins. If all fail → `ERROR(E_NO_ROUTE)`, and the UI gives actionable advice (switch to the LAN / set up port forwarding).

#### 3.5.3 `ERROR`

```json
{ "code": "E_MAC_MISMATCH", "detail": "attempt 2 of 5", "fatal": false }
```

| Field | Required | Description |
|---|---|---|
| `code` | yes | See the error code table in §8 |
| `detail` | no | Human-readable supplement; **must not contain the password, keys, file contents or file names** |
| `fatal` | yes | `true` = destroy the session immediately; `false` = retryable |

> **Sanitising `detail` is a hard requirement.** Both the relay and the browser console may log it.

### 3.6 Direct mode without a relay (LAN / port forwarding)

The rendezvous layer is **optional**. When the responder can already reach the initiator directly, **L1 is skipped entirely**:

```
Direct mode:
  Responder ──GET /session──> initiator HTTPS service   (instead of HELLO; gets salt/suites/sid directly)
  Responder ──POST /auth───> initiator                  (instead of AUTH_REQ)
  Responder <── 200 + nonce_i, mac_i ── initiator       (instead of AUTH_OK)
  Responder ──GET /chunk───> initiator                  (L5 data plane)
```

**A consistency requirement at the protocol level**: the handshake payload fields in direct mode are **exactly the same** as in rendezvous mode (the same `suite`, `nonce_r`, `mac_r`, `nonce_i`, `sid`, `mac_i`); they are merely carried in HTTP request/response bodies instead of relay messages. That way:

- The same `lib/handshake.js` can be used in both modes
- Adding the relay does not require writing new cryptographic code
- Tests can cover one carrier, and the other is covered automatically

| Mode | Trigger condition | Needs a relay | Data plane |
|---|---|---|---|
| **LAN direct** | Both sides on the same segment (the sender prints the LAN address) | No | `https-chunk` direct |
| **Port forwarding / public IPv6** | The initiator has a reachable public address | No | `https-chunk` direct |
| **Rendezvous (relay)** | Neither of the above is reachable | **Yes** | `https-chunk` direct (the relay tells them the address) |

> Note the last row: **even when the relay is used, the data plane is still direct.** The relay's only job is "let both sides learn the other's address"; it never enters the data path (§3.1).

### 3.7 Station-local UI endpoints (explicitly outside this protocol)

Under the station model, the program starts an additional **local UI service** on `127.0.0.1` (for the GUI front end, see option C in §2.2 of `架构决策.md`).

**This protocol specifies nothing about its behaviour.** Reasons:

- It serves only the local browser and does not communicate across machines, so **there is no interoperability problem** and defining it has no value
- It may change frequently with interface requirements; writing it into the protocol only creates a meaningless compatibility burden
- It and the data plane are **two independent HTTPS services**, with different ports, lifecycles and certificate policies

**The only protocol-level requirement**: the local UI service **must listen only on `127.0.0.1`** (or `::1`) and must not listen on `0.0.0.0`. Otherwise anyone on the same network segment can reach the station interface —— a major security defect. The reason this requirement is written into the protocol is that getting it wrong affects the security of the whole session, not just the usability of one interface.

> ✅ **Verified (2026-10)**: what §2.3 of `架构决策.md` requires —— "browser probing + explicit degradation + honest disclosure" ——
> has been implemented in the receive page, and follows the §2.3 principle that "**capability detection takes precedence over UA sniffing**":
>
> | Requirement | Implementation |
> |---|---|
> | Do not guess the browser name; measure the API | `const CAN_STREAM = typeof window.showSaveFilePicker === 'function'` |
> | When capability is insufficient, **warn prominently** rather than failing silently | On probe failure, insert a `note warn` banner on the **password screen** (not only after the transfer fails) |
> | State the consequence and the advice | Copy key `recv.go.noStreamWarn`: streaming-to-disk unsupported → transfers over about 1 GB may fail → use Edge/Chrome |
> | One more warning for large files | When `total > 900 MB`, swap the note for `recv.go.bigWarn` (with the concrete size) |
>
> See `test/protocol-facts.test.js` for the cases (it asserts the probe method, the banner position, the copy keys, and that "UA sniffing is not allowed").


---

## 3R. Relay forwarding layer (the cross-network scheme actually used)

> This chapter records the cross-network transport that is **implemented and has passed measurement**. For the full deployment
> instructions see [Relay deployment](中继部署.md); what follows is the protocol-level definition.

### 3R.1 Why it is needed

Rendezvous mode (§3) requires the sender to have an address the receiver can reach. On this machine all three options were
measured and none held (CGNAT + no global IPv6), so the data **continues to go through the relay**.
The cost is that the relay carries all the bandwidth; the benefit is that it **depends on no hole-punching success rate**.

### 3R.2 Endpoints

```
POST   /r/:room              create the room (idempotent)
POST   /r/:room?seq=N        put message number N (one at a time; seq is given by the caller)
POST   /r/:room/batch        put a batch of messages (seq is assigned by the **server** in arrival order)
GET    /r/:room?seq=N        take message number N (without deleting it)
POST   /r/:room/ack?upTo=N   prefix-acknowledge and delete
GET    /r/:room              room status
DELETE /r/:room              destroy the room
GET    /health               health check + **capability declaration** (no side effects, for readiness probes)
```

The room ID `:room` = **64 hexadecimal characters** (128 bit), derived from the password via HKDF
(`HKDF(V, "flicker/1/room")`). It appears only after the `#` in the link, and
**the browser does not send the fragment to the server**. Knowing the room name ≡ knowing the password,
so the relay needs no second authorisation mechanism (the earlier "authorisation key registration" scheme had a
first-come-first-served race and has been abandoned).

### 3R.3 Message format

The room carries opaque bytes, whose first byte is a type tag:

```
0x01 + salt(16) + iv(12) + tag(16) + ciphertext   manifest (the salt is placed together with the encrypted manifest)
0x02 + tag(16) + ciphertext                       one file chunk
```

The `/batch` request body is several messages concatenated in order, each preceded by a **4-byte big-endian length**:

```
[4B len][msg][4B len][msg]...
```

A batch holds at most 64 messages; the single-message ceiling is covered by "Chunk size and capability negotiation" below.

**Chunk size and capability negotiation (new in 2026-10, backwards compatible)**

One message is one file chunk, so "the single-message ceiling" is exactly "**the largest chunk**".
That ceiling is **not a protocol constant**: a relay may accept more, but it must **declare** its own
ceiling, and the sender picks the chunk size from it.

| Location | Field | Meaning |
|---|---|---|
| `GET /health` | `maxMessageBytes` | The largest single message (in bytes) the relay accepts. Also carries `ok: true` and `protocol: 1` |
| `POST /r/:room` (without `seq`, create/idempotent) | `maxMessageBytes` | The same value, delivered with the create response (the sender always goes through it, so no extra request) |

The rules:

1. **The protocol guarantees** `1 MiB + 17` (a 1 MiB chunk plus the type byte and the 16-byte authentication tag).
   Every conforming relay must accept a message of that size.
2. A relay **may** declare more; this project's deployments default to `2 MiB + 17`
   (measured: at a 195 ms round trip and a 29.5 MB/s link, a 1 MiB chunk gives 18.9 MB/s end to end,
   2 MiB gives 26.3 MB/s, and 4 MiB adds nothing).
3. The sender takes `min(the chunk size it wants, the declared ceiling − 17)` and clamps it into `[64 KiB, 8 MiB]`.
4. **When the field cannot be read (old relay, non-JSON response, probe failure) it always falls back to `1 MiB + 17`.**
   That rule is mandatory: it is what keeps "upgrading the client" from killing every already-deployed old relay
   (which would otherwise answer 413).
5. The receiver takes no part in the negotiation —— the chunk size travels in the manifest's `files[].chunkBytes`
   and it simply decrypts accordingly (the IV is derived from the chunk index alone and the AAD binds only the file
   index, the chunk index, the total chunk count and the plaintext length, **none of which depend on the chunk size**).

### 3R.4 Delivery model: pull-based + in-flight window

```
seq 0        manifest —— placed when the room is established
seq 1..N     chunks —— delivered by window, default window 8
```

**Why "one POST per batch" rather than "N concurrent `?seq=N`"**:
the relay requires strictly ordered delivery, and the arrival order of concurrent requests is not guaranteed, so they
inevitably hit `409 BAD_SEQ`; worse, the server reports **the same** expected sequence number to all the colliding
requests, so their retries collide again. Letting the server assign sequence numbers one by one inside a batch is
the only clean way to make "strictly ordered" and "high throughput" coexist.

**What the window means**: a window of 1 is stop-and-wait, with throughput deadlocked at `chunk size ÷ round-trip delay`.
Measured at 195 ms that gives 4.72 MB/s; with window 8 + batch delivery it becomes **20.75 MB/s (4.4×)**.
`--window 1` falls back to stop-and-wait. The cost: at most 8 MiB of in-flight ciphertext exists on the relay at one time.

### 3R.5 Four criteria (each settled only after hitting the pit)

| Criterion | What happens if you violate it |
|---|---|
| The sequence number to deliver next comes from the server's `nextSeq`, not from a local counter | When the local counter disagrees with the server, it reports "sequence not contiguous" |
| `ack` is a **prefix delete**, and after the delete there is **no renumbering** | Earlier, the prefix was deleted and the rest renumbered, so every sequence number the receiver had recorded shifted |
| The completion criterion is `ackedBase >= total`, not `posted >= total && pending === 0` | When the receiver has taken the last message but has not yet acked it, this falsely reports completion and destroys the room —— that piece of data can never be obtained |
| **Before destroying, wait for the in-flight batch to finish being delivered** | `putBatch` yields control while it is `await`ing a chunk read (it is not atomic). If the user clicks "cancel" at that moment, DELETE reaches the server **before** that batch POST: the room is deleted, the following POST then gets 404, and a **normal cancellation** is reported as a relay error. The fix: `destroy()` first waits for the in-flight batch to finish before deleting the room, and the delivery loop re-asks the abort criterion on every round |

> The fourth was caught by an end-to-end test using **exact ordering assertions** —— you cannot see it by reading
> the code, because every line looks correct on its own.

### 3R.6 Where "destroy when done" lands on the relay

| Moment | What happens |
|---|---|
| Each message is acked | The relay deletes it at once (prefix delete) |
| The transfer completes | The sender does `DELETE /r/:room` |
| 15 minutes of inactivity | The whole room expires (TTL backstop) |
| The relay process restarts | Every room disappears (**messages live only in memory; nothing is written to disk**) |

`test/relay-protocol.test.js` checks that `relay/worker.js` contains no KV / D1 / R2 /
Durable Objects —— anyone who adds a persistence facility will fail it, which reminds them to re-examine this promise.

---

## 4. Session layer (Handshake)

### 4.1 Preconditions and inputs

| Input | Source | Description |
|---|---|---|
| Password `P` | Typed in the initiator's terminal; typed on the responder's page | Both sides must match exactly (case- and space-sensitive) |
| Salt `S` | Randomly generated by the initiator (16 bytes) | Must be conveyed to the responder: embedded in the link fragment, or returned by `GET /session` |
| `suite_id` | The negotiation result of §2.5 | |
| `suite.protocol` | The constant `"FLICKER/1"` | The domain-separation prefix that goes into the MAC |

### 4.2 Key derivation (two phases)

```
Phase 1 (expensive, done only once):
    V = suite.pdf(P, S)                       // FLICKER/1: PBKDF2-SHA256, 600000 rounds, 32 bytes

Phase 2 (cheap, derive three mutually unrelated keys from V):
    K_room = suite.kdf(V, "room")             // room name; never used as an encryption key
    K_auth = suite.kdf(V, "auth")             // handshake MAC
    K_enc  = suite.kdf(V, "enc")              // file encryption (as the input to K_job)

    // session-level key (after the handshake completes, see §4.5)
    K_job  = HKDF-Expand(HKDF-Extract(salt = "", IKM = K_enc), info = SID, L = 32)
```

**Why `K_job` exists**: `K_enc` is derived from the password, so **the same password pair + the same `S`** (which
will hardly ever happen, but could in theory be constructed by force) would yield the same key. Binding `SID` into
`K_job` guarantees that **every session's encryption key is unique**, which rules out cross-session replay entirely.
`K_job` is the key actually used for chunk encryption; `K_enc` serves only as its input.

**Why only three keys (a design that was rejected)**: we once considered deriving an extra `K_aux = kdf(V, "aux")` as
a fourth key "reserved for future SAS use". **That design was rejected**, because of a deadlock:

- If `K_aux` is **not** part of the wire format (and it is not —— it never appears on the wire), then whether a `FLICKER/1` implementation derives it has **no effect whatsoever** on interoperability
- Therefore "derive it now" can neither force future implementations to derive it too, nor stop future implementations from switching to a different label
- The result: its only effect today is to compute 32 extra bytes inside each process, and a future suite will still have to redefine it in its own specification

**Conclusion**: reserving a label is ineffective insurance. When a fourth key is needed in the future, it will be
defined by the **specification of the new suite** (for example `FLICKER/4` mandating `K_aux = kdf(V, "aux")`), and
since suite negotiation already decides which suite is used, old implementations are not dragged into it. This is
exactly why the suite layer exists —— **compatibility does not have to be bought with "pointless extra work done in advance"**.

> This is recorded here to stop a later contributor from "helpfully" adding `K_aux` back.

### 4.3 Handshake message sequence (rendezvous mode, complete)

```
   Initiator A (Node)                      relay                      Responder B (browser)
        │                                    │                                │
        │  [phase 0] generate S (16B), P, negotiate the suite list            │
        │            compute V, K_room → room_name                            │
        │                                    │                                │
        │── POST /room/{room_name} ──────────>│  HELLO{suites,token?}          │
        │                                    │<──── POST /room/{room_name} ───│ HELLO{suites}
        │                                    │                                │
        │<── GET long poll ───────────────────│  gets B's HELLO                │
        │                                    │                                │  [phase 1] read S from the link
        │                                    │                                │  compute V, K_room, K_auth
        │                                    │                                │  negotiate suite (B decides)
        │                                    │                                │  generate nonce_r (32B random)
        │                                    │                                │
        │                                    │   mac_r = HMAC(K_auth,         │
        │                                    │       "flk1-recv" ‖ suite_id   │
        │                                    │       ‖ "recv" ‖ nonce_r)      │
        │                                    │                                │
        │                                    │<──── POST ─────────────────────│ AUTH_REQ{suite,nonce_r,mac_r}
        │<── GET long poll ───────────────────│                                │
        │                                    │                                │
        │  [phase 2] recompute K_auth from the **local V**                     │
        │            recompute mac_r and **compare in constant time**          │
        │            mismatch → failure counter +1, send ERROR(E_MAC_MISMATCH) │
        │            match → generate nonce_i (32B random)                     │
        │            SID = SHA-256(nonce_r ‖ nonce_i)[0..16)                   │
        │            K_job = HKDF(K_enc, SID)                                  │
        │                                                                      │
        │           mac_i = HMAC(K_auth, "flk1-send" ‖ suite_id ‖ "send" ‖ nonce_i ‖ SID)
        │                                    │                                │
        │── POST ───────────────────────────>│  AUTH_OK{nonce_i,sid,mac_i}    │
        │                                    │───────────────────────────────>│
        │                                    │                                │
        │                                                                     │  [phase 3] verify mac_i (constant time)
        │                                                                     │            compute SID, K_job
        │                                                                     │            failure → ERROR(E_MAC_MISMATCH)
        │                                                                     │
        │── POST ───────────────────────────>│  ENDPOINT{urls,expires_in}     │
        │                                    │───────────────────────────────>│
        │                                    │                                │
        │<═══════════ L2 transport direct (the relay leaves the data path) ═══│
        │                                    │                                │
        │<── GET /session ───────────────────┼────────────────────────────────│
        │─── 200 {sid, suite, salt, manifest_ct, ...} ─────────────────────>│
        │<── POST /auth (direct re-check) ───┼────────────────────────────────│   optional, see §4.7
        │<── GET /chunk?seq=N ───────────────┼────────────────────────────────│
        │─── 200 ciphertext block ───────────┼───────────────────────────────>│
```

#### 4.3.1 The precise definition of the MAC (byte by byte)

```
MAC_RECV_DOMAIN = "flk1-recv"     // ASCII, 9 bytes: 66 6C 6B 31 2D 72 65 63 76
MAC_SEND_DOMAIN = "flk1-send"     // ASCII, 9 bytes
ROLE_RECV       = "recv"          // ASCII, 4 bytes
ROLE_SEND       = "send"          // ASCII, 4 bytes

mac_r = HMAC-SHA-256(
          key  = K_auth,
          data = MAC_RECV_DOMAIN ‖ suite_id_ascii ‖ ROLE_RECV ‖ nonce_r
        )

mac_i = HMAC-SHA-256(
          key  = K_auth,
          data = MAC_SEND_DOMAIN ‖ suite_id_ascii ‖ ROLE_SEND ‖ nonce_i ‖ SID
        )
```

| Component | Why it is required |
|---|---|
| `MAC_*_DOMAIN` | **Domain separation**. It prevents a MAC from the recv direction being replayed into the send direction (without it, the two directions have the same MAC input structure, differing only in the nonce, which leaves an opening) |
| `suite_id` | Binds the negotiation result → makes the downgrade attack of §2.6 detectable |
| `ROLE_*` | Role binding. Prevents a bidirectional reflection attack |
| `nonce_r` / `nonce_i` | Freshness. Random for every session → replay-resistant |
| `SID` (in `mac_i` only) | Makes the initiator commit to "the final identifier of this session". The responder can already compute `SID` before receiving `mac_i`, so it can verify it |

> **`nonce_i` appears only inside `mac_i`; `nonce_i` itself is sent in the clear with `AUTH_OK`.** That is safe: `nonce_i` is not a secret; its job is freshness. Security comes from `K_auth`, and `K_auth` never goes on the wire.

> ### ✅ The divergence has been handled (2026-10, see §4.5.1)
>
> The passage above is the **design intent**. Since 2026-10 the implementation uses **two named constructions**,
> described in detail (with the trade-offs) in §4.5.1:
>
> ```
> v2 (default, suite-bound): mac_r = HMAC(K_auth, "FLICKER/1\nrecv\n" ‖ nonce_r)
>                            mac_i = HMAC(K_auth, "FLICKER/1\nsend\n" ‖ nonce_i)
> v1 (old-peer compat):      mac_r = HMAC(K_auth, "flicker/1/recv\n" ‖ nonce_r)
>                            mac_i = HMAC(K_auth, "flicker/1/send\n" ‖ nonce_i)
> ```
>
> **Third-party implementers, please note**: a new peer should implement v2; **implementing only v1 still interoperates
> with old versions**, but it cannot obtain the downgrade protection of §2.6 (v2 is where "the negotiation result goes
> into the MAC" actually lands).
>
> Two other points still differ from the first paragraph of this section: the literal value of `MAC_*_DOMAIN`
> (`flk1-recv` / `flk1-send`), and whether `SID` is concatenated into `mac_i`. That is a **protocol evolution that has
> not been decided yet**, not a typo —— putting `SID` into the MAC requires making `SID` derivable first (today it is
> generated randomly after authentication), which reaches further.
> Until that decision is made, **the divergence between this document and the implementation is stated openly** ——
> letting someone implement to the document and then fail to connect is far worse than an ugly document.

> #### 4.5.1 The two handshake MAC constructions and downgrade protection (implemented 2026-10)
>
> **Background**: §2.6 requires that "downgrade protection comes from binding `suite_id` into the authenticated
> material". But implementations that know only the old construction are already out in the field (in particular **the
> receiver page hosted by the relay**: an old relay means an old page), and changing the bytes outright would make every
> old deployment report "password mismatch" to every other one. So there are two named constructions plus an **echo**:
>
> | Construction | MAC input | Used for |
> |---|---|---|
> | `v2` | `utf8(suite_id ‖ "\n" ‖ role ‖ "\n")` ‖ nonce | The default. The suite id goes into the authenticated material |
> | `v1` | `utf8("flicker/1/" ‖ role ‖ "\n")` ‖ nonce | **The bytes shipped in 0.1.0**, only for interoperating with old peers |
>
> **Flow** (the challenge-response of LAN mode; `role` = `recv` / `send`):
>
> 1. The sender **offers** in the `/api/auth/start` response: `macProfiles: ["v2","v1"]` (a new optional field)
> 2. The receiver picks the first construction it recognises, computes its MAC with it in `/api/auth/finish`,
>    and **echoes it truthfully** as `macProfile`
> 3. The sender verifies using **the echoed construction**, and returns its own answer under the same one
>    (the response also carries `macProfile`, which the receiver checks against)
>
> **The downgrade-detection criteria** (the same idea as TLS's downgrade sentinel):
>
> | What arrives | What the sender does |
> |---|---|
> | An echo of `v2` | Normal (the bound construction is in use) |
> | **No echo at all** | Treated as an **old peer**: continue on `v1`, but record `macProfile='v1'` and **warn explicitly in the UI** that "downgrade protection does not hold for this session" |
> | An echo of `v1` (while I offered `v2`) | **Abort** with `ERROR(E_DOWNGRADE)`, saying "the negotiation was tampered with, possibly a man in the middle" —— it **must not** degrade into "password mismatch" |
> | Any other echo | Abort (`BAD_PROFILE`) —— anything unrecognised is refused, never "best effort" |
>
> **What this protection does not cover (state it plainly; it is not a cure-all)**:
>
> - **In relay mode the receiver page is hosted by the relay.** A malicious relay can simply replace the page code ——
>   at that point no protocol-level protection means anything. What this mechanism stops is an **honest but
>   version-skewed** peer and a **man in the middle on the link**, not "the other endpoint's code was swapped".
> - Relay mode has **no challenge-response** (the room name is derived from the password and the manifest is AEAD under
>   the session key), so there is no MAC to bind there. The good news: a different suite ⇒ different KDF labels ⇒
>   **a different room name** ⇒ the receiver finds no room —— in relay mode the suite is **implicitly bound**.
> - An attacker who can rewrite both sides' offers can still make both sides agree on a weak suite consistently
>   (that requires controlling the link in both directions without breaking the MAC —— which is beyond "negotiation
>   downgrade").

### 4.4 Distribution of the salt `S` and the token `token`

`S` must reach the responder, but **must not** reach unrelated parties outside the relay (although leaking `S` is not
fatal, it weakens resistance to precomputation).

#### 4.4.1 LAN / direct mode (preferred)

`S` is provided by the initiator **inside the connection**: the response body of the responder's `GET /session`
carries `salt`. The link itself contains only the address and the token:

```
https://192.168.1.5:8443/?k=7f3a9c1e4b8d2a60
```

#### 4.4.2 Relay-hosted page mode

The receive page is hosted by the relay, so `S` must arrive **with the link** (**it must not** go in the relay's URL
path or query —— that would be written to Worker logs):

```
https://<relay>/#k=<room name 64 hex>&s=<salt 32 hex>
              └─ URL fragment: the browser does not send it to the server
```

| URL fragment | Meaning |
|---|---|
| `k` (64 hex) | The room name, derived from the password; the relay uses it to find the room |
| `s` (32 hex) | The salt `S` (16 bytes) |

> **Why a fragment rather than a query**: a URL fragment (after `#`) **never appears in the HTTP request**, so it does not enter the relay's access log. This is the only safe channel for getting `S` and `token` to the browser.
>
> ~~**Unverified**: putting `token` and `S` in the same fragment means……~~
>
> ✅ **Verified (and there is a test guarding it)**: after the relay-hosted page obtains the fragment, it **does not write it into any persistent storage**.
> The only place on the page that writes storage is the language preference, and the receiver uses `sessionStorage` (gone when the tab closes).
> See "credentials in the link are never written into any storage (the fragment is read but not stored)" in `test/receiver-page.test.js`.
>
> The original question is kept here for the record: putting `token` and `S` in the same fragment means "whoever has the link"
> has both at once —— which matches the purpose of a one-time token (the link is itself the credential),
> but only on the premise that the page never writes it to disk; otherwise a "one-time" credential becomes something
> lying on disk that can be dug out again.

#### 4.4.3 Semantics of the one-time token `token`

| Rule | Description |
|---|---|
| Generation | Randomly generated by the initiator, **16 bytes**, encoded as **base64url** (22 characters, goes into the link's `?k=`) |
| Purpose | Lets the responder (or the relay-hosted page) prove to the initiator "I am the one who got the link" |
| Consumption | Voided at the **first `GET /`** (opening the page); any visit after that returns `410 TOKEN_USED`. `GET /api/session` only **checks**, it does not consume |
| Failure | A wrong `token` → `403 TOKEN_INVALID`, and it **does not consume** a consumption opportunity (so guessing cannot push a legitimate user out) |

> ✅ **The exception "later requests on the same connection do not count as a new consumption" has been deleted (measured and checked 2026-10).**
>
> It was never implemented, and it **should not** be:
>
> 1. **The problem it was meant to solve does not exist.** The original text justified it as "so that resume is not blocked by the token" ——
>    but resume uses **`SID`**, not `token`. `consumeToken()` is called in exactly one place, `GET /` (the page itself)
>    (see `src/server.js`), and it never takes part in chunk downloads.
> 2. **It would make behaviour non-deterministic.** Whether a browser refresh reuses the same TCP connection depends on
>    the current state of keep-alive, on proxies, and on the browser's own policy —— so "can I continue after a refresh"
>    becomes a behaviour that works sometimes and not others. **Working sometimes is worse than failing deterministically**:
>    users cannot form an expectation, and we can neither document it nor test it.
> 3. Measurement confirms it is now **deterministic**: even when the same keep-alive connection is explicitly reused,
>    the second `GET /?k=…` always returns `410 TOKEN_USED` (see
>    `test/protocol-facts.test.js`). And the page already carries the notice "this page will not be accessible again after a refresh"
>    (`UI设计.md` §2.2 ④); §7 of `设计文档.md` states the same thing.

### 4.5 Final definition of the session ID and subkeys

```
SID   = SHA-256(nonce_r ‖ nonce_i)[0 .. 16)          // the first 16 bytes
K_job = HKDF-SHA-256(salt = "", IKM = K_enc, info = SID, L = 32)
```

| Quantity | Length | Purpose |
|---|---|---|
| `SID` | 16 bytes | Session identifier; goes into every chunk's AAD; goes into the manifest |
| `K_job` | 32 bytes | **The actual chunk encryption key** (the key for AES-256-GCM) |

**Destruction requirement**: `V`, `K_auth`, `K_enc`, `K_job`, `nonce_r` and `nonce_i` are all overwritten with `fill(0)` when the session ends (see chapter 6 of `设计文档.md`).

### 4.6 Failure handling

| Situation | Behaviour |
|---|---|
| `mac_r` mismatch | The initiator does `failCount++`; replies `ERROR(E_MAC_MISMATCH, fatal=false)`; does **not** enter L5 |
| `mac_i` mismatch | The responder does `failCount++`; replies `ERROR(E_MAC_MISMATCH, fatal=false)`; does **not** enter L5 |
| `failCount >= 5` | The initiator sends `ERROR(E_TOO_MANY_FAILURES, fatal=true)` and **destroys the session immediately**: zero all keys, close the listener, `DELETE` the room, exit the process |
| Replay (the same `nonce_r` appearing a second time) | Treated as a failed attempt, `failCount++`, reply `E_REPLAY_DETECTED` |
| Handshake timeout | Not completed within **60 seconds** of receiving `AUTH_REQ` → `ERROR(E_HANDSHAKE_TIMEOUT, fatal=true)` |
| Total session timeout | **600 seconds** (10 minutes) from generating the password → destroy |

**Extra delay during the handshake (mandatory)**: after every `E_MAC_MISMATCH`, the initiator **must** wait before responding

```
delay_ms = min(1000 * 2^(failCount-1), 8000)
```

that is, 1s, 2s, 4s, 8s, 8s. The purpose is to stop online brute-force enumeration from covering a meaningful search space within 5 attempts.

> **Note**: this delay applies only during the **handshake phase** (handling `AUTH_REQ`), and **must not** be imposed on L5 data-chunk requests, which would badly hurt normal throughput.

### 4.7 Handshake in direct mode (identical fields)

In direct mode the rendezvous layer is skipped, but the **handshake payloads are exactly the same**:

| Rendezvous mode | Direct mode |
|---|---|
| `HELLO` in `POST /room/{rn}` | `{sid?, suite, salt, suites, manifest_ct}` in the `GET /session` response |
| `AUTH_REQ` in `POST /room/{rn}` | The `POST /auth` request body: `{suite, nonce_r, mac_r}` |
| `AUTH_OK` in `POST /room/{rn}` | The `POST /auth` response body: `{nonce_i, sid, mac_i}` |

**The `GET /session` response body in direct mode** (**consistent with the implementation, checked 2026-10**):

```json
{
  "suite": "FLICKER/1",
  "salt": "<BASE64, 16 bytes>",
  "room": "<64 hex, the room identifier; for logging and UI display only, not the SID>",
  "manifest": { "iv": "<BASE64>", "ct": "<BASE64>", "tag": "<BASE64>" },
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000 },
  "chunkBytes": 1048576
}
```

> ⚠️ **This section previously disagreed with the implementation and has been corrected to match it (2026-10).** The original listed
> six fields, `protocol` / `suites` / `session` / `manifest` (a BASE64 string) / `files` / `bytes`,
> while the implementation sends the six above. The differences are explained one by one, because each has a reason:
>
> | Original document field | Implementation | Reason |
> |---|---|---|
> | `protocol` | Only `suite` | The two fields say the same thing, so keep one. The version number used for negotiation is inside `suite` |
> | `suites` (the negotiation list) | Absent | **Suite negotiation is not implemented**. `FLICKER/1` is the only suite, and pretending there is a negotiation list would only make clients write superfluous code |
> | `session` (16 hex, for display) | `room` | The same purpose, renamed. `room` is also used for the address in relay mode, so one name serves both |
> | `manifest` (a BASE64 string) | An `{iv, ct, tag}` object | The three things are sent separately, so the client does not have to split a base64 blob. **In relay mode the wire format concatenates them** (salt‖iv‖tag‖ct, see §3.2), and that is to save a round trip; direct mode has no such constraint |
> | `files` / `bytes` (plaintext digest) | **Not sent** | See below |
> | — | `kdf` / `chunkBytes` | The client needs to know the iteration count and the chunk size in order to decrypt correctly; neither is a secret |
>
> #### About `files` / `bytes`: not sending them is more thorough than "require authentication first"
>
> The original said "`files` / `bytes` are a plaintext digest, used to show 'the other side wants to give you 3 files,
> 2.32 GB in total' **before the password is entered**", and noted below it as unverified that "returning a plaintext
> digest before authentication is a mild information leak, and the mitigation is to require `token` first".
>
> **The implementation chose a third path: these two fields are simply not sent.** The file count and total size are
> inside the **encrypted manifest**, and the manifest key is derived from the password —— so someone who has the link
> but not the password sees nothing. That is more thorough than "authenticate first, then hand it over", and it matches
> exactly what `使用手册.md` §10.4 promises the user:
> "all you can see is a page asking for the password, **no file information at all** —— not even the file names or the number of files".
>
> The cost is that **the password entry page cannot show "how many files, how large"** (`UI设计.md` §2.2 ① once required
> showing the file list, and that item has been corrected to match the implementation). What is gained: when the link is
> forwarded to an unrelated person, they do not even know how many files there are.
> In this product, "you can see nothing without the password" is the core of the promise, and it matters more than
> "seeing the count in advance".
>
> ✅ **Confirmed by measurement (2026-10)**: before authentication, `GET /session` returns `403 TOKEN_INVALID`, the
> response body contains **no** digest field at all; and even with a correct token, if the page was not opened first,
> it is still 403. See `test/protocol-facts.test.js` for the cases.

---

## 5. Data plane (chunks / IV / AAD / resume / backpressure)

### 5.1 The definition of `seq` (a single 64-bit integer)

```c
seq = (fileIndex << 16) | chunkIndex      // transmitted after big-endian BE64 encoding
```

| Bit field | Width | Range | Meaning |
|---|---|---|---|
| High 48 bits | 48 | `0 .. 281474976710655` | `fileIndex`: the file's ordinal in the manifest (starting at 0) |
| Low 16 bits | 16 | `0 .. 65535` | `chunkIndex`: the chunk's ordinal inside the file (starting at 0) |

**Two hard limits follow from the low 16 bits**:

| Limit | Value | Consequence |
|---|---|---|
| Maximum chunks per file | `65536` | Above that, `E_FILE_TOO_LARGE` |
| Maximum bytes per file | `65536 × 1 MiB = 64 GiB` | As above |
| Maximum files per session | `2^48` (theoretical) | In practice bounded by the manifest size and memory limits |

> A 64 GiB per-file limit is sufficient for this project's positioning (hundreds of MB to tens of GB). If it ever needs
> to be exceeded, the way is to **add a suite** (`chunkSize` is a suite member) or add a new `seq` encoding; it **must not**
> be quietly changed to a 4-byte chunk number —— that would break the wire format.

#### 5.1.1 Implementation warning: `seq` must use `BigInt` in JavaScript

`seq` is a **64-bit unsigned integer**, while JavaScript's bitwise operators (`<<`, `|`, `>>>`) **force their operands
to 32-bit signed integers**. So the following is **wrong** and will silently produce wrong results once `fileIndex >= 32768`:

```js
// ✗ Wrong: JS bitwise operations truncate to 32 bit
const seq = (fileIndex << 16) | chunkIndex;

// ✓ Correct: use BigInt throughout to keep 64-bit semantics
const seq     = (BigInt(fileIndex) << 16n) | BigInt(chunkIndex);
const buf     = Buffer.alloc(8);
buf.writeBigUInt64BE(seq);                       // serialisation on the Node side
const back    = buf.readBigUInt64BE(0);          // deserialisation on the Node side
const fileIdx = Number(back >> 16n);             // only narrow to Number after checking the range
const chunkIdx= Number(back & 0xFFFFn);
```

The browser side must likewise use `BigInt` (WebCrypto's `additionalData` is a byte string, so pass it in **after**
serialisation; do not do bitwise arithmetic on the numeric domain).

> **Suggested unit test**: take `fileIndex = 65535` and `chunkIndex = 65535` and assert that the round-trip
> serialisation/deserialisation is consistent. That case catches the 32-bit truncation defect above.

**Reserved value**:

| `seq` | Meaning |
|---|---|
| `0xFFFFFFFFFFFFFFFF` (all ones) | **Manifest only** (§6.3) |
| Everything else | A normal data chunk |

### 5.2 Frame format (single chunk)

```
┌──────────────────────┬───────────────────────────────┬───────────────┐
│ seq (8 bytes BE)     │ ciphertext (chunkLen bytes)   │ tag (16 bytes)│
└──────────────────────┴───────────────────────────────┴───────────────┘
```

| Field | Length | Description |
|---|---|---|
| `seq` | 8 | `BE64(seq)`, **in the clear** (the receiver needs it to derive the IV and AAD) |
| `ciphertext` | `chunkLen` | Plaintext length `chunkLen`, equal to `min(chunkSize, fileSize - chunkIndex × chunkSize)` |
| `tag` | 16 | GCM authentication tag, output by the AEAD |

**Total frame length** = `8 + chunkLen + 16`.

> A cleartext `seq` is not a leak: it exposes only "the file ordinal and the chunk ordinal", while "the number of files
> and the total size" were a plaintext digest anyway (§4.7). **File names are unrelated to it, and are already encrypted.**

### 5.3 IV derivation (12 bytes, deterministic)

```
IV = ivSalt(4 bytes) ‖ BE48(seq)(6 bytes) ‖ [0x00] * 2
```

| Part | Length | Source |
|---|---|---|
| `ivSalt` | 4 | **Randomly generated once per session**, handed down in the `GET /session` response body (field `iv_salt`, BASE64). **It must stay constant for the lifetime of the session** —— if it were regenerated during a resume, the receiver could not recompute the IV |
| `BE48(seq)` | 6 | The high 48 bits of `seq`, big-endian. It holds exactly the 48-bit effective range of `seq` |
| Padding | 2 | All zero |

**Why it is constructed this way**:

| Design point | Reason |
|---|---|
| Determinism (not random per chunk) | On resume, the receiver must be able to **recompute independently** the IV of any `seq`. If the IV were random, it would have to travel with each frame and be stored additionally |
| `ivSalt` random per session | Guarantees that the IV spaces of **different sessions** (even with the same password) do not overlap. This is an **absolute requirement** of GCM: IV reuse under the same key destroys GCM's security outright |
| The IV maps one-to-one onto `seq` | As long as `K_job` is unique (guaranteed by §4.2), each IV appears only once under the same key |

> **Two uniqueness preconditions that must both hold**: ① `K_job` is unique per session (achieved by mixing in `SID`); ② `ivSalt` is random per session (4 bytes = 2³² of space, while the number of sessions is far below that, so the collision probability is negligible). **If either one is violated, GCM fails catastrophically**. Both must be written as assertions + tests in the implementation.

### 5.4 AAD contents (28 bytes)

```
AAD = SID(16 bytes) ‖ BE64(seq)(8 bytes) ‖ BE32(totalChunks)(4 bytes)
```

| Part | Length | What it binds |
|---|---|---|
| `SID` | 16 | **Session binding**: moving a chunk across sessions fails |
| `BE64(seq)` | 8 | **Coordinate binding**: reordering, reshuffling, or splicing across files fails |
| `BE32(totalChunks)` | 4 | **Length binding**: truncation attacks fail (if an attacker drops the tail and claims the file is shorter, `totalChunks` changes and the AAD no longer matches) |

**These 28 bytes are the core of the whole data plane's security.** They pin "this piece of ciphertext" to "which chunk of which file of which session, and how many chunks that file has". Any movement is rejected by the GCM tag at decryption time.

> `totalChunks` = `ceil(fileSize / chunkSize)`, supplied by the manifest.

### 5.5 Chunk size and memory

| Quantity | Value | Description |
|---|---|---|
| `chunkSize` | `1048576` (1 MiB) | A suite member |
| Maximum single ciphertext frame | `8 + 1048576 + 16 = 1048600` bytes | |
| Sender buffer | 1 chunk (zeroed after reuse) | See chapter 6 of `设计文档.md` |
| Receiver memory | `O(chunkSize)`, **independent** of file size | Achieved by streaming to disk (§5.7) |

**The chunk-size trade-off (recorded here for future tuning)**:

| Smaller (e.g. 256 KiB) | Larger (e.g. 4 MiB) |
|---|---|
| Finer resume granularity; more requests, so the fixed per-chunk overhead is a larger share | Fewer requests and higher throughput; a resumed retransmission wastes more |

1 MiB is the compromise between the two. **Note that `chunkSize` is a suite member, so different suites may use different chunk sizes**, but within one session it must be consistent.

### 5.6 Resume (RESUME)

When the receiver reconnects after a broken connection, it expresses "how much I already have" through the transport layer:

**Mode A: `https-chunk` (the only implementation in P0/P1/P2)**

```http
GET /chunk?seq=12345 HTTP/1.1
```

- The receiver **requests chunk by chunk**, so "the chunks already received" are naturally known to it —— no RESUME message is needed; it simply **skips the completed `seq` values** and the transfer continues
- This is a structural advantage of `https-chunk` over streaming transports: **resume comes for free**

**Mode B: `wss-stream` (reserved)**

In streaming mode there are no natural chunk boundaries, so it must be negotiated explicitly:

```json
{ "type": "RESUME", "at": { "fileIndex": 2, "chunkIndex": 1400 } }
```

| Field | Description |
|---|---|
| `fileIndex` | Continue from this chunk of this file |
| `chunkIndex` | The **next chunk** that has been successfully decrypted and written to disk (that is, the lowest sequence number that needs resending) |

**The receiver's precondition for resume**: only a chunk that has been **signature-verified and written to disk** counts as "received". A chunk that "arrived over TCP but failed GCM verification" **must never** be counted as complete.

**The interaction between writing to disk and resume (important)**:

| Situation | Behaviour |
|---|---|
| Using `showSaveFilePicker` + `createWritable` | Writing is streaming (append), so on resume it **can** continue appending from the previous position —— provided the browser keeps the same `FileSystemFileHandle` and the page has **not been refreshed** |
| The page is refreshed | The `FileSystemFileHandle` is lost → **must start from the beginning**. Storing the handle in IndexedDB looks like it could save this, but it **cannot** —— see the note below |
| The Blob fallback path (Firefox/Safari) | Everything is in memory → a refresh loses it all, so resume is impossible |

> ⚠️ **Cannot be verified on this machine (needs real Chromium + a manual refresh)**: the **availability** of a
> `FileSystemFileHandle` restored across refreshes after being stored in IndexedDB. Note that even if it works,
> it **still does not solve resume** —— the real obstacle is not the handle but that every call to `createWritable()`
> **truncates the file**, and the browser has no interface for "keep writing from byte N".
> This has been investigated at the browser-API level and written up item by item as item 5 in
> `路线图.md` (which also explains why it is only arguable on Chromium's streaming-to-disk path).
> The current behaviour is explicit: after a refresh you must start over, and the page carries the notice
> "this page will not be accessible again after a refresh".


### 5.7 Write-to-disk path (receiver side)

| Browser | Path | Memory footprint | Limit |
|---|---|---|---|
| Chromium desktop | `showSaveFilePicker()` → `createWritable()` → `write()` per chunk → `close()` | `O(chunkSize)` | Bounded by disk (tens of GB are feasible) |
| Firefox / Safari | Accumulate `BlobPart[]` → `new Blob()` → `URL.createObjectURL()` → `<a download>` | `O(fileSize)` | **Cannot be verified on this machine**: the exact threshold floats with device memory and needs measuring on real hardware; the implementation does not depend on that number —— above 900 MB the page warns explicitly and suggests Edge/Chrome |

Detection method: `typeof window.showSaveFilePicker === 'function'`. **When it is unavailable the warning must come in advance**, rather than crashing halfway through a transfer.

### 5.8 Backpressure and ACK

**Under `https-chunk` backpressure holds naturally**: each chunk is an independent HTTP request, and the receiver **receives no data unless it requests the next chunk**. Therefore:

- **No explicit ACK message is needed** —— the request itself is the ACK
- **No buffer watermark control is needed** —— the browser will not pull more data than it can handle
- Concurrency control on the sender: **serial is recommended** (one chunk at a time). Concurrency can raise throughput (especially with a large RTT), but it complicates the accounting of "completed chunks" and raises the receiver's memory peak

| Concurrency | Recommendation |
|---|---|
| `1` (serial) | **Default**. Throughput is decided by bandwidth; on a LAN it can reach 100+ MB/s |
| `2~4` | An optional optimisation. **Not enabled, and not needed** —— see the measured conclusion below |

> ✅ **Settled with measured data (2026-10)**: this item asked "should we do concurrent delivery for the sake of RTT?"
> The answer is no: in relay mode the bottleneck is **not the concurrency level but the in-flight window**.
> Measurement showed that widening the window from 1 to 8 (stop-and-wait → batch delivery) already gives **4.72 → 20.75 MB/s (4.4×)**,
> and the in-flight window is itself another form of "concurrency" (`/batch` puts several messages at once, with the server assigning sequence numbers).
> Raising concurrency further would only complicate the accounting of "completed chunks" and lift the memory peak at both ends,
> for a gain far smaller than the 4.4× already obtained. See the ninth supplementary chapter of `路线图.md` and
> `_lab/bench-window-sweep.mjs` (the measured curve for windows 1/2/4/8).


**`wss-stream` mode (reserved) needs an explicit ACK**, because streaming sends have no natural backpressure:

```json
{ "type": "ACK", "seq": 12345 }        // cumulative acknowledgement: all chunks <= seq are verified and written to disk
```

The sender keeps an `inflight` count and waits for an ACK when the window is full. A window of `8` chunks (8 MiB) is suggested.
(For the actual implementation in relay-forwarding mode see §3R.4: the same window semantics, but delivering in batches with "one POST per batch".)

### 5.9 Transport layer interface (unified across both modes)

```
transport.request(seq) → frames          // https-chunk: GET /chunk?seq=N
transport.resume(at)   → void            // wss-stream: send RESUME
transport.ack(seq)     → void            // wss-stream: cumulative acknowledgement
transport.close()      → void
```

**L5's code depends only on this interface**, so adding a transport implementation does not require changing the chunking or encryption logic.

---

## 6. Application layer: manifest

### 6.1 Manifest structure

**What follows is the real output of the implementation** (`toWire()` in `src/manifest.js`; generated from the real code and pasted in, 2026-10):

```json
{
  "v": 1,
  "suite": "FLICKER/1",
  "sentAt": "<ISO timestamp>",
  "files": [
    {
      "kind": "file",
      "name": "旅行记录 2024.mp4",
      "rel": "旅行记录 2024.mp4",
      "size": 2480340992,
      "chunks": 2366,
      "chunkBytes": 1048576,
      "sha256": "<64 hex>",
      "chunkHashes": ["<64 hex>", "…"]
    }
  ],
  "totalBytes": 2480340992,
  "totalChunks": 2366,
  "gift": null
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `v` | number | yes | Manifest format version, currently always `1`. **Reject anything you do not recognise** (`fromWire` throws rather than guessing) |
| `suite` | string | yes | The negotiation result, `"FLICKER/1"` |
| `sentAt` | string | yes | ISO timestamp, for display only |
| `files[]` | array | yes | **The array order is the transfer order**; the receiver accumulates `chunks` to work out each file's starting chunk number |
| `files[].kind` | string | yes | `"file"` / `"flicker-station-sea"` / `"flicker-station-source"` (the last two are gifts, see §9) |
| `files[].name` | string | yes | The file name (the last segment of `rel`), for display only |
| `files[].rel` | string | yes | **Relative path**: the only basis for writing to disk, and **untrusted input**, see §6.2 |
| `files[].size` | number | yes | Size in bytes (an integer, `>= 0`) |
| `files[].chunks` | number | yes | `size === 0 ? 1 : ceil(size / chunkBytes)` —— **an empty file still occupies one chunk** (an integer, `>= 1`) |
| `files[].chunkBytes` | number | yes | The chunk size. **No longer always 1048576**: the sender chooses it from the relay's declared ceiling and the link (see §3R.3), and the receiver chunks accordingly —— the IV and AAD do not depend on the chunk size, so changing it does not affect decryption |
| `files[].sha256` | string | yes | 64 hex characters, the SHA-256 of the whole file's plaintext |
| `files[].chunkHashes` | string[] | yes | The SHA-256 (hex) of each chunk's plaintext; **the length must equal `chunks`** |
| `totalBytes` | number | yes | The sum of all `size` values |
| `totalChunks` | number | yes | The sum of all `chunks` values = the upper bound of the global chunk sequence number |
| `gift` | object \| null | yes | The gift summary, see §9; `null` when the transfer carries no gift |

> ⚠️ **This section used to disagree with the implementation and has been corrected to match it (2026-10).**
> The original text described a different set of fields: `protocol` / `session` / `sid` / `created` / `totalFiles` /
> `files[].path` / `files[].index` / `files[].merkle` / `files[].mode` / `files[].mtime`,
> plus a `files[].gift` boolean on every file —— **none of which exist in the implementation**.
> A client written against the old document will **fail to parse** (`fromWire` recognises `v` and `rel`).
>
> A few differences that are easy to trip over, spelled out one by one:
>
> | Old document | Implementation | Note |
> |---|---|---|
> | `protocol` | only `suite` | The two fields say the same thing, so only one is kept |
> | `session` | `room` | Only appears in the `GET /session` response (§4.7); **the manifest has no such field** |
> | `files[].path` | `files[].rel` | The same thing. The implementation calls it `rel` (relative path), and the rules in §6.2 apply to it |
> | `files[].index` | none | The index is simply the **array position** (the receiver processes files in order), so a separate field is neither necessary nor desirable —— sending one introduces the possibility of "field and position disagree" |
> | `files[].merkle` | `files[].chunkHashes` | The implementation sends a **per-chunk hash array** and the receiver verifies chunk by chunk; there is no Merkle root |
> | `files[].mode` / `mtime` | none | **Permission bits and modification time are not preserved** (see `行为与运行.md`: the receiver writes file contents only) |
> | `files[].gift` | `files[].kind` | Gifts are distinguished by `kind` (`flicker-station-*`), not by a boolean |
> | — | `totalChunks` / `chunkBytes` | The receiver needs them to compute chunk sequence numbers and memory usage |

**Unknown fields must be ignored** (§0.1). The receiver **must not** raise an error because an unrecognised field appears in the manifest.

### 6.2 Path safety rules (**a security boundary, not a UI detail**)

`files[].rel` is **untrusted input** (the initiator may be under an attacker's control, or the user may have sent a malicious directory by mistake). Before writing to disk the receiver must perform **all** of the following checks; if any one fails, it is `ERROR(E_PATH_UNSAFE, fatal=true)` and the whole session is aborted:

| Rule | Check |
|---|---|
| R1 Not an absolute path | Reject leading `/`, `\` |
| R2 Not a drive path | Reject anything matching `^[A-Za-z]:` |
| R3 Not a UNC path | Reject a leading `\\` or `//` |
| R4 No upward traversal | Reject any path segment equal to `..` |
| R5 No current-directory segment | Reject any path segment equal to `.` (judged after normalisation) |
| R6 No NUL | Reject anything containing `\u0000` |
| R7 Length | Reject a single path segment over 255 bytes, or a whole path over 4096 bytes |
| R8 Reserved names (Windows) | Reject segment names matching `CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]` (case-insensitive, including the form with an extension) |
| R9 Illegal characters (Windows) | Reject content containing `< > : " \| ? *` |
| R10 Trailing | Reject a segment ending in a space or `.` (Windows truncates them silently) |
| R11 Separator unification | First normalise `\` to `/`, then validate segment by segment |
| R12 Deduplication | The same normalised path appearing twice → `ERROR(E_MANIFEST_DUPLICATE_PATH)` |

**Normalisation order (must be followed strictly)**:

```
1. Normalise separators: replace every '\' with '/'
2. Split on '/'
3. Drop empty segments (handles "a//b")
4. Apply R4/R5/R6/R8/R9/R10 to each segment
5. Re-join with '/'
6. Apply R1/R2/R3/R7/R11/R12 to the result
```

> **The order matters**: normalise before validating, otherwise input such as `a/./../b` slips past the per-segment checks.

#### Implementation notes (the only implementation is in `src/path-safety.js`)

| Decision | Content | Why |
|---|---|---|
| **R9/R10 rewrite rather than reject** | Illegal characters become `_`, and a trailing dot or space is dropped | On Linux/macOS `a:b.txt` and `report.` are **perfectly normal filenames**; the sender sees nothing wrong with them under its own platform rules, so it writes them into the manifest as they are. If the receiver simply rejected them, a **completely normal** transfer would fail as a whole |
| **R8 rejects, and does not get around it by renaming** | `CON` cannot be let through as `_CON` | Renaming deceives the user (he thinks he received `CON`, but that name cannot be created on Windows at all) |
| **R5 has two modes** | The receiver (`strict`) rejects a bare `.` segment; the sender folds it away | When the sender scans its own files, `./dir/a.txt` is quite natural; the receiver is looking at untrusted input, and rejects it per the protocol |
| **R7 counts bytes, not characters** | A single segment >255 **bytes**, the whole path >4096 **bytes** | A Chinese character is 3 bytes in UTF-8. The old implementation used "1024 characters", which is stricter than this protocol —— where implementation and protocol disagree, the protocol wins |

| **R12's comparison key = NFC + case folding** | See below | See below |

#### R12 and Unicode normalisation (**measured and confirmed; no longer an unverified item**)

When comparing whether two paths "would land on the same file", the key must first undergo **Unicode NFC
normalisation** and then **case folding**. The reason is not theoretical fastidiousness, but three situations that
really exist and all of whose consequences are **silently losing a file**:

| Situation | Source | Consequence of not handling it |
|---|---|---|
| `café`(NFC) versus `café`(NFD, `e`+U+0301) | macOS HFS+/APFS uses NFD | On a macOS receiver they are **the same file**, and the later write overwrites the earlier one |
| `Readme.md` versus `readme.md` | Windows / macOS are case-insensitive by default | As above |
| `a:b.txt` versus `a_b.txt` | The former is rewritten to `a_b.txt` on Windows by R9 | The rewrite itself is right; what is wrong is **not noticing the resulting name collision** |

**The receiver must find the conflict and abort before the transfer starts** (`E_MANIFEST_DUPLICATE_PATH`),
rather than discovering it when writing to disk —— by then the user has waited through tens of GB, and the
overwrite is **unannounced**: the interface says "transfer complete" while one file is missing from the disk.

The comparison key is used only for **judging**; it does not rewrite the name to be written (the user sees the same
name as the sender). The sender's deduplication (`a.txt` → `a (1).txt`) uses **the same key**, otherwise the sender
thinks there is no conflict while the receiver writes out only one file —— exactly the most typical bad outcome of
"two implementations".

#### The copy of the rules inside the page is **inlined**, not a second implementation

What really decides the name that lands on the user's disk is the code running in `web/receiver.html`,
not `src/manifest.js` in Node. **The two places used to each have their own copy, with different rules**:

```
src/manifest.js      the 12 rules are basically all there
web/receiver.html    rel.replace(/[<>:"|?*\x00-\x1f]/g, '_')      ← just one line
```

The consequence was that the same manifest passed in the Node tests and lost files in the browser.
The rules are now written once, in `src/path-safety.js`, and inlined into the page **verbatim** by
`gen/inline-path-rules.mjs`, with `--check` guarding the synchronisation (the same approach used for the i18n and
PWA inlining). `test/path-safety.test.js` executes that script from the page inside a **sandbox with no
`Buffer`/`process`** and compares its behaviour rule by rule against the Node copy —— merely checking that "both
sides have this function" is not enough; the two sides used to have their own implementations as well.

### 6.3 Encrypting and transporting the manifest

```
manifest_seq = 0xFFFFFFFFFFFFFFFF        (all ones, reserved)
manifest_pt  = UTF-8(JSON(manifest))
manifest_aad = SID(16 bytes)              (no seq, no totalChunks —— see below)
manifest_ct  = AEAD.seal(K_job, IV_manifest, manifest_pt, manifest_aad)

IV_manifest  = ivSalt(4) ‖ [0xFF] * 6 ‖ [0x00] * 2      (12 bytes)
```

**What is special about `IV_manifest`**: in the IVs produced by the general formula of §5.3, the middle 6 bytes equal `BE48(seq)`. `IV_manifest` sets those middle 6 bytes to all `0xFF`, which is equivalent to `BE48(0xFFFFFFFFFFFF)`. So the condition for it to collide with a data-chunk IV is:

```
fileIndex = 0xFFFFFFFFFFFF      (that is, the high 48 bits of seq are all ones)
and the high 2 bytes of chunkIndex agree with the corresponding bits of 0xFFFF
```

And §5.1 already **forbids** `fileIndex` from approaching that value —— implementations must carry the assertion `fileIndex < 0xFFFFFFFFFFFF`. Under that constraint, `IV_manifest` **does not collide** with any data-chunk IV.

> **Implementation requirement**: this assertion is not "defensive programming" but one of the preconditions for GCM's security (the IV must not be reused under the same key). It must be written as a startup check + a unit test, not merely as a comment.

#### 6.3.1 The difference between the two AADs (must be kept straight; easy to get wrong)

The manifest and the data chunks use AADs of **different lengths**. This is deliberate, because the manifest has no
notion of "a chunk coordinate inside a file":

| Object | AAD length | Contents |
|---|---|---|
| **Data chunk** | 28 bytes | `SID(16) ‖ BE64(seq)(8) ‖ BE32(totalChunks)(4)` |
| **Manifest** | 16 bytes | `SID(16)` |

Both bind `SID` (so neither can be moved across sessions); the difference is that a data chunk also binds its
"coordinate" and the "file length".

> **Do not** pad the manifest's AAD to 28 bytes just to make the two the same length —— padding introduces the
> theoretical collision surface where "the all-zero AAD of some `seq`/`totalChunks` combination equals the
> manifest's AAD". **Keeping them different in length removes the ambiguity instead.**

**The manifest's transport paths (two)**:

| Path | When | Description |
|---|---|---|
| Inlined in the `GET /session` response | Direct mode | The receiver gets `manifest_ct` **before entering the password**; the file count and total size are supplied separately as a **plaintext digest** (§4.7) |
| As a chunk with the reserved `seq` | Rendezvous mode / streaming mode | In relay mode the manifest may also be inlined in `GET /session`, since the data plane goes direct anyway |

**The receiver's processing order (mandatory)**:

```
1. Get manifest_ct, iv_salt, salt, suite from GET /session
2. The user enters P
3. Compute V → K_auth / K_enc (this step may take time and needs a UI indicator)
4. Handshake (§4) → obtain SID, K_job
5. Decrypt manifest_ct, verify manifest.sid === SID (mismatch → E_SID_MISMATCH, abort)
6. Run all the path checks of §6.2 (failure → E_PATH_UNSAFE, abort)
7. Verify files[].chunks === ceil(size / chunkSize) (mismatch → E_MANIFEST_INVALID)
8. Begin the L5 transfer
```

> **Step 5 cannot be skipped**: it pins the manifest to this session, preventing the relay from mounting a
> substitution attack with the manifest of **another session** (although the relay cannot obtain `K_job`, the
> defensive check costs almost nothing).

### 6.4 Definition of the Merkle root

> ⚠️ **This section is the original design; `FLICKER/1` never adopted it (reviewed 2026-10).**
>
> The implementation contains **no Merkle tree at all** (searching `src/` and `web/` for `merkle` returns **0 hits**),
> and the manifest has **no `merkle` field** — per-chunk verification uses `files[].chunkHashes`
> (an array of per-chunk SHA-256 values), as §6.1's "old doc → implementation" table already states.
>
> So the leaf/inner/root construction below **is not part of the wire format**. The section is kept as a design
> record, and it explains where the conclusion came from (see the ✅ at the end of this section).
> **Implementing a Merkle root from this section is wasted work**: the other side neither sends the field nor
> verifies it.

```
Leaf layer:  leaf[i]  = SHA-256( BE32(i) ‖ BE32(chunkLen_i) ‖ plaintext_i )     i = 0 .. chunks-1
Inner layer: node     = SHA-256( left ‖ right )
        (with an odd number of nodes, the last node is **promoted directly**, not duplicated —— this avoids a CVE-2012-2459-style ambiguity)
Root:        merkle   = the final single 32 bytes
```

| Parameter | Value |
|---|---|
| `chunkLen_i` | `min(chunkSize, size - i × chunkSize)` |
| Empty file | `chunks = 0`, `merkle = SHA-256("")`, `sha256 = SHA-256("")` |
| Single-chunk file | `merkle = leaf[0]` |

**What the Merkle root was for** (original design):
- It lets the receiver **verify chunk by chunk** (a leaf hash can be verified as soon as one chunk arrives, without waiting for the whole file)
- It supports fine-grained recovery that "retransmits only the damaged chunk" (an optional P1 optimisation)
- `files[].sha256` is the whole-file check and `merkle` is the chunk-level check; **both must be verified** (the chunk-level half is actually carried by `chunkHashes`)

> ✅ **Settled (2026-10)**: this item asked "does tree-style chunk-by-chunk verification need authentication paths?"
> The answer is **no**; what `FLICKER/1` does is already sufficient:
> the receiver computes each leaf hash chunk by chunk and caches them, and once everything has arrived it recomputes
> the whole tree and compares it against the root in the manifest.
> In other words: a **chunk-level** tampering can be localised to the exact chunk (because every chunk is separately
> AEAD-authenticated, and the manifest carries `chunkHashes` per-chunk fingerprints), while the integrity of **the
> tree structure itself** is guaranteed by the root.
>
> Authentication paths are needed for the scenario "prove the validity of one chunk while holding only part of the
> chunks" (light clients / random access) —— this product **receives the whole file in one go**, so that scenario does
> not arise. If it ever had to be supported, the way would be to add a proof field to the manifest (in line with the
> extensibility rule of §0.1); that is an optional extension after P1, not a present gap.


---

## 7. Transport endpoints (the initiator's HTTPS service)

### 7.1 Endpoint table

> ⚠️ **This entire table was wrong once (corrected 2026-10)**: the paths were missing the `/api/`
> prefix, `/auth` is really two endpoints (`start` / `finish`), and `/api/manifest` and `/api/health`
> were not listed at all. A client written against that table would have got a **404 on every endpoint**.
> It is now verified row by row against a real service by `gen/check-send-protocol-doc.mjs`
> (it starts a plain-HTTP `TransferServer`, requests each path, and confirms it is not "no such interface").

| Method | Path | Authentication required | Role |
|---|---|---|---|
| `GET` | `/?k={token}` | **`token`, consumed right here** (§7.1.1) | Return the receiver HTML |
| `GET` | `/api/session` | Requires the `token` to be **already consumed** (else `403 TOKEN_INVALID`) | Return suite / salt / encrypted manifest / kdf / chunkBytes |
| `GET` | `/api/auth/start` | None (its whole purpose is to begin authentication) | Send the challenge + quote `macProfiles` |
| `POST` | `/api/auth/finish` | None (self-proving via MAC) | Take `{mac, challenge, macProfile}`, return `{sid, mac, macProfile}` |
| `GET` | `/api/manifest` | `SID` (see §7.2) | Return the encrypted manifest `{iv, ct, tag}` |
| `GET` | `/api/chunk?seq={N}` | `SID` | Return a single ciphertext frame (§7.3) |
| `POST` | `/api/done` | `SID` | The receiver declares completion |
| `GET` | `/api/health` | None | Readiness probe: plain-text `ok`; **no side effects, leaks no session information** |

> Two more that carry no session: `GET /index.html` is equivalent to `GET /`, and `GET /favicon.ico`
> returns `204`. Any other path/method → `404 {"error":"NOT_FOUND"}`.
>
> ⚠️ **The server does not check the HTTP method** (routing looks at the path only), so `GET /api/auth/finish`
> works too. The method column states what a **client should use**.

#### 7.1.1 Why `/api/session` only accepts the token and not `SID`

There is a **chicken-and-egg** ordering problem: `SID` is a product of the handshake, while the receiver must first
`GET /api/session` to obtain `salt`, `suite` and the encrypted `manifest` before it can start the handshake.

```
The receiver must GET /api/session first  →  then it can handshake  →  then it can get SID
         └─ at that moment it cannot possibly hold a SID yet
```

So the division of authentication must be exactly this:

| Endpoint | Authenticated by | Reason |
|---|---|---|
| `GET /` (the page) | **`token`**, and it is **consumed right here** | Proves "I hold the link"; at that moment `SID` does not exist yet |
| `GET /api/session` | Only requires the `token` to be **already consumed** | It does not consume the token itself — otherwise one page prefetch could burn the user's link |
| `GET /api/auth/start`, `POST /api/auth/finish` | **Nothing** (the handshake is itself the authentication) | Its security comes from the proof of knowledge of `mac_r`, not from transport-layer identity |
| `GET /api/manifest`, `GET /api/chunk`, `POST /api/done` | **`SID`** | The session is established; the session secret protects the data plane |

**The `token` is consumed at `GET /` (opening the page)**, not here (§4.4.3).
`GET /api/session` merely **checks** that it has already been consumed; an empty token, or a page that was
never opened → `403 TOKEN_INVALID`, and it must not degrade to "let it through unauthenticated".

### 7.2 Authentication method (how `SID` travels)

`SID` is a 16-byte secret (known only to the two sides). **The two services carry it differently**
(checked against the implementation 2026-10 — this section used to give only the header, which is wrong for the initiator's service):

| Service | How it travels | Where in the code |
|---|---|---|
| The initiator's service (§7) | **Query parameter** `?sid=<SID>` | `url.searchParams.get('sid')` (`src/server.js`); the receiver page builds its URLs that way (`web/receiver.html`), including the `sendBeacon` to `/api/done` |
| The receiver's service (§7R) | **Request header** `X-Flicker-Sid: <SID>` | `req.headers['x-flicker-sid']` (`src/upload-server.js`) |

**Both are verified with a constant-time comparison** (`timingSafeEqual`). A mismatch → `401 {"error":"BAD_SID"}`.
⚠️ A SID mismatch does **not** count towards `failCount` — that counter exists for **password guessing** (§4.6), not for SIDs.

> **Why not a Bearer token**: `SID` is itself the session secret; introducing a separate token would add state
> without any security gain.
>
> **About a future WebSocket (`wss-stream`, unimplemented)**: in that shape, the way `SID` travels would have to
> change to **first-frame authentication** (HTTP headers appear only once, at the handshake, and cannot be changed
> afterwards). This is an **envisaged extension point**, not a current gap —— it is recorded here only so that
> whoever builds it later knows this is where the work is, rather than leaving a TODO behind.


### 7.3 The `GET /api/chunk?seq=N` response

> ⚠️ **This section too was corrected against the implementation in 2026-10**: the response headers it used to
> give (`X-Flicker-Seq` / `X-Flicker-Len`), the `429` token bucket, and the `E_BAD_SEQ` / `E_UNAUTHORIZED` /
> `E_SOURCE_CHANGED` error codes **do not exist in the implementation** (that vocabulary belongs to the
> rendezvous design — see the note in §8.2). A client written against the old text would have read none of
> the headers and recognised none of the codes.

| Status code | Meaning | Response body |
|---|---|---|
| `200` | Success | A single ciphertext frame (§5.2), `Content-Type: application/octet-stream` |
| `401` | `SID` mismatch, or not authenticated yet | `{"error":"BAD_SID"}` / `{"error":"NOT_AUTHED"}` (§7.2) |
| `416` | `seq` is invalid or beyond `totalChunks` | `{"error":"RANGE"}` |
| `500` | The server failed to read the file (moved/deleted/changed) | `{"error":"INTERNAL"}` |

**Response headers** (`seq` is not echoed back — the client knows which `seq` it asked for):

```http
Content-Length: <ciphertext length>
X-Flicker-Tag: <BASE64(GCM tag)>
X-Flicker-File: <file index>
X-Flicker-Chunk: <chunk index within that file>
Cache-Control: no-store, no-cache, must-revalidate
```

> `Cache-Control: no-store` is a **security requirement**: any intermediate cache (browser cache, proxy) holding a
> ciphertext chunk would weaken "destroy when done". Although the ciphertext is itself encrypted, a cache outliving
> the session lifecycle contradicts the product's promise.
>
> The plaintext length has **no dedicated header**: the client derives it from the manifest's `chunkBytes` and
> `size` (`plainLen = ci === chunks-1 ? size - (chunks-1)*chunkBytes : chunkBytes`).

**There is no rate-limit response code.** Rate limiting (`--rate`) means the **sender deliberately slows down**
(`src/rate.js`: it sleeps before encrypting), not "accept it and answer `429`". So the server never returns
`429` and has no `Retry-After` — it simply goes slower.

### 7.4 TLS and certificate trust

The data plane must go over HTTPS. The reason is not the vague "it is more secure", but a **hard platform
constraint**: the receiver needs `crypto.subtle` (WebCrypto), and browsers expose it only in a **secure context**.

| Origin | Secure context? | `crypto.subtle` |
|---|---|---|
| `http://127.0.0.1` | ✅ Yes (loopback is listed by the specification as potentially trustworthy) | Available |
| `http://192.168.1.5` | ❌ No | **`undefined` → encryption is simply unavailable** |
| `https://192.168.1.5` | ✅ Yes | Available |

So the encrypted protocol **must** run over HTTPS, and the certificate must be accepted by the browser, otherwise
the whole main LAN scenario cannot work.

#### 7.4.1 Two certificate strategies

| Strategy | Approach | Status |
|---|---|---|
| **A. Manual trust bootstrapping** (the fallback) | Generate a self-signed certificate at runtime, the user manually clicks "Advanced → Proceed" in the browser, and the page gives step-by-step guidance | Behaviour is defined; the exact wording awaits P0 measurement |
| **B. Automatic session-level CA install/uninstall** (the goal of `架构决策.md`) | Generate a two-level structure (a session root CA + a server certificate issued by it) and install the **root CA** into the current user's trust store, uninstalling it on exit | ⚠️ **Failed measurement on this machine**, see §7.4.2 |

Strategy B's two-level structure is **necessary**: if you generated only a self-signed certificate and installed it
into the trust store itself, verification would fail with `DEPTH_ZERO_SELF_SIGNED_CERT`. It must be "the CA goes into
the trust store, and the server certificate is issued by that CA".

#### 7.4.2 Measured certificate-trust results on this machine (important; they do not match the expectation in `架构决策.md` §4.3)

> ✅ **Later progress (2026-10): this problem has been solved; what follows is the record of how it went at the time.**
> The root cause was that the **generated CA was missing the CA flag** (`basicConstraints` must carry `ca=1`) ——
> once that was added, real interactive verification on Windows + Edge 155 **passed with zero warnings**
> (three modes: headless / visible window / app window without an address bar; two addresses: loopback and a real LAN IP).
> So the ❌ marks in this section **do not describe the current behaviour**; they record what was seen back when that flag was missing.
> The conclusion and the evidence are in Q1 of §12.1 and in `_lab/实测报告-证书信任.md`.
>
> **Why this passage is still here**: it is a sample of "looks like a conclusion, is actually a wrong attribution" ——
> at the time we nearly wrote "browsers do not trust self-signed CAs" down as a platform limitation, when the real cause was one extension field we had omitted.

Measured **on this machine** (Windows 10 19044, non-administrator), three conclusions emerged:

**① Installing and removing from the current user's Root store with `certutil` really does not need administrator rights —— feasibility holds**

```
Is the current user an administrator?          No
certutil -addstore -user Root  exit code 0, certificates in the Root store 49 → 50, the certificate really is there
certutil -delstore -user Root  exit code 0, 50 → 49, fully restored
```

**② But PowerShell's `Remove-Item` cannot delete a certificate from the Root store**

```
Remove-Item Cert:\CurrentUser\Root\<thumbprint>
  → The operation is on user root store and UI is not allowed.
```

**This is an operational constraint that must be written into the implementation**: uninstalling the certificate
**can only** be done with `certutil -delstore -user Root <thumbprint>`, not with `Remove-Item`. What `架构决策.md`
specified is exactly `certutil`, and that is confirmed here —— but for a harder reason than expected: not "we are
used to it", but **no other way works at all**.

> **A reliability requirement follows from this**: uninstalling can only be done by invoking an external process.
> If the program is force-killed after installing the certificate (`taskkill` rather than `Ctrl+C`, a power cut, a
> crash), **no mechanism can guarantee the certificate is removed**, and an unrecognised root CA remains in the
> user's trust store forever.
>
> That directly contradicts the product promise of "destroy when done", and it is a **security-level** residue: an
> forgotten root CA whose private key is gone cannot be used to forge certificates, but its mere presence in the
> trust store would make the user uneasy.
>
> **Suggestion**: when installing, print the CA thumbprint and the uninstall command to the terminal and write them
> to a log file; at startup, **scan first for a leftover session CA from last time**, and if one is found, warn the
> user and offer one-click removal.

**③ After installing the root CA, the browser still refuses to connect —— the core experience of the target scheme was not achieved**

Test method (using a **fresh profile** for every combination, to rule out configuration caches):

```
1. Generate a session root CA + a 127.0.0.1 server certificate issued by it
2. Install the root CA with certutil -addstore -user Root
3. Start the Node HTTPS service (the private key is never written to disk, only held in memory)
4. Open https://127.0.0.1:8443/ with Edge (--headless=new) and dump the DOM
```

| Variant | Result |
|---|---|
| Baseline (CA in the trust store, new profile) | ❌ Refused |
| `--disable-features=NetworkServiceSandbox` | ❌ Refused |
| `--no-sandbox` | ❌ Refused |
| `--disable-features=CertificateTransparencyEnforcement` | ❌ Refused |
| Baseline repeated (to rule out caching) | ❌ Refused |
| **Control: `--ignore-certificate-errors`** | ✅ **Rendered successfully** |

The control holds, which proves that **the server, the private key, the certificate chain and the network path are
all correct**; the only variable is "whether the browser accepts the CA in the trust store". **The conclusion is: in
this machine's environment, installing the CA into the Windows current-user Root store is not enough to make Edge
accept that certificate.**

> **This cannot be generalised straight into "strategy B definitely does not work"**, because several variables were
> not ruled out:
> - Edge's `--headless=new` mode may not read the Windows trust store
> - Chrome/Edge on Windows are known to **cache certificate validation results**, so the browser process may need
>   restarting after a new CA is installed; this experiment used a fresh profile, but ran 5 instances one after
>   another on the same machine
> - Certificate Transparency (CT) policy, or details such as a missing `authorityKeyIdentifier` in the two-level chain
>
> **So the accurate verdict is: "the warning-free experience of strategy B (step 3 of `架构决策.md` §4.3) is not confirmed on this machine."**
>
> **It must be adjudicated by one real interactive verification** (use real Chrome, close it, install the CA, open it
> again, and confirm with your own eyes whether there is a warning). This is a **P0 blocker** (see §12.1 Q1).

#### 7.4.3 Implementation advice based on the measurements

1. **Use strategy A first in P0** (self-signed + bootstrapping), so the main path works and is not blocked by certificate problems
2. **Strategy B is a P2 goal**, but it must first pass interactive verification in a real browser before it is made the default
3. **The `--no-cert-install` switch is required**, not optional: some users will not accept any program modifying their certificate store, and the measurements on this machine show that this scheme is not reliable enough to be the only path
4. **Whichever strategy is used, the CA must be session-level, the private key must never touch disk** (held in memory only), and leftovers from last time must be cleaned up at startup (§7.4.2 ②)

| Mode | Certificate |
|---|---|
| LAN / port forwarding / public IPv6 | A session-level certificate (strategy A or B), including the `subjectAltName` for every local IP |
| Relay-hosted page | The relay provides a normal certificate; the data plane still uses the station's own session-level certificate |
| **The station's own GUI interface** (`127.0.0.1`) | **Needs no certificate** —— loopback is itself a secure context. The GUI and the data plane are **two different HTTPS services**; do not conflate them |

---

## 7R. Receive-mode endpoints (the receiver's HTTPS service, phone uploads)

> **Why this chapter exists**: §7 is "the initiator opens an HTTPS service and the other side **fetches**" (`GET /chunk?seq=N`).
> When a phone is the sender the direction flips — a phone cannot listen on a port (browsers cannot do it), so **the computer runs the service and the phone pushes chunks up** (`PUT /up/chunk?f=&c=`).
> Not one byte of the cryptography changes: the same `FLICKER/1` (§2), the same challenge–response with downgrade protection (§4), the same manifest encryption (§6.3), the same per-chunk IV/AAD binding (§5.3, §5.4).
> Only "who listens, who requests" and the names of 7 endpoints are new. Implementation: `src/upload-server.js` (HTTP layer), `src/recv.js` (certificate, link, destruction).

### 7R.1 How it divides work with §7

| | §7 initiator service | §7R receiver service |
|---|---|---|
| Who listens | The sender (the side holding the files) | The receiver (the side that wants them — here, the computer) |
| How the peer gets data | `GET /chunk?seq=N` — **pull** | `PUT /up/chunk?f=&c=` — **push** |
| Who sends the manifest to whom | Initiator → peer | Phone → computer |
| Who learns the manifest first | The peer (the encrypted manifest rides along with `GET /session`) | The computer (the phone POSTs it) |
| Cryptography | All of §2–§6 | **Identical, not one line changed** |
| Endpoint prefix | None (`/session`, `/auth`…) | `/up/` (`/up/session`, `/up/auth`…) |

**In one sentence**: both directions share L3 (suite) and L4 (session); only the carrying direction at L5 differs.

### 7R.2 Endpoint table

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/` | None | Returns the phone upload page (self-contained HTML, no secrets in it) |
| `POST` | `/up/session?k={token}` | **`token` only** | Sends the challenge + quotes limits; the phone derives keys from it |
| `POST` | `/up/auth` | None (this *is* the authentication) | The phone proves it knows the password; the computer answers with its own MAC and the `SID` |
| `POST` | `/up/manifest` | `SID` | Accepts the encrypted manifest; **checks everything checkable before any data flows** |
| `PUT` | `/up/chunk?f={fileIndex}&c={chunkIndex}` | `SID` | Pushes one ciphertext chunk; **idempotent** |
| `GET` | `/up/status` | `SID` | Which chunks have arrived (used to resume) |
| `POST` | `/up/finish` | `SID` | Finalises: whole-file digest check → rename into place |

> This table and `RECV_ROUTE_TABLE` in `src/upload-server.js` are **the same source**;
> `gen/check-recv-protocol-doc.mjs` compares them row by row — an endpoint added, missing, or
> spelled differently in the document makes it fail (that class of error leaves the local test
> suite fully green, and only trips up whoever writes a client from the document).

### 7R.3 Where `token` is consumed, and the split of authentication (differs from §7.1.1)

**The two modes consume `token` at different points**, and this is the easiest thing to get wrong:
the initiator's service in §7 consumes it at **`GET /` (opening the receiver page)** (`/api/session` only
checks, never consumes); receive mode consumes it the moment **`POST /up/session`** succeeds —
`GET /` (the page) **does not consume** it, because it is only a static HTML document that proves nothing.

| Endpoint | Authenticated by | Reason |
|---|---|---|
| `GET /` | Nothing | It is only an HTML page; no session secret is in it |
| `POST /up/session` | **`token`** | Proves "holds the link"; no shared key exists yet |
| `POST /up/auth` | **Nothing** (the handshake *is* the authentication) | Its security comes from knowing the password, not from transport identity |
| The other 4 endpoints | **`SID`** (`X-Flicker-Sid`, as in §7.2) | The session exists; the data plane is protected by the session secret |

`token` is the base64url of 16 random bytes (22 characters) and goes into the link as `?k=`.
**A second `POST /up/session` always returns `410 TOKEN_USED`** — there is no "same TCP connection does
not count as a new consumption" exception (reloading the page = new connection + spent token = 410;
that is deterministic behaviour, not a flake).

### 7R.4 The `POST /up/session` response

The request body is empty. On success (`200`):

```json
{
  "suite": "FLICKER/1",
  "salt": "ZkmFadmDN+pVRpeI54+bzA==",
  "challenge": "HLLzVkKjpcxukQXjsNxrDZpRyxWGjNGBqo+CCK02J4U=",
  "macProfiles": ["v2", "v1"],
  "limits": {
    "maxFiles": 5000,
    "maxBytes": 214748364800,
    "maxChunkBytes": 2097169,
    "maxPlainChunkBytes": 2097152
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `suite` | string | Always `"FLICKER/1"` (suite negotiation: §2) |
| `salt` | string | `BASE64(S)`, 16 bytes; the PBKDF2 salt (§4.2) |
| `challenge` | string | `BASE64(nonce_r)`, 32 bytes (§4.3) |
| `macProfiles` | array | Handshake MAC constructions this machine supports, in priority order (§4.3 downgrade protection) |
| `limits` | object | The limits this machine quotes; see the table below |

| `limits` field | Meaning |
|---|---|
| `maxFiles` | Maximum files in one session (5000 by default) |
| `maxBytes` | Maximum bytes in one session (200 GiB by default) |
| `maxChunkBytes` | Limit on **one on-the-wire message** (includes the 17-byte fixed overhead) |
| `maxPlainChunkBytes` | Limit on a **plaintext chunk** — the manifest's `chunkBytes` is bounded by this |

> **Why both chunk limits are quoted**: with only `maxChunkBytes`, a client has to subtract that 17
> itself (type byte + GCM tag) — an implementation detail a client has no business knowing.
> That is exactly where the 2026-10 on-device rehearsal tripped: the page declared its chunk size from
> `maxChunkBytes`, the server rejected everything on `+17`, and the symptom was "manifest rejected,
> not a single chunk sent". **A quote that the client must do arithmetic on will blow up on a real phone sooner or later.**

### 7R.5 `POST /up/auth`

The request body is JSON (≤ 4096 bytes) with fields **identical** to the direct-mode handshake of §4.3:
`mac` (`BASE64(mac_s)`), `challenge` (`BASE64(nonce_r)`), and `macProfile` (the construction being echoed, optional).
On success (`200`):

```json
{
  "sid": "9q3_vM3n0LQATNZhkMsspQ",
  "mac": "p6SUyxX+DDkvQwyT5F4KZtQ5RwSAbIWScDjzvvTM3lQ=",
  "macProfile": "v2"
}
```

| Field | Type | Meaning |
|---|---|---|
| `sid` | string | The session ID (16 random bytes, base64url in this implementation). Send it back **verbatim** in `X-Flicker-Sid` (§7.2) — a client need not understand its encoding |
| `mac` | string | `BASE64(mac_i)` — the computer proving it also knows the password; the phone **must** verify it (otherwise the other side may be a phishing page) |
| `macProfile` | string | The handshake construction actually used this time (`v2` / `v1`) |

> ⚠️ **The roles are reversed**: here the computer is the `receiver` and the phone is the sender.
> So the computer verifies `senderMac` and answers with `receiverMac`; the two directions are computed
> separately to defeat reflection (§4.5). A password mismatch gives `401 BAD_PASSWORD` and is counted
> per §4.6; the 5th failure destroys the session (`410 TOO_MANY_FAILURES`).

### 7R.6 `POST /up/manifest`

The request body is `iv(12) ‖ tag(16) ‖ ciphertext` (**the same order as §6.3**), AAD = `"flicker/1/manifest"`.
The plaintext is JSON — a **reduced form** of the §6.1 wire format (fields in the second table below).
On success (`200`):

```json
{
  "accepted": [
    { "index": 0, "rel": "note.txt", "renamedFrom": null },
    { "index": 1, "rel": "photo.bin", "renamedFrom": null }
  ],
  "skipped": [],
  "totalChunks": 3,
  "diskFree": 79984742400,
  "partSuffix": ".flicker-part"
}
```

| Field | Type | Meaning |
|---|---|---|
| `accepted` | array | Entries the computer **accepted**: `{index, rel, renamedFrom}` (`renamedFrom` non-null = renamed because of a collision) |
| `skipped` | array | Entries skipped: `{index, rel, reason}` (same name on disk and the user chose "skip") |
| `totalChunks` | number | Total chunks over the accepted part (the denominator of the progress bar) |
| `diskFree` | number\|null | Free bytes on the target volume; `null` when the filesystem cannot be queried |
| `partSuffix` | string | Suffix for a half-finished file; always `.flicker-part` |

The fields of the manifest **plaintext** (what the phone sends up):

| Field | Type | Meaning |
|---|---|---|
| `files[]` | array | One entry per file |
| `files[].index` | number | File index — the value of the `f` parameter (0-based) |
| `files[].rel` | string | **A single path segment only**: containing `/` or `\` gives `400 E_PATH_UNSAFE` |
| `files[].size` | number | Plaintext byte count |
| `files[].chunks` | number | Total chunks; must equal `ceil(size / chunkBytes)`, else `400 BAD_CHUNKS` |
| `files[].chunkBytes` | number | Plaintext bytes per chunk; must not exceed `maxPlainChunkBytes`, else `400 BAD_CHUNK_BYTES` |
| `files[].sha256` | string | Whole-file SHA-256 in `HEX`; recomputed and compared from disk during `finish` (§7R.9) |
| `totalBytes` | number | Sum of all file sizes |
| `totalChunks` | number | Sum of all chunk counts |

> **Why this manifest is smaller**: a phone can only pick files, never a folder (a browser limitation),
> so there is no `kind`, `name`, `chunkHashes`, `gift` or `sentAt` — directory-tree rebuilding and the
> program gift simply do not exist on this path. **That is not "not implemented yet"; this path does not need them** (§7R.12).
>
> The path rule is stricter than §6.2: after the 12 rules of `sanitizeRelPath`, **path separators are
> additionally forbidden**. Any hit **aborts the whole session** with **not a single byte written** —
> because every check happens at manifest time, before any data arrives.

### 7R.7 `PUT /up/chunk?f={fileIndex}&c={chunkIndex}`

The request body is `tag(16) ‖ ciphertext` (**tag first**, as in §5.2).
The IV and AAD algorithms are **exactly** those of §5.3 and §5.4 (AAD = `fileIndex ‖ chunkIndex ‖ totalChunks ‖ plainLen`).
On success (`200`):

```json
{ "ok": true, "f": 0, "c": 0 }
```

| Situation | Response |
|---|---|
| First time this chunk arrives | `200 {ok:true, f, c}` |
| **The same chunk resent** (phones retry all the time) | `200 {ok:true, already:true, f, c}` — **not rewritten**, idempotent |
| `f` is not in the manifest | `404 BAD_FILE_INDEX` |
| `c` is beyond that file's chunk count | `404 BAD_CHUNK_INDEX` |
| The ciphertext fails verification (GCM tag mismatch) | `400 E_CHUNK_AUTH`, and it is counted |
| Consecutive failures hit the cap (10 by default) | `400 TOO_MANY_BAD_CHUNKS`, **session destroyed** |

> **Per-chunk authentication is the only place on this path where corruption is caught on the spot**:
> a bad chunk is refused immediately and is not written to disk; the whole-file digest is only checked at
> `finish` (§7R.9). Both layers are needed — drop one and bad data gets called a success.
>
> **Why idempotence matters**: on a flaky network a phone resending is normal. Without it, a resend either
> errors out or writes the same chunk twice.

### 7R.8 `GET /up/status`

On success (`200`; below is a real state with every chunk received but `finish` not yet called):

```json
{
  "files": [
    { "index": 0, "rel": "note.txt", "chunks": 1, "received": 1, "receivedBytes": 25, "size": 25, "missing": [] },
    { "index": 1, "rel": "photo.bin", "chunks": 2, "received": 2, "receivedBytes": 69857, "size": 69857, "missing": [] }
  ],
  "totalChunks": 3,
  "totalBytes": 69882,
  "receivedChunks": 3,
  "receivedBytes": 69882,
  "finished": false
}
```

| Field | Type | Meaning |
|---|---|---|
| `files[]` | array | One row per accepted file |
| `files[].index` | number | File index (matches the `f` parameter) |
| `files[].rel` | string | The name it is being written under |
| `files[].chunks` | number | Total chunks |
| `files[].received` | number | Chunks received so far |
| `files[].receivedBytes` | number | Plaintext bytes received so far |
| `files[].size` | number | Total byte count declared for that file |
| `files[].missing` | array | Which chunk numbers are still missing; **at most 64 are listed**, for humans only |
| `totalChunks` / `totalBytes` | number | Totals over the accepted part |
| `receivedChunks` / `receivedBytes` | number | How much has arrived |
| `finished` | boolean | Whether `finish` has already been called |

> The phone page does **not** rely on this endpoint to decide which chunks to resend (it tracks what it sent
> itself — see `web/phone.html`); it uses it for two things: **telling the user honestly how much is left**
> after a reconnect, and aligning progress. A client that does want to resend should compute
> `chunks - received` — `missing` is truncated at 64 entries.

### 7R.9 `POST /up/finish`

The request body is ignored (the phone sends `{}`). This is where the computer runs the **final layer of
verification**. On success (`200`):

```json
{
  "done": [
    { "rel": "note.txt", "bytes": 25, "renamedFrom": null },
    { "rel": "photo.bin", "bytes": 69857, "renamedFrom": null }
  ],
  "failed": [],
  "skipped": []
}
```

| Field | Type | Meaning |
|---|---|---|
| `done` | array | Files that verified and were finalised: `{rel, bytes, renamedFrom}` |
| `failed` | array | Files whose **whole-file digest did not match**: `{rel, reason}` — the partial file is **deliberately left on disk** (see below) |
| `skipped` | array | Files skipped back at manifest time |

**The four finalisation rules** (all of them are criteria):

1. **Not one chunk may be missing**, otherwise `409 INCOMPLETE` (stating how many chunks and which file) — a missing chunk means "ask the client to resend", not "call it a success".
2. Verification **re-reads `.flicker-part` in disk order** to compute SHA-256 and compares it with the manifest's `sha256` — it **does not depend on the order chunks arrived in** (a wrong order is caught here too).
3. Pass → `rename` into the real name; fail → **no rename**, the `.flicker-part` stays put as evidence: it pollutes no normal file, and it is possible to see what happened.
4. Calling it again → `409 ALREADY_FINISHED`.

> **Data lands first; only the name comes last**: `.flicker-part` → real file is the single "finalisation"
> act in the whole flow. If a transfer is cut short, the disk gains one file with an obvious suffix and
> nothing else — a file that *looks* normal but holds bad content can never appear.

### 7R.10 Errors and status codes

The response body is the same as in §7: `{"error": "<code>", "message": "<one line for a human>"}`.

| Code | HTTP | When | What the client should do |
|---|---|---|---|
| `TOKEN_INVALID` | `403` | `?k=` missing or not matching | Ask the user to scan the code again |
| `TOKEN_USED` | `410` | `token` was already consumed once | Tell them to start again on the computer |
| `NOT_AUTHED` | `401` | An endpoint needing `SID` was hit before the handshake | Do §7R.5 first |
| `BAD_SID` | `401` | `X-Flicker-Sid` is wrong (**so is omitting it**: an empty string does not match either) | Handshake again. ⚠️ Reaching these endpoints **before** the handshake gives `NOT_AUTHED`, not `BAD_SID` |
| `CHALLENGE_MISMATCH` | `401` | `challenge` is not the one just issued | Abort (possible replay) |
| `BAD_PROFILE` / `E_DOWNGRADE` | `500` | An unknown construction was echoed / the quote was altered | Abort (§4.3 downgrade protection). ⚠️ See the note below: these two codes are **not registered** in the receive-mode mapping, so the status is the `500` fallback rather than `400` — treat it as "abort" and do not depend on the number |
| `BAD_PASSWORD` | `401` | The MAC the phone computed is wrong | Retry (case and spaces matter); the 5th failure destroys the session |
| `TOO_MANY_FAILURES` | `410` | The failure cap was reached (5) | Session is gone; start again on the computer |
| `DESTROYED` | `410` | The session was destroyed | Same as above |
| `BAD_MANIFEST` | `400` | The manifest will not decrypt (password mismatch or tampering) | Session destroyed; ask for a fresh start |
| `EMPTY_MANIFEST` | `400` | The manifest holds no files at all | Abort (were too few selected?) |
| `MANIFEST_TWICE` | `409` | The manifest was sent a second time | Client bug (the manifest is atomic) |
| `TOO_MANY_FILES` / `TOO_MANY_BYTES` | `413` | Beyond the limits quoted in `limits` | Select less and retry |
| `E_PATH_UNSAFE` | `400` | A file name has a separator or fails the 12 rules | **Aborts the whole session**; nothing was written |
| `E_MANIFEST_DUPLICATE_PATH` | `400` | Two entries collide in the manifest | Same as above |
| `BAD_CHUNK_BYTES` / `BAD_CHUNKS` | `400` | The chunk parameters are not self-consistent | Abort (the AAD binds the chunk count; forcing it through must fail) |
| `BAD_CHUNK` | `400` | The chunk request body is too short (< 16 bytes — not even a tag fits) | Abort; a correct client never triggers it |
| `NO_SPACE` | `507` | Free space < total × 1.1 | Refused **before any work**; free space and start over |
| `NO_MANIFEST` | `409` | A chunk was sent, or `finish` was called, before the manifest | Client is out of order (the manifest must come first) |
| `INCOMPLETE` | `409` | Chunks are missing at `finish` | `GET /up/status` first, then resend the missing chunks |
| `ALREADY_FINISHED` | `409` | `finish` called twice | Client bug |
| `E_CHUNK_AUTH` | `400` | One chunk failed authentication | Resend that chunk |
| `TOO_MANY_BAD_CHUNKS` | `400` | Consecutive bad chunks hit the cap (10) | Session destroyed |
| `BODY_TOO_LARGE` | `413` | The request body exceeds that endpoint's cap | Abort (a correct client never triggers it) |
| `NO_PAGE` | `404` | The service was configured without a page (API-only) | Only seen in self-tests and automation |
| `NOT_FOUND` | `404` | No such endpoint or method | Client bug |

> **Relationship to §8.2 (stated plainly)**: the `E_*` table in §8.2 is a **planning** code table for the
> L1/relay message-frame layer, whereas the two direct HTTPS services of §7 and §7R actually return the
> codes in the table above — whose single sources are `errorBody()` in `src/session.js` and
> `RECV_ERROR_STATUS` in `src/upload-server.js` (receive-mode-specific codes are registered only in the
> latter; the handshake codes reuse the former, so one code never maps to two different statuses).
> The two naming schemes are **not unified today**, and that is not glossed over: writing a direct-mode
> client from §8.2 is wrong; writing it from this section is right.
>
> **One more thing stated plainly**: a code registered in **neither** table falls through to the `500`
> fallback in `errorBody()` (that is the case for `BAD_PROFILE` / `E_DOWNGRADE` above) — the result of a
> missing registration, not a design. A client seeing `500` should treat it as "abort", not as
> "server trouble, therefore retryable".
>
> The table above is **not hand-guessed**: `gen/check-recv-protocol-doc.mjs` takes `RECV_ERROR_STATUS`
> plus that fallback rule and verifies every row's status code — the exact numbers a client relies on
> come from the same place as the implementation.

### 7R.11 TLS, certificates, and the link

The same hard constraint as §7.4 applies: receive mode **must** run over HTTPS, because the phone page needs
`crypto.subtle` (WebCrypto), and browsers only expose it in a **secure context** — `http://192.168.1.5` is not
one, and `crypto.subtle` is simply `undefined` there.

| Item | How receive mode does it |
|---|---|
| Listen address | `0.0.0.0` by default (reachable on the LAN); the port is **random** by default |
| Certificate | A session-level CA plus a server certificate it signs, with `subjectAltName` covering every local IPv4 address plus `127.0.0.1` and `localhost` |
| Installing into the local trust store | **Not by default** (only with `--trust`). The phone cannot install any certificate, so installing it here does not help the phone |
| The phone's first visit | Inevitably shows a "not secure" warning → tap "Advanced → Proceed". The page must say so clearly, or users conclude the program is broken |
| Link shape | `https://{local IPv4}:{port}/?k={token}` (the same `?k=` shape as §7) |
| Waiting for the sender | Nobody connects within 10 minutes by default, and the session is destroyed |
| Destruction chain when done | Session keys and verifier zeroed → service closed → one-time link dead → session certificate removed from the trust store / personal store → temporary certificate directory deleted → **received files stay in the target directory** (deliberately the opposite wording from the sender: the sender says "the original files were not modified", the receiver must say "the received files have been kept in …") |

> **Why receive mode does not install a trust store entry by default**: the certificate would have to go
> into the **phone's** trust store to be useful, and that is impossible from a web page (neither iOS nor
> Android lets a page or program silently install a root CA). So this path is designed from the start around
> "the user taps through one warning", not around pretending it can be warning-free. Installing it into the
> computer's own store only helps when self-testing with this computer's browser.

### 7R.12 What this path does not do (an honest list)

| Not done | Why |
|---|---|
| Directory trees / folder upload | A phone browser can only pick files, not folders — a browser limit, not a missing feature |
| The program gift | The §9 gift is "the sender sends itself along"; this path runs the other way, and a phone holds no executable artifact |
| Cross-session resume at **chunk** granularity | Coming back from a backgrounded phone resumes within the same session (after asking `/up/status`), but closing the page and returning means a new session and a spent token — impossible (same limit as §5.6) |
| A relay-based receive mode | Phone → relay → computer is not built yet (M3 in the design draft) |
| Several devices uploading at once | One receive service serves one session; `token` is one-shot and 5 wrong passwords destroy it |
| On-device (real phone) testing | ⏳ **Not done yet**: what is verified is "the phone page runs byte-for-byte in a real browser (headless Edge)" (`_lab/e2e-phone-browser.mjs`); **a real phone** is needed to confirm screen-lock/backgrounding, iPhone, and writing to real storage (`路线图.md` item 7b) |

---

## 8. Error code table

### 8.1 Encoding rule

```
E_<UPPER_SNAKE>
```

- Every error code has a **unique** meaning and is not reused
- Adding error codes does not break the protocol (a receiver meeting an unrecognised code just handles it by the `fatal` field)
- An error with `fatal = true` **must** trigger the destruction procedure immediately

### 8.2 Error code table

> ⚠️ **This is the code table for the Rendezvous layer (§3) — and that path is not implemented (reviewed 2026-10).**
>
> These codes are **not what today's program returns**: they are the error-message vocabulary of a path that was
> **fully designed but never started** (§3.5's `ERROR` message type, envelope in §3.2).
> **Not a single `E_*` code exists in the code** — the `E_GIFT_*` entries below are in the same boat (§9.2 says so too).
>
> | What you are looking for | Where to look |
> |---|---|
> | The live direct endpoints (initiator's service) | §7.3's status table + `errorBody()` in `src/session.js` |
> | The live receive mode (phone uploads) | **§7R.10** |
> | The live relay interface | §3R.2 (`NO_ROOM` / `GONE` / `NOT_YET` / `BAD_SEQ`…) |
>
> **Why the table is kept**: like §3, this is a fully designed path that is merely **not needed yet**
> (§3's warning box says "once the sender has a public address it can be used"). The day work starts,
> this table is the ready-made specification — but until then, **a client written against it will not
> connect to anything**.

| Code | `fatal` | Phase | Human-readable description (suggested UI copy) | Handling |
|---|---|---|---|---|
| `E_NO_COMMON_SUITE` | ✅ | Negotiation | The two program versions are too far apart; please upgrade one of them and try again | Abort |
| `E_SUITE_REJECTED` | ✅ | Negotiation | The encryption suite the other side chose is not supported | Abort (possibly a downgrade attack) |
| `E_PROTOCOL_TOO_NEW` | ✅ | Negotiation | The other side used a newer protocol version; please upgrade this program | Abort |
| `E_ROOM_GONE` | ✅ | Rendezvous | The session timed out or has been destroyed; please start again | Abort |
| `E_ROOM_FULL` | ❌ | Rendezvous | Too many rendezvous messages | Retry once, then abort |
| `E_TOKEN_INVALID` | ❌ | Rendezvous | The link is invalid or has already been used | Prompt the user to obtain the link again |
| `E_TOKEN_CONSUMED` | ❌ | Rendezvous | This link has already been used | Prompt the user to obtain the link again |
| `E_MAC_MISMATCH` | ❌ | Handshake | **The passwords do not match** | `failCount++`; retry allowed after the delay in §4.6 |
| `E_REPLAY_DETECTED` | ❌ | Handshake | A duplicate handshake request was detected | `failCount++` |
| `E_TOO_MANY_FAILURES` | ✅ | Handshake | Too many failures; the session has been destroyed | Destroy immediately |
| `E_HANDSHAKE_TIMEOUT` | ✅ | Handshake | The handshake timed out | Destroy immediately |
| `E_SESSION_TIMEOUT` | ✅ | Session | The session did not complete within 10 minutes | Destroy immediately |
| `E_SID_MISMATCH` | ✅ | Manifest | The session identifiers do not match | Abort (possibly a substitution attack) |
| `E_MANIFEST_INVALID` | ✅ | Manifest | The file manifest is malformed | Abort |
| `E_MANIFEST_DUPLICATE_PATH` | ✅ | Manifest | A duplicate path exists in the manifest | Abort |
| `E_PATH_UNSAFE` | ✅ | Manifest | The manifest contains an unsafe path and was rejected | Abort (**do not display the concrete path**, to avoid leading the user to create it by hand) |
| `E_FILE_TOO_LARGE` | ✅ | Manifest | A single file exceeds the 64 GiB limit | The initiator reports the error during the scan phase |
| `E_CHUNK_AUTH_FAILED` | ❌ | Data plane | Chunk verification failed | Retry that chunk; 3 in a row → `E_TRANSFER_ABORTED` |
| `E_GIFT_UNSIGNED_ONLY` | ✅ | Application | The other side claims the gifted program is signed, and this version cannot verify signatures | Abort. **Must not** degrade to "treat it as trusted" or "treat it as an ordinary file" |
| `E_GIFT_PLATFORM_MISMATCH` | ❌ | Application | The gifted program does not match this machine's platform | **Used only when a protocol-level check fails** (such as the SEA form claiming `any`). A normal case of merely differing platforms **raises no error** (G7) |
| `E_BAD_SEQ` | ❌ | Data plane | The requested chunk sequence number is invalid | The receiver corrects it and retries; it should not happen, and is an implementation defect |
| `E_UNAUTHORIZED` | ❌ | Data plane | The session is not authenticated | The receiver handshakes again |
| `E_SOURCE_CHANGED` | ✅ | Data plane | The source file was modified or deleted during the transfer | Abort (**no retry** —— a retry would yield inconsistent data) |
| `E_RATE_LIMITED` | ❌ | Data plane/rendezvous | Requests are too frequent | Wait per `Retry-After`, then retry |
| `E_NO_ROUTE` | ✅ | Transport | Cannot connect to the other side | Suggest switching to a LAN or configuring port forwarding |
| `E_DISK_FULL` | ✅ | Disk write | Not enough disk space | Abort and prompt the user to free space |
| `E_USER_CANCELLED` | ✅ | Any | The user cancelled the transfer | Destroy immediately |
| `E_DESTROYED` | ✅ | Any | The session has been destroyed | A normal terminal state; the UI shows the destruction list |

### 8.3 Wire format of an error message

```json
{
  "v": 1,
  "type": "ERROR",
  "seq": 7,
  "from": "i",
  "ts": 1765500000000,
  "body": {
    "code": "E_MAC_MISMATCH",
    "detail": "attempt 2 of 5",
    "fatal": false,
    "retry_after_ms": 2000
  }
}
```

| `body` field | Required | Description |
|---|---|---|
| `code` | yes | A code from §8.2 |
| `detail` | no | **Must be sanitised**: no password, keys, file names or file contents |
| `fatal` | yes | Whether the session is terminated |
| `retry_after_ms` | no | The suggested wait before retrying |

---

## 9. Program gift

> **Alignment note**: the protocol part of this section has been **fully aligned** with chapter 3 of `架构决策.md`
> (program gift); the alignment conclusions are:
>
> | Architecture decision | Where it lands in the protocol |
> |---|---|
> | §3.2 Self-gift is "an ordinary file entry in the manifest", on by default but switchable off | The `gift` object of §9.2 + the `files[].gift` marker; **whether to include it is decided by the user interface, the protocol layer does not mandate it** |
> | §3.3 What is sent depends on how the program itself is distributed | The three `kind`/`platform` combinations of §9.1 |
> | §3.4 The SEA single-file executable is the real value of self-gift | The `platform` field of §9.2 and the executable that `entry` points to |
> | §3.5 Chained propagation | Needs no protocol support —— every station that receives a gift naturally gains full initiator capability |
> | §5.3 The self-gift filename carries a version number | `entry` is suggested to look like `flicker-1.0.0-windows-x64.exe`, so the receiver can see at a glance how old it is |

### 9.1 Concept

A **gift** is an entry in the manifest marked as a "program". It lets the initiator send **the very program it is
running** along with the files, so that the other side can:
1. Start transfers independently even when the sender is **not** present
2. **Gain station capability in one click** on browsers that support automatic program downloads

**The core protocol-level constraint: on the wire, a gift is exactly the same as an ordinary file** —— the same
chunking, the same encryption, the same integrity checks. The protocol introduces no special chunk, special channel
or special permission for gifts.

#### 9.1.1 What form is sent depends on what form the station itself is in

§3.3 of `架构决策.md` requires the program to work out "how I was distributed" and decide the gift's form from that:

| The station's own form | `gift.kind` | What `gift.entry` points to | `gift.platform` | What the other side gets |
|---|---|---|---|---|
| **Single-file executable** (SEA-packaged) | `"flicker-station-sea"` | That executable itself | `win32-x64` etc. | Double-click and it runs, **zero dependencies** ⭐ |
| **Running from a source directory** | `"flicker-station-source"` | The packaged source archive | `any` | Node.js 24+ must be installed first; the archive contains `启动.cmd` as the bootstrap |
| **npm global install** | `"flicker-station-source"` | The same source package as above | `any` | As above |

| `kind` value | Meaning |
|---|---|
| `"flicker-station-sea"` | A single-file executable station (no external dependencies) |
| `"flicker-station-source"` | A source-form station (depends on Node.js 24+) |
| Other | Reserved. When the receiver meets an unrecognised `kind` it **treats it as an ordinary file** and gives no "runnable" hint |

How the implementation decides: probe the relationship between `process.execPath` and `process.argv[1]` to
determine whether it is a SEA-packaged single file or an ordinary script (`架构决策.md` §3.3).

> **The combined semantics of `gift.platform` and `kind`** (added by this specification, to remove ambiguity):
>
> | `kind` | Allowed `platform` values |
> |---|---|
> | `"flicker-station-sea"` | **Must be a concrete platform**, such as `win32-x64`, `darwin-arm64`, `linux-x64` |
> | `"flicker-station-source"` | **Must be `"any"`** —— the source form is platform-independent
>
> When `platform` is `"any"`, `E_GIFT_PLATFORM_MISMATCH` never fires (§8.2).

### 9.2 How it is expressed in the manifest

> ⚠️ **This section previously disagreed with the implementation and has been corrected (2026-10).** It splits into two parts:
>
> **① The `gift` field the implementation actually sends** (`src/prepare.js`, checked against the real code in 2026-10):
>
> ```json
> "gift": {
>   "name": "flicker-1.0.0-windows-x64.exe + flicker-1.0.0-source.fkz",
>   "names": ["flicker-1.0.0-windows-x64.exe", "flicker-1.0.0-source.fkz"],
>   "kind": "flicker-station-sea",
>   "platform": "win32-x64",
>   "note": "对方双击即可运行，不需要安装任何东西",
>   "count": 2
> }
> ```
>
> (`note` is the program's own sentence and is emitted in Chinese by the current build: "the other side can just double-click it; nothing needs to be installed".)
>
> It is only a **one-line summary for the receiver to read** (the UI shows "what else did the other side send you").
> Inside `files[]` a gift is an **ordinary file**, distinguished by `files[].kind`
> (`"flicker-station-sea"` / `"flicker-station-source"`); there is **no** `files[].gift` boolean.
>
> **② The set below (`entry` / `signed` / G1–G7 / `E_GIFT_*`) is a design, not implemented yet.**
> It is kept to show what a gift would have to look like to count as safe, but **do not write a client against it** ——
> the error codes `E_GIFT_*` do not exist in the code, and the receiver performs none of these checks.
> To make it real, the implementation has to come first and this section's wording second (the order cannot be reversed).
>
> The design draft follows (the value rules for `platform` are in §9.1.1, and that part **is implemented**):

```json
{
  "gift": {
    "kind": "flicker-station-sea",
    "platform": "win32-x64",
    "version": "1.0.0",
    "sha256": "<BASE64, 32 bytes>",
    "signed": false,
    "entry": "flicker-1.0.0-windows-x64.exe"
  },
  "files": [
    {
      "index": 3,
      "rel": "flicker-1.0.0-windows-x64.exe",
      "size": 41943040,
      "chunks": 40,
      "sha256": "<BASE64>",
      "chunkHashes": ["<BASE64>"],
      "kind": "flicker-station-sea"
    }
  ]
}
```

| Design field | Type | Required | Description |
|---|---|---|---|
| `kind` | string | yes | The kind of program, see §9.1.1. `FLICKER/1` defines `"flicker-station-sea"` and `"flicker-station-source"`. Other values are reserved |
| `platform` | string | yes | `<os>-<arch>` or `"any"`, see §9.1.1 |
| `version` | string | yes | The program version |
| `sha256` | string | yes | BASE64 of 32 bytes. **Must equal** the corresponding `files[].sha256` |
| `signed` | boolean | yes | Whether there is a trusted signature. For `FLICKER/1` it is **always `false`** |
| `entry` | string | yes | A relative path that **must** match some `files[].rel` in the manifest |

**Consistency checks (the receiver must perform these, in order) —— ⚠️ these are a design; the code does not have them yet:**

```
1. gift === null  → no gift; skip all the logic in this section
2. gift.kind is not in the known set → treat it as an ordinary file, give no "runnable" hint, skip 3~6
3. gift.signed !== false → ERROR(E_GIFT_UNSIGNED_ONLY)
     FLICKER/1 cannot verify signatures; if the other side claims signed=true, it used a newer protocol,
     and we cannot verify that claim. Never treat it as trusted just because "it says it is signed" → must terminate
4. gift.sha256 !== the corresponding files[].sha256 → ERROR(E_MANIFEST_INVALID)
5. gift.entry does not appear in any files[].rel → ERROR(E_MANIFEST_INVALID)
6. There is no files[].kind === "flicker-station-*" whose rel === gift.entry → ERROR(E_MANIFEST_INVALID)
7. gift.kind is "flicker-station-sea" and gift.platform === "any" → ERROR(E_MANIFEST_INVALID)
8. gift.platform !== "any" and does not match this machine's platform → no error; only withdraw the "runnable" hint (G7)
```

### 9.3 Rules for the receiver to recognise and handle a gift

> ⚠️ **This section is a design as well; the code implements only the spirit of G2/G3/G4/G5**
> (never execute automatically, never overwrite silently, the path rules apply equally, the integrity
> check applies equally —— but they do not need the `gift` field to work, because in the implementation
> a gift is just an **ordinary file**).
> G1/G6/G7 depend on `files[].gift` / `gift.signed` / `gift.platform`, which are **not implemented**;
> a client written against them will read `undefined`.

| Rule | Content |
|---|---|
| **G1 Recognition** | `manifest.gift !== null` or some `files[].gift === true` exists (design draft; in the implementation, look at `files[].kind`) |
| **G2 Never execute automatically** | The receiver **never** runs, opens or registers a gift automatically. It must be an explicit user action |
| **G3 Never overwrite automatically** | If a file of the same name already exists at the target path, the normal name-clash handling must be used (rename / ask); it **must not** be overwritten silently |
| **G4 The path rules apply equally** | The gift's `rel` must pass **all** the checks of §6.2. **A gift gets no exemption whatsoever** |
| **G5 Integrity checks cannot be skipped** | The `sha256` and `chunkHashes` checks on the gift file are **exactly the same** as for other files. A failed check → `E_CHUNK_AUTH_FAILED` |
| **G6 The UI must distinguish it** | In the UI a gift must be **clearly distinguished** from ordinary files, and labelled "unverified" (because `signed = false`) |
| **G7 A platform mismatch is not an error** | If `gift.platform` does not match this machine's platform (and is not `"any"`), the file is **still transferred normally**; only the "runnable" hint is dropped. **This is not an error** and does not go in the error code table |
| **G8 Declining the download does not count as transfer failure** | A user refusing to save the gift **does not constitute** a transfer failure. The other files are verified and completed as usual |
| **G9 It does not affect the session lifecycle** | The presence or absence of a gift **does not change** the destruction timing or the scope of destruction |

> **The meaning of `signed = false` must be presented honestly**: the receiver cannot confirm by cryptographic means
> that this program really comes from "the Flicker project". Password authentication proves only that **both sides
> know the same password**, not **the sender's identity**. The UI must state this clearly and must not let the user
> believe the program is trustworthy just because "there is a hash check" —— a hash proves only that "the transfer
> was not corrupted", not that "the source is trustworthy".

### 9.4 Relationship to the "station model"

A gift's **distribution channel** is related to the **station model** (the three L0 page-delivery sources, §1.1):
gifts let the station model degrade from "there must be a relay-hosted page" to "the other side can just give you
the program".

### 9.5 Alignment status: complete

Chapter 1 (station model) and chapter 3 (program gift) of `架构决策.md` are finalised; their correspondence with
the protocol is:

| Requirement in the architecture decision | How the protocol satisfies it | Does the protocol need changing? |
|---|---|---|
| C2: the two sides are peers; one program, two roles | The handshake is inherently **role-neutral**: `HELLO.from` and the `ROLE_*` in the MAC express the role explicitly, and the direction of `AUTH_REQ`/`AUTH_OK` is decided by the role, not by "who is the server" | **No.** The protocol has been symmetric from the start |
| C3: the program gift as an optional manifest item | §9.1–§9.4 | **No.** A gift is just an ordinary file + a marker |
| §3.5 Chained propagation | Every station that receives a gift gains full initiator capability; the protocol need not be involved | **No** |
| §2.4 The GUI and the CLI share one core | The GUI is a **front end**; it takes data through an in-process event stream, not over the wire protocol | **No** |
| §4.3 Automatic session-level certificate install/uninstall | §7.4 defines the certificate strategy and the measured conclusions | **The wire format does not change**, but it blocks the P0 feasibility verification |

> **Conclusion**: `架构决策.md` introduced no new on-the-wire behaviour. The protocol needs no structural change
> for the station model, the GUI or the program gift —— which also validates the value of separating the suite layer
> from the flow layer in §2.1, and of this protocol having adopted a role-neutral handshake from the outset.

**The only boundary to watch**: the station's local UI service (`127.0.0.1`) is explicitly outside the protocol's
scope, with a single hard requirement —— **listen on loopback only** (§3.7).

---

## 10. Complete successful-transfer sequence diagram

The following is a complete end-to-end flow in **rendezvous mode**, covering all six layers.

```
Initiator A (Node)           relay                  Responder B (Chrome)
     │                          │                          │
     │ ══ L4 preparation ══     │                          │
     │ generate P, S(16B), ivSalt(4B), token(8B)            │
     │ V = PBKDF2(P,S,600000)   │                          │
     │ K_room = HKDF(V,"room")  │                          │
     │ room_name = HEX(K_room)  │                          │
     │                          │                          │
     │ ══ L1 rendezvous ══      │                          │
     │ terminal shows: password + link + QR code (the link carries token and S)
     │                          │                          │
     │ POST /room/{rn}          │                          │
     │  HELLO{suites,token,     │                          │
     │        endpoints}        │                          │
     ├─────────────────────────>│                                                     │
     │                          │<─── B opens the link, the page loads ──│
     │                          │     (L0: relay-hosted page)            │
     │                          │                          │
     │                          │<─── POST HELLO{suites} ───│
     │<── the long poll fetches B's HELLO                   │
     │                          │                          │
     │ sends ENDPOINT{urls}     │                          │
     ├─────────────────────────>│──── forwarded ──────────>                           │
     │                          │                          │
     │                          │     B reads S and token from the fragment
     │                          │     V = PBKDF2(P,S,600000)
     │                          │     negotiate suite (B decides)
     │                          │     nonce_r = random(32)
     │                          │     mac_r = HMAC(K_auth, ...)
     │                          │                          │
     │                          │<─── POST AUTH_REQ ───────│
     │<── the long poll fetches AUTH_REQ                    │
     │                          │                          │
     │ constant-time verify mac_r│                         │
     │ ✓ passed                 │                          │
     │ nonce_i = random(32)     │                          │
     │ SID = SHA256(nonce_r‖nonce_i)[0..16)                 │
     │ K_job = HKDF(K_enc, SID) │                          │
     │ mac_i = HMAC(K_auth, ...)│                          │
     │                          │                          │
     │ POST AUTH_OK             │                          │
     │  {nonce_i,sid,mac_i}     │                          │
     ├─────────────────────────>│──── forwarded ──────────>                           │
     │                          │                          │
     │                          │     verify mac_i ✓       │
     │                          │     compute SID, K_job   │
     │                          │                          │
     │ ══ L2 transport direct (the relay takes no further part) ══
     │                          │                          │
     │<────────── GET /session (no X-Flicker-Sid yet) ──────│
     │─────────── 200 {suite,salt,iv_salt,manifest_ct, ────>│
     │                files,bytes}                          │
     │                          │     decrypt manifest_ct ✓│
     │                          │     check sid === SID ✓  │
     │                          │     run the §6.2 path checks ✓
     │                          │     UI: show the file manifest + progress
     │                          │                          │
     │ ══ L5 data plane (chunk-by-chunk loop, serial) ══     │
     │                          │                          │
     │<── GET /chunk?seq=0 ─────┼──────────────────────────│
     │    X-Flicker-Sid: ...    │                          │
     │─── 200 [seq‖ct‖tag] ─────┼─────────────────────────>│
     │                          │   IV = ivSalt‖BE48(seq)‖00│
     │                          │   AAD = SID‖BE64(seq)‖BE32(chunks)
     │                          │   open(K_job, IV, ct, AAD)│
     │                          │   ✓ write to createWritable()
     │                          │   compute the leaf hash and keep it in memory
     │                          │                          │
     │<── GET /chunk?seq=1 ─────┼──────────────────────────│
     │         …(repeat until the last chunk)…              │
     │                          │                          │
     │<── GET /chunk?seq=2365 ──┼──────────────────────────│
     │─── 200 ──────────────────┼─────────────────────────>│
     │                          │                          │
     │ ══ L6 application-layer verification ══              │
     │                          │   compare chunkHashes chunk by chunk ✓
     │                          │   streaming SHA-256 compared against sha256 ✓
     │                          │   createWritable().close()│
     │                          │   UI: show the destruction list + verification passed
     │                          │                          │
     │<────────── POST /done ───┼──────────────────────────│
     │                          │                          │
     │ ══ destroy ══             │                          │
     │ V,K_auth,K_enc,          │                          │
     │ K_job,K_room,nonce all   │                          │
     │ overwritten with fill(0) │                          │
     │ close the listener, drop the socket
     │ DELETE /room/{rn}        │                          │
     ├─────────────────────────>│  the room is destroyed immediately
     │                          │                          │
     │ print the destruction list                          │    UI shows the destruction list
     │ exit the process                                    │     the page becomes invalid
     ▼                          ▼                          ▼
```

---

## 11. Security considerations

### 11.1 The relay's place in the trust boundary

**Explicit assumption: the relay is untrusted.**

| The relay can see | The relay cannot see | Reason |
|---|---|---|
| `room_name` (64 hex) | The password `P` | `room_name = HEX(HKDF(PBKDF2(P,S)))`, one-way |
| The **size** and **timing** of messages | The salt `S`, the token `token` | They are in the URL fragment and never enter the HTTP request (§4.4.2) |
| The `type`, `ts`, `from` of both sides' messages | The session keys `K_auth`/`K_job` | They never go on the wire |
| The IPs and UAs of the two connecting sides | **File names** | The manifest is encrypted as a whole (§6.3) |
| The plaintext digest: file count and total bytes | **File contents** | L5 encrypts chunk by chunk; and **the data does not pass through the relay at all** (§3.1) |
| The `agent` string (if sent) | The directory structure | It is inside the encrypted manifest |

**Attacks the relay can mount**:

| Attack | Feasible? | Mitigation |
|---|---|---|
| Read file contents | ❌ Impossible | The data does not pass through the relay + end-to-end encryption |
| Modify file contents | ❌ Impossible | The GCM tag + the AAD binding `SID` |
| Learn the password | ❌ Impossible | The password never goes on the wire |
| Denial of service (not returning messages) | ✅ Feasible | It shows up as a timeout and the UI reports it clearly; another relay can be used to retry |
| Trim the suite list (downgrade attack) | ✅ **but it is detected** | `suite_id` is bound into the MAC (§2.6): if the two sides pick different suites → the MAC necessarily fails |
| Substitute an old session's manifest | ✅ Attemptable | The `manifest.sid === SID` check (step 5 of §6.3) |
| Observe metadata (who is transferring, how much) | ✅ **unavoidable** | See §11.2 below |

### 11.2 Metadata leakage (an honest list)

The following information is **necessarily** observed by the relay and cannot be hidden by encryption:

| Leaked item | Severity | Possible mitigations (not implemented) |
|---|---|---|
| The two parties' IPs, and the timing | Medium | Use Tor / a VPN (outside this project's scope) |
| The number of files transferred and the total size | Low-medium | Pad to fixed buckets (**not implemented**; it would cost bandwidth) |
| The room name (a random 64 hex) | Low | Unavoidable (the relay has to be able to route) |
| The transfer duration | Low | Unavoidable |

**Means of mitigating metadata leakage are explicitly outside the scope of `FLICKER/1`.** If padding is added in
future, it is a **new field** (in line with §0.1), not a modification of existing behaviour.

### 11.3 Replay resistance

| Level | Mechanism |
|---|---|
| Handshake | `nonce_r` / `nonce_i` are 32 random bytes each time; `mac_r` contains `nonce_r` |
| Session | `SID` is mixed into `K_job`, so keys differ across sessions |
| Data chunk | The AAD contains `SID` and `seq`, so a chunk cannot be moved across sessions or positions |
| Replaying a chunk within a session | `seq` is unique + the IV is derived from `seq` → there can be only one valid ciphertext for a given `seq` |
| Replaying room messages | The relay's `cursor` is monotonic + the client deduplicates by `(from, seq)` |

### 11.4 Tamper resistance

| Goal | Mechanism |
|---|---|
| Ciphertext tampering | The GCM tag (16 bytes) |
| Chunk reordering | The AAD contains `BE64(seq)` |
| Splicing across files | The high 48 bits of the AAD's `seq` are the `fileIndex` |
| Truncation | The AAD contains `BE32(totalChunks)` |
| File substitution | `files[].sha256` + `files[].chunkHashes` |
| Manifest substitution | The `manifest.sid === SID` check |
| Suite downgrade | `suite_id` is bound into `mac_r`/`mac_i` |
| Path traversal | The 12 rules of §6.2 (a security boundary) |

### 11.5 The password never goes on the wire (the full argument)

```
Every password-related quantity that has appeared on the wire:
  ① room_name = HEX(HKDF(PBKDF2(P,S,600000),"room"))     → one-way, cannot be reversed
  ② mac_r / mac_i = HMAC(K_auth, ...)                     → one-way, and the nonce is single-use
  ③ manifest_ct / ciphertext chunks = AEAD(K_job, ...)    → one-way

Quantities that have never appeared on the wire:
  P (the password), S (inside the fragment or TLS), V, K_auth, K_enc, K_job, and the raw value of nonce_i (sent in the clear but not sensitive)
```

**What a packet sniffer can conclude**: only that "someone is doing a transfer". It cannot brute-force the password
offline, because:
- The only password-related output is `room_name`, and that is an HKDF output; **the PBKDF2 result `V` is never exposed**
- Even with `mac_r` in hand, testing one password guess requires: guess `P'` → PBKDF2 600k rounds → HKDF → HMAC → compare. **The cost of each guess = 600k rounds of PBKDF2**
- And `nonce_r` is single-use, so precomputed tables are **useless**

> **Residual risk**: **weak passwords**. If a user sets the password to `123456`, an attacker who captures `mac_r`
> can enumerate offline (600k rounds of PBKDF2 is about 0.1–0.5 seconds, so `123456` needs only one attempt). That
> is why the sender **generates a strong password by default** (4 words ≈ 52 bit) and **must ask for confirmation
> twice**. **This is the only risk in this protocol that cryptography cannot solve; only UI guidance can.**

### 11.6 Forward secrecy (stated honestly)

`FLICKER/1` **does not provide forward secrecy**. The reason: the key is derived entirely from the password, with no
Diffie-Hellman exchange. If the password leaks afterwards, and an attacker kept the ciphertext from that time, it
can be decrypted.

**Mitigations**:
- The session lifetime is measured in minutes (a 10-minute timeout), and `ivSalt` and `S` are random per session
- The password is randomly generated by default and discarded after use
- `FLICKER/4` (X25519) will introduce forward secrecy

**The UI and the documentation must not claim that this protocol provides forward secrecy.**

---

## 12. Open Questions

The following items are **not yet settled**; a decision or a measurement is needed before implementation. They are ordered by priority.

> **This section has been updated as the implementation progressed**: several items originally listed under 12.1
> (marked "blocks P0") are **resolved or no longer applicable**; the original records are kept below with
> ~~strikethrough~~ and the actual conclusion is noted —— they are kept so that we remember "what we were worried
> about at the time and how it turned out", not so that they keep occupying a "pending" slot and giving a false read
> of progress.

### 12.1 Issues blocking P0 (**all closed**)

| # | Issue | Conclusion |
|---|---|---|
| ~~Q1~~ | ~~Certificate trust: does the browser really accept a session-level CA once it is in the trust store?~~ | ✅ **Resolved.** A real interactive verification was done as a follow-up: Windows + Edge 155, in three modes (headless / visible window / app window with no address bar) and with two address forms (loopback + a real LAN IP) —— **all passed with zero warnings**. The key is that the CA must carry the CA flag (`'2.5.29.19={critical}{text}ca=1'`); it was missing at first, which made all 5 variants fail. Evidence in `_lab/实测报告-证书信任.md` |
| ~~Q2~~ | ~~The semantics of one-time `token` consumption under concurrent requests~~ | ✅ **Resolved**, and the problem originally feared **no longer exists**: the readiness probe at startup now uses the **side-effect-free `/api/health`**. It used to probe the token-bearing link and consume the token, so the user saw 410 when opening it —— exactly the "pushed out by ourselves" problem Q2 worried about, and it was hit once in measurement |
| ~~Q3~~ | ~~The information leak from `GET /session` returning a plaintext digest when unauthenticated~~ | ✅ **Resolved**: the `token` check runs **before** the digest is returned (§4.7). An unauthenticated request gets no file information at all |
| ~~Q17~~ | ~~How to handle certificate leftovers after a force-kill~~ | ✅ **Resolved**: startup scan + cleanup (`findResidualCa` / `cleanResidual` / `cleanAllLeftovers` / `cleanTempDirs`). The test suite asserts after every case that the certificate store is back to its original state. Real leakage was hit in measurement: `New-SelfSignedCertificate` left the CA in `Cert:\CurrentUser\My`, which at one point accumulated 148 certificates + 84 temporary directories |

### 12.2 Issues affecting P1

| # | Issue | Impact | Action needed |
|---|---|---|---|
| Q4 | **Can a `FileSystemFileHandle` stored in IndexedDB be restored across a refresh?** | Whether resume after a refresh is possible | Measure Chromium; if not feasible, state clearly in the UI that "a refresh means starting over". **Already analysed**: the constraint is not the handle but that every call to `createWritable()` truncates the file, and there is no way to "keep writing from byte N". See item 5 of `路线图.md` |
| Q5 | **The actual Blob ceiling in Firefox/Safari** | When large files fail on non-Chromium browsers | Measure several file sizes to derive a conservative warning threshold. The current "about 1 GB" is a conservative estimate and is **unmeasured** |
| Q6 | **Should Merkle proofs be handed down with the manifest?** | Whether fine-grained recovery ("retransmit only the damaged chunk") is supported | `FLICKER/1` explicitly **does not** include proofs (the manifest carries only the root). If fine-grained recovery is wanted, it is an extension through a **new field** per §0.1, without changing the semantics of existing fields |
| ~~Q7~~ | ~~Does HTTP chunk concurrency need to be > 1?~~ | Throughput on high-RTT links | ✅ **Resolved, with a large gain.** Measured: serial (window 1) to Cloudflare gives only **4.72 MB/s**, while the same link can do 29.5 MB/s —— the bottleneck was the implementation. After switching to batch delivery + window 8 it reaches **18–24 MB/s**; adding more window gives diminishing returns and **saturates at 28–30 MB/s** (the link's own ceiling). See the fifth supplementary chapter of `路线图.md` |

### 12.3 Issues affecting P2

| # | Issue | Impact | Action needed |
|---|---|---|---|
| Q8 | **Can Cloudflare Workers hold a 25-second long poll?** | Rendezvous latency and request count | Measure; if it is cut short, lower `GET_HOLD` while keeping the "retry immediately on 204" semantics |
| Q9 | **Workers rate limit thresholds** | The balance between abuse prevention and normal use | Adjust the thresholds in §3.4 according to measurement |
| ~~Q10~~ | ~~How can the relay-hosted page hand the fragment to JS without writing it to disk?~~ | ~~The security of §4.4.2~~ | ✅ **Resolved**: the page only **reads** the parameters from `location.hash` and never writes them to storage. There is exactly one place that writes storage —— the language preference (the receiver uses `sessionStorage`, which disappears when the tab closes). A test guards it: "credentials in the link are never written into any storage" in `test/receiver-page.test.js` |
| Q11 | **Is it worth migrating the data plane to WebSocket?** | The cost of one HTTP request per chunk | Measure the requests-per-second ceiling; consider `wss-stream` only if HTTP overhead becomes the bottleneck |

### 12.4 Issues about protocol evolution

| # | Issue | Impact | Action needed |
|---|---|---|---|
| Q12 | **The WASM size cost of `FLICKER/2` (Argon2id)** | The receiver's first-paint time | Measure the WASM module size and initialisation time; decide whether it is on by default |
| Q13 | **How to extend the handshake for `FLICKER/4` (X25519 + SAS)** | A new handshake message is needed | When designing it, follow §0.1 "only add, never change" strictly: add message types and fields, do not change the semantics of existing fields |
| Q14 | **A signature mechanism for gifts** | Users cannot verify where a program came from | A trusted public-key distribution mechanism is needed (beyond the scope of FLICKER/1); until then `signed` is always `false` and the UI must label it "unverified" |
| Q15 | ~~Details of how the station model interacts with gifts~~ | — | ✅ **Resolved**: chapters 1 and 3 of `架构决策.md` are finalised; the alignment conclusions are in §9.5. **The protocol needs no change** |
| Q16 | ~~Do "the GUI" and "the program gift" introduce new protocol requirements?~~ | — | ✅ **Resolved**: the GUI is an in-process front end (it does not use the wire protocol); the program gift is already covered by §9. **The protocol needs no change** |
| Q18 | **The port and lifecycle of the station's local UI service** | Risk of a port clash with the data-plane service | Explicitly **outside the protocol's scope** (§3.7), but the implementation must guarantee it listens only on `127.0.0.1` |
| Q19 | **Filename normalisation for `gift.entry` after SEA packaging** | Readability during chained propagation | §5.3 of `架构决策.md` requires a version number; it must be confirmed that the filenames on all three platforms (Windows/macOS/Linux) are legal under the §6.2 path rules (especially spaces and Chinese characters) |

### 12.5 Capabilities known to be unimplemented and not included in this version

Listed explicitly, to avoid misunderstanding:

| Capability | Status |
|---|---|
| Forward secrecy | ❌ Not implemented (§11.6) |
| Metadata padding (hiding file sizes) | ❌ Not implemented (§11.2) |
| Multiple receivers (one-to-many broadcast) | ❌ Not designed. The current model is strictly one-to-one |
| The receiver sending files back to the initiator | ❌ Still one-way **within a session**. A reverse transfer is a **separate session** (§7R: the computer is the receiver, the phone is the sender), not a reply inside the same one |
| Cross-process recovery of a resume (continuing after the initiator restarts) | ❌ Not designed. Exiting the process destroys everything; that is the product's core promise |
| Preserving directory permissions/ownership | ❌ Only `mtime` is preserved; `uid`/`gid` are not (meaningless across platforms) |
| **The Rendezvous layer (§3) and the §8.2 error code table** | ⏳ **Planned, not implemented.** The design is complete, but neither the relay-side endpoints nor the client are started; it becomes usable once the sender has an address the peer can reach (public IPv6 / port forwarding). The `E_*` codes in §8.2 belong to it |

---

## Appendix A: Constant summary

| Constant | Value | Section |
|---|---|---|
| `PROTOCOL` | `"FLICKER/1"` | §2.2 |
| `SALT_LEN` | 16 bytes | §2.3 |
| `NONCE_LEN` | 32 bytes | §2.3 |
| `IV_LEN` | 12 bytes | §2.3 |
| `IV_SALT_LEN` | 4 bytes | §5.3 |
| `SID_LEN` | 16 bytes | §4.5 |
| `PBKDF2_ITERATIONS` | 600000 | §2.4 |
| `CHUNK_SIZE` | 1048576 bytes | §2.4 |
| `TAG_SIZE` | 16 bytes | §2.4 |
| `AAD_LEN` | 28 bytes | §5.4 |
| `MANIFEST_SEQ` | `0xFFFFFFFFFFFFFFFF` | §5.1 |
| `MAX_CHUNKS_PER_FILE` | 65536 | §5.1 |
| `MAX_FILE_BYTES` | 68719476736 (64 GiB) | §5.1 |
| `ROOM_TTL` | 900000 ms | §3.4 |
| `ROOM_MAX_MSGS` | 100 | §3.4 |
| `ROOM_MAX_BODY` | 8192 bytes | §3.4 |
| `GET_HOLD` | 25000 ms | §3.4 |
| `MAX_FAILURES` | 5 | §4.6 |
| `HANDSHAKE_TIMEOUT` | 60000 ms | §4.6 |
| `SESSION_TIMEOUT` | 600000 ms | §4.6 |

## Appendix B: Summary of ASCII domain-separation strings

| Purpose | Bytes | ASCII |
|---|---|---|
| RECV MAC domain | 9 | `flk1-recv` |
| SEND MAC domain | 9 | `flk1-send` |
| Role recv | 4 | `recv` |
| Role send | 4 | `send` |
| HKDF label | 4 | `room` |
| HKDF label | 4 | `auth` |
| HKDF label | 3 | `enc` |

> **Implementation assertion**: the strings above must be concatenated as **ASCII bytes** (1 byte per character), **not** as the length of a UTF-8-encoded JS string. All of them are ASCII characters, so both give the same result, but the implementation should explicitly use `Buffer.from(s, 'ascii')` / `new TextEncoder().encode(s)` to avoid ambiguity.
