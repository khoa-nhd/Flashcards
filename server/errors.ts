/** An error with a deliberate HTTP status and a message that is safe to show the user. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly options: {
      /** Extra top-level fields for the JSON body. */
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
