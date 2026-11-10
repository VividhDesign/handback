import { GoogleGenAI } from '@google/genai';
import { env, hasGemini } from '../env.ts';

let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  if (!hasGemini()) throw new Error('GEMINI_API_KEY is not configured');
  // The v3 SDK defaults to API v1, which rejects systemInstruction.
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, apiVersion: 'v1beta' });
  return client;
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export const textPart = (text: string): Part => ({ text });
export const jpegPart = (buf: Buffer): Part => ({ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } });

export class AiTimeout extends Error {}

/** Models to try in order: the configured one, then the fallbacks (no duplicates). */
export function modelChain(primary: string): string[] {
  return [...new Set([primary, ...env.GEMINI_FALLBACK_MODELS])];
}

// A model that said "per day" quota exhausted is skipped until the next UTC day.
const exhausted = new Map<string, string>();
const today = () => new Date().toISOString().slice(0, 10);

/** Errors where another model may still answer: quota, overload, model gone, server error. */
function shouldTryNext(err: any) {
  const status = Number(err?.status ?? 0);
  return [404, 429, 500, 503].includes(status) || /RESOURCE_EXHAUSTED|UNAVAILABLE|high demand/i.test(String(err?.message));
}

/**
 * One structured-JSON call at temperature 0, tried on each model in `models` until one answers.
 * Returns the model that answered. Throws on timeout, on a non-retryable error, or when every model fails.
 */
export async function generateJson(opts: { models: string[]; system: string; parts: Part[]; schema: unknown; timeoutMs?: number }): Promise<{ json: unknown; text: string; model: string }> {
  const ai = gemini();
  let last: any = new Error('No AI model configured');
  for (const model of opts.models) {
    if (exhausted.get(model) === today()) continue;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 25_000);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: opts.parts }],
        config: {
          systemInstruction: opts.system,
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: opts.schema as any,
          abortSignal: ctl.signal,
        },
      });
      const text = res.text ?? '';
      try {
        return { json: JSON.parse(text), text, model };
      } catch {
        // Empty or cut-off output (or a blocked prompt): let the caller's schema check fail and retry.
        console.warn(`[ai] ${model}: no valid JSON (finishReason ${res.candidates?.[0]?.finishReason ?? 'none'}, block ${res.promptFeedback?.blockReason ?? 'none'}, ${text.length} chars)`);
        return { json: undefined, text, model };
      }
    } catch (err: any) {
      if (ctl.signal.aborted) throw new AiTimeout(`AI call timed out (${model})`);
      if (!shouldTryNext(err)) throw err;
      if (Number(err?.status) === 429 && /per day/i.test(String(err?.message))) exhausted.set(model, today());
      console.warn(`[ai] ${model} unavailable (${err?.status ?? 'error'}), trying the next model`);
      last = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** Lists models that support generateContent (used to pick GEMINI_VISION_MODEL). */
export async function listModels(): Promise<string[]> {
  const ai = gemini();
  const out: string[] = [];
  const pager = await ai.models.list();
  for await (const m of pager) {
    if ((m.supportedActions ?? []).includes('generateContent')) out.push(String(m.name).replace(/^models\//, ''));
  }
  return out;
}
