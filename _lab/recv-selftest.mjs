/**
 * 真机前的自检：起一个**真的** `flicker recv` 子进程，用 sim-phone 把文件发进去。
 *
 * ⚠️ 与 `test/upload-server.test.js` 的分工：
 *    · 单测跑的是 `src/upload-server.js`（进程内、明文 HTTP、注入依赖）；
 *    · 这个脚本跑的是**命令行那一整条**：证书生成 → TLS 监听 → 打印链接 → 收 → 校验
 *      → 落盘 → 销毁 → 进程退出。它同时验证 `sim-phone.mjs`（手机侧）能对着真服务跑通。
 *
 * 用法：node _lab/recv-selftest.mjs [--corrupt]
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { makeTempDir, cleanupTempDirs } from '../gen/tmp.mjs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'flicker.js')
const SIM = path.join(ROOT, '_lab', 'sim-phone.mjs')
const CORRUPT = process.argv.includes('--corrupt')
const PASSWORD = 'k7m-3fq'

const cleanups = []
const run = (cmd, argv, opts = {}) => new Promise((resolve) => {
  const c = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b })
  c.stderr.on('data', (b) => { err += b })
  c.on('exit', (code) => resolve({ code, out, err }))
})

async function main() {
  const work = makeTempDir('flicker-selftest-')
  cleanups.push(() => { cleanupTempDirs(); return rm(work, { recursive: true, force: true }) })
  const inbox = path.join(work, 'inbox')
  const src = path.join(work, 'phone')
  const readyFile = path.join(work, 'ready.txt')
  const caFile = path.join(work, 'ca.cer')
  await mkdir(inbox, { recursive: true })
  await mkdir(src, { recursive: true })

  // 手机上的三种东西：小文本、整块、跨块 + 一个中文名
  const files = {
    'note.txt': Buffer.from('手机发来的第一条\n', 'utf8'),
    'full-chunk.bin': randomBytes(2 * 1024 * 1024),
    '跨块的照片.bin': randomBytes(2 * 1024 * 1024 + 4321),
  }
  for (const [name, buf] of Object.entries(files)) await writeFile(path.join(src, name), buf)

  console.log(`临时目录 ${work}`)
  const child = spawn(process.execPath, [
    CLI, 'recv',
    `--dir=${inbox}`, `--password=${PASSWORD}`, '--machine', `--machine-cert=${caFile}`,
    '--no-ask', '--no-open',
    // 反向验证那条路没人收尾（那块数据本来就没收到），所以把超时压到几秒，
    // 否则要等满 10 分钟才看得到"超时销毁"这个结果。
    ...(CORRUPT ? ['--timeout=6s'] : []),
  ], {
    // 第二道保险：自动化跑的时候绝不弹资源管理器窗口
    // （目录随后会被删掉，那个窗口就变成"位置不可用"的系统错误框）
    env: { ...process.env, FLICKER_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let out = '', err = ''
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 __READY__ 超时\n${out}\n${err}`)), 60000)
    const scan = (b, isErr) => {
      if (isErr) err += b; else out += b
      const m = out.match(/__READY__ (\S+) (\S+)/)
      if (m) { clearTimeout(timer); resolve(m) }
    }
    child.stdout.on('data', (b) => scan(b, false))
    child.stderr.on('data', (b) => scan(b, true))
    child.on('exit', (code) => reject(new Error(`接收端提前退出 ${code}\n${out}\n${err}`)))
  })

  const m = await ready
  await writeFile(readyFile, out, 'utf8')
  console.log(`✓ 服务已就绪：${m[1]}`)

  const sim = await run(process.execPath, [
    SIM, `--from-ready=${readyFile}`, `--dir=${src}`, `--password=${PASSWORD}`, `--ca=${caFile}`,
    ...(CORRUPT ? ['--corrupt'] : []),
  ])
  process.stdout.write(sim.out)
  if (sim.err.trim()) process.stdout.write('  [stderr] ' + sim.err.trim() + '\n')

  const code = await done            // 传输成功后接收端自己会退出
  process.stdout.write(out.slice(out.indexOf('__READY__') + 1).replace(/^[^\n]*\n/, ''))
  console.log(`接收端退出码 ${code}`)

  // ── 判据 ──────────────────────────────────────────────
  if (CORRUPT) {
    assert.equal(sim.code, 0, '改坏一块时必须被拒绝（sim-phone 的退出码说明它没被拒绝）')
    assert.equal(code, 6, `改坏一块之后没人收尾 → 按超时退出（EXIT.TIMEOUT＝6，实际 ${code}）`)
    assert.match(out, /收到的文件已保留在/, '超时销毁同样要写明收到的文件在哪')
    console.log('✓ 反向验证通过：改坏一个字节被拒；会话最终按超时销毁')
    return
  }
  assert.equal(sim.code, 0, `手机侧应当全部成功（退出码 ${sim.code}）`)
  assert.equal(code, 0, `接收端应当正常退出（退出码 ${code}）`)
  for (const [name, buf] of Object.entries(files)) {
    const got = await readFile(path.join(inbox, name))
    assert.equal(got.length, buf.length, `${name} 长度不符`)
    assert.equal(createHash('sha256').update(got).digest('hex'),
      createHash('sha256').update(buf).digest('hex'), `${name} 内容不符`)
  }
  const names = await readdir(inbox)
  assert.deepEqual(names.filter((n) => n.endsWith('.flicker-part')), [], '不该留下半成品')
  assert.match(out, /收到的文件已保留在/, '销毁清单必须写明"收到的文件保留在哪"')
  assert.match(out, /会话密钥与密码验证值已清零/)
  assert.match(out, /接收服务已关闭/)
  console.log(`✓ 三个文件逐字节一致：${names.join('、')}`)
  console.log('✓ 销毁清单与"收到的文件已保留"都在输出里')
}

main()
  .catch((e) => { console.error(`✗ ${e?.message ?? e}`); process.exitCode = 1 })
  .finally(async () => { for (const fn of cleanups.reverse()) { try { await fn() } catch { /* 尽力 */ } } })
