import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import QRCode from 'qrcode'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { signReceipt } from './crypto'
import { fromHex } from './encoding'
import { BeaconSource, parseFrameText } from './fountain'
import { demoReceipt } from './receipt'

describe('QR pixel adapter contract', () => {
  it('decodes a rendered BBP/1 frame back from PNG pixels', async () => {
    const secret = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
    const source = await BeaconSource.create(await signReceipt(demoReceipt(), secret), 64)
    const frameText = await source.frame(73)
    const goldenFrame = (await readFile(new URL('../../examples/demo/frame-0073.txt', import.meta.url), 'utf8')).trim()
    expect(frameText).toBe(goldenFrame)
    const buffer = await QRCode.toBuffer(frameText, { type: 'png', width: 320, margin: 4, errorCorrectionLevel: 'M' })
    const png = PNG.sync.read(buffer)
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' })
    expect(decoded?.data).toBe(frameText)
    expect(parseFrameText(decoded!.data).sequence).toBe(73)
  })
})
