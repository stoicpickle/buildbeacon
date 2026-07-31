const TABLE = new Uint32Array(256)

for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1
  TABLE[index] = value >>> 0
}

export function crc32c(...parts: Uint8Array[]): number {
  let crc = 0xffffffff
  for (const bytes of parts) {
    for (const byte of bytes) crc = (TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}
