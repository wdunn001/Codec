/**
 * Shared encoder utilities — the GPT-2 byte↔unicode mapping table and
 * UTF-8 partial-sequence buffering. Used by both the Detokenizer (to recover
 * bytes from byte-level tokens) and the BPETokenizer (to encode input bytes
 * into the vocab's character space).
 */

/**
 * Build the GPT-2 byte→unicode mapping table.
 *
 * The 256-entry bijection used by tiktoken / GPT-2 / Llama-3 / Qwen2 BPE
 * tokenizers. Bytes 33-126 (printable ASCII), 161-172, 174-255 map to
 * themselves as Unicode characters; all other bytes map to characters
 * starting at U+0100 (`Ā`).
 */
function buildByteToUnicode(): { byteToChar: Map<number, string>; charToByte: Map<number, number> } {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const byteToChar = new Map<number, string>();
  const charToByte = new Map<number, number>();
  for (let i = 0; i < bs.length; i++) {
    const ch = String.fromCodePoint(cs[i]!);
    byteToChar.set(bs[i]!, ch);
    charToByte.set(cs[i]!, bs[i]!);
  }
  return { byteToChar, charToByte };
}

const TABLES = buildByteToUnicode();
export const BYTE_TO_CHAR: ReadonlyMap<number, string> = TABLES.byteToChar;
export const CHAR_TO_BYTE: ReadonlyMap<number, number> = TABLES.charToByte;

/**
 * Decode a byte-level BPE token string (e.g. `"Ġhello"`) to its raw bytes
 * by reversing the GPT-2 byte→unicode table. Characters outside the table
 * are emitted as their UTF-8 bytes (defensive — shouldn't happen for valid
 * vocab tokens but keeps the decoder total).
 */
export function decodeByteLevelToken(rawToken: string): Uint8Array {
  const out: number[] = [];
  for (const ch of rawToken) {
    const cp = ch.codePointAt(0)!;
    const b = CHAR_TO_BYTE.get(cp);
    if (b !== undefined) {
      out.push(b);
    } else {
      const utf8 = new TextEncoder().encode(ch);
      for (let i = 0; i < utf8.length; i++) out.push(utf8[i]!);
    }
  }
  return new Uint8Array(out);
}

/**
 * Encode raw bytes into a string of GPT-2 byte-encoded characters. Used by
 * the BPE tokenizer — input text is split into pieces, each piece is encoded
 * to UTF-8 bytes, then each byte is mapped through this table to produce a
 * string that matches the keys of the model's vocab.
 */
export function encodeByteLevelChars(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += BYTE_TO_CHAR.get(bytes[i]!)!;
  }
  return out;
}

/**
 * The metaspace marker — a single character used by SentencePiece-derived
 * tokenizers to denote a space prefix. Llama-2, Mistral-v3, Mixtral, Gemma
 * all use this convention.
 */
export const METASPACE = '▁'; // ▁
