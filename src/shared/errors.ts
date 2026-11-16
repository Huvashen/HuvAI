export class JarvisError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'JarvisError';
  }
}

export function safeFailure(error: unknown): string {
  // Never print token responses, authorization URLs, provider bodies or stack traces.
  return error instanceof JarvisError
    ? `${error.code}: ${error.message}`
    : 'UNEXPECTED_FAILURE: Operation stopped. No paid fallback was attempted.';
}
