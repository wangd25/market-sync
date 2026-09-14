import type { MarketMetadata, RoomState } from '@marketsync/shared-types';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  private readonly rooms = new Map<string, RoomState>();

  public create(random = Math.random): RoomState {
    const generate = () =>
      Array.from({ length: 6 }, () => alphabet[Math.floor(random() * alphabet.length)] ?? 'A').join(
        '',
      );
    let code = generate();
    while (this.rooms.has(code)) code = generate();
    const room: RoomState = { code, selectedMarket: null, revision: 0 };
    this.rooms.set(code, room);
    return structuredClone(room);
  }

  public get(code: string): RoomState | null {
    const room = this.rooms.get(code.toUpperCase());
    return room === undefined ? null : structuredClone(room);
  }

  public selectMarket(code: string, selectedMarket: MarketMetadata): RoomState {
    const normalized = code.toUpperCase();
    const room = this.rooms.get(normalized);
    if (room === undefined) throw new Error('Room not found');
    const next = { ...room, selectedMarket, revision: room.revision + 1 };
    this.rooms.set(normalized, next);
    return structuredClone(next);
  }
}
