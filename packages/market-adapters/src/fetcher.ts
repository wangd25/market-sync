export type Fetcher = typeof fetch;

/**
 * Chromium's Window.fetch is receiver-sensitive. Keeping it as an object property and later
 * calling `object.fetch()` can throw "Illegal invocation". This wrapper always invokes the
 * platform function through globalThis while still allowing tests to inject a deterministic
 * fetch implementation.
 */
export const browserSafeFetch: Fetcher = (input, init) => globalThis.fetch(input, init);
