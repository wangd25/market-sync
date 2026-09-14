# Phase 1 visual concept record

## Generation

Mode: built-in Image Gen, `ui-mockup` use case.

Final prompt:

> Design a complete 1440×1000 desktop companion web application specification for MarketSync, an original anti-spoiler synchronization dashboard for delayed live sports. This is a functional React/Next.js product surface, not a marketing page. Include code-native MarketSync navigation; fixture soccer market selection; reference period, clock, and score; a dominant delayed probability chart with current probability, bid, ask, spread, provider, “Aligned to your broadcast,” and a clear viewer-now/future-hidden cutoff; a right synchronization rail with 20-second delay, 92% confidence, strict anti-spoiler toggle, delay slider and ±5/±1/±0.25 controls, Pause, event tap, and guided clock tap; a low simulator band; and a diagnostics/status rail. Use an original editorial-sports control-room direction: true deep-navy background, slate-blue surfaces, off-white type, restrained seafoam/cyan accent, coral warnings, fine 1px borders, 10–14px radii, sparse shadow, modern grotesk typography, medium density, generous gutters, and a distinctive timeline-cutoff motif. Use an open two-column canvas rather than nested cards. Keep controls and text practical for responsive HTML/CSS and reusable React components. Do not copy Polymarket or Kalshi, show trading/wallet UI, invent profit metrics, use filler pills, bento grids, excessive glow, glassmorphism, crypto motifs, remote imagery, or unreadable text.

Generated concept: [phase-1-concept.png](phase-1-concept.png).

## Extracted design system

- Background `#061b2a` / deep `#031521`; slate surfaces `#0a2233`; border `#29465c`.
- Primary text `#edf5f6`; muted `#91a6b8`; accent `#8fe4cf`; warning `#ff796f`.
- Open chart/right-rail composition, fine separators, 12px primary radius, minimal elevation.
- Modern system grotesk with deliberate small control labels and strong numeric hierarchy.
- Dashed viewer-now rule plus hatched future-hidden region; line-chart attribution remains visible.

## Fidelity ledger

| Comparison point      | Concept evidence                                            | Production render                                                                  | Resolution                         |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| Composition           | Dominant left chart and narrow right sync rail              | Same two-column ratio at 1500×1045                                                 | Matched                            |
| Palette               | Deep navy, slate, seafoam, coral only for warning           | Token values sampled into `theme.css`                                              | Matched                            |
| Typography            | Large probability, compact labels, restrained navigation    | Same hierarchy with code-native controls                                           | Matched                            |
| Timeline motif        | Dashed cutoff and hatched hidden future                     | Implemented as shared chart overlay                                                | Matched                            |
| Control anatomy       | Fine borders, small radii, three-column sync summary        | Shared control families and focus states                                           | Matched                            |
| Simulator/diagnostics | Low horizontal bands below primary workspace                | Same rhythm; companion room follows below                                          | Matched with required continuation |
| Responsive behavior   | Practical mobile continuation implied                       | Verified 390×844 with no horizontal overflow                                       | Matched                            |
| Visible copy          | Core sync, reference, chart, and simulator labels preserved | Added only required live market, viewer device, room, camera, and attribution copy | Intentional functional deviation   |

Latest verified production renders: [desktop](phase-1-implementation.png) and [mobile](phase-1-mobile.png).
