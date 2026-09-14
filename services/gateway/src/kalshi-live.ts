import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { KALSHI_ENDPOINTS } from '@marketsync/market-adapters';
import type { MarketTick } from '@marketsync/shared-types';

export interface KalshiServerConfig {
  environment: 'production' | 'demo';
  mode: 'mocked' | 'live';
  apiKeyId?: string;
  privateKeyPath?: string;
}

export interface KalshiLiveGateway {
  readonly available: boolean;
  readonly reason: string;
  subscribe(
    marketTickers: readonly string[],
    onTick: (tick: MarketTick) => void,
  ): Promise<() => void>;
}

export const redactSecret = (value: string): string =>
  value.length === 0 ? '[empty]' : '[redacted]';

export const createKalshiHandshakeHeaders = async (
  config: KalshiServerConfig,
  timestampMs: number,
): Promise<Record<string, string>> => {
  if (
    config.mode !== 'live' ||
    config.apiKeyId === undefined ||
    config.privateKeyPath === undefined
  ) {
    throw new Error('Kalshi live credentials are unavailable');
  }
  const privateKeyPem = await readFile(config.privateKeyPath);
  const path = '/trade-api/ws/v2';
  const message = `${timestampMs}GET${path}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(message),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return {
    'KALSHI-ACCESS-KEY': config.apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': String(timestampMs),
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
};

export class MockKalshiLiveGateway implements KalshiLiveGateway {
  public readonly available = false;
  public readonly reason =
    'Kalshi live unavailable — gateway is running in credential-free mock mode.';

  public subscribe(
    marketTickers: readonly string[],
    onTick: (tick: MarketTick) => void,
  ): Promise<() => void> {
    void marketTickers;
    void onTick;
    return Promise.resolve(() => undefined);
  }
}

export const requireLiveKalshiConfig = (environment: NodeJS.ProcessEnv): KalshiServerConfig => {
  const mode = environment['KALSHI_LIVE_MODE'] === 'live' ? 'live' : 'mocked';
  const target = environment['KALSHI_ENV'] === 'production' ? 'production' : 'demo';
  if (
    mode === 'live' &&
    (!environment['KALSHI_API_KEY_ID'] || !environment['KALSHI_PRIVATE_KEY_PATH'])
  ) {
    throw new Error('Refusing to start live Kalshi WebSocket: server credentials are missing.');
  }
  return {
    environment: target,
    mode,
    ...(environment['KALSHI_API_KEY_ID'] === undefined
      ? {}
      : { apiKeyId: environment['KALSHI_API_KEY_ID'] }),
    ...(environment['KALSHI_PRIVATE_KEY_PATH'] === undefined
      ? {}
      : { privateKeyPath: environment['KALSHI_PRIVATE_KEY_PATH'] }),
  };
};

export const kalshiWebSocketUrl = (environment: KalshiServerConfig['environment']): string =>
  environment === 'production'
    ? KALSHI_ENDPOINTS.productionWebSocket
    : KALSHI_ENDPOINTS.demoWebSocket;
