// 独立核查：这次会话结束后，用户的证书库里有没有留下残留
// （不采信程序自己的销毁清单，自己再去读一次证书库）
import * as trust from '../src/trust.js'

console.log('本机平台支持情况：', JSON.stringify(trust.support()))

if (typeof trust.rootStoreCount === 'function') {
  console.log('信任库里的证书总数：', await trust.rootStoreCount())
}
if (typeof trust.findResidualCa === 'function') {
  const found = await trust.findResidualCa()
  console.log('残留的闪传会话 CA：', Array.isArray(found) ? (found.length ? found : '（没有）') : found)
}
for (const name of ['findMyLeftovers', 'findTempDirs']) {
  if (typeof trust[name] === 'function') {
    try { console.log(`${name}()：`, await trust[name]()) } catch (e) { console.log(`${name}() 出错：${e.message}`) }
  }
}
