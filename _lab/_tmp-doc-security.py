import io

def patch(path, old, new, count=1):
    src = io.open(path, encoding='utf-8', newline='').read()
    if src.count(old) != count:
        raise SystemExit(f'{path}: 期望 {count} 次，实际 {src.count(old)}\n---\n{old[:120]}')
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, count))
    print(f'{path}: 改好')

# ── 使用手册（中）：中继那一节补"手机传手机"的入口 ──────────────
patch('中文文档/使用手册.md',
'''`#` 之后的内容（房间名与盐）**浏览器不会发给服务器**，所以中继不知道别人要取的是哪一份数据。''',
'''`#` 之后的内容（房间名与盐）**浏览器不会发给服务器**，所以中继不知道别人要取的是哪一份数据。

> **手机直接发给另一台手机？** 两台手机都打开中继地址的 `/send`（例如
> `https://你的中继.你的用户名.workers.dev/send`）就能发 —— 发送方选文件、设一个一次性密码、
> 拿到链接；接收方打开链接、输入同一个密码即可。**必须经过中继**，因为手机浏览器不能当服务端；
> 中继只转发密文。细节与限制见 [`手机使用指南.md`](手机使用指南.md) 第六点五节。''')

patch('docs/使用手册.md',
'''Everything after `#` (the room name and the salt) is **never sent to the server**, so the relay does not know which payload someone is asking for.''',
'''Everything after `#` (the room name and the salt) is **never sent to the server**, so the relay does not know which payload someone is asking for.

> **Phone straight to another phone?** Both phones open `/send` on the relay address (for example
> `https://your-relay.your-name.workers.dev/send`): the sender picks files, sets a one-time password and
> gets a link; the receiver opens the link and types the same password. **A relay is required**, because a
> phone browser cannot be a server; the relay only forwards ciphertext. Details and limits:
> [`手机使用指南.md`](手机使用指南.md) section 6.5.''')

# ── SECURITY.md（中）：信任边界补一段"发送端也可能是网页" ─────────
patch('中文文档/SECURITY.md',
'''**核心假设：中继完全不可信。** 它可以记录一切、可以篡改一切、可以随时停止服务。
加密的设计不依赖它的诚实。''',
'''**核心假设：中继完全不可信。** 它可以记录一切、可以篡改一切、可以随时停止服务。
加密的设计不依赖它的诚实。

### 2.1 发送端有两种形态（2026-10 起）

上面的图里发送端是"Node 程序"。从 2026-10 起，**发送端也可以是中继托管的网页**
（`/send`，用于手机传给手机 —— 两边都只有浏览器时没有别的办法）。

| | 发送端 = 本机程序 | 发送端 = 中继托管的页面 |
| --- | --- | --- |
| 明文与密钥在哪 | 用户自己的电脑内存里 | 浏览器标签页的内存里 |
| 你要信谁的代码 | 你下载/构建的那个程序 | **中继运营者发给你浏览器的那份页面代码** |
| 中继能不能看到内容 | 不能（只有密文） | 不能（只有密文） |
| 密钥会不会经过网络 | 不会（密码只在两端，中继看不到） | 不会（房间名与盐在 `#` 之后，浏览器不发给服务器） |

⚠️ **这条差别必须说清**：网页发送端把"你信任的代码"从"自己机器上的程序"扩到了
"中继发的那份 HTML"。自己部署中继（本项目的默认用法）时这两者是同一个主体；
用**别人的**中继时，你等于同时信任他的页面代码 —— 这跟用别人的接收页是同一个假设，
不是新出现的能力，但以前发送端不受它影响。用户手册里已明确写出这一点，
不想接受这个假设的人仍然可以只用自己的程序发送。

其它不变：网页发送端同样**在出门前加密**（`src/suite/flicker1.js` 的同一套参数，
页面里是 `web/phone-core.js` 的实现，两边做过逐字节比对），中继拿到的仍然只有密文。''')

patch('docs/SECURITY.md',
'''**Core assumption: the relay is fully untrusted.** It may log everything, tamper with everything,
and stop serving at any time. The encryption design does not depend on its honesty.''',
'''**Core assumption: the relay is fully untrusted.** It may log everything, tamper with everything,
and stop serving at any time. The encryption design does not depend on its honesty.

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
so the relay still only ever sees ciphertext.''')
