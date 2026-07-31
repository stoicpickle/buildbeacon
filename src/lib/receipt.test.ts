import { describe, expect, it } from 'vitest'
import { decodeReceipt, demoReceipt, encodeReceipt } from './receipt'
import { toHex } from './encoding'

describe('deterministic receipt encoding', () => {
  it('round-trips the public demo receipt as strict dCBOR', () => {
    const receipt = demoReceipt()
    const encoded = encodeReceipt(receipt)
    expect(decodeReceipt(encoded)).toEqual(receipt)
    expect(encodeReceipt(decodeReceipt(encoded))).toEqual(encoded)
  })

  it('has a stable public demo vector', () => {
    expect(toHex(encodeReceipt(demoReceipt()))).toMatchInlineSnapshot(`"a7000101782a68747470733a2f2f6769746875622e636f6d2f73746f69637069636b6c652f6275696c64626561636f6e02a200010154491b2ddf7a44d269ae5432de2d22255398abfa9d030104a30071696e697469616c2d726561646d652e6d640158207b43b2c1d9c12a279c96eb322d2a183f022b8ae99da7ee3d48720b93e5c1fb8b020d05a3001a6a6cdeef017753796e746865746963204242502f31206669787475726502785a68747470733a2f2f6769746875622e636f6d2f73746f69637069636b6c652f6275696c64626561636f6e2f636f6d6d69742f343931623264646637613434643236396165353433326465326432323235353339386162666139640681a200781863616e6f6e6963616c206669787475726520766563746f720101"`)
  })

  it('rejects malformed claims before encoding', () => {
    const receipt = demoReceipt()
    receipt.artifact.sha256 = 'not-a-digest'
    expect(() => encodeReceipt(receipt)).toThrow(/sha256/u)
  })

  it('rejects timestamps that would be silently truncated to whole seconds', () => {
    const receipt = demoReceipt()
    receipt.build.builtAt = '2026-07-31T17:44:15.999Z'
    expect(() => encodeReceipt(receipt)).toThrow(/whole-second/u)
  })

  it('counts Unicode scalar values and rejects ill-formed strings', () => {
    const receipt = demoReceipt()
    receipt.artifact.name = '🔦'.repeat(128)
    expect(() => encodeReceipt(receipt)).not.toThrow()
    receipt.artifact.name = '\ud800'
    expect(() => encodeReceipt(receipt)).toThrow(/artifact\.name/u)
  })
})
