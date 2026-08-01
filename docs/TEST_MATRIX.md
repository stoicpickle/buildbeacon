# Public test matrix

This is the evidence boundary for BuildBeacon 0.1 as of 2026-08-01. A green row supports only the stated condition.

| Surface | Condition | Result | Reproduce |
|---|---|---:|---|
| Canonical receipt | dCBOR round trip and byte-stable public vector | Pass | `npm test` |
| Signature | RFC 8032 vector, receipt sign/verify, one-bit envelope mutation | Pass | `npm test` |
| QR pixels | 320 px, error correction M, PNG render → `jsQR` decode | Pass | `npm test` |
| Static comparison | 720 px `BBR1` PNG upload → envelope + signature recovery | Pass | `npm run test:e2e` |
| Invalid signature UI | one-bit signature mutation renders invalid / not trusted / unverified | Pass/rejected as designed | `npm run test:e2e` |
| Fountain transport | every join offset in one lossless epoch | Pass | `npm test` |
| Fountain transport | start at sequence 73, deterministic 25% erasure, reverse order | Pass | `npm test` |
| Frame handling | duplicate, mixed-receipt, and CRC-corrupt frames | Pass/rejected as designed | `npm test` |
| Video fragment | 6.0 s, 1280×720, 8 fps, H.264 CRF 27, yuv420p | Pass | `npm run demo:verify` |
| Video fragment | 11 deliberate duplicate candidates among 48 frames | Pass after 11 sampled / 9 unique | `npm run demo:verify` |
| Browser | checked-in video through the production `jsQR` recovery path | Pass at rank 7/7 | `npm run test:e2e` |
| Browser cancellation | delayed image decode cancelled before completion | Pass; stale result suppressed | `npm run test:e2e` |
| Browser evidence state | edited claims and fresh local signing invalidate stale signed/recovered state | Pass | `npm run test:e2e` |
| Responsive UI | Chromium viewport 390×844, no horizontal overflow | Pass | `npm run test:e2e` |
| Equal-footprint lab | 240 px, 6 s, 2 Hz marker, H.264 CRF 18→27 and CRF 18→35, 25% configured sample-erasure probability | BBR1 0/49; BBP/1 49/49 in both transcodes | `npm run bench` |
| Equal-footprint lab | 280 px and 320 px under the same six-second conditions | BBR1 49/49; BBP/1 49/49 in every cell | `npm run bench` |
| Collection-time lab | 320 px, 3 s, sequence 73, H.264 CRF 18→27, 25% configured sample-erasure probability | BBR1 73/73; BBP/1 8/73 | `npm run bench` |
| YouTube file round trip | one downloaded 720p rendition, all 8 fps sample-aligned 6 s starts, 25% configured sample erasure | 240 px BBR1 0/49; 240 px BBP/1 49/49; both 49/49 at 260/280 px | `npm run bench:platform -- youtube PATH` |
| Discord attachment round trip | one private attachment-download path under the same matrix | same recovery as upload source; H.264 stream bytes unchanged | `npm run bench:platform -- discord PATH` |
| YouTube player pixels | Chrome tab screencast, canonical 1280×720 player crop, all 8 fps sample-aligned 6 s starts | 240 px BBR1 0/49; 240 px BBP/1 49/49 | Analyzer: `npm run bench:player -- CAPTURE_DIRECTORY`; historical raw input is private |
| YouTube player scaling | canonical crop scaled to 960×540 and 640×360 | BBP/1 49/49 at both sizes | Analyzer only; machine-readable result checked in |
| YouTube player edge crop | remove 48 px vs 80 px from right and bottom | BBP/1 49/49 with marker intact; 0/49 after clipping 24 px from marker edges | Analyzer only; machine-readable result checked in |

Protocol coverage is gated at 80% statements, 70% branches, 80% functions, and 80% lines. The recorded 2026-07-31 run reached 85.18% statements, 72.38% branches, 95.91% functions, and 96.00% lines.

Beacon Bench enumerates all sample-aligned starts in one 12-second carrier. Its overlapping excerpts are exact descriptions of that fixture, not independent statistical trials or population reliability estimates. The 240 px gap exists in the clean QR probe before media encoding.

## Not yet established

No public claim is made yet for:

- other YouTube renditions, accounts, player sizes, adaptive codec switches, or broad YouTube/Discord behavior;
- operating-system framebuffer recording, browser-window occlusion, handheld capture, or mobile playback;
- marker sizes below the effective 120 px animated case or untested points between current boundaries;
- crop patterns other than the documented right/bottom cuts;
- blur, glare, perspective distortion, or handheld capture distances;
- codecs other than the checked-in H.264 fixture;
- browser engines outside the Chromium CI lane;
- hostile/adversarial media transformations;
- interoperability with a second BBP/1 implementation.

Those are deliberately visible gaps, not implied guarantees. Add a deterministic fixture and a row here before broadening a resilience claim.
