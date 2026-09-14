import type { NextConfig } from 'next';

const config: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: [
    '@marketsync/core',
    '@marketsync/fixtures',
    '@marketsync/shared-types',
    '@marketsync/sports-models',
    '@marketsync/ui',
  ],
};

export default config;
