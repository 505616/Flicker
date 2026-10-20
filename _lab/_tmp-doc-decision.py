import io

def patch(path, old, new, count=1):
    src = io.open(path, encoding='utf-8', newline='').read()
    if src.count(old) != count:
        raise SystemExit(f'{path}: 期望 {count} 次，实际 {src.count(old)}\n---\n{old[:120]}')
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, count))
    print(f'{path}: 改好')

# ── 架构决策：新增一条决策记录（中）──────────────────────────
patch('中文文档/架构决策.md',
  '## 七、更新后的实现阶段',
  '''## 八、网页发送端：为什么由中继托管发送页

**背景**：手机传手机时，两边的设备都只有浏览器 —— 没有一台能当服务端（浏览器不能监听端口），
也没有人愿意为了发一次文件去装个 App。而中继这条路早就存在：接收页一直由中继托管。

**考虑过的四条路**

| 路线 | 为什么没选 |
| --- | --- |
| 原生 App / Capacitor 外壳 | 目标设备"不需要安装"是这个程序最值钱的承诺，装 App 一下就把它换掉了；还要过签名与商店 |
| WebRTC 直连 | 要信令 + STUN/TURN；移动网对称 NAT 下经常打不通，而 TURN 要服务器和钱。本项目早先实测过：本机宽带在 CGNAT + 无 IPv6 现实下直连根本连不上 |
| 局域网内跑一台"本地中继" | 可行（`relay/local.mjs` 就是），但**它同样是明文 HTTP** —— 而浏览器的 `crypto.subtle` 只在安全上下文里可用，所以局域网内的本地中继也得先有 TLS。它解决的是"没有外网"，不是"没有服务端" |
| **中继托管发送页（选了这条）** | 协议一行都不用改（中继本来就是双向 HTTP）；双方都不用装东西；密码学与接收页共用同一份实现 |

**代价（如实写下，不是宣传）**

1. **信任面变宽**：发送端从"你自己机器上的程序"变成"中继发给你浏览器的那份 HTML"。
   自己部署中继时主体没变；用别人的中继就等于同时信他的页面代码。这条写进了 `SECURITY.md` §2.1。
2. **发之前要整体读一遍文件**：清单里必须带整文件 SHA-256 与逐块哈希（接收端靠它验完整性），
   而浏览器的 `crypto.subtle.digest` 没有流式接口，只能用页内那份增量 SHA-256 一遍读完。
   手机上大文件会有明显的"准备中"。
3. **刷新即失效**：密钥与房间名只活在页面里。跨会话续传本来就明确不做，这里沿用同一条决定。
4. **不能选文件夹**：网页只拿得到"选中的文件"，拿不到目录结构（手机的相册选择也是同理）。

**没有做的事**：不做断点续传、不做限速、不送赠品程序、不并入统一 i18n（先内联双语文案）。
这些都不是"忘了"，是这一版的边界。

## 七、更新后的实现阶段''')

# ── 架构决策：新增一条决策记录（英）──────────────────────────
patch('docs/架构决策.md',
  '## 7. Updated implementation phases',
  '''## 8. Web sender: why the relay hosts the sending page

**Context**: when a phone sends to another phone, both devices only have a browser —— neither can be a
server (browsers cannot listen on a port), and nobody wants to install an app to send one file. The
relay path already existed: the receiving page has always been hosted by the relay.

**The four routes we considered**

| Route | Why it was not chosen |
| --- | --- |
| A native app / Capacitor shell | "The target device installs nothing" is this project's most valuable promise; installing an app trades it away, and it needs signing and stores |
| WebRTC direct | Needs signalling plus STUN/TURN; symmetric NAT on mobile networks often fails, and TURN costs a server and money. Measured earlier in this project: on CGNAT with no IPv6, direct connection simply does not come up |
| A "local relay" on the LAN | Feasible (`relay/local.mjs` exists), but **it is plain HTTP too** —— and a browser only exposes `crypto.subtle` in a secure context, so even a LAN local relay needs TLS first. It solves "no internet", not "no server" |
| **Relay-hosted sending page (chosen)** | No protocol change at all (the relay is plain HTTP in both directions); neither side installs anything; the crypto shares one implementation with the receiving page |

**Costs (written down plainly, not marketing)**

1. **A wider trust surface**: the sender changes from "the program on your machine" to "the HTML the
   relay hands your browser". Deploying the relay yourself keeps the same party; using someone else's
   relay means trusting their page code too. This is in `SECURITY.md` §2.1.
2. **Every file is read once before sending starts**: the manifest must carry the whole-file SHA-256 and
   per-chunk hashes (the receiver verifies with them), and `crypto.subtle.digest` has no streaming
   interface —— so the in-page incremental SHA-256 has to chew through the file first. Large files on a
   phone show a visible "preparing" phase.
3. **A reload loses everything**: keys and the room name only live in the page. Cross-session resume was
   already explicitly out of scope; this follows the same decision.
4. **No folders**: a web page only receives the files you selected, never the directory structure (same
   for phone photo pickers).

**What we deliberately did not do**: no resume, no rate limiting, no gift program, no integration with the
unified i18n (bilingual text is inlined for now). None of these are oversights; they are this version's
boundaries.

## 7. Updated implementation phases''')

# ── 读我 P4 行：手机↔手机也实现了 ───────────────────────────
patch('读我.md',
  '**手机当发送端（手机 → 电脑）已实现**（命令行 + 手机页 + 图形界面入口，真浏览器里逐字节验过），**只差真机实测**（见 [`中文文档/路线图.md`](中文文档/路线图.md) 第 7b 项）',
  '**手机当发送端已实现**：手机 → 电脑（命令行 + 手机页 + 图形界面入口），以及**手机 → 手机**（中继托管的 `/send` 发送页，页面↔页面在真浏览器里逐字节验过）。两者都**只差真机实测**（见 [`中文文档/路线图.md`](中文文档/路线图.md) 第 7b 项）')
