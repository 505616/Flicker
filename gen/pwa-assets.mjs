/**
 * PWA 的图标与 manifest 数据（内联用）。
 *
 * ── 为什么是"数据"而不是文件 ──────────────────────────────────
 *
 * 接收端页面必须保持**单文件、零外部请求**（局域网可能没有外网）。
 * 而 PWA 的常规做法是 `<link rel="manifest" href="/manifest.webmanifest">`
 * 加几个 PNG 图标 —— 那需要 relay 那边也提供这些文件，多出部署步骤。
 *
 * 所以这里把图标压成 **SVG data URL**（文本、体积极小），
 * 由 gen/inline-pwa.mjs 内联进页面。整份 manifest 也作为
 * data URL 放在 `<link rel="manifest">` 上 —— 不需要任何额外文件。
 *
 * ── 关于 maskable ────────────────────────────────────────────
 *
 * Android 的"自适应图标"会把图标裁成圆形/方形/水滴等形状，只保证
 * **中心 80%** 的区域可见。所以 maskable 那个必须：
 *   · 铺满整块背景（不能被裁掉边）
 *   · 把图形收在中心（用 40% 半径以内，留够安全边距）
 * "any" 那个则相反：可以留透明边距，让它看起来像个图标而不是色块。
 *
 * 用法：node gen/pwa-assets.mjs   （打印两个 data URL 的长度与内容，供核对）
 */

/** 品牌色，与页面 CSS 里的 --accent 保持一致 */
export const ACCENT = '#5b6cff';
const BG_DARK = '#12141c';

/**
 * 闪电图形的顶点（相对中心、已归一化到 glyph 的边长）。
 *
 * ⚠️ 单独导出是为了**可测试**：图形是否落在 maskable 的安全区里是个几何问题，
 *    应该用坐标算，而不是拿正则去 SVG 文本里猜数字 ——
 *    我第一版就是那么做的，结果把渐变 `stop` 的 `offset="1"` 也当成了坐标，
 *    算出一个荒唐的偏移量（1744px）。
 */
export function boltPoints() {
  // 顶点顺序：上尖 → 左缺口上沿 → 左缺口内沿 → 下尖 → 右缺口下沿 → 右缺口内沿。
  // 两个"缺口"构成闪电特有的 Z 形台阶。
  //
  // ⚠️ 宽度是调过的：第一版横向只到 ±0.34，光栅化一看是根细长的针，
  //    在 192px 下几乎看不出是闪电。现在横向 ±0.44、纵向 ±0.50，
  //    既保持闪电的细长比例，又有足够的笔画宽度。
  return [
    [0.06, -0.50],   // 上尖
    [-0.44, 0.06],   // 左下（缺口外沿）
    [-0.10, 0.06],   // 缺口内沿
    [-0.06, 0.50],   // 下尖
    [0.44, -0.06],   // 右上（缺口外沿）
    [0.10, -0.06],   // 缺口内沿
  ];
}

/**
 * 生成一个图标的 SVG。
 * @param {object} o
 * @param {number} o.size 画布边长
 * @param {boolean} o.maskable 是否为 maskable（铺满背景、图形收进中心）
 * @param {number} o.radius 圆角半径（maskable 时必须是 0 —— 裁切由系统做）
 */
function iconSvg({ size, maskable, radius }) {
  const s = size;
  // maskable：图形只占中心约 52%（留足 80% 安全区）
  // any：图形可以大一些，留一圈视觉边距
  const scale = maskable ? 0.52 : 0.68;
  const glyph = s * scale;
  const cx = s / 2;
  const cy = s / 2;
  // 闪电的路径（与页面上的 ⚡ 呼应的几何形状，不是字体渲染 —— 字体在 SVG 里不可靠）
  const pts = boltPoints();
  const at = ([dx, dy]) => `${(cx + glyph * dx).toFixed(2)} ${(cy + glyph * dy).toFixed(2)}`;
  const bolt = `M ${at(pts[0])} L ${at(pts[1])} L ${at(pts[2])} ` +
    `L ${at(pts[3])} L ${at(pts[4])} L ${at(pts[5])} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="#7b5cff"/>` +
    `</linearGradient></defs>` +
    `<rect width="${s}" height="${s}" rx="${radius}" fill="url(#g)"/>` +
    `<path d="${bolt}" fill="#fff"/>` +
    `</svg>`;
}

/** 图形在画布上的边长占比（供测试核对安全区） */
export const GLYPH_SCALE = { any: 0.68, maskable: 0.52 };

/** SVG 文本 → data URL（只做最小转义：`#` 与 `"` 在 data URL 里要处理） */
export function svgDataUrl(svg) {
  // 用 encodeURIComponent 保证任何字符都安全，代价是体积略大
  // （图标只有几百字节，不值得为省这点去做 base64）
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** 两个图标：一个常规、一个 maskable */
export function icons() {
  return [
    { src: svgDataUrl(iconSvg({ size: 192, maskable: false, radius: 42 })),
      sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
    { src: svgDataUrl(iconSvg({ size: 512, maskable: false, radius: 112 })),
      sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
    // maskable 必须 radius=0 且铺满 —— 圆角由系统裁切决定
    { src: svgDataUrl(iconSvg({ size: 512, maskable: true, radius: 0 })),
      sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
  ];
}

/**
 * 应用清单（manifest）。
 *
 * `start_url` 用 `"."` 而不是 `"/"` —— 接收端可能被挂在任意路径下
 * （自建 relay、端口转发、子目录），写死 `/` 会指到别的地方去。
 * `scope` 同理。
 *
 * `display: standalone` 是为了"加到主屏幕后没有地址栏"，看起来像个应用。
 */
export function manifest({ lang, title, shortName, description }) {
  return {
    name: title,
    short_name: shortName,
    description,
    lang,
    start_url: '.',
    scope: '.',
    display: 'standalone',
    orientation: 'any',
    background_color: BG_DARK,
    theme_color: ACCENT,
    icons: icons(),
  };
}

export const COLORS = { accent: ACCENT, background: BG_DARK };

/**
 * 自检输出。被 import 时不会打印 —— 只有直接运行才打印。
 * 用 process.argv[1] 的 basename 判断，比比较完整 URL 可靠
 * （Windows 下 file:// 前缀与盘符形式容易对不上）。
 */
if (process.argv[1] && /pwa-assets\.mjs$/.test(process.argv[1])) {
  const ic = icons();
  console.log('图标：');
  for (const i of ic) {
    console.log(`  ${i.sizes.padEnd(9)} ${i.purpose.padEnd(9)} ${String(i.src.length).padStart(5)} 字节`);
  }
  const m = manifest({ lang: 'zh-CN', title: '闪传 Flicker', shortName: '闪传', description: 'x' });
  console.log(`\nmanifest 序列化后 ${JSON.stringify(m).length} 字节`);
  console.log(`图标合计 ${ic.reduce((s, i) => s + i.src.length, 0)} 字节`);
  console.log(`\n（这些都会以 data URL 内联进页面，不产生任何外部请求）`);
}
