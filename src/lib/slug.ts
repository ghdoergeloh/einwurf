const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 22 Zeichen aus 62 → etwa 131 Bit Zufall; nicht zu erraten. */
export function generateSlug(length = 22): string {
  const out: string[] = [];
  const buf = new Uint8Array(64);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 248 = 4 * 62: Werte darüber verwerfen, damit jedes Zeichen gleich wahrscheinlich ist.
      if (b < 248) out.push(ALPHABET[b % 62]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}
