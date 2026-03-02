export class VouchApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Array<{ field: string; issue: string }>,
  ) {
    super(message);
    this.name = 'VouchApiError';
  }
}
