import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('recovers and verifies the checked-in six-second pixel fixture', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Prove the receipt. Keep it in the pixels.' })).toBeVisible()
  await page.getByRole('button', { name: 'Run the 6-second proof →', exact: true }).click()
  await expect(page.getByText('Receipt reconstructed. Signature valid under the embedded key.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('7 / 7')).toBeVisible()

  await page.getByRole('button', { name: '03inspect', exact: true }).click()
  await expect(page.getByText('Receipt reconstructed')).toBeVisible()
  await expect(page.getByText('Signature valid')).toBeVisible()
  await expect(page.getByText('Self-presented key', { exact: true })).toBeVisible()
  await expect(page.getByText('sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9', { exact: true })).toBeVisible()
  await expect(page.getByText('It does not prove the surrounding footage came from the claimed artifact', { exact: false })).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('fits the mobile viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth)
  await expect(page.getByRole('button', { name: 'Run the 6-second proof →', exact: true })).toBeVisible()
})

test('recovers the self-contained static QR comparison', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '02recover', exact: true }).click()
  await page.getByLabel('Upload a local video or QR image').setInputFiles(resolve('public/demo/buildbeacon-static.png'))
  await expect(page.getByText('Receipt reconstructed. Signature valid under the embedded key.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('1 / 1')).toBeVisible()
})

test('labels a recovered receipt with an invalid signature as untrusted', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '02recover', exact: true }).click()
  await page.getByLabel('Upload a local video or QR image').setInputFiles(resolve('public/demo/buildbeacon-static-invalid.png'))
  await expect(page.getByText('Ed25519 signature does not match the receipt')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '03inspect', exact: true }).click()
  await expect(page.getByText('Signature invalid', { exact: true })).toBeVisible()
  await expect(page.getByText('Not trusted', { exact: true })).toBeVisible()
  await expect(page.getByText('Unverified build claims', { exact: true })).toBeVisible()
  await expect(page.getByText('invalid', { exact: true })).toBeVisible()
})

test('a cancelled image scan cannot publish stale recovered evidence', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const originalCreateImageBitmap = window.createImageBitmap.bind(window)
    Object.defineProperty(window, 'createImageBitmap', {
      configurable: true,
      value: async (source: ImageBitmapSource) => {
        await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 750))
        return originalCreateImageBitmap(source)
      },
    })
  })
  await page.getByRole('button', { name: '02recover', exact: true }).click()
  await page.getByLabel('Upload a local video or QR image').setInputFiles(resolve('public/demo/buildbeacon-static.png'))
  await page.getByRole('button', { name: 'Cancel scan', exact: true }).click()
  await expect(page.getByText('Scan cancelled. Choose another local source when ready.', { exact: true })).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(page.getByText('Scan cancelled. Choose another local source when ready.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '03inspect', exact: true }).click()
  await expect(page.getByText('Recover a beacon or load a signed receipt to inspect its claims.', { exact: true })).toBeVisible()
})

test('editing claims invalidates the previously signed beacon', async ({ page }) => {
  await page.goto('/')
  const signedDownload = page.getByRole('button', { name: 'Download signed receipt', exact: true })
  await expect(signedDownload).toBeEnabled()
  await page.evaluate(() => {
    const originalDigest = window.crypto.subtle.digest.bind(window.crypto.subtle)
    Object.defineProperty(window.crypto.subtle, 'digest', {
      configurable: true,
      value: async (...argumentsList: Parameters<SubtleCrypto['digest']>) => {
        await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 500))
        return originalDigest(...argumentsList)
      },
    })
  })
  await page.getByRole('button', { name: 'Create signed beacon', exact: true }).click()
  await page.getByLabel('Artifact name').fill('edited-artifact.tar.gz')
  await page.waitForTimeout(750)
  await expect(signedDownload).toBeDisabled()
  await expect(page.getByText('Claims changed. Create a new signed beacon before using the marker.', { exact: true })).toBeVisible()
  await expect(page.getByText('No current signed beacon. Create or re-create one to continue.', { exact: true })).toHaveCount(2)
})

test('local signing clears prior recovered transport evidence', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run the 6-second proof →', exact: true }).click()
  await expect(page.getByText('Receipt reconstructed. Signature valid under the embedded key.')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '01transmit', exact: true }).click()
  await page.getByRole('button', { name: 'Create signed beacon', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download signed receipt', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '03inspect', exact: true }).click()
  await expect(page.getByText('Waiting for frames', { exact: true })).toBeVisible()
  await expect(page.getByText('6b3ba041e95d4a51da0da0f55965bf1d', { exact: true })).toHaveCount(0)
})
