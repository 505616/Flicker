/**
 * 界面文案表（中英）。
 *
 * ⚠️ 这个文件由 gen/inline-i18n.mjs 内联进 web/*.html，**不是运行时加载的**。
 *    接收端页面必须保持单文件、零外部请求（局域网可能没有外网），
 *    所以不能在页面里 fetch 它。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *
 * HTML 里：给元素加 data-i18n，元素内保留中文作为**无脚本兜底**
 *     <h2 data-i18n="pw.title">对方想给你发文件</h2>
 *   需要替换属性时用 data-i18n-attr：
 *     <input data-i18n-attr="placeholder:pw.placeholder" placeholder="输入密码">
 *   需要整段 HTML（含 <b> 标签）时用 data-i18n-html="1"。
 *
 * 脚本里：
 *     t('rate.mb', { n: 3 })        →  "3 MB/s" / "3 MB/s"
 *     setLang('en')                 →  切换并重绘
 *
 * ⚠️ **占位符一律用 {name}**，不要用模板字符串拼中文句子 ——
 *    中英文语序不同，拼接出来的句子在另一种语言里一定是错的。
 *    例：「还有 {n} 个文件」→ "{n} more files"，语序天然不同。
 *
 * ⚠️ **不要在这里放任何"以后可能会变"的运行时状态**。它是一张静态表。
 */

