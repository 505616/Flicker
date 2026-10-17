#!/usr/bin/env node
/**
 * 单文件产物的入口（SEA）
 * ======================
 * 这是**构建产物的入口**，不是源码入口。它必须是 CommonJS ——
 * 实测发现 SEA 的模块加载器有两处限制，两条都踩过：
 *   ① 不按包边界解析，连入口的 ES 模块都加载不了
 *      （报 "Failed to load the ES module ... set type: module"）
 *   ② require() 只能加载**内置模块**，不能加载磁盘上的文件
 *      （报 ERR_UNKNOWN_BUILTIN_MODULE）
 * 所以打包产物也是走"内嵌资产 + module._compile"，而不是 require 一个文件。
 *
 * 它只做三件事，顺序很关键：
 *   1. 装上"根目录"和"资源读取器" —— 必须在加载应用代码**之前**，
 *      因为 src/assets.js 的读取器是全局的，而应用启动时就要读资源
 *   2. 注入版本号（单文件形态下磁盘上没有可读的 package.json）
 *   3. 取出并执行打包后的应用，失败时明确报错而不是静默退出
 *
 * 这个文件由 gen/build-sea.mjs 复制进构建目录，与打包产物一起被嵌入。
 */
'use strict'

const path = require('node:path')
const sea = require('node:sea')

const isSea = sea.isSea()

/** 读一个内嵌（或构建期本地）资源的文本内容 */
function loadAssetString(name) {
  if (isSea) {
    try {
      return new TextDecoder().decode(sea.getAsset(name))
    } catch (e) {
      throw new Error('内嵌资源读取失败: ' + name + '（' + e.message + '）')
    }
  }
  // 非 SEA（构建期自测）时从磁盘读，方便排查
  return require('node:fs').readFileSync(path.join(__dirname, name), 'utf8')
}

// ── 1. 资源读取器与根目录 ───────────────────────────────────
globalThis.__flickerIsSea = isSea
globalThis.__flickerSea = isSea
// 单文件形态下"根目录"是逻辑概念：程序自身所在的位置。
// 源码包赠品会告诉接收方把它解压到哪里，两者是同一套约定。
globalThis.__flickerRoot = isSea ? path.dirname(process.execPath) : __dirname
globalThis.__flickerAssets = async (name) => loadAssetString(name)

/**
 * 二进制资源读取器（源码包 `.fkz` 走这条）。
 *
 * 为什么不能复用上面那个：它做 `TextDecoder` 解码，二进制 bytes 会被破坏。
 * `sea.getAsset(name)` 不传编码时给的是 **ArrayBuffer**，所以这里直接包成 Buffer。
 * 非 SEA（构建期自测）时从磁盘读。
 */
function loadAssetBuffer(name) {
  if (isSea) {
    try {
      return Buffer.from(sea.getAsset(name))
    } catch (e) {
      throw new Error('内嵌资源读取失败: ' + name + '（' + e.message + '）')
    }
  }
  return require('node:fs').readFileSync(path.join(__dirname, name))
}
globalThis.__flickerAssetsBinary = async (name) => loadAssetBuffer(name)

// ── 2. 版本号 ───────────────────────────────────────────────
try {
  globalThis.__flickerVersion = JSON.parse(loadAssetString('version.json')).version || null
} catch {
  globalThis.__flickerVersion = null
}

// ── 3. 执行打包后的应用 ─────────────────────────────────────
//
// 为什么不是 require('./app.cjs')：SEA 里 require 只认内置模块。
// 为什么用 module._compile 而不是 vm.runInThisContext：
//   _compile 会提供完整的 CommonJS 环境（exports/require/module/__filename/__dirname），
//   而应用代码里用了 require('node:crypto') 之类的内置模块。
const APP = path.join(__dirname, 'app.cjs')
let appSource
try {
  appSource = isSea ? loadAssetString('app.cjs') : require('node:fs').readFileSync(APP, 'utf8')
} catch (e) {
  process.stderr.write('\n  ✗ 无法取出内嵌的应用代码：' + e.message + '\n\n')
  process.exit(1)
}

globalThis.__flickerStarted = true
try {
  const Module = require('node:module')
  const m = new Module(APP, null)
  m.filename = APP
  m.paths = Module._nodeModulePaths(__dirname)
  m._compile(appSource, APP)
} catch (err) {
  const msg = err && err.message ? err.message : String(err)
  process.stderr.write('\n  ✗ 单文件产物启动失败：' + msg + '\n\n')
  if (process.env.FLICKER_DEBUG && err && err.stack) process.stderr.write(err.stack + '\n')
  process.exit(1)
}
