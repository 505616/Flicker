/**
 * 当 `git push` 连不上 github.com 时，用 **api.github.com** 把提交推上去
 * ================================================================
 *
 * 为什么会有这个工具（2026-10 实测这台机器所在的网络）：
 *   · `api.github.com`、`codeload.github.com`：正常（HTTP 200）
 *   · `github.com`（git 的 push/fetch 都走它）：**443 连接超时**，换几个官方地址也一样，
 *     偶发能连上一次 —— 表现就是 `RPC failed; curl 52` 或者干等 21 秒超时。
 *   所以 `git push` 在这条网络上不可用，而 GitHub 的 **Git Data API** 是通的。
 *
 * 它做的事与 `git push` **等价**（不是"上传一个压缩包"这种近似）：
 *   1. `git rev-list` 找出远端缺失的那几个提交（必须是它的**后代**，否则拒绝 —— 不做合并）
 *   2. `git ls-tree -r` 逐提交取文件清单，`git cat-file --batch` 取**已提交的**字节
 *   3. `POST /git/blobs` 建 blob（内容寻址，所以返回的 SHA 与本地一模一样）
 *   4. `POST /git/trees` 建树（tree SHA 必须等于本地 `git rev-parse <commit>^{tree}`）
 *   5. `POST /git/commits` 建提交，**作者/提交者/时间/说明与本地逐字相同**
 *      —— 于是 GitHub 生成的 commit SHA 应当 == 本地 SHA
 *   6. `PATCH /git/refs/heads/<branch>`（`force:false`）
 *
 * 做完之后远端与本地**逐字节同一批提交**，不需要 fetch/reset 去对账；
 * 本脚本会顺手把 `refs/remotes/origin/<branch>` 更新成同一个 SHA（等价于 fetch 的结果）。
 *
 * ⚠️ 它不该被当成推送的常规方式：网络正常时请用 `git push`。
 *
 * 用法：
 *   node _lab/push-via-api.mjs --repo=505616/Flicker --branch=main --token=ghp_xxx
 *   （token 也可用环境变量 GH_TOKEN；不要写进任何文件）
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const REPO = argOf('repo')
const BRANCH = argOf('branch', 'main')
const TOKEN = argOf('token') ?? process.env.GH_TOKEN
if (!REPO) { console.error('缺 --repo=owner/name'); process.exit(2) }
if (!TOKEN) { console.error('缺 --token=（或环境变量 GH_TOKEN）'); process.exit(2) }

const API = 'https://api.github.com'
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'flicker-push-via-api',
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1) }

async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 就留 null */ }
  if (!res.ok) {
    const e = new Error(`${method} ${urlPath} → HTTP ${res.status}: ${json?.message ?? text.slice(0, 300)}`)
    e.status = res.status
    throw e
  }
  return json
}

/** `git cat-file --batch` 一次取一批 blob 的原始字节（不必按文件起进程） */
function readBlobs(shas) {
  if (!shas.length) return new Map()
  const buf = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input: shas.join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024,
  })
  const out = new Map()
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i)
    if (nl < 0) break
    const m = buf.subarray(i, nl).toString('utf8').match(/^([0-9a-f]{40}) (\w+) (\d+)$/)
    if (!m) break
    const size = Number(m[3])
    const start = nl + 1
    out.set(m[1], buf.subarray(start, start + size))
    i = start + size + 1          // 跳过内容后那个换行
  }
  return out
}

/** 一个提交的文件清单：[{ mode, sha, path }] */
function treeEntriesOf(commit) {
  return git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean).map((line) => {
    const m = line.match(/^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/)
    return { mode: m[1] === '100755' ? '100755' : '100644', type: 'blob', sha: m[3], path: m[4] }
  })
}

console.log(`仓库：${REPO}  分支：${BRANCH}`)

// ── 0. 本地必须干净：否则"推上去的"与"你看到的"不是一回事 ──
const dirty = git('status', '--porcelain').trim()
if (dirty) fail(`工作区有未提交的改动，先提交再推：\n${dirty.split('\n').slice(0, 10).join('\n')}`)

const localSha = git('rev-parse', 'HEAD').trim()

// ── 1. 远端现状 ──
const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
const remoteSha = ref.object.sha
if (remoteSha === localSha) {
  console.log('✓ 远端已经是这个提交了，不用做任何事')
  process.exit(0)
}
try {
  git('merge-base', '--is-ancestor', remoteSha, 'HEAD')
} catch {
  fail(`远端 ${BRANCH}（${remoteSha.slice(0, 10)}）**不是**本地 HEAD 的祖先 —— ` +
    '两条历史分叉了，先人工对齐（本工具不做合并、也不 force）')
}

