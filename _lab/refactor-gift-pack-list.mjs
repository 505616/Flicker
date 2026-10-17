// 一次性重构：把 src/gift.js 里那份手写白名单 SOURCE_FILES 换成"遍历 + 黑名单"
// ======================================================================
// 用字节区间拼接（而不是让模型抄一段长文本），并且断言边界找对了才写盘。
// 用法：node _lab/refactor-gift-pack-list.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry')
const FILE = 'src/gift.js'
const src = readFileSync(FILE, 'utf8')

const START_MARK = '/**\n * 源码形态下需要打包的文件'
const start = src.indexOf(START_MARK)
if (start < 0) throw new Error('找不到 SOURCE_FILES 上方的注释起点')
const arrStart = src.indexOf('const SOURCE_FILES = [', start)
if (arrStart < 0) throw new Error('找不到 const SOURCE_FILES = [')
const endMarker = '\n]\n'
const arrEnd = src.indexOf(endMarker, arrStart)
if (arrEnd < 0) throw new Error('找不到清单数组的结尾')
const cut = arrEnd + endMarker.length
const removed = src.slice(start, cut)
if (!/启动\.sh/.test(removed)) throw new Error('要替换的片段里没有看到清单结尾（起点/终点找错了）')

const NEW = `/**
 * 打包源码树时要**排除**的东西。
 *
 * ⚠️ 这里是从"手写白名单"改成"遍历 + 黑名单"的 —— 原因是一次实测事故：
 *    原来那份手写清单只有 40 个条目（22 份文档 + 3 个启动脚本 + 十几个源码文件），
 *    而 \`src/run.js\`、\`src/gui.js\`、\`src/tty.js\`、\`src/assets.js\`、\`src/relay/*\`
 *    全都不在里面。把包解开、在里面跑 \`node bin/flicker.js --version\`，
 *    第一句就 \`ERR_MODULE_NOT_FOUND: Cannot find module .../src/assets.js\`。
 *    也就是说：**对方收到的是一个跑不起来的半份源码**，而赠品的说明写着
 *    "源码 + 全部文档，对方可以自己看、自己改、自己构建"。
 *
 *    白名单这种东西漏一个是必然的（新加一个模块就会漏），而且**没人会发现** ——
 *    所以改成遍历整棵树：完整性不再依赖谁记得去加一行。
 *    判据在 \`gen/check-source-pack.mjs\`：结构（该在的都在）+ 行为（解开后真的跑一次）。
 */
const PACK_EXCLUDES = [
  /^\\.git\\//,                    // 版本库
  /^node_modules\\//,
  /^dist\\//,                     // 构建产物（源码包里不该有 91 MB 的 exe）
  /^_lab\\/out\\//,                // 体检/压测的日志与截图（临时产物）
  /(^|\\/)\\.DS_Store$/,
  /(^|\\/)Thumbs\\.db$/,
  /^flicker-plugin\\.log$/,       // 示例插件往 cwd 写的日志（跑过一次就会出现）
]

/**
 * 列出要打进源码包的文件：**整棵树**减去上面的排除项。
 *
 * 排序是刻意的：同样的源码树要打出**逐字节相同**的包（可复现构建是项目的硬要求，
 * 而"包里文件顺序随机"会让指纹每次都不一样）。
 *
 * @param {string} root 项目根目录
 * @returns {Promise<Array<{rel:string, data:Buffer, mode:number}>>}
 */
async function collectSourceFiles(root) {
  const out = []
  const walk = async (dir, prefix) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const rel = prefix ? prefix + '/' + e.name : e.name
      const probe = e.isDirectory() ? rel + '/' : rel
      if (PACK_EXCLUDES.some((re) => re.test(probe))) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else if (e.isFile()) {
        out.push({ rel, data: await readFile(abs), mode: rel.startsWith('启动') ? 0o755 : 0o644 })
      }
    }
  }
  await walk(root, '')
  return out
}
`

const out = src.slice(0, start) + NEW + src.slice(cut)
console.log(`替换：${removed.length} 字符 → ${NEW.length} 字符`)
if (DRY) {
  console.log('（--dry 预演，未写盘）')
} else {
  writeFileSync(FILE, out)
  console.log('已写盘 ' + FILE)
}
