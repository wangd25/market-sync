import '@marketsync/ui/theme.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'MarketSync · anti-spoiler market timeline',
  description: 'Align delayed prediction-market information to your personal broadcast timeline.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