const commits = git('rev-list', '--reverse', `${remoteSha}..HEAD`).trim().split('\n').filter(Boolean)
console.log(`要做 ${commits.length} 个提交（接在远端的 ${remoteSha.slice(0, 10)} 后面）`)

// ── 2. 所有提交里的 blob 去重上传 ──
const perCommit = commits.map((sha) => ({ sha, entries: treeEntriesOf(sha) }))
const allBlobs = new Set()
for (const c of perCommit) for (const e of c.entries) allBlobs.add(e.sha)
const blobData = readBlobs([...allBlobs])
console.log(`文件条目：${perCommit.reduce((a, c) => a + c.entries.length, 0)}，` +
  `去重后 blob：${blobData.size}`)

let done = 0
const queue = [...blobData.entries()]
async function worker() {
  for (;;) {
    const item = queue.shift()
    if (!item) return
    const [sha, data] = item
    const r = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: Buffer.from(data).toString('base64'), encoding: 'base64',
    })
    if (r.sha !== sha) fail(`blob SHA 对不上：本地 ${sha}，远端 ${r.sha}（不该发生）`)
    done++
    if (done % 25 === 0 || done === blobData.size) console.log(`  已上传 ${done}/${blobData.size}`)
  }
}
await Promise.all(Array.from({ length: 6 }, worker))

// ── 3. 逐个提交：建树 → 建提交（SHA 必须与本地一致）──
let prev = remoteSha
for (const c of perCommit) {
  const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: c.entries })
  const localTree = git('rev-parse', `${c.sha}^{tree}`).trim()
  if (tree.sha !== localTree) fail(`tree SHA 不一致：本地 ${localTree}，远端 ${tree.sha}`)

  const snap = {
    message: git('log', '-1', '--pretty=%B', c.sha),
    tree: tree.sha,
    parents: [prev],
    author: {
      name: git('log', '-1', '--pretty=%an', c.sha).trim(),
      email: git('log', '-1', '--pretty=%ae', c.sha).trim(),
      date: git('log', '-1', '--pretty=%aI', c.sha).trim(),
    },
    committer: {
      name: git('log', '-1', '--pretty=%cn', c.sha).trim(),
      email: git('log', '-1', '--pretty=%ce', c.sha).trim(),
      date: git('log', '-1', '--pretty=%cI', c.sha).trim(),
    },
  }
  const created = await api('POST', `/repos/${REPO}/git/commits`, snap)

  // ⚠️ GitHub 会把提交说明**末尾的换行去掉**（git 本地默认保留一个），于是同样的树、
  //    同样的作者与时间，SHA 仍然不同。解决办法不是"就让它不同"（那样两端看起来一样、
  //    其实不是同一个提交，以后 fetch/push 立刻对不上），而是**在本地也造一个逐字节
  //    相同的提交对象**：用 GitHub 存下来的说明文本 + 本地的原始时间戳跑 `git commit-tree`，
  //    再核对两边 SHA 是否真的一致。一致才继续。
  const rawAuthorDate = git('log', '-1', '--pretty=%ad', '--date=raw', c.sha).trim()
  const rawCommitterDate = git('log', '-1', '--pretty=%cd', '--date=raw', c.sha).trim()
  const localSame = execFileSync('git', ['commit-tree', tree.sha, '-p', prev], {
    cwd: ROOT,
    input: created.message,          // 原样（不带末尾换行）
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: snap.author.name, GIT_AUTHOR_EMAIL: snap.author.email,
      GIT_AUTHOR_DATE: `@${rawAuthorDate}`,
      GIT_COMMITTER_NAME: snap.committer.name, GIT_COMMITTER_EMAIL: snap.committer.email,
      GIT_COMMITTER_DATE: `@${rawCommitterDate}`,
    },
  }).toString().trim()

  if (localSame !== created.sha) {
    fail(`本地重造的提交与远端不一致：本地 ${localSame}，远端 ${created.sha} —— ` +
      '两端对提交对象的规范化不同，不能假装一致（停在这里，远端分支还没动）')
  }
  console.log(`✓ commit ${localSame.slice(0, 10)}  ${created.message.split('\n')[0]}` +
    '（两端逐字节相同）')
  prev = localSame
}

// ── 4. 更新分支 ──
const updated = await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  sha: prev, force: false,
})
console.log(`✓ ${BRANCH} → ${updated.object.sha.slice(0, 10)}`)

// ── 5. 本地 remote-tracking 指过去（等价于 fetch；否则 git status 会以为分叉了）──
git('update-ref', `refs/remotes/origin/${BRANCH}`, updated.object.sha)
try { git('branch', `--set-upstream-to=origin/${BRANCH}`, BRANCH) } catch { /* 非当前分支时忽略 */ }
console.log(`✓ 本地 refs/remotes/origin/${BRANCH} 已更新为同一个提交`)
console.log('\n完成。远端与本地现在是同一批提交。')
