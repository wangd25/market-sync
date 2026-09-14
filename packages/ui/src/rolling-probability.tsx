'use client';

import { useEffect, useRef } from 'react';

export interface RollingProbabilityProps {
  value: number | null;
  suffix: '¢' | '%';
}

const displayValue = (value: number | null): string =>
  value === null ? '—' : String(Math.round(value * 100));

export const RollingProbability = ({ value, suffix }: RollingProbabilityProps) => {
  const previousValueRef = useRef(value);
  const previousValue = previousValueRef.current;
  const currentDigits = displayValue(value);
  const previousDigits = displayValue(previousValue);
  const width = Math.max(currentDigits.length, previousDigits.length);
  const current = currentDigits.padStart(width, ' ');
  const previous = previousDigits.padStart(width, ' ');
  const currentNumber = value === null ? null : Math.round(value * 100);
  const previousNumber = previousValue === null ? null : Math.round(previousValue * 100);
  const direction =
    currentNumber === null || previousNumber === null || currentNumber === previousNumber
      ? 'flat'
      : currentNumber > previousNumber
        ? 'up'
        : 'down';

  useEffect(() => {
    previousValueRef.current = value;
  }, [value]);

  return (
    <output className="ms-animated-price" aria-live="polite" aria-atomic="true">
      <span className="ms-sr-only">
        {currentDigits}
        {value === null ? '' : suffix}
      </span>
      <span className="ms-odometer" aria-hidden="true">
        {[...current].map((digit, index) => {
          const oldDigit = previous[index] ?? ' ';
          const changed = direction !== 'flat' && digit !== oldDigit;
          const key = `${index}-${oldDigit}-${digit}`;
          if (!changed)
            return (
              <span key={key} className="ms-odometer-digit">
                {digit === ' ' ? '\u00a0' : digit}
              </span>
            );
          const orderedDigits = direction === 'up' ? [oldDigit, digit] : [digit, oldDigit];
          return (
            <span key={key} className={`ms-odometer-digit is-changing ${direction}`}>
              <span className="ms-odometer-track">
                {orderedDigits.map((trackDigit, trackIndex) => (
                  <span key={`${trackIndex}-${trackDigit}`}>
                    {trackDigit === ' ' ? '\u00a0' : trackDigit}
                  </span>
                ))}
              </span>
            </span>
          );
        })}
        {value === null ? null : <span className="ms-odometer-suffix">{suffix}</span>}
      </span>
    </output>
  );
};
