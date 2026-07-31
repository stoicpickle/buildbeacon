# Security policy

## Supported versions

BuildBeacon is experimental. Security fixes are applied to the latest release and the `main` branch; no older release line is currently maintained.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability, private-key exposure, denial-of-service vector, signature bypass, canonicalization ambiguity, or malicious-media crash.

Use GitHub’s private vulnerability-reporting flow:

1. Open the repository’s **Security** tab.
2. Select **Advisories** → **Report a vulnerability**.
3. Include the affected commit or release, a minimal reproducer, impact, and any suggested mitigation.

You should receive an initial acknowledgement within seven days. Disclosure timing will be coordinated after impact and remediation are understood.

Never include live private keys, credentials, private recordings, or personal media in a report. Use synthetic fixtures and public test keys.

## Security status

BuildBeacon 0.1 and BBP/1 have not been independently audited. A valid BuildBeacon signature is not, by itself, proof of signer identity or video authenticity. Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before relying on a receipt.
