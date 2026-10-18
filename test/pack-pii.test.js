/**
 * 「赠品包里不许带个人信息」判据的规则本身
 * ========================================
 * `gen/check-pack-pii.mjs` 守的是"发给别人的那份源码包里不许有作者的个人信息"。
 * 2026-10 用户准备把仓库做成公开的时候又查了一遍，发现**文档里还留着作者家的出口公网 IP
 * 与运营商跳数**（`设计文档.md`、`中继部署.md`，中英各一份）—— 本地地址也一样是个人信息。
 *
 * 所以那条判据补了一条规则：**真实可路由的公网 IPv4 一律不许出现**
 * （私网、回环、CGNAT、文档保留段、ASN.1 OID 都不算）。这里验规则本身：
 *   · 该抓的抓得住（作者家的出口地址、随便一个公网地址）；
 *   · 不该抓的别误伤（私网示例、OID、文档保留段、CGNAT 段、公共 DNS 那种"刻意的例外"
 *     由脚本里的 ALLOW 处理，不在这里重复）。
 *
 * ⚠️ 为什么不在真实文件上测：那要给仓库里塞一个真 IP 再删掉，风险比收益大。
 *    规则是纯正则，直接拿字符串验更干净，也更**能证伪**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT } from '../gen/check-pack-pii.mjs'

const rule = (name) => CONTENT.find((c) => c.name === name)
const hits = (name, text) => [...text.matchAll(rule(name).re)].map((m) => m[0])

test('公网 IPv4 规则存在（不然"作者家的出口 IP"就没人挡了）', () => {
  assert.ok(rule('公网 IPv4'), '规则不见了：作者地址会重新溜进赠品包')
})

test('⭐ 该抓的抓得住', () => {
  // 作者家那次实测的出口地址（已从文档里删掉，但规则必须认得这种形状）
  assert.deepEqual(hits('公网 IPv4', '出口公网 IP 203.0.114.9'), ['203.0.114.9'])
  assert.deepEqual(hits('公网 IPv4', 'Egress 8.8.4.4'), ['8.8.4.4'])
  assert.deepEqual(hits('公网 IPv4', '跳数 100.128.1.1'), ['100.128.1.1'])
})

test('不该误伤：私网 / 回环 / 链路本地 / CGNAT / 文档保留段 / OID', () => {
  for (const ok of [
    '192.168.1.5', '192.168.1.1', '10.0.0.5', '172.16.0.1', '172.31.255.254',
    '127.0.0.1', '169.254.1.1', '0.0.0.0',
    '100.64.0.0', '100.127.255.255',
    '192.0.2.10', '198.51.100.7', '203.0.113.7',
    '2.5.29.19', '2.5.4.3', '1.3.6.1.5.5.7.3.1',
    '224.0.0.1', '255.255.255.255',
  ]) {
    assert.deepEqual(hits('公网 IPv4', `见 ${ok} 这一处`), [], `${ok} 不该被当成"作者的公网 IP"`)
  }
})

test('局域网 IP 规则仍然只管 192.168/16（示例地址靠 ALLOW 放行）', () => {
  assert.deepEqual(hits('局域网 IP', 'https://192.168.1.5:8443/'), ['192.168.1.5'])
  assert.deepEqual(hits('局域网 IP', 'https://10.0.0.5/'), [])
})

test('作者账号与 Windows 用户目录仍然挡着', () => {
  assert.deepEqual(hits('作者账号', 'B站 1UWD'), ['1UWD'])
  assert.deepEqual(hits('Windows 用户目录', 'C:\\Users\\realname\\Downloads'), ['C:\\Users\\realname'])
  // 占位写法放行（文档里到处都是）
  assert.deepEqual(hits('Windows 用户目录', 'C:\\Users\\you\\Downloads'), [])
  assert.deepEqual(hits('Windows 用户目录', 'C:\\Users\\a & b\\Downloads'), [])
})
