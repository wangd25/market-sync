import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  analyzeResearchObservations,
  parseResearchJsonl,
  providerBenchmarkMarkdown,
} from '@marketsync/core';
import { fixtureStream, fixtures } from '@marketsync/fixtures';
import type { ResearchObservation, SportsObservation } from '@marketsync/shared-types';

const argument = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const fixtureResearch = (): readonly ResearchObservation[] => {
  const sessionId = 'fixture-provider-benchmark';
  const fixture = fixtures.basketball;
  const market = fixtureStream(fixture, { outOfOrder: true }).map((tick): ResearchObservation => ({
    id: `${sessionId}:market:${tick.id}`,
    sessionId,
    kind: 'market',
    recordedAtMs: tick.receivedTimestampMs,
    monotonicRecordedMs: tick.monotonicReceivedMs,
    tick,
  }));
  const sports = fixture.sportsStates.map((state, index): ResearchObservation => {
    const sportsObservation: SportsObservation = {
      id: `fixture-sports:${index}:0`,
      sourceId: 'fixture-sports',
      sourceLabel: 'Deterministic benchmark truth',
      authority: 'fixture',
      capabilities: [
        'scoreboard',
        'game_clock',
        'play_by_play',
        'wall_clock_timestamp',
        'ordered_sequence',
        'replay_recovery',
      ],
      providerEventId: String(state.discreteState?.['playId'] ?? index),
      revision: 0,
      correction: false,
      timestampQuality: 'provider',
      sourceTimestampMs: state.sourceTimestampMs,
      receivedTimestampMs: state.sourceTimestampMs + 120 + (index % 3) * 40,
      monotonicReceivedMs: index * 1_000,
      state,
      rawSchemaVersion: 'fixture-benchmark-v1',
    };
    return {
      id: `${sessionId}:sports:${sportsObservation.id}`,
      sessionId,
      kind: 'sports',
      recordedAtMs: sportsObservation.receivedTimestampMs,
      monotonicRecordedMs: sportsObservation.monotonicReceivedMs,
      observation: sportsObservation,
    };
  });
  return [...market, ...sports].toSorted((left, right) => left.recordedAtMs - right.recordedAtMs);
};

const run = async (): Promise<void> => {
  const inputPath = argument('input');
  const provider = argument('provider') ?? 'fixture';
  if (inputPath === undefined && provider !== 'fixture')
    throw new Error('Non-fixture benchmarks require --input=/path/to/sanitized-research.jsonl');
  const observations =
    inputPath === undefined
      ? fixtureResearch()
      : parseResearchJsonl(await readFile(resolve(inputPath), 'utf8'));
  const generatedAtMs = Date.now();
  const report = analyzeResearchObservations(observations, generatedAtMs);
  const outputDirectory = resolve('diagnostics');
  await mkdir(outputDirectory, { recursive: true });
  const inputLabel = inputPath === undefined ? provider : basename(inputPath).replace(/\W+/g, '-');
  const baseName = `provider-benchmark-${inputLabel}-${generatedAtMs}`;
  const jsonPath = resolve(outputDirectory, `${baseName}.json`);
  const markdownPath = resolve(outputDirectory, `${baseName}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
    writeFile(markdownPath, providerBenchmarkMarkdown(report), { encoding: 'utf8', mode: 0o600 }),
  ]);
  console.info(
    JSON.stringify(
      {
        jsonPath,
        markdownPath,
        warning: report.warning,
        signals: report.signals.length,
      },
      null,
      2,
    ),
  );
};

await run();
