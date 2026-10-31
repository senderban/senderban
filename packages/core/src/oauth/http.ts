import { AdapterError } from "../adapter.js";

/** The words of the error for an answer over the cap; a caller that must tell it from a passing failure looks for them. */
export const OVERSIZE = "larger than any valid one";

/** Who answered, in a fixed text: only these two names ever reach a log or a toast. */
export type ProviderName = "Google" | "Microsoft";

/** Reads the body in chunks and stops at the cap; the message is a fixed text, never part of the answer. */
export async function readBounded(
  response: Response,
  what: string,
  maxBytes: number,
  who: ProviderName = "Google",
): Promise<string> {
  const tooLarge = (): AdapterError =>
    new AdapterError("TRANSIENT", `${who} answer is ${OVERSIZE} (${what})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done || chunk.value === undefined) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses JSON from an answer body; anything that is not JSON is `null`, never an error carrying the text. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
