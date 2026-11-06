/**
 * SEA 构建的路径与配置计算（与"真去跑构建"分开，为了能被测试）
 * ==========================================================
 *
 * ── 为什么单独成文件 ──
 * `gen/build-sea.mjs` 一被 import 就会真的开始构建（写 `dist/`、下载 postject、90 MB），
 * 没法在单测里碰。但"可复现构建"的关键恰恰是**路径怎么写**：
 *
 *   ① 构建目录必须**确定**（不能带时间戳/随机数）；
 *   ② 写进 `sea-config.json` 的路径必须**相对**（不能有绝对路径）。
 *
 * 第 ② 条是 2026-11 补的：入口文件的路径会被 Node 写进 SEA blob，而
 * `path.join(tmpdir(), …)` 里的 `tmpdir()` 随机器/用户变化 ——
 * 同一份源码在不同机器（甚至同一台机器换 `TMPDIR`）会产出不同的二进制，
 * 而 README/release 却拿"校验值 + 可复现构建"说服人下载。实测（本文件配套测试）：
 * 只要 `main`/assets 写成相对路径、以构建目录为 cwd 调 `node --experimental-sea-config`，
 * blob 里就**只有相对文件名**，与目录位置无关（两份不同目录的 blob 逐字节相同）。
 *
 * 构建目录放在仓库的 `dist/` 下：`dist/` 已被 `.gitignore` 与赠品源码包的
 * `PACK_EXCLUDES` 排除，所以既不会进 git，也不会被嵌进产物。
 */
import path from 'node:path'

/**
 * 本平台的构建目录（**确定**且**相对仓库**）。
 *
 * 不放在 `tmpdir()`：临时目录的绝对路径会随机器变化。放在 `dist/` 下，
 * 路径虽然仍是绝对路径，但**不会进 blob**（见 `buildSeaConfig` 只写相对路径）。
 *
 * @param {{root:string, platformTag:string}} o
 * @returns {string} 绝对路径（仅供本机文件操作；写进配置的一律是相对名）
 */
export function resolveBuildDir({ root, platformTag }) {
  return path.join(root, 'dist', `.build-sea-${platformTag}`)
}

/**
 * `sea-config.json` 的内容。
 *
 * ⚠️ 这里**只放相对路径**（相对构建目录），并且调用方必须以构建目录为 cwd 去跑
 *    `node --experimental-sea-config`。绝对路径进配置 = 进 blob = 不可复现。
 *
 * @param {{assets:string[], embeddedSourcePack:string}} o
 *   `assets` 是仓库内的相对路径（同时也是 SEA 里的资产键名），构建时会按原名拷到构建目录。
 */
export function buildSeaConfig({ assets, embeddedSourcePack }) {
  return {
    main: 'sea-entry.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    // 资产键名 = 仓库内相对路径；值也写相对路径（构建目录里按同样的相对路径存放）
    assets: Object.fromEntries([
      ...assets.map((rel) => [rel, rel]),
      ['app.cjs', 'app.cjs'],
      ['version.json', 'version.json'],
      [embeddedSourcePack, embeddedSourcePack],
    ]),
  }
}
