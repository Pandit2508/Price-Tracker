/**
 * Every failure the scraper can produce is a ScrapeError with a stable `code`
 * (shown in the scrape log) and a `retryable` flag (drives the retry loop).
 */
export class ScrapeError extends Error {
  constructor(code, message, { retryable = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ScrapeError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Turn anything thrown (Playwright timeouts, network errors, bugs) into a ScrapeError. */
export function classify(err) {
  if (err instanceof ScrapeError) return err;
  const msg = String(err?.message ?? err);
  const firstLine = msg.split('\n')[0];
  if (err?.name === 'TimeoutError' || /timeout/i.test(msg)) {
    return new ScrapeError('TIMEOUT', firstLine, { cause: err });
  }
  if (/Target (page, context or browser )?has been closed|browser has been closed/i.test(msg)) {
    return new ScrapeError('BROWSER_CLOSED', firstLine, { cause: err });
  }
  if (/net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) {
    return new ScrapeError('NETWORK', firstLine, { cause: err });
  }
  return new ScrapeError('UNEXPECTED', firstLine, { cause: err });
}
