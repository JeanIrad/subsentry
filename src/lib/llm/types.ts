// Provider-agnostic structured-output call. Implementations live next to this
// file; pick one with LLM_PROVIDER. Mocked in unit tests.

export interface StructuredRequest {
  system: string;
  user: string;
  jsonSchema: unknown;
}

export interface StructuredResponse {
  /** Raw model text (expected to be JSON). Contains email-derived data: never log it. */
  text: string;
  model: string;
}

export interface StructuredLLM {
  readonly model: string;
  generateJson(req: StructuredRequest): Promise<StructuredResponse>;
}

/** The provider asked us to slow down; retry later. */
export class LLMRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super("LLM rate limit reached");
    this.name = "LLMRateLimitError";
  }
}
