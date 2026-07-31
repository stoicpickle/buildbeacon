# BuildBeacon Protocol 1 (BBP/1)

Status: experimental. Protocol version 1 is implemented by BuildBeacon 0.1. It is not an IETF standard, a standard fountain-code implementation, or independently audited.

All integer fields in the frame header are unsigned and big-endian. All string limits below count Unicode scalar values at the application boundary and encoded bytes at the envelope boundary. Decoders must reject unsupported versions and unknown fields rather than guessing.

## Receipt

A receipt is encoded with the deterministic CBOR profile (dCBOR). The implementation requires preferred encodings, NFC-normalized strings, finite integers, definite-length items, deterministic key ordering, no duplicate keys, and no unknown map keys. The canonical byte string is signed directly; a verifier re-encodes and requires exact byte equality.

Top-level numeric map:

| Key | Type | Meaning |
|---:|---|---|
| `0` | uint | receipt schema version; `1` |
| `1` | text | HTTPS repository URL; maximum 256 Unicode scalar values |
| `2` | map | commit: `{0: algorithm, 1: digest bytes}` |
| `3` | uint | tree state: `0` unknown, `1` clean, `2` dirty |
| `4` | map | artifact: `{0: name, 1: SHA-256 bytes, 2?: size}` |
| `5` | map | build: `{0: Unix seconds, 1: builder claim, 2?: HTTPS run URL}` |
| `6` | array | at most 16 check maps |

Commit algorithm `1` is Git SHA-1 (20 bytes); `2` is Git SHA-256 (32 bytes). An artifact digest is exactly 32 bytes. Each check is `{0: name, 1: result, 2?: evidence SHA-256}`, where result is `0` unknown, `1` pass, `2` fail, or `3` skip.

The receipt is limited to 2,048 encoded bytes and nesting depth 8. Names, builder claims, URLs, and check arrays have additional limits enforced in `src/lib/receipt.ts`.

The public deterministic receipt vector is asserted byte-for-byte in [`src/lib/receipt.test.ts`](../src/lib/receipt.test.ts). Its human-readable input is [`examples/demo/receipt.json`](../examples/demo/receipt.json).

## Signed envelope

The signing input is exactly:

```text
ASCII("BUILD-BEACON-RECEIPT-V1\0") || canonical_receipt_bytes
```

The signature algorithm is strict RFC 8032 Ed25519 verification (`zip215: false`). The canonical dCBOR envelope is:

| Key | Type | Meaning |
|---:|---|---|
| `0` | uint | envelope version; `1` |
| `1` | uint | signature algorithm; `1` means Ed25519 |
| `2` | bytes(32) | public key |
| `3` | bytes | exact canonical receipt bytes |
| `4` | bytes(64) | signature |

The envelope is limited to 3,072 bytes. BBP/1 does not compress input, avoiding decompression bombs and keeping the signed bytes directly inspectable.

Identifiers:

```text
receipt_id     = first 16 bytes of SHA-256(envelope_bytes)
key_id         = "sha256:" || lowercase_hex(SHA-256(public_key))
```

The complete key ID is the trust identifier. Short forms in the UI are display-only.

## Static comparison transport

The workbench can render a complete envelope as one QR when it fits:

```text
BBR1:<unpadded-base64url(canonical_envelope_bytes)>
```

`BBR1` is a bounded single-frame comparison format, not part of the BBP/1 erasure stream. The receiver caps its text at 4,200 characters, decodes at most the 3,072-byte envelope limit, derives the normal receipt ID from the envelope, and performs the same strict canonical/signature verification. It has no join-late or missing-frame benefit. See the checked-in [`public/demo/buildbeacon-static.png`](../public/demo/buildbeacon-static.png) pixel fixture.

## Frame format

Each QR contains UTF-8 text:

```text
BB1:<unpadded-base64url(frame_bytes)>
```

The binary frame is a 32-byte header followed by one fixed-size coded symbol:

