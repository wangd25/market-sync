import { describe, expect, it } from 'vitest';
import { MockKalshiLiveGateway, requireLiveKalshiConfig } from '../src/kalshi-live';
import { RoomManager } from '../src/rooms';

describe('secure Kalshi gateway boundary', () => {
  it('uses a visible mocked state without credentials', async () => {
    const gateway = new MockKalshiLiveGateway();
    expect(gateway.available).toBe(false);
    expect(gateway.reason).toContain('live unavailable');
    await expect(gateway.subscribe(['KXTEST'], () => undefined)).resolves.toBeTypeOf('function');
  });

  it('refuses live mode when server credentials are absent', () => {
    expect(() => requireLiveKalshiConfig({ KALSHI_LIVE_MODE: 'live' })).toThrow(
      'Refusing to start',
    );
    expect(requireLiveKalshiConfig({})).toMatchObject({ mode: 'mocked', environment: 'demo' });
  });
});

describe('in-memory companion rooms', () => {
  it('shares the selected market but has no viewer delay field', () => {
    const rooms = new RoomManager();
    const room = rooms.create(() => 0.1);
    const updated = rooms.selectMarket(room.code, {
      provider: 'fixture',
      providerMarketId: 'soccer',
      eventId: 'event',
      title: 'Harbor City wins',
      outcomes: [],
      status: 'open',
    });
    expect(updated.selectedMarket?.title).toBe('Harbor City wins');
    expect(updated).not.toHaveProperty('delay');
    expect(rooms.get(room.code)?.revision).toBe(1);
  });
});
