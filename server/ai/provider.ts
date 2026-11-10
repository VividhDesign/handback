import { GoogleGenAI } from '@google/genai';
import { env, hasGemini } from '../env.ts';

let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  if (!hasGemini()) throw new Error('GEMINI_API_KEY is not configured');
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export const textPart = (text: string): Part => ({ text });
export const jpegPart = (buf: Buffer): Part => ({ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } });

export class AiTimeout extends Error {}

/** One structured-JSON vision call. Temperature 0. Throws on timeout or API error. */
export async function generateJson(opts: { model: string; system: string; parts: Part[]; schema: unknown; timeoutMs?: number }): Promise<{ json: unknown; text: string }> {
  const ai = gemini();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 25_000);
  try {
    const res = await ai.models.generateContent({
      model: opts.model,
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
    return { json: JSON.parse(text), text };
  } catch (err: any) {
    if (ctl.signal.aborted) throw new AiTimeout('AI call timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Lists models that support generateContent (used once to pick GEMINI_VISION_MODEL). */
export async function listModels(): Promise<string[]> {
  const ai = gemini();
  const out: string[] = [];
  const pager = await ai.models.list();
  for await (const m of pager) {
    if ((m.supportedActions ?? []).includes('generateContent')) out.push(String(m.name).replace(/^models\//, ''));
  }
  return out;
}
