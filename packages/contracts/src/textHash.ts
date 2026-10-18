const encoder = new TextEncoder();

/**
 * FNV-1a, 64 bits, over the UTF-8 bytes: a stable fingerprint for "is this the same
 * text", not a secret. The 64-bit product is kept in two 32-bit halves, because the
 * prime is 2^40 + 0x1b3 and BigInt per byte is far too slow for a whole patch.
 */
export const fnv1a64 = (text: string): string => {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of encoder.encode(text)) {
    lo = (lo ^ byte) >>> 0;
    const low = lo * 0x1b3;
    hi = (Math.imul(hi, 0x1b3) + (lo << 8) + Math.floor(low / 0x100000000)) >>> 0;
    lo = low >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
};
