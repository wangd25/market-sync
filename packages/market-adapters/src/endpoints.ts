export const POLYMARKET_ENDPOINTS = {
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
  marketWebSocket: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  sportsWebSocket: 'wss://sports-api.polymarket.com/ws',
} as const;

export const KALSHI_ENDPOINTS = {
  productionRest: 'https://external-api.kalshi.com/trade-api/v2',
  demoRest: 'https://external-api.demo.kalshi.co/trade-api/v2',
  productionWebSocket: 'wss://external-api-ws.kalshi.com/trade-api/ws/v2',
  demoWebSocket: 'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2',
} as const;
