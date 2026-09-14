import { ZodError } from 'zod';

export type ProviderErrorCode =
  | 'invalid_reference'
  | 'permission_denied'
  | 'http_error'
  | 'validation_error'
  | 'network_error'
  | 'not_found'
  | 'unexpected_error';

export class ProviderError extends Error {
  public constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export const classifyProviderError = (error: unknown): ProviderError => {
  if (error instanceof ProviderError) return error;
  if (error instanceof ZodError)
    return new ProviderError(
      'validation_error',
      'The provider returned data MarketSync could not validate.',
      undefined,
      { cause: error },
    );
  if (error instanceof DOMException && error.name === 'NotAllowedError')
    return new ProviderError(
      'permission_denied',
      'Permission to access public market data was denied.',
      undefined,
      { cause: error },
    );
  if (error instanceof TypeError)
    return new ProviderError(
      'network_error',
      error.message.includes('Illegal invocation')
        ? 'MarketSync could not start the browser request.'
        : 'The public market service is unreachable. Check your connection and try again.',
      undefined,
      { cause: error },
    );
  return new ProviderError(
    'unexpected_error',
    error instanceof Error ? error.message : 'An unexpected provider error occurred.',
    undefined,
    { cause: error },
  );
};
