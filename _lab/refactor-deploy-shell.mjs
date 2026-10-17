// 一次性重构：把 relay/deploy.mjs 里那些 `run('npx', …)` / `run(process.execPath, …)`
// 换成不带 shell 的两个帮手（runNpx / runNode）。
//
// 起因是一次实测：`node relay/deploy.mjs` 在 Windows 官方安装的 Node 上第一步就失败 ——
// `'C:\Program' is not recognized as an internal or external command`，
// 因为 spawnSync 带了 shell，而 node.exe 的路径 `C:\Program Files\…` 里有空格。
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'relay/deploy.mjs'
let s = readFileSync(FILE, 'utf8')

const PAIRS = [
  [
    "const gen = run(process.execPath, [path.join(ROOT, 'gen', 'gen-relay-page.mjs')])",
    "const gen = runNode([path.join(ROOT, 'gen', 'gen-relay-page.mjs')])",
  ],
  [
    "const wv = run('npx', ['--yes', 'wrangler@latest', '--version'])",
    "const wv = runNpx(['--yes', 'wrangler@latest', '--version'])",
  ],
  [
    "const who = run('npx', ['--yes', 'wrangler@latest', 'whoami'], { cwd: HERE })",
    "const who = runNpx(['--yes', 'wrangler@latest', 'whoami'], { cwd: HERE })",
  ],
  [
    "const login = run('npx', ['--yes', 'wrangler@latest', 'login'], { cwd: HERE, stdio: 'inherit' })",
    "const login = runNpx(['--yes', 'wrangler@latest', 'login'], { cwd: HERE, stdio: 'inherit' })",
  ],
  [
    "const dep = run('npx', ['--yes', 'wrangler@latest', 'deploy'], { cwd: HERE })",
    "const dep = runNpx(['--yes', 'wrangler@latest', 'deploy'], { cwd: HERE })",
  ],
]

for (const [from, to] of PAIRS) {
  const hits = s.split(from).length - 1
  if (hits !== 1) throw new Error(`锚点命中 ${hits} 次（要求 1 次）：${from.slice(0, 60)}…`)
  s = s.replace(from, to)
}

const leftover = [...s.matchAll(/[^a-zA-Z_.]run\(/g)].length
if (leftover) throw new Error(`还有 ${leftover} 处旧的 run( 调用没换掉`)

writeFileSync(FILE, s)
console.log(`已替换 ${PAIRS.length} 处调用；文件里不再有旧的 run( 调用`)