/** 语言表。键名用点分层级，按界面区域分组，改文案时好找。 */
export const STRINGS = {
  zh: {
    // ── 通用 ──
    'app.name': '闪传',
    'app.brand': 'Flicker',
    'app.tagline': '一次性文件传输 · 用完即销毁',
    'common.retry': '重试',
    'common.cancel': '取消',
    'common.cancelDestroy': '取消并销毁',
    'common.done': '完成',
    'common.error': '出错了',
    'common.seconds': '{n} 秒',
    'common.minutes': '{n} 分',
    'common.langSwitch': 'English',

    // ── 接收端：标题 ──
    'recv.title': '闪传 Flicker · 接收文件',
    'recv.titleDone': '闪传 Flicker · 传输结束后本页将无法再次访问',

    // ── 接收端：密码屏 ──
    'recv.pw.title': '对方想给你发文件',
    'recv.pw.sub': '输入对方告诉你的一次性密码即可开始。传输完成后，密码和链接立即失效。',
    'recv.pw.manifestLocked': '文件清单已加密',
    'recv.pw.manifestHint': '输入正确密码后才能看到',
    'recv.pw.label': '一次性密码',
    'recv.pw.placeholder': '输入对方给你的密码',
    'recv.pw.show': '显示密码',
    'recv.pw.start': '开始接收',
    'recv.pw.foot': '密码不会离开你的电脑 —— 它只用来核对双方是否一致',

    // ── 接收端：核对中 ──
    'recv.busy.title': '正在核对密码…',
    'recv.busy.sub': '双方密码一致后才会开始传输',
    'recv.busy.localCalc': '本地计算中，密码不会离开这台电脑（约 1 秒）',
    'recv.busy.localParams': '正在读取会话参数…',
    'recv.busy.relayParams': '正在从中继取回信息…',

    // ── 接收端：传输中 ──
    'recv.go.state': '传输中',
    'recv.go.crypto': '端到端加密 · AES-256-GCM',
    'recv.go.total': '总进度',
    'recv.go.speed': '速度',
    'recv.go.elapsed': '已用时间',
    'recv.go.eta': '剩余',
    'recv.go.relayNote': '数据经中继转发，但内容是端到端加密的 —— 中继解不开',
    'recv.go.streamNote': '正在<b>边收边写入磁盘</b>，不占用内存。首次接收会弹出保存位置选择框；' +
      '浏览器随后会问「是否允许此网站修改文件」—— 那是写入磁盘所必需的，选<b>允许</b>即可。',
    'recv.go.blobNote': '正在<b>在内存中拼装</b>后保存，请注意大文件可能受内存限制。',
    'recv.go.bigWarn': '这个浏览器无法边收边写盘，而本次共 <b>{size}</b>。' +
      '建议改用 <b>Edge 或 Chrome</b> 重新打开链接，否则可能中途失败。',
    'recv.go.noStreamWarn': '当前浏览器不支持<b>边收边写磁盘</b>，' +
      '超过约 1 GB 的文件可能因内存不足而失败。建议改用 <b>Edge 或 Chrome</b> 打开本页。',
    'recv.go.noPermissionWarn': '你刚才没有允许写入文件，所以接下来会<b>先收进内存</b>再保存。' +
      '本次共 <b>{size}</b>，这个大小内存放得下，可以继续；' +
      '但如果想边收边写盘（更稳、也不占内存），请点「取消」，' +
      '重新开始并在文件夹窗口里选 <b>允许</b>。',
    'recv.go.reconnecting': '链路不稳，正在重连（{n}/{max}）…',

    // ── 接收端：完成屏 ──
    'recv.done.title': '传输完成',
    'recv.done.sum': '共 {n} 个文件 · {size}',

    // ── 接收端：错误 ──
    'recv.err.cancelled': '已取消',
    'recv.err.failed': '传输失败',

    // ── 接收端：动态消息（脚本内） ──
    'recv.msg.decryptFail': '第 {n} 块解密失败 —— 数据可能被篡改或损坏。已中止，未写入这一块。',
    'recv.msg.lengthMismatch': '第 {n} 块长度不符',
    'recv.msg.chunkHashFail': '第 {n} 块校验失败（内容与清单不符）',
    'recv.msg.fileHashFail': '文件「{name}」整体校验失败：收到的内容与发送端不一致。文件已保存但不可信。',
    'recv.msg.peerAuthFail': '对方未能通过认证',
    'recv.msg.relayTimeout': '等了很久也没等到下一块 —— 对方可能已经关掉了程序',
    'recv.msg.relayGone': '中继上的房间已经不存在了 —— 可能已过期，或对方取消了传输',
    'recv.msg.relayTaken': '这一块已经被取走过了',
    'recv.msg.relayStatus': '中继返回 {status}',
    'recv.msg.badManifest': '清单数据不完整',
    'recv.msg.badSalt': '链接里的盐不完整',
    'recv.msg.badChunk': '分块数据不完整',
    'recv.msg.moreFiles': '还有 {n} 个文件',
    'recv.msg.fileCount': '共 {n} 个文件',
    'recv.msg.wantSend': '对方想给你发 {n} 个文件',
    'recv.msg.receiving': '接收中',
    'recv.msg.about': '约 {time}',

    // ── 接收端：完成屏明细 ──
    'recv.done.detail': '{n} 个文件 · {size} · 用时 {time} · 平均 {rate}/s',
    'recv.done.verified': '✓ 校验通过 · SHA-256 一致',
    'recv.done.saved': '已保存',
    'recv.done.destroyList': '会话销毁清单',
    'recv.done.ck1': '密码与会话密钥已随本页释放',
    'recv.done.ck2': '一次性链接已失效',
    'recv.done.ck3': '本页刷新后将无法再次访问',
    'recv.done.share': '分享 / 保存到…',
    'recv.done.shareUnavailable': '这个浏览器收文件时是把内容直接写到磁盘的（内存里没有副本），' +
      '所以无法调起系统分享面板 —— 文件已经在你选的位置了。',
    'recv.done.shareUnsupported': '这个平台不支持分享这种文件（{name}）。文件已经保存到磁盘了，' +
      '可以从文件管理器里分享。',
    'recv.done.shareFailed': '分享没能完成：{msg}',

    // ── 接收端：取消 ──
    'recv.cancel.title': '已取消',
    'recv.cancel.keptPart': '传输已中止，<b style="color:var(--text)">已接收的部分保留在磁盘上</b>，未接收的文件没有创建。',
    'recv.cancel.nothing': '传输已中止，<b style="color:var(--text)">没有文件被写入磁盘</b>。',

    // ── 接收端：错误对照表（标题 + 说明） ──
    'recv.err.BAD_PASSWORD.t': '密码不一致',
    'recv.err.BAD_PASSWORD.m': '双方密码不匹配，握手被拒绝。<b style="color:var(--text)">没有传输任何数据</b>，也没有文件被写入磁盘。',
    'recv.err.TOO_MANY_FAILURES.t': '会话已销毁',
    'recv.err.TOO_MANY_FAILURES.m': '认证失败次数过多，为防暴力破解，本次会话已自动销毁。请让对方重新发起传输。',
    'recv.err.TOKEN_USED.t': '链接已失效',
    'recv.err.TOKEN_USED.m': '这个链接已经被使用过一次了。一次性链接只允许访问一次，请让对方重新发起传输。',
    'recv.err.TOKEN_INVALID.t': '链接无效',
    'recv.err.TOKEN_INVALID.m': '链接不完整或已失效。请确认完整复制了对方给你的地址（包括 <code>?k=</code> 后面的部分），或直接扫二维码。',
    'recv.err.DESTROYED.t': '会话已销毁',
    'recv.err.DESTROYED.m': '发送端已经销毁了这次会话。请让对方重新发起传输。',
    'recv.err.DECRYPT.t': '数据校验失败',
    'recv.err.DECRYPT.m': '接收到的数据无法通过完整性校验，已中止。<b style="color:var(--text)">这一块没有被写入磁盘。</b>',
    'recv.err.CHUNK_HASH.t': '数据校验失败',
    'recv.err.CHUNK_HASH.m': '有一块内容与发送端清单不符，已中止。这通常意味着传输过程中发生了损坏。',
    'recv.err.HASH.t': '文件校验失败',
    'recv.err.HASH.m': '收到的文件与发送端的哈希不一致。文件已保存但<b style="color:var(--text)">不可信</b>，建议删除后重传。',
    'recv.err.CANCELLED.t': '已取消',
    'recv.err.CANCELLED.m': '传输已中止。',
    'recv.err.NO_WRITE_PERMISSION.t': '没有获得写入权限',
    'recv.err.NO_WRITE_PERMISSION.m': '你拒绝了"允许修改文件"，而本次共 <b>{size}</b> —— ' +
      '这个大小没法先在内存里拼装（会在传输中途失败）。<br>' +
      '请点下面的「重试」，在弹出的文件夹窗口里选 <b>允许</b>，再选一个保存位置即可。',
    'recv.err.PEER_AUTH.t': '对方认证失败',
    'recv.err.PEER_AUTH.m': '发送端未能证明它知道密码，已中止。',
    'recv.err.UNKNOWN.t': '出错了',
    'recv.err.UNKNOWN.m': '未知错误',
    'recv.err.CHUNK.t': '传输中断',
    'recv.err.CHUNK.m': '有一块没能取到，传输已中断。',
    'recv.err.LENGTH.t': '数据损坏',
    'recv.err.LENGTH.m': '有一块的长度与清单不符，已中止。',
    'recv.err.RELAY_BAD_MANIFEST.t': '数据不完整',
    'recv.err.RELAY_BAD_MANIFEST.m': '从中继取回的清单不完整，可能只取到一部分。请重试。',
    'recv.err.RELAY_BAD_CHUNK.t': '数据不完整',
    'recv.err.RELAY_BAD_CHUNK.m': '从中继取回的分块不完整，请重试。',
    'recv.err.RELAY_TIMEOUT.t': '等不到了',
    'recv.err.RELAY_TIMEOUT.m': '很久没有收到下一块 —— 对方可能已经关掉了程序。',
    'recv.err.RELAY_GONE.t': '房间已消失',
    'recv.err.RELAY_GONE.m': '中继上的房间已经不在了（可能已过期，或对方取消了传输）。',
    'recv.err.NOT_SUPPORTED.t': '浏览器不支持',
    'recv.err.NOT_SUPPORTED.m': '这个浏览器缺少本次传输需要的某个能力。建议改用 Edge 或 Chrome。',
    'recv.err.E_PATH_UNSAFE.t': '文件名不安全，已停止',
    'recv.err.E_PATH_UNSAFE.m': '清单里的这个路径不能用：{name}（规则 {rule}）。为安全起见一个字节都没有写入。',
    'recv.err.E_MANIFEST_DUPLICATE_PATH.t': '有两个文件会撞在一起，已停止',
    'recv.err.E_MANIFEST_DUPLICATE_PATH.m': '「{a}」与「{b}」在你的系统上会是同一个文件，继续写会静默覆盖掉一个。为避免丢文件，一个字节都没有写入。',
    'recv.err.hint.badPassword': '确认双方输入的是同一个密码（区分大小写与空格）',

    // ── 发送端：标题 ──
    'send.title': '闪传 Flicker · 发送',
    'send.booting': '正在启动…',
    'send.bootingBadge': '启动中',

    // ── 发送端：选文件 ──
    'send.pick.head': '我要发文件',
    'send.pick.dropTitle': '把文件或文件夹拖到这里',
    'send.pick.dropSub': '也可以直接选整个文件夹，内部结构会一起传过去',
    'send.pick.files': '选择文件',
    'send.pick.dir': '选择文件夹',
    'send.pick.path': '直接输入路径',
    'send.pick.pathPlaceholder': '例如 D:\\视频\\旅行记录.mp4（多个用 ; 分隔）',
    'send.pick.add': '添加',
    'send.browse.titleFile': '选择要发的文件',
    'send.browse.titleDir': '选择要发的文件夹',
    'send.browse.up': '上一级',
    'send.browse.close': '关闭',
    'send.browse.pickDir': '就发这个文件夹',
    'send.browse.pickFile': '就发这个文件',
    'send.browse.pickFiles': '就发这些（{n} 个）',
    'send.browse.selected': '已选 {n} 个',
    'send.browse.enter': '进入这个文件夹',
    'send.browse.hintFile': '点文件选中（可多选，Shift 连选）；点文件夹名字进去；双击直接发这一个',
    'send.browse.hintDir': '点文件夹选中（可多选）；点左边的 ▸ 进去；这里只列文件夹',
    'send.browse.empty': '这里没有可发的东西',
    'send.browse.loading': '正在读取…',
    'send.browse.more': '（只列出前 {n} 项）',
    'send.browse.drives': '这台电脑',
    'send.browse.failed': '打不开：{msg}',
    'send.browse.here': '当前',
    'send.plan.groupFiles': '{n} 个文件',
    'send.plan.entriesMore': '还有 {n} 个未列出',
    'send.pick.dropNoPath': '浏览器不会把文件的完整路径交给网页，' +
      '请在下面这个窗口里找到它（点文件夹进去，选中后按「就发这个」）',

    // ── 发送端：清单 ──
    'send.plan.head': '本次传输',
    'send.plan.more': '继续添加',
    'send.plan.clear': '全部清空',
    'send.plan.remove': '从清单里去掉这一项',
    'send.plan.removeFailed': '去不掉：{msg}',
    'send.plan.summary': '{n} 个文件 · {size}',

    // ── 发送端：密码与选项 ──
    'send.pw.head': '一次性密码',
    'send.pw.regen': '换一个',
    'send.pw.copy': '复制',
    'send.pw.hint': '自动生成，好念好打。传输完成后立即失效。对方需要输入完全相同的密码。',
    'send.opt.head': '传输选项',
    'send.opt.gift': '顺便把「闪传」也送给对方',
    'send.opt.giftHint': '对方收到后也能把文件发给别人，不用再去下载。',
    'send.opt.rate': '限速',
    'send.opt.rateNone': '不限速',
    'send.opt.rateCustom': '自定义…',
    'send.opt.rateHint': '限制发送速度，别把上行带宽占满（家里有人打游戏、开会时有用）。' +
      '选「不限速」就是全速发送。',
    'send.opt.ratePlaceholder': '例如 512K、5M、2G',
    'send.opt.rateBad': '看不懂这个速度写法：{spec}。可以写 512K、5M、2G（纯数字按字节/秒算）',
    'send.opt.rateActive': '限速 {spec}/s',
    'send.start': '开始传输',

    // ── 发送端：等待 ──
    'send.wait.head': '让对方扫码或打开链接',
    'send.wait.copyLink': '复制链接',
    'send.wait.preview': '本机预览',
    'send.wait.hint': '链接含一次性令牌，首次访问后失效。<b style="color:var(--warn)">建议链接和密码分开发送</b>（比如链接发微信、密码打电话说）。<br>' +
      '<b>对方那台电脑第一次打开会看到一次「不安全」提示</b> —— 证书只装在本机，' +
      '让 TA 点「高级 → 继续前往」即可；数据仍然是端到端加密的。',
    'send.wait.destroy': '立即销毁',

    // ── 发送端：传输中 ──
    'send.go.total': '总进度',
    'send.go.speed': '速度',
    'send.go.elapsed': '已用时间',
    'send.go.eta': '剩余',
    'send.go.cancel': '取消并销毁',

    // ── 发送端：完成 ──
    'send.done.head': '传输完成',
    'send.done.detail': '{n} 个文件 · {size} · 用时 {time}',
    'send.done.destroyList': '会话销毁清单',
    'send.done.ck1': '密码与会话密钥已释放',
    'send.done.ck2': '一次性链接已失效',
    'send.done.ck3': '本地服务已关闭',
    'send.done.giftSent': '已把「闪传」一并送给对方',
    'send.done.again': '再传一次',

    // ── 发送端：错误 ──
    'send.err.head': '出错了',
    'send.err.back': '返回',
    'send.err.planFailed': '无法读取这些文件',
    'send.err.planFailedHint': '确认路径存在、且有读取权限。',
    'send.err.startFailed': '启动失败',
    'send.err.unknown': '未知错误',
    'send.foot': '本页面只监听本机回环地址，局域网内其他设备无法访问',

    // ── 发送端：状态与动态 ──
    'send.state.idle': '空闲中',
    'send.state.plan': '待开始',
    'send.state.waiting': '等待对方',
    'send.state.transfer': '传输中',
    'send.state.done': '已完成',
    'send.state.destroyed': '已销毁',
    'send.state.error': '出错',
    'send.state.unknown': '未知',
    'send.sub.local': '本机 {host} · 同一网络内可直连',
    'send.sub.ready': '准备就绪',
    'send.done.delivered': '✓ 已送达',
    'send.fileCount': '{n} 个文件',
    'send.copyOk': '已复制',
    'send.err.addFailed': '添加失败：{msg}',
    'send.err.startFailedMsg': '无法开始：{msg}',
    'send.err.pathHint': '浏览器出于安全限制不会把本地完整路径交给网页。\n\n' +
      '已为你填好文件名，请在前面补上所在文件夹（例如 D:\\视频\\），然后回车。\n' +
      '这样 Node 会直接读取原文件，不复制、不占内存 —— 大文件必须这样做。',

    // ── 手机上传页（phone.html）：手机 → 电脑 ──
    // 这一页是**对方（手机）**看到的，所以措辞以"手机"为主语，别写成"发送端"。
    'phone.title': '闪传 Flicker · 发到电脑',
    'phone.sub': '把手机里的照片、视频发给电脑',
    'phone.pw.head': '输入电脑屏幕上的密码',
    'phone.pw.sub': '电脑上运行着接收服务，屏幕上写着一串一次性密码。',
    'phone.pw.label': '一次性密码',
    'phone.pw.placeholder': '例如 k7m-3fq',
    'phone.pw.start': '连接电脑',
    'phone.pw.checking': '正在核对密码…（约 1 秒）',
    'phone.pw.foot': '密码不会离开这台手机 —— 它只用来核对两边是不是同一个密码',
    'phone.pick.head': '选要发的照片 / 视频',
    'phone.pick.photos': '选择照片 / 视频',
    'phone.pick.other': '选择其他文件',
    'phone.pick.hint': '可以一次选多个。手机不能选整个文件夹 —— 那是浏览器的限制，不是程序的问题。',
    'phone.pick.empty': '还没有选文件',
    'phone.pick.selected': '已选 {n} 个 · 共 {size}',
    'phone.pick.remove': '移除',
    'phone.pick.clear': '全部清空',
    'phone.pick.start': '开始发送',
    'phone.pick.resume': '继续发送（接着上次没传完的）',
    'phone.pick.hashing': '正在计算校验值 {done}/{n}（手机上这步略慢，之后电脑才能验证完整性）',
    'phone.pick.hashDone': '校验值已算好，可以发送了',
    'phone.pick.waitHash': '校验值还在算，稍等一下…',
    'phone.pick.connected': '已连上电脑，密码核对通过',
    'phone.go.state': '正在发送',
    'phone.go.file': '当前文件',
    'phone.go.total': '总进度',
    'phone.go.speed': '速度',
    'phone.go.eta': '剩余',
    'phone.go.pause': '暂停',
    'phone.go.paused': '已暂停（会话还在，点「继续发送」接着传）',
    'phone.go.keepAwake': '请让这个页面保持在前台，别熄屏 —— 切到别的应用会被浏览器冻住（回来会自动接着传）',
    'phone.go.resume': '从上次中断的地方继续（还有 {n} 块）',
    'phone.go.retrying': '网络抖了一下，正在重试（{n}/{max}）',
    'phone.done.head': '全部发完了',
    'phone.done.detail': '{n} 个文件 · {size} · 用时 {time}',
    'phone.done.renamed': '有 {n} 个文件电脑上本来就有同名的，已自动改名保存（比如「照片 (1).jpg」）',
    'phone.done.skipped': '跳过了 {n} 个（电脑上已有同名文件）',
    'phone.done.failed': '有 {n} 个没能定稿：{list}',
    'phone.done.close': '手机上可以关掉这个页面了。电脑那边会接着校验并保存。',
    'phone.done.againHint': '还想再发一批？请在电脑上重新发起一次接收 —— 那会给你一个新链接（链接是一次性的）。',
    'phone.err.BAD_PASSWORD.t': '密码不对',
    'phone.err.BAD_PASSWORD.m': '和电脑屏幕上那串密码不一致（区分大小写，注意中间的短横线）。可以直接重试。',
    'phone.err.TOO_MANY_FAILURES.t': '会话已作废',
    'phone.err.TOO_MANY_FAILURES.m': '密码连续错了太多次，为防止有人在猜，这次会话已经销毁。请在电脑上重新运行一次接收命令。',
    'phone.err.TOKEN_USED.t': '这个链接已经用过了',
    'phone.err.TOKEN_USED.m': '链接是一次性的。请让电脑那边重新发起一次，你会拿到一个新链接。',
    'phone.err.TOKEN_INVALID.t': '链接无效',
    'phone.err.TOKEN_INVALID.m': '这个链接不是这次会话的（可能过期或被改过）。请重新扫码。',
    'phone.err.BAD_LINK.t': '链接不完整',
    'phone.err.BAD_LINK.m': '这个地址里没有一次性令牌。请扫电脑屏幕上的二维码，或让电脑那边重新发一次链接。',
    'phone.err.DESTROYED.t': '电脑那边已经结束了',
    'phone.err.DESTROYED.m': '这次接收服务已经关闭（可能是超时或对方按了 Ctrl+C）。请让电脑重新运行一次。',
    'phone.err.NETWORK.t': '连不上电脑',
    'phone.err.NETWORK.m': '请确认：① 手机和电脑在同一个 WiFi；② 电脑上那个程序还在运行；③ 电脑的防火墙允许它。然后重试。',
    'phone.err.E_CHUNK_AUTH.t': '有一块数据没通过校验',
    'phone.err.E_CHUNK_AUTH.m': '传输途中有字节被改动或丢失（隧道的加密校验拦住了它），程序会自动重发这一块。',
    'phone.err.INCOMPLETE.t': '电脑说还缺数据',
    'phone.err.INCOMPLETE.m': '有几块没收到。点重试会先问电脑缺哪些，只补那些。',
    'phone.err.NO_SPACE.t': '电脑磁盘空间不够',
    'phone.err.NO_SPACE.m': '电脑那边算下来放不下这些文件，已经在写任何东西之前停下了。清出空间后重新发起即可。',
    'phone.err.TOO_MANY_FILES.t': '文件太多',
    'phone.err.TOO_MANY_FILES.m': '电脑设的上限被超过了（默认 5000 个）。少选一些再试。',
    'phone.err.TOO_MANY_BYTES.t': '总量太大',
    'phone.err.TOO_MANY_BYTES.m': '电脑设的大小上限被超过了（默认 200 GB）。少选一些再试。',
    'phone.err.E_PATH_UNSAFE.t': '文件名不安全，已中止',
    'phone.err.E_PATH_UNSAFE.m': '有文件名不符合电脑上的安全规则（例如带路径分隔符或保留名）。为安全起见，这次会话已经中止，一个字节都没写入。',
    'phone.err.E_MANIFEST_DUPLICATE_PATH.t': '有两个文件会撞在一起',
    'phone.err.E_MANIFEST_DUPLICATE_PATH.m': '选中的文件里有重名（在电脑的系统上会是同一个文件）。请去掉一个再试 —— 一个字节都没有写入。',
    'phone.err.UNKNOWN.t': '出错了',
    'phone.err.retry': '重试',
    'phone.err.hint.badPassword': '确认双方输入的是同一个密码（区分大小写与空格）',

    // ── 站点页里的「接收文件」（手机 → 这台电脑）──
    // ⚠️ 与手机上传页（phone.*）是**两端**的文案：这里是电脑屏幕上看的，
    //    那边是手机上看的。同一个动作在两边的措辞不一样，别互相抄。
    'recvui.head': '或者，让别人发给我',
    'recvui.title': '手机拍的照片传到这台电脑',
    'recvui.sub': '点下面这个按钮，屏幕上会出现一个二维码；手机扫码打开页面，选照片发过来即可。手机不用装任何东西。',
    'recvui.enter': '接收文件',
    'recvui.panelHead': '接收文件（手机发过来）',
    'recvui.idleHint': '电脑会起一个 HTTPS 服务（只在局域网里可达），手机扫码就能把照片/视频发过来。传完之后密钥、链接、证书都会销毁。',
    'recvui.dirLabel': '存到哪里',
    'recvui.dirPick': '选择文件夹',
    'recvui.dirPickTitle': '选择保存到哪个文件夹',
    'recvui.dirPickOk': '就存到这里',
    'recvui.start': '开始接收',
    'recvui.back': '返回发送',
    'recvui.scanHint': '手机和电脑要在同一个 WiFi 下。手机上第一次打开会看到一次「不安全」提示，点「高级 → 继续前往」即可。',
    'recvui.copyLink': '复制链接',
    'recvui.pwLabel': '一次性密码（手机上要输入它）',
    'recvui.dirShowLabel': '保存到',
    'recvui.curFile': '当前文件',
    'recvui.stop': '停止并销毁',
    'recvui.openDir': '打开保存文件夹',
    'recvui.state.starting': '正在准备证书与监听…',
    'recvui.state.waiting': '等待手机连上来…（链接与密码是一次性的）',
    'recvui.state.transfer': '正在接收…',
    'recvui.state.finalizing': '正在收尾（校验已完成，正在销毁密钥与证书）…',
    'recvui.state.done': '全部收到，已保存',
    'recvui.state.stopped': '已按你的要求停止并销毁',
    'recvui.state.timeout': '一直没人连上来，已经销毁',
    'recvui.state.error': '出错了',
    'recvui.state.peer': '手机已连接：{addr}',
    'recvui.ask.title': '电脑上已经有同名文件',
    'recvui.ask.file': '「{rel}」在电脑上已经存在（{existing}）。这一个文件先挂着，其余文件继续传。',
    'recvui.ask.rename': '换个名字',
    'recvui.ask.overwrite': '覆盖它',
    'recvui.ask.skip': '跳过这个文件',
    'recvui.ask.timeout': '5 分钟不回答就按最安全的「换个名字」处理。',
    'recvui.done.title': '接收结束',
    'recvui.done.detail': '{n} 个文件 · {size} · 用时 {time}',
    'recvui.done.again': '再来一次',
    // ── 从对方的链接接收（`flicker recv <链接>` 的界面版）──
    'pullui.head': '或者，从对方的链接接收',
    'pullui.title': '对方也装了闪传？把链接和密码贴进来',
    'pullui.sub': '由这台电脑直接取回文件（逐块校验、整文件哈希），不用开浏览器。',
    'pullui.enter': '从链接接收',
    'pullui.panelHead': '从对方的链接接收',
    'pullui.hint': '把对方屏幕上那条链接和一次性密码贴进来。第一次连上会显示对方的证书指纹，核对一致再开始。',
    'pullui.linkLabel': '对方的链接',
    'pullui.pwLabel': '一次性密码',
    'pullui.dirLabel': '存到哪里',
    'pullui.dirPick': '选择文件夹',
    'pullui.dirShowLabel': '保存到',
    'pullui.probe': '连上去看证书指纹',
    'pullui.back': '返回',
    'pullui.confirmHint': '对方屏幕上应该显示同一个指纹。不一致就不要继续 —— 那说明有人可能冒充了对方的地址。',
    'pullui.noTls': '这条链接是明文 http，没有证书可核对。确定是自家局域网再继续。',
    'pullui.noTlsShort': '（明文 http，无证书）',
    'pullui.start': '指纹一致，开始接收',
    'pullui.insecure': '不核对，直接开始',
    'pullui.insecureNote': '「不核对」会跳过证书检查：一个冒充了对方地址的假服务就拦不住了。只在你自己确定这是自家局域网时用。',
    'pullui.stop': '停止接收',
    'pullui.openDir': '打开保存文件夹',
    'pullui.curFile': '当前文件',
    'pullui.defaultDir': '（默认：这台电脑的「下载」目录）',
    'pullui.state.connecting': '正在连对方、取清单…',
    'pullui.state.transfer': '正在接收：{files}/{total} 个文件',
    'pullui.state.stopping': '正在停止…',
    'pullui.doneDetail': '收到 {n} 个文件 · {size} —— 逐块校验与整文件哈希都已通过',
    'pullui.doneFailed': '（{n} 个失败）',
    'pullui.stopped': '已停止接收。已经收下的文件保留在磁盘上。',
    'pullui.err.noLink': '先填对方的链接',
    'pullui.err.noPassword': '先填对方给的一次性密码',
    'pullui.err.network': '连不上对方：确认对面的程序还开着、两台机器在同一个网络里',
    'pullui.err.unknown': '出错了（没有更多信息）',
    'pullui.err.withWhere': '{where} 失败：{msg}',
    'pullui.err.RELAY_LINK': '这是中继链接：它的接收端在网页里，请用浏览器打开（那里用的是正规 HTTPS，没有证书门槛）。',
    'pullui.err.NEED_CONFIRM': '还没核对证书指纹 —— 先点「连上去看证书指纹」，或者明确选择「不核对」。',
    'pullui.err.FINGERPRINT': '你输入的指纹和对方证书不一致 —— 可能有人在冒充对方的地址。',
    'pullui.err.BAD_PASSWORD': '密码不对（区分大小写，注意空格）',
    'pullui.err.PEER_AUTH': '对方未能证明它知道密码 —— 已中止',
    'pullui.err.CONNECT': '连不上对方（程序关了？不在同一个网络？）',
    'pullui.err.TIMEOUT': '对方太久没有响应',
    'pullui.err.TOKEN_USED': '这个链接已经被用过了（一次性链接）',
    'pullui.err.TOKEN_INVALID': '链接无效或已失效',
    'pullui.err.CANCELLED': '已取消',
  },

  en: {
    // ── Common ──
    'app.name': 'Flicker',
    'app.brand': 'Flicker',
    'app.tagline': 'One-shot file transfer · gone when it\'s done',
    'common.retry': 'Retry',
    'common.cancel': 'Cancel',
    'common.cancelDestroy': 'Cancel and destroy',
    'common.done': 'Done',
    'common.error': 'Something went wrong',
    'common.seconds': '{n}s',
    'common.minutes': '{n}m',
    'common.langSwitch': '中文',

    // ── Receiver: titles ──
    'recv.title': 'Flicker · Receive files',
    'recv.titleDone': 'Flicker · This page will no longer work once the transfer ends',

    // ── Receiver: password screen ──
    'recv.pw.title': 'Someone wants to send you files',
    'recv.pw.sub': 'Enter the one-time password they gave you. Once the transfer finishes, ' +
      'the password and the link stop working immediately.',
    'recv.pw.manifestLocked': 'File list is encrypted',
    'recv.pw.manifestHint': 'Visible only after the correct password is entered',
    'recv.pw.label': 'One-time password',
    'recv.pw.placeholder': 'Enter the password you were given',
    'recv.pw.show': 'Show password',
    'recv.pw.start': 'Start receiving',
    'recv.pw.foot': 'The password never leaves your computer — it is only used to confirm both sides match',

    // ── Receiver: verifying ──
    'recv.busy.title': 'Verifying password…',
    'recv.busy.sub': 'The transfer starts only after both sides match',
    'recv.busy.localCalc': 'Computing locally — the password never leaves this computer (~1 second)',
    'recv.busy.localParams': 'Reading session parameters…',
    'recv.busy.relayParams': 'Fetching information from the relay…',

    // ── Receiver: transferring ──
    'recv.go.state': 'Transferring',
    'recv.go.crypto': 'End-to-end encrypted · AES-256-GCM',
    'recv.go.total': 'Overall',
    'recv.go.speed': 'Speed',
    'recv.go.elapsed': 'Elapsed',
    'recv.go.eta': 'Remaining',
    'recv.go.relayNote': 'Data is forwarded by the relay, but end-to-end encrypted — the relay cannot read it',
    'recv.go.streamNote': 'Streaming <b>straight to disk</b> — memory stays flat. ' +
      'You will be asked where to save it; the browser then asks ' +
      '"allow this site to modify files?" — that permission is required to write the file, ' +
      'so choose <b>Allow</b>.',
    'recv.go.blobNote': 'Assembling <b>in memory</b> before saving. Large files may hit memory limits.',
    'recv.go.bigWarn': 'This browser cannot stream to disk, and this transfer is <b>{size}</b>. ' +
      'Please reopen the link in <b>Edge or Chrome</b>, or it may fail partway.',
    'recv.go.noStreamWarn': 'This browser cannot stream <b>straight to disk</b>. ' +
      'Files over ~1 GB may fail due to memory limits. Please open this page in <b>Edge or Chrome</b>.',
    'recv.go.noPermissionWarn': 'You did not allow file writing, so the transfer will be ' +
      '<b>assembled in memory</b> before saving. This one is <b>{size}</b>, which fits — you can continue. ' +
      'To stream to disk instead (safer, no memory use), click Cancel, start again and choose ' +
      '<b>Allow</b> in the folder prompt.',
    'recv.go.reconnecting': 'Connection unstable — reconnecting ({n}/{max})…',

    // ── Receiver: done ──
    'recv.done.title': 'Transfer complete',
    'recv.done.sum': '{n} files · {size}',

    // ── Receiver: errors ──
    'recv.err.cancelled': 'Cancelled',
    'recv.err.failed': 'Transfer failed',

    // ── Receiver: dynamic messages ──
    'recv.msg.decryptFail': 'Chunk {n} failed to decrypt — the data may be tampered with or corrupted. ' +
      'Aborted; this chunk was not written.',
    'recv.msg.lengthMismatch': 'Chunk {n} has the wrong length',
    'recv.msg.chunkHashFail': 'Chunk {n} failed verification (content does not match the manifest)',
    'recv.msg.fileHashFail': 'File "{name}" failed its overall verification: what arrived does not match ' +
      'the sender\'s copy. The file was saved but cannot be trusted.',
    'recv.msg.peerAuthFail': 'The other side failed authentication',
    'recv.msg.relayTimeout': 'Waited a long time for the next chunk — the other side may have closed the program',
    'recv.msg.relayGone': 'The room on the relay no longer exists — it may have expired, or the sender cancelled',
    'recv.msg.relayTaken': 'This chunk has already been taken',
    'recv.msg.relayStatus': 'Relay returned {status}',
    'recv.msg.badManifest': 'Incomplete manifest data',
    'recv.msg.badSalt': 'The salt in the link is incomplete',
    'recv.msg.badChunk': 'Incomplete chunk data',
    'recv.msg.moreFiles': '{n} more files',
    'recv.msg.fileCount': '{n} files',
    'recv.msg.wantSend': 'Someone wants to send you {n} files',
    'recv.msg.receiving': 'Receiving',
    'recv.msg.about': 'about {time}',

    // ── Receiver: done screen detail ──
    'recv.done.detail': '{n} files · {size} · {time} · {rate}/s average',
    'recv.done.verified': '✓ Verified · SHA-256 matches',
    'recv.done.saved': 'Saved',
    'recv.done.destroyList': 'Session destroyed',
    'recv.done.ck1': 'Password and session keys released with this page',
    'recv.done.ck2': 'The one-time link no longer works',
    'recv.done.ck3': 'Reloading this page will not work again',
    'recv.done.share': 'Share / Save to…',
    'recv.done.shareUnavailable': 'This browser streams files straight to disk (no copy is kept in memory), ' +
      'so the system share sheet cannot be used — the file is already where you chose to save it.',
    'recv.done.shareUnsupported': 'This platform cannot share this kind of file ({name}). ' +
      'The file is already saved to disk — you can share it from your file manager.',
    'recv.done.shareFailed': 'Sharing did not complete: {msg}',

    // ── Receiver: cancelled ──
    'recv.cancel.title': 'Cancelled',
    'recv.cancel.keptPart': 'Transfer stopped. <b style="color:var(--text)">What was already received stays on disk</b>; ' +
      'files that were not received were never created.',
    'recv.cancel.nothing': 'Transfer stopped. <b style="color:var(--text)">No files were written to disk</b>.',

    // ── Receiver: error table (title + message) ──
    'recv.err.BAD_PASSWORD.t': 'Passwords do not match',
    'recv.err.BAD_PASSWORD.m': 'The two sides do not share the same password, so the handshake was rejected. ' +
      '<b style="color:var(--text)">No data was transferred</b> and no files were written to disk.',
    'recv.err.TOO_MANY_FAILURES.t': 'Session destroyed',
    'recv.err.TOO_MANY_FAILURES.m': 'Too many failed attempts. To prevent brute force, this session was destroyed automatically. ' +
      'Ask the sender to start a new transfer.',
    'recv.err.TOKEN_USED.t': 'Link already used',
    'recv.err.TOKEN_USED.m': 'This link has already been used once. One-time links only work once — ' +
      'ask the sender to start a new transfer.',
    'recv.err.TOKEN_INVALID.t': 'Invalid link',
    'recv.err.TOKEN_INVALID.m': 'The link is incomplete or has expired. Make sure you copied the whole address ' +
      '(including everything after <code>?k=</code>), or scan the QR code instead.',
    'recv.err.DESTROYED.t': 'Session destroyed',
    'recv.err.DESTROYED.m': 'The sender has destroyed this session. Ask them to start a new transfer.',
    'recv.err.DECRYPT.t': 'Verification failed',
    'recv.err.DECRYPT.m': 'The received data failed its integrity check, so the transfer was stopped. ' +
      '<b style="color:var(--text)">This chunk was not written to disk.</b>',
    'recv.err.CHUNK_HASH.t': 'Verification failed',
    'recv.err.CHUNK_HASH.m': 'One chunk does not match the sender\'s manifest, so the transfer was stopped. ' +
      'This usually means the data was corrupted in transit.',
    'recv.err.HASH.t': 'File verification failed',
    'recv.err.HASH.m': 'The received file does not match the sender\'s hash. It was saved but ' +
      '<b style="color:var(--text)">cannot be trusted</b> — delete it and transfer again.',
    'recv.err.CANCELLED.t': 'Cancelled',
    'recv.err.CANCELLED.m': 'The transfer was stopped.',
    'recv.err.NO_WRITE_PERMISSION.t': 'No write permission',
    'recv.err.NO_WRITE_PERMISSION.m': 'You declined "allow this site to modify files", and this ' +
      'transfer is <b>{size}</b> — too large to assemble in memory first ' +
      '(it would fail partway).<br>Click <b>Retry</b> below, choose <b>Allow</b> in the folder ' +
      'prompt, then pick a save location.',
    'recv.err.PEER_AUTH.t': 'Sender failed authentication',
    'recv.err.PEER_AUTH.m': 'The sender could not prove it knows the password, so the transfer was stopped.',
    'recv.err.UNKNOWN.t': 'Something went wrong',
    'recv.err.UNKNOWN.m': 'Unknown error',
    'recv.err.CHUNK.t': 'Transfer interrupted',
    'recv.err.CHUNK.m': 'A chunk could not be fetched, so the transfer was interrupted.',
    'recv.err.LENGTH.t': 'Corrupted data',
    'recv.err.LENGTH.m': 'A chunk had the wrong length, so the transfer was stopped.',
    'recv.err.RELAY_BAD_MANIFEST.t': 'Incomplete data',
    'recv.err.RELAY_BAD_MANIFEST.m': 'The manifest fetched from the relay was incomplete. Please retry.',
    'recv.err.RELAY_BAD_CHUNK.t': 'Incomplete data',
    'recv.err.RELAY_BAD_CHUNK.m': 'A chunk fetched from the relay was incomplete. Please retry.',
    'recv.err.RELAY_TIMEOUT.t': 'Timed out',
    'recv.err.RELAY_TIMEOUT.m': 'No new chunk arrived for a long time — the other side may have closed the program.',
    'recv.err.RELAY_GONE.t': 'Room is gone',
    'recv.err.RELAY_GONE.m': 'The room on the relay no longer exists (it may have expired, or the sender cancelled).',
    'recv.err.NOT_SUPPORTED.t': 'Browser not supported',
    'recv.err.NOT_SUPPORTED.m': 'This browser lacks a capability this transfer needs. Please use Edge or Chrome.',
    'recv.err.E_PATH_UNSAFE.t': 'Unsafe file name — stopped',
    'recv.err.E_PATH_UNSAFE.m': 'A path in the manifest cannot be used: {name} (rule {rule}). Nothing was written to disk.',
    'recv.err.E_MANIFEST_DUPLICATE_PATH.t': 'Two files would collide — stopped',
    'recv.err.E_MANIFEST_DUPLICATE_PATH.m': '"{a}" and "{b}" would be the same file on your system; writing both would silently overwrite one. Nothing was written to disk.',
    'recv.err.hint.badPassword': 'Make sure both sides typed the same password (case and spaces matter)',

    // ── Sender: titles ──
    'send.title': 'Flicker · Send',
    'send.booting': 'Starting…',
    'send.bootingBadge': 'Starting',

    // ── Sender: pick files ──
    'send.pick.head': 'Send files',
    'send.pick.dropTitle': 'Drag files or folders here',
    'send.pick.dropSub': 'You can also pick a whole folder — its structure is preserved',
    'send.pick.files': 'Choose files',
    'send.pick.dir': 'Choose folder',
    'send.pick.path': 'Type a path instead',
    'send.pick.pathPlaceholder': 'e.g. D:\\Videos\\trip.mp4 (separate several with ;)',
    'send.pick.add': 'Add',
    'send.browse.titleFile': 'Pick files to send',
    'send.browse.titleDir': 'Pick a folder to send',
    'send.browse.up': 'Up',
    'send.browse.close': 'Close',
    'send.browse.pickDir': 'Send this folder',
    'send.browse.pickFile': 'Send this file',
    'send.browse.pickFiles': 'Send these ({n})',
    'send.browse.selected': '{n} selected',
    'send.browse.enter': 'Open this folder',
    'send.browse.hintFile': 'Click files to select (multi-select, Shift for a range). Click a folder name to open it; double-click sends that one item',
    'send.browse.hintDir': 'Click folders to select (multi-select). Use the ▸ on the left to open one. Only folders are listed here',
    'send.browse.empty': 'Nothing to send in here',
    'send.browse.loading': 'Reading…',
    'send.browse.more': '(showing the first {n})',
    'send.browse.drives': 'This computer',
    'send.browse.failed': 'Cannot open: {msg}',
    'send.browse.here': 'Now in',
    'send.plan.groupFiles': '{n} files',
    'send.plan.entriesMore': '{n} more not listed',
    'send.pick.dropNoPath': 'Browsers never hand a page the full path of a file, ' +
      'so find it in this window instead (open folders, then click “Send this…”)',

    // ── Sender: plan ──
    'send.plan.head': 'This transfer',
    'send.plan.more': 'Add more',
    'send.plan.clear': 'Clear all',
    'send.plan.remove': 'Remove this item from the list',
    'send.plan.removeFailed': 'Could not remove it: {msg}',
    'send.plan.summary': '{n} files · {size}',

    // ── Sender: password and options ──
    'send.pw.head': 'One-time password',
    'send.pw.regen': 'New one',
    'send.pw.copy': 'Copy',
    'send.pw.hint': 'Generated automatically — easy to read aloud and type. ' +
      'It stops working the moment the transfer ends. The other side must type exactly the same password.',
    'send.opt.head': 'Options',
    'send.opt.gift': 'Also send them Flicker itself',
    'send.opt.giftHint': 'So they can pass files on to someone else without downloading it again.',
    'send.opt.rate': 'Speed limit',
    'send.opt.rateNone': 'No limit',
    'send.opt.rateCustom': 'Custom…',
    'send.opt.rateHint': 'Cap the sending speed so it does not saturate your uplink ' +
      '(handy when someone else is gaming or on a call). “No limit” sends at full speed.',
    'send.opt.ratePlaceholder': 'e.g. 512K, 5M, 2G',
    'send.opt.rateBad': 'Cannot read that speed: {spec}. Use 512K, 5M or 2G (a plain number means bytes/s)',
    'send.opt.rateActive': 'Limited to {spec}/s',
    'send.start': 'Start transfer',

    // ── Sender: waiting ──
    'send.wait.head': 'Let them scan the code or open the link',
    'send.wait.copyLink': 'Copy link',
    'send.wait.preview': 'Preview locally',
    'send.wait.hint': 'The link contains a one-time token that stops working after the first visit. ' +
      '<b style="color:var(--warn)">Send the link and the password separately</b> ' +
      '(e.g. link by chat, password by phone).<br>' +
      '<b>Their browser will show a "not secure" warning the first time</b> — the certificate ' +
      'is only installed on this machine. Tell them to click "Advanced → Proceed"; ' +
      'the data is still end-to-end encrypted.',
    'send.wait.destroy': 'Destroy now',

    // ── Sender: transferring ──
    'send.go.total': 'Overall',
    'send.go.speed': 'Speed',
    'send.go.elapsed': 'Elapsed',
    'send.go.eta': 'Remaining',
    'send.go.cancel': 'Cancel and destroy',

    // ── Sender: done ──
    'send.done.head': 'Transfer complete',
    'send.done.detail': '{n} files · {size} · {time}',
    'send.done.destroyList': 'Session destroyed',
    'send.done.ck1': 'Password and session keys released',
    'send.done.ck2': 'The one-time link no longer works',
    'send.done.ck3': 'The local server is closed',
    'send.done.giftSent': 'Flicker was sent along with your files',
    'send.done.again': 'Send again',

    // ── Sender: errors ──
    'send.err.head': 'Something went wrong',
    'send.err.back': 'Back',
    'send.err.planFailed': 'Could not read these files',
    'send.err.planFailedHint': 'Check that the paths exist and are readable.',
    'send.err.startFailed': 'Failed to start',
    'send.err.unknown': 'Unknown error',
    'send.foot': 'This page listens on loopback only — other devices on your LAN cannot reach it',

    // ── Sender: state and dynamic ──
    'send.state.idle': 'Idle',
    'send.state.plan': 'Ready to start',
    'send.state.waiting': 'Waiting for the other side',
    'send.state.transfer': 'Transferring',
    'send.state.done': 'Done',
    'send.state.destroyed': 'Destroyed',
    'send.state.error': 'Error',
    'send.state.unknown': 'Unknown',
    'send.sub.local': 'This machine: {host} · reachable on your network',
    'send.sub.ready': 'Ready',
    'send.done.delivered': '✓ Delivered',
    'send.fileCount': '{n} files',
    'send.copyOk': 'Copied',
    'send.err.addFailed': 'Could not add: {msg}',
    'send.err.startFailedMsg': 'Could not start: {msg}',
    'send.err.pathHint': 'For security reasons the browser does not give a web page your full local path.\n\n' +
      'The file name has been filled in — add the folder in front of it (e.g. D:\\Videos\\) and press Enter.\n' +
      'That way Node reads the original file directly: no copy, no memory cost. Large files require this.',

    // ── Phone upload page (phone.html): phone → computer ──
    'phone.title': 'Flicker · Send to computer',
    'phone.sub': 'Send photos and videos from this phone to the computer',
    'phone.pw.head': 'Type the password shown on the computer',
    'phone.pw.sub': 'The computer is running a receive service and its screen shows a one-time password.',
    'phone.pw.label': 'One-time password',
    'phone.pw.placeholder': 'e.g. k7m-3fq',
    'phone.pw.start': 'Connect',
    'phone.pw.checking': 'Checking the password… (about a second)',
    'phone.pw.foot': 'The password never leaves this phone — it only proves both sides typed the same one',
    'phone.pick.head': 'Pick photos / videos to send',
    'phone.pick.photos': 'Choose photos / videos',
    'phone.pick.other': 'Choose other files',
    'phone.pick.hint': 'You can select several at once. A phone cannot pick a whole folder — that is a browser limit, not a limitation of this program.',
    'phone.pick.empty': 'Nothing selected yet',
    'phone.pick.selected': '{n} selected · {size} total',
    'phone.pick.remove': 'Remove',
    'phone.pick.clear': 'Clear all',
    'phone.pick.start': 'Start sending',
    'phone.pick.resume': 'Resume (continue the parts that did not finish)',
    'phone.pick.hashing': 'Computing checksums {done}/{n} (slower on a phone; the computer needs them to verify integrity)',
    'phone.pick.hashDone': 'Checksums ready — you can send now',
    'phone.pick.waitHash': 'Still computing checksums, one moment…',
    'phone.pick.connected': 'Connected to the computer — password verified',
    'phone.go.state': 'Sending',
    'phone.go.file': 'Current file',
    'phone.go.total': 'Total progress',
    'phone.go.speed': 'Speed',
    'phone.go.eta': 'Remaining',
    'phone.go.pause': 'Pause',
    'phone.go.paused': 'Paused (the session is still alive — tap "Resume" to carry on)',
    'phone.go.keepAwake': 'Keep this page in the foreground and the screen awake — a backgrounded page gets frozen by the browser (it resumes automatically when you come back)',
    'phone.go.resume': 'Resuming where it stopped ({n} chunks left)',
    'phone.go.retrying': 'The network hiccuped, retrying ({n}/{max})',
    'phone.done.head': 'Everything sent',
    'phone.done.detail': '{n} files · {size} · took {time}',
    'phone.done.renamed': '{n} file(s) already existed on the computer and were saved under a new name (e.g. "photo (1).jpg")',
    'phone.done.skipped': '{n} skipped (the computer already had files with those names)',
    'phone.done.failed': '{n} could not be finalised: {list}',
    'phone.done.close': 'You can close this page now. The computer will finish verifying and saving.',
    'phone.done.againHint': 'Want to send another batch? Start the receive service again on the computer —— that gives you a fresh link (links are one-shot).',
    'phone.err.BAD_PASSWORD.t': 'Wrong password',
    'phone.err.BAD_PASSWORD.m': 'It does not match the password on the computer screen (case matters, and watch the dash in the middle). You can retry right away.',
    'phone.err.TOO_MANY_FAILURES.t': 'Session destroyed',
    'phone.err.TOO_MANY_FAILURES.m': 'Too many wrong passwords, so this session was destroyed to stop guessing. Run the receive command on the computer again.',
    'phone.err.TOKEN_USED.t': 'This link was already used',
    'phone.err.TOKEN_USED.m': 'The link is one-shot. Ask the computer to start again and you will get a fresh one.',
    'phone.err.TOKEN_INVALID.t': 'Invalid link',
    'phone.err.TOKEN_INVALID.m': 'This link does not belong to the current session (expired or altered). Scan the code again.',
    'phone.err.BAD_LINK.t': 'Incomplete link',
    'phone.err.BAD_LINK.m': 'There is no one-time token in this address. Scan the QR code on the computer screen, or ask for the link again.',
    'phone.err.DESTROYED.t': 'The computer side has finished',
    'phone.err.DESTROYED.m': 'This receive service is closed (timed out, or the other side pressed Ctrl+C). Start it again on the computer.',
    'phone.err.NETWORK.t': 'Cannot reach the computer',
    'phone.err.NETWORK.m': 'Check that: (1) the phone and the computer are on the same WiFi; (2) the program is still running on the computer; (3) its firewall allows it. Then retry.',
    'phone.err.E_CHUNK_AUTH.t': 'One chunk failed verification',
    'phone.err.E_CHUNK_AUTH.m': 'Bytes were changed or lost on the way (the tunnel encryption caught it); the program resends that chunk automatically.',
    'phone.err.INCOMPLETE.t': 'The computer says data is missing',
    'phone.err.INCOMPLETE.m': 'Some chunks did not arrive. Retrying first asks the computer what is missing and sends only that.',
    'phone.err.NO_SPACE.t': 'Not enough space on the computer',
    'phone.err.NO_SPACE.m': 'The computer calculated that these files do not fit and stopped before writing anything. Free some space and start again.',
    'phone.err.TOO_MANY_FILES.t': 'Too many files',
    'phone.err.TOO_MANY_FILES.m': 'The computer\u2019s limit was exceeded (5000 by default). Select fewer and retry.',
    'phone.err.TOO_MANY_BYTES.t': 'Too much data',
    'phone.err.TOO_MANY_BYTES.m': 'The computer\u2019s size limit was exceeded (200 GB by default). Select less and retry.',
    'phone.err.E_PATH_UNSAFE.t': 'Unsafe file name — aborted',
    'phone.err.E_PATH_UNSAFE.m': 'A file name breaks the computer\u2019s safety rules (path separators, reserved names…). The session was aborted and not a single byte was written.',
    'phone.err.E_MANIFEST_DUPLICATE_PATH.t': 'Two files would collide',
    'phone.err.E_MANIFEST_DUPLICATE_PATH.m': 'Two of the selected files share a name (they would be the same file on the computer). Remove one and retry — nothing was written.',
    'phone.err.UNKNOWN.t': 'Something went wrong',
    'phone.err.retry': 'Retry',
    'phone.err.hint.badPassword': 'Make sure both sides typed the same password (case and spaces matter)',

    // ── The station page's "Receive files" panel (phone → this computer) ──
    'recvui.head': 'Or, let someone send to me',
    'recvui.title': 'Photos from your phone, onto this computer',
    'recvui.sub': 'Click the button below and a QR code appears; the phone scans it, picks photos and sends them. The phone installs nothing.',
    'recvui.enter': 'Receive files',
    'recvui.panelHead': 'Receiving (sent from a phone)',
    'recvui.idleHint': 'The computer starts an HTTPS service (reachable on your LAN only); the phone scans the code and sends photos/videos. When it finishes, the keys, the link and the certificate are all destroyed.',
    'recvui.dirLabel': 'Save to',
    'recvui.dirPick': 'Choose folder',
    'recvui.dirPickTitle': 'Choose where to save',
    'recvui.dirPickOk': 'Save here',
    'recvui.start': 'Start receiving',
    'recvui.back': 'Back to sending',
    'recvui.scanHint': 'Phone and computer must be on the same WiFi. The phone will show a "not secure" warning the first time — tap "Advanced → Proceed".',
    'recvui.copyLink': 'Copy link',
    'recvui.pwLabel': 'One-time password (typed into the phone)',
    'recvui.dirShowLabel': 'Saving to',
    'recvui.curFile': 'Current file',
    'recvui.stop': 'Stop and destroy',
    'recvui.openDir': 'Open the save folder',
    'recvui.state.starting': 'Preparing certificate and listener…',
    'recvui.state.waiting': 'Waiting for the phone… (the link and password are one-shot)',
    'recvui.state.transfer': 'Receiving…',
    'recvui.state.finalizing': 'Finishing up (verification passed; destroying keys and certificate)…',
    'recvui.state.done': 'All received and saved',
    'recvui.state.stopped': 'Stopped and destroyed as you asked',
    'recvui.state.timeout': 'Nobody connected, so it was destroyed',
    'recvui.state.error': 'Something went wrong',
    'recvui.state.peer': 'Phone connected: {addr}',
    'recvui.ask.title': 'A file with that name already exists',
    'recvui.ask.file': '"{rel}" already exists on the computer ({existing}). That one file waits for you; the rest keep transferring.',
    'recvui.ask.rename': 'Use a new name',
    'recvui.ask.overwrite': 'Overwrite it',
    'recvui.ask.skip': 'Skip this file',
    'recvui.ask.timeout': 'After 5 minutes without an answer it takes the safest choice (rename).',
    'recvui.done.title': 'Receiving finished',
    'recvui.done.detail': '{n} files · {size} · took {time}',
    'recvui.done.again': 'Start again',
    // ── Receiving from the other side's link (the GUI form of `flicker recv <link>`) ──
    'pullui.head': 'Or, receive from a link',
    'pullui.title': 'They have Flicker too? Paste the link and password',
    'pullui.sub': 'This computer fetches the files itself (every chunk verified, whole-file hash checked) —— no browser needed.',
    'pullui.enter': 'Receive from a link',
    'pullui.panelHead': 'Receive from a link',
    'pullui.hint': "Paste the link and the one-time password shown on the other side's screen. The first connection shows their certificate fingerprint — check it, then start.",
    'pullui.linkLabel': "The other side's link",
    'pullui.pwLabel': 'One-time password',
    'pullui.dirLabel': 'Save to',
    'pullui.dirPick': 'Choose folder',
    'pullui.dirShowLabel': 'Saving to',
    'pullui.probe': 'Connect and show the fingerprint',
    'pullui.back': 'Back',
    'pullui.confirmHint': "Their screen should show the same fingerprint. If it does not, do not continue —— that means someone may be impersonating their address.",
    'pullui.noTls': 'This link is plain http, so there is no certificate to check. Only continue if you are sure it is your own LAN.',
    'pullui.noTlsShort': '(plain http, no certificate)',
    'pullui.start': 'Fingerprint matches — start',
    'pullui.insecure': 'Skip the check and start',
    'pullui.insecureNote': '"Skip the check" turns off certificate verification: a fake service impersonating their address would get through. Only use it when you are sure it is your own LAN.',
    'pullui.stop': 'Stop receiving',
    'pullui.openDir': 'Open the save folder',
    'pullui.curFile': 'Current file',
    'pullui.defaultDir': '(default: this computer’s Downloads folder)',
    'pullui.state.connecting': 'Connecting and fetching the manifest…',
    'pullui.state.transfer': 'Receiving: {files}/{total} files',
    'pullui.state.stopping': 'Stopping…',
    'pullui.doneDetail': 'Received {n} files · {size} —— every chunk and the whole-file hash verified',
    'pullui.doneFailed': '({n} failed)',
    'pullui.stopped': 'Stopped. Files already received stay on disk.',
    'pullui.err.noLink': 'Fill in their link first',
    'pullui.err.noPassword': 'Fill in the one-time password first',
    'pullui.err.network': 'Cannot reach the other side: check that their program is still running and you are on the same network',
    'pullui.err.unknown': 'Something went wrong (no further details)',
    'pullui.err.withWhere': '{where} failed: {msg}',
    'pullui.err.RELAY_LINK': 'This is a relay link: it receives inside the web page, so open it in a browser (a relay uses a proper HTTPS certificate, so there is no hurdle there).',
    'pullui.err.NEED_CONFIRM': 'The certificate fingerprint has not been checked yet — click "Connect and show the fingerprint", or explicitly choose "Skip the check".',
    'pullui.err.FINGERPRINT': 'The fingerprint you typed does not match their certificate — someone may be impersonating their address.',
    'pullui.err.BAD_PASSWORD': 'Wrong password (case and spaces matter)',
    'pullui.err.PEER_AUTH': 'The other side could not prove it knows the password — stopped',
    'pullui.err.CONNECT': 'Cannot reach the other side (program closed? different network?)',
    'pullui.err.TIMEOUT': 'The other side did not respond for a long time',
    'pullui.err.TOKEN_USED': 'This link has already been used (one-shot link)',
    'pullui.err.TOKEN_INVALID': 'Invalid or expired link',
    'pullui.err.CANCELLED': 'Cancelled',
  },
}

/** 支持的语言，以及它们在切换按钮上显示的名字 */
export const LANGS = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
]

export const DEFAULT_LANG = 'zh'

/** 语言偏好的存储键。⚠️ 只存语言，绝不存任何与传输有关的东西。 */
export const LANG_KEY = 'flicker.lang'
