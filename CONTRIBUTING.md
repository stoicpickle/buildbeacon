# Contributing

BuildBeacon welcomes narrow, evidence-backed improvements to the protocol, decoder, CLI, test fixtures, accessibility, and public documentation.

## Set up

Requirements:

- Node.js 22.12 or newer;
- npm;
- ffmpeg 8 or compatible for media-fixture verification;
- Chromium installed through Playwright for end-to-end tests.

```bash
npm ci
npx playwright install chromium
npm run check
npm run demo:verify
npm run test:e2e
```

## Pull requests

- Keep protocol changes separate from presentation-only work.
- Add deterministic tests for every decoder or canonicalization change.
- Update `docs/PROTOCOL.md` when encoded bytes, limits, versions, or signed semantics change.
- Update `docs/THREAT_MODEL.md` when a security boundary changes.
- Add a row to `docs/TEST_MATRIX.md` before broadening a media-resilience claim.
- Never add a real private key, private recording, credential, or confidential receipt fixture.
- Preserve the UI distinction among transport recovery, signature validity, and signer trust.
- Do not describe BBP/1 as a standard LT/Raptor fountain code or claim that it authenticates the surrounding video.

Before opening a pull request, run:

```bash
npm run check
npm run demo:verify
npm run test:e2e
npm audit --audit-level=high
git diff --check
```

## Protocol compatibility

Fail closed. If a change alters canonical receipt bytes, envelope signing semantics, mask derivation, or frame parsing, introduce the appropriate new version and golden vector rather than silently changing version 1.

## Security issues

Follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.
