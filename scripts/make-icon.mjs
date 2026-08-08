/** Rasterize build/icon.svg into build/icon.png (512) and build/icon.ico. */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = path.resolve(import.meta.dirname, '..')
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = []
for (const size of sizes) {
  pngs.push(await sharp(svg).resize(size, size).png().toBuffer())
}
await sharp(svg).resize(512, 512).png().toFile(path.join(root, 'build', 'icon.png'))
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), await pngToIco(pngs))
console.log('icon.png (512) and icon.ico written to build/')
