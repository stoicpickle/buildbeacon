# YouTube and Discord Platform Round Trips

**Question:** Do two ordinary platform upload/download paths change recovery of the exact static and animated BuildBeacon markers prepared by the real-footage benchmark?

**Bottom line:** Neither path introduced an additional recovery failure. YouTube returned byte-different H.264 streams, while Discord returned byte-different files whose H.264 streams were bit-identical to the uploads. The 240 px animated marker recovered from every six-second excerpt on both paths; the 240 px static marker was already unreadable before upload. At 260 and 280 px, both transports recovered every excerpt and static was substantially faster.

This is a bounded experiment over one YouTube rendition and one Discord attachment path. It is not evidence that all transformations on either platform preserve BuildBeacon markers.

## Results

Each cell reports successful six-second excerpts out of 49 with 25% seeded sample erasure after optical decoding.

| Return path | Stream handling | Static 240 | Animated 240 | Static 260 | Animated 260 | Static 280 | Animated 280 |
|---|---|---:|---:|---:|---:|---:|---:|
| Discord attachment download | File bytes differed; H.264 stream identical | 0/49 | 49/49 | 49/49 | 49/49 | 49/49 | 49/49 |
| YouTube 720p download | H.264 stream bytes differed | 0/49 | 49/49 | 49/49 | 49/49 | 49/49 | 49/49 |

The zero-erasure condition produced the same recovery counts. For every successful animated case, median recovery was 3.875 seconds and p95 was 4.75 seconds. For readable static cases, median recovery was immediate on the first sample and p95 was 0.125 seconds under the seeded-erasure condition.

The experiment supports a narrow product decision:

- Use animation when a complete signed receipt is too dense for the available marker area and the clip is long enough to collect independent symbols.
- Use static when the complete receipt fits. At 260 px and above in this experiment, it was equally reliable and much faster.
- Do not claim that animation is inherently more resistant to social-platform processing. Its demonstrated advantage was optical readability at the smaller marker size.

## Method

The [real-footage benchmark](REAL_FOOTAGE_BENCH.md) produced six 12-second, 1280×720, H.264 upload artifacts: static BBR1 and animated BBP/1 at 240, 260, and 280 px. Their exact hashes are recorded in the [platform manifest](../benchmarks/platform-roundtrip-manifest.json).

The files followed two paths:

1. upload as unlisted YouTube videos, then download a 720p H.264 rendition;
2. upload as private Discord attachments, then download the attachments.

The public evidence deliberately omits unlisted video URLs and private Discord identifiers. The returned files were analyzed locally at 8 samples per second across every sample-aligned six-second window. Recovery required the canonical payload and Ed25519 signature to verify. Each returned file and its elementary video stream were hashed independently, distinguishing whole-file changes from elementary video-stream changes.

The analyzer was run as:

```sh
npm run bench:platform -- youtube /absolute/path/to/youtube-downloads
npm run bench:platform -- discord /absolute/path/to/discord-downloads
```

Compact analyzer snapshots are checked in as [youtube.json](../benchmarks/platform-roundtrips/youtube.json) and [discord.json](../benchmarks/platform-roundtrips/discord.json). Raw returned media is excluded from the repository.

## Limits

- One account and one download path were tested per platform.
- The YouTube result covers one downloaded 720p rendition, not every rendition or playback condition.
- The Discord result covers attachment retrieval, not Discord screen sharing or player capture.
- Neither platform player was screen-recorded; no crop, scaling, overlay, trim, mobile workflow, editor export, or repost chain was tested.
- The 49 windows overlap within one twelve-second clip; they are not 49 independent videos.
- The 25% condition is one deterministic post-decode sample-erasure realization, not measured platform frame loss.
- The matrix uses one receipt size, decoder, codec family, screen resolution, marker position, and twelve-second source clip.
- A fresh `npm run bench:real` regenerates the upload artifacts and manifest. Its hashes must be treated as a new experiment, and the platform round trips must be repeated before these results can be applied to it.

BuildBeacon remains a receipt transport, not a video-authenticity system. A valid visible receipt can be copied onto unrelated footage.
