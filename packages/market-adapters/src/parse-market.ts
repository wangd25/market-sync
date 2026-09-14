export interface ParsedMarketReference {
  provider: 'polymarket' | 'kalshi';
  identifier: string;
  kind: 'event' | 'market' | 'unknown';
}

export const parseMarketReference = (input: string): ParsedMarketReference => {
  const trimmed = input.trim();
  if (trimmed.length === 0)
    throw new Error('Enter a Polymarket or Kalshi URL, slug, or identifier.');
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'polymarket.com' || url.hostname.endsWith('.polymarket.com')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const eventIndex = parts.indexOf('event');
      const identifier = eventIndex >= 0 ? parts[eventIndex + 1] : parts.at(-1);
      if (identifier === undefined)
        throw new Error('The Polymarket URL does not include a market slug.');
      return {
        provider: 'polymarket',
        identifier: decodeURIComponent(identifier),
        kind: eventIndex >= 0 ? 'event' : 'unknown',
      };
    }
    if (url.hostname === 'kalshi.com' || url.hostname.endsWith('.kalshi.com')) {
      const identifier = url.pathname.split('/').filter(Boolean).at(-1);
      if (identifier === undefined)
        throw new Error('The Kalshi URL does not include a market ticker.');
      return { provider: 'kalshi', identifier: identifier.toUpperCase(), kind: 'market' };
    }
    throw new Error('Only official Polymarket and Kalshi URLs are supported.');
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Invalid URL')) throw error;
  }
  if (/^KX[A-Z0-9-]+$/i.test(trimmed))
    return { provider: 'kalshi', identifier: trimmed.toUpperCase(), kind: 'market' };
  if (/^[a-z0-9-]{3,}$/i.test(trimmed))
    return { provider: 'polymarket', identifier: trimmed, kind: 'unknown' };
  throw new Error('That market reference is not recognized.');
};
