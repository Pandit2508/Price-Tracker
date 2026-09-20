import { chromium } from 'playwright';

export function launchBrowser({ headed = false, slowMoMs = 0 } = {}) {
  return chromium.launch({
    headless: !headed,
    slowMo: headed ? slowMoMs : 0,
    channel: process.env.BROWSER_CHANNEL || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}
