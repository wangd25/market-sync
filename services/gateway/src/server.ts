import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fixtureList } from '@marketsync/fixtures';
import type { MarketMetadata } from '@marketsync/shared-types';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { MockKalshiLiveGateway, requireLiveKalshiConfig } from './kalshi-live';
import { RoomManager } from './rooms';

const port = Number(process.env['MARKETSYNC_GATEWAY_PORT'] ?? 8787);
const rooms = new RoomManager();
const kalshiConfig = requireLiveKalshiConfig(process.env);
const kalshi = new MockKalshiLiveGateway();
const selectionSchema = z.object({ selectedMarket: z.custom<MarketMetadata>() });

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, null);
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, {
      ok: true,
      kalshi: {
        available: kalshi.available,
        reason: kalshi.reason,
        environment: kalshiConfig.environment,
      },
    });
  }
  if (request.method === 'GET' && url.pathname === '/fixtures')
    return json(response, 200, fixtureList);
  if (request.method === 'POST' && url.pathname === '/rooms')
    return json(response, 201, rooms.create());
  const roomMatch = /^\/ROOMS\/([A-Z0-9]{6})$/.exec(url.pathname.toUpperCase());
  if (roomMatch !== null) {
    const code = roomMatch[1];
    if (code === undefined) return json(response, 400, { error: 'Invalid room code' });
    if (request.method === 'GET') {
      const room = rooms.get(code);
      return room === null
        ? json(response, 404, { error: 'Room not found' })
        : json(response, 200, room);
    }
    if (request.method === 'POST') {
      try {
        const body = selectionSchema.parse(await readBody(request));
        return json(response, 200, rooms.selectMarket(code, body.selectedMarket));
      } catch {
        return json(response, 400, { error: 'Invalid room selection' });
      }
    }
  }
  return json(response, 404, { error: 'Not found' });
});

const sockets = new WebSocketServer({ server, path: '/stream/fixture' });
sockets.on('connection', (socket) => {
  let index = 0;
  const fixture = fixtureList[0];
  const timer = setInterval(() => {
    const tick = fixture?.ticks[index % (fixture.ticks.length || 1)];
    if (tick !== undefined && socket.readyState === socket.OPEN) socket.send(JSON.stringify(tick));
    index += 1;
  }, 1_000);
  socket.on('close', () => clearInterval(timer));
});

server.listen(port, '0.0.0.0', () => {
  console.info(
    `MarketSync gateway listening on http://0.0.0.0:${port}; Kalshi credentials: never logged`,
  );
});
