# Beacon Bench 1

**Question:** At the same visible footprint, when does a loss-tolerant BBP/1 marker recover the checked-in signed receipt more reliably than a static BBR1 QR—and how close can either come to a benchmark-only identifier QR?

**Bottom line:** For this 403-byte fixture, BBP/1 meets the lab follow-up threshold at 240 px; the gap already exists in the clean QR density test, while BBR1 is equally successful and faster at 280 and 320 px. This earns a real-footage follow-up, not a general resilience claim.

This is a controlled lab benchmark, not a claim about a named social platform or arbitrary footage. The experimental identifier-QR control is not a shipped BuildBeacon mode or protocol format: it decodes only the fixture receipt ID and exercises no resolver. BBR1 and BBP/1 recover and verify the complete signed envelope offline.

## Evaluation rule for this run

The primary cell is a 320 px marker, a six-second excerpt, one H.264 CRF 18 capture followed by a CRF 27 transcode, and a 25% seeded sample-erasure probability. “Animated advantage” requires at least 95% observed BBP/1 recovery and at least a 15-point observed advantage over BBR1. The broader continuation gate also requires that result under both CRF 27 and CRF 35 transcodes at at least one tested footprint, with p95 recovery under five seconds among successful excerpts. These are point-estimate thresholds for this one carrier, not confidence-bound reliability claims.

## Primary result

| Transport | Observed outcome | Median recovery* | p95 recovery* | Evidence returned |
|---|---:|---:|---:|---|
| Identifier QR control | 49/49 (100.0%) | 0.000 s | 0.125 s | identifier decoded; no lookup exercised |
| Static BBR1 | 49/49 (100.0%) | 0.000 s | 0.125 s | signed receipt |
| Animated BBP/1 | 49/49 (100.0%) | 4.000 s | 4.750 s | signed receipt |

*Recovery timing is measured from the first sample timestamp at 0.000 seconds and only among successful excerpts.

Primary BBP/1 minus BBR1 recovery delta: **0.0 percentage points**. Classification: **no observed recovery difference across this carrier’s sample-aligned excerpts at 320 px**.

## Why marker size matters

| Transport | QR text | QR version | Data modules | Modules with quiet zone | 320 px pitch |
|---|---:|---:|---:|---:|---:|
| Identifier QR control | 37 chars | 3 | 29×29 | 37×37 | 8.65 px/module |
| Static BBR1 | 543 chars | 18 | 89×89 | 97×97 | 3.30 px/module |
| Animated BBP/1 | 132 chars | 8 | 49×49 | 57×57 | 5.61 px/module |

At 320 px, BBR1 would need an approximately **545px** marker to match the BBP/1 frame’s module pitch. At 240 px the clean static marker was already unreadable while the clean animated marker decoded, so the observed gap existed before H.264. Chunking creates the density advantage; the erasure code then makes enough arbitrary symbols reconstructable. This is not a pure “fountain code versus QR” result or evidence that recompression created the gap.

## Six-second outcomes at 25% configured sample-erasure probability

| Marker | Media path | Identifier QR | Static BBR1 | Animated BBP/1 | Animated delta |
|---:|---|---:|---:|---:|---:|
| 240px | capture-crf18 | 49/49 (100.0%) | 0/49 (0.0%) | 49/49 (100.0%) | 100.0 pp |
| 240px | transcode-crf27 | 49/49 (100.0%) | 0/49 (0.0%) | 49/49 (100.0%) | 100.0 pp |
| 240px | transcode-crf35 | 49/49 (100.0%) | 0/49 (0.0%) | 49/49 (100.0%) | 100.0 pp |
| 280px | capture-crf18 | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 0.0 pp |
| 280px | transcode-crf27 | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 0.0 pp |
| 280px | transcode-crf35 | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 0.0 pp |
| 320px | capture-crf18 | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 0.0 pp |
| 320px | transcode-crf27 | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 0.0 pp |
| 320px | transcode-crf35 | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 0.0 pp |

## Duration tradeoff at the current 320 px footprint

| Excerpt | Identifier QR | Static BBR1 | Animated BBP/1 | Animated p95* |
|---:|---:|---:|---:|---:|
| 3s | 73/73 (100.0%) | 73/73 (100.0%) | 8/73 (11.0%) | 2.875 s |
| 6s | 49/49 (100.0%) | 49/49 (100.0%) | 49/49 (100.0%) | 4.750 s |

## Fixed conditions

- The same 403-byte signed fixture and expected receipt ID are used by every transport.
- The identifier QR is an experimental optical lower-bound control. It is not the shipped eight-character visible Build ID, and no lookup service is implemented or tested.
- The carrier is 1280×720, 30 fps, 12 seconds; the marker updates at the public transmitter default of 2 Hz.
- The animated stream begins at sequence 73, exercising a join-late slice rather than sequence-zero startup. Short-excerpt outcomes can change with this phase.
- The receiver samples full frames at 8 Hz through jsQR. It is not given a cropped marker region.
- QR error correction is M with a 4-module quiet zone. Marker position, colors, H.264 preset, GOP, and yuv420p format are held constant.
- Every possible sample-aligned start in the one carrier is evaluated: 73 three-second excerpts and 49 six-second excerpts. The same seeded erasure mask is used for every transport at each start. These overlapping windows are descriptive outcomes, not independent statistical trials.
- A configured 25% erasure probability removes receiver sample timestamps, not whole 2 Hz symbols. The six-second masks realized 24.4% erasure across 2352 window observations.
- `capture-crf18` is a first-generation x264 encode. `transcode-crf27` and `transcode-crf35` are genuine second-generation encodes of that capture.

## Reproduce

Requirements: Node.js 22.12+, npm dependencies, ffmpeg with libx264, and several minutes of local CPU time.

```bash
npm ci
npm run bench
```

Machine-readable results: [benchmarks/beacon-bench.json](../benchmarks/beacon-bench.json). The checked-in run used ffmpeg 8.1.

## Limits and non-claims

- The synthetic moving carrier is not a real application demo or a named platform pipeline.
- The overlapping excerpts come from one carrier and one encode per transport/size. Percentages are exact descriptions of those windows, not population reliability estimates.
- Sample erasure means decoder timestamps were discarded after media decoding; it is not whole-symbol loss or a claim about network or platform frame loss.
- The benchmark does not test crop, blur, glare, perspective, camera capture, codecs other than H.264, or an independent BBP/1 implementation.
- The identifier QR is a hypothetical control. It would require a resolver and network or local index before it could return provenance.
- A valid signed receipt still does not authenticate the surrounding footage or establish signer identity.
- The generator and receiver share this implementation. The result is product evidence, not an interoperability or security audit.
