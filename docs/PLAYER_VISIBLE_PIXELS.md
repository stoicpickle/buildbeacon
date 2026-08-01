# YouTube Player Visible-Pixels Experiment

**Question:** Can the signed receipt be recovered from six-second fragments of the visible pixels rendered by the YouTube player, and where do scale or edge crops break it?

**Bottom line:** Under this exact Chrome, YouTube rendition, display, and tab-capture path, animated 240 recovered from 49/49 tested six-second P100 windows. Conditions meeting the 95% zero-erasure bar: p100, s75, s50, c-safe.

This experiment captures the rendered YouTube watch-page viewport through Chrome’s tab screencast path. The analyzer crops the visible 16:9 player pixels, normalizes them once to 1280×720, and evaluates deterministic scale and crop derivatives. It does not inspect or decode the downloaded platform file.

## Six-second recovery

Each cell is successful overlapping six-second windows out of all 8 fps sample-aligned starts. The first value uses no simulated erasure; the parenthesized value uses one deterministic 25% post-decode sample-erasure realization.

| Condition | Visible transformation | Static BBR1 | Animated BBP/1 |
|---|---|---:|---:|
| p100 (1280×720) | Canonical 1280×720 player-visible master | 0/49 (0/49) | 49/49 (49/49) |
| s75 (960×540) | 75% Lanczos scale | 0/49 (0/49) | 49/49 (49/49) |
| s50 (640×360) | 50% Lanczos scale | 0/49 (0/49) | 49/49 (49/49) |
| c-safe (1232×672) | Remove 48 px from right and bottom; no resize | 0/49 (0/49) | 49/49 (49/49) |
| c-edge (1200×640) | Remove 80 px from right and bottom; clips 24 px from marker edges | 0/49 (0/49) | 0/49 (0/49) |

## Fixed conditions

- Browser: Chrome 151.0.0.0 on macOS; viewport 2044×944, DPR 2.
- YouTube player source resolution: 1280×720 at 1.0×; both playthroughs reported zero dropped video frames.
- Capture: Chrome DevTools Protocol Page.startScreencast, JPEG quality 95; raw viewport frames and private watch-page identifiers remain ignored locally.
- Player crop: 1434×806 at (16, 68), normalized with Lanczos to 1280×720.
- Receiver: full derivative frames sampled at 8 fps; every sample-aligned 6-second window; exact envelope equality plus Ed25519 verification required.

## Reproducibility boundary

- The analyzer is public (`npm run bench:player -- CAPTURE_DIRECTORY`), and this report pins the private capture manifest and frame-set hashes.
- The historical raw viewport capture is not public because it contains account and unlisted-watch-page context. Therefore the checked-in result can be audited, but that exact historical analysis cannot be rerun from this repository alone.
- A future public capture fixture should contain player-only pixels and a documented capture producer before this row is described as independently reproducible.

## Limits

- This is one Chrome version, one display scale, one YouTube rendition, one account, and one tab-screencast implementation.
- Chrome tab screencast pixels are composited browser output, but they are not an operating-system framebuffer recording and do not include browser-window occlusion.
- The overlapping windows are not independent videos. The 25% condition is deterministic post-decode sample erasure, not measured platform frame loss.
- Static 240 was already unreadable before upload, so its failure cannot be attributed to YouTube or the screen-capture path.
- Adaptive codec changes, different display scaling, player sizing, OS recorders, cursor or control overlays, stalls, editing, and repost chains remain untested.
- Raw watch-page frames are intentionally excluded from the public repository because they can contain account and unlisted-video context.

Machine-readable results: [player-visible-pixels.json](../benchmarks/player-visible-pixels.json). Related upload/download evidence: [Platform Round Trips](PLATFORM_ROUND_TRIPS.md).