| Offset | Size | Meaning |
|---:|---:|---|
| 0 | 2 | magic `0x42 0x42` (`BB`) |
| 2 | 1 | frame protocol version `1` |
| 3 | 1 | flags; bit 0 means systematic, all other bits reserved and zero |
| 4 | 16 | receipt ID |
| 20 | 4 | sequence number |
| 24 | 1 | source block count `K` |
| 25 | 1 | block size `B` |
| 26 | 2 | unpadded envelope length `L` |
| 28 | 4 | CRC32C |
| 32 | `B` | coded symbol |

CRC32C uses the Castagnoli polynomial and covers `bytes[0..27] || symbol`; the four-byte CRC field is excluded.

Decoder limits:

```text
32 <= B <= 128
1 <= K <= 32
1 <= L <= min(3072, K * B)
K == ceil(L / B)
frame_bytes.length == 32 + B
accepted unique sequences <= 512
```

The browser and fixture use `B = 64`, QR error correction Medium, and a four-module quiet zone. The checked-in video fixture uses eight candidate frames per second; the interactive transmitter defaults to a user-started two frames per second and disables animation when the system reduced-motion preference is active.

## Fountain-style erasure coding

The envelope is zero-padded to `K * B` and split into `K` source blocks. Let:

```text
R = ceil(K / 2)
E = K + R
slot = sequence mod E
```

When `slot < K`, the frame is systematic and carries source block `slot`. Otherwise it is a deterministic dense repair symbol: the XOR of blocks selected by a coefficient mask.

The repair mask is derived from:

```text
SHA-256(
  ASCII("BUILD-BEACON-MASK-V1\0") ||
  receipt_id ||
  u32be(sequence) ||
  u8(K)
)
```

Bit `i` of the digest selects source block `i`, with bit zero the least-significant bit of digest byte zero. Bits at or above `K` are ignored. If the mask is zero, block `digest[31] mod K` is selected. Systematic masks are derived from the epoch slot. The decoder recomputes every mask rather than trusting coefficients supplied by a frame.

This is a versioned random-linear erasure codec, colloquially “fountain-style.” It is not LT, Raptor, RaptorQ, or BC-UR. It corrects erased frames; CRC-failing or malformed frames are discarded, never treated as equations.

## Decoder state machine

1. Parse base64url and enforce all size/version/flag limits.
2. Validate CRC32C before hashing or matrix work.
3. Bind the receiver to one receipt ID and one `(K, B, L)` tuple; reject mixed or inconsistent frames.
4. Deduplicate by sequence number.
5. Recompute the coefficient mask and incrementally row-reduce over GF(2), XORing symbol bytes with each equation operation.
6. Report progress as matrix rank over `K`, never raw frame count.
7. At full rank, concatenate recovered source blocks and truncate to `L`.
8. Require the reconstructed envelope’s SHA-256 prefix to equal the receipt ID.
9. Strictly decode and canonicalize the envelope and receipt.
10. Verify the Ed25519 signature, then apply any separately configured trust anchor.

Result classes are conceptually:

- `recovered-invalid` — transport completed but canonical or signature checks failed;
- `valid-self-presented` — signature is valid under the key carried by the envelope;
- `valid-trusted-key` — the same signature is valid and the key ID was pinned separately.

## Public vector

The reproducible fixture uses:

- receipt ID `6b3ba041e95d4a51da0da0f55965bf1d`;
- key ID `sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9`;
- `K = 7`, `B = 64`, start sequence `73`;
- the public RFC 8032 test key, never a production key.

See [`examples/demo/frame-0073.txt`](../examples/demo/frame-0073.txt), [`examples/demo/signed-receipt.bb`](../examples/demo/signed-receipt.bb), and [`examples/demo/expected.json`](../examples/demo/expected.json). Regenerate them with `npm run demo:fixture` and verify the recompressed video with `npm run demo:verify`.

## Compatibility policy

Versions are independent: receipt schema, signed envelope, signature algorithm, and frame protocol each carry an explicit discriminator. BBP/1 decoders fail closed on values they do not implement. A future version must use a new domain separator when signed-byte semantics change.
