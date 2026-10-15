import { env } from "@/env";
import { createGeminiLLM } from "./gemini";
import type { StructuredLLM } from "./types";

export function createLLM(): StructuredLLM {
  switch (env.LLM_PROVIDER) {
    case "gemini":
      if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set (see .env.example)");
      return createGeminiLLM({ apiKey: env.GEMINI_API_KEY, model: env.EXTRACT_MODEL });
  }
}
