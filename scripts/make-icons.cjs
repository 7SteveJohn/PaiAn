// 图标资产生成：把设计源图（墨水瓶精灵 jpg）转成 electron-builder 需要的两件套。
// 用法：node scripts/make-icons.cjs <源图>
// 产出：build/icon.png（512，跨平台用）+ build/icon.ico（多尺寸，Windows 窗口/托盘/安装包用）。
// sharp 负责 resize + 圆角遮罩（源图是直角贴边满幅的，Windows 图标惯例要透明边距 + 圆角）；
// png2icons 负责把 PNG 封成多尺寸 ico。两个都是 devDependencies，不进运行时。
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const png2icons = require('png2icons');

const SIZE = 512;
const PAD = 56; // 瓶子与方块边缘的呼吸距离（内容占约 78%，标准 App 图标比例）
const R = 64; // 图标自身的圆角（铺满格子，与其他 App 图标同大）

async function main() {
  const src = process.argv[2];
  const outDir = process.argv[3] || path.join(__dirname, '..', 'build');
  if (!src || !fs.existsSync(src)) {
    console.error('源图不存在：' + src);
    process.exit(1);
  }
  // 图标 = 一整块米色圆角方片铺满格子（与其他 App 图标同大），瓶子在方片内居中占约九成。
  // 流程：裁掉源图四周纯色底 → contain 缩进呼吸距离 → 米色补满到格子 → 圆角遮罩。
  const MI = { r: 242, g: 227, b: 195, alpha: 1 };
  const mask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${R}" ry="${R}" fill="#fff"/></svg>`,
  );
  const inner = await sharp(src)
    .trim({ threshold: 12 })
    .resize(SIZE - PAD * 2, SIZE - PAD * 2, { fit: 'contain', background: MI })
    .toBuffer();
  const pngBuf = await sharp(inner)
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: MI })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), pngBuf);
  const ico = png2icons.createICO(pngBuf, png2icons.BICUBIC, 0, true, true);
  if (!ico) {
    console.error('ico 生成失败');
    process.exit(1);
  }
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  console.log(`OK build/icon.png (512) + build/icon.ico (${ico.length} bytes)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
