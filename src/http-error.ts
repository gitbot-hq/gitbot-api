/** Thrown by routes; the app's error handler turns it into { error: { code, message } }. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
