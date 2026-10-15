import { createHash, timingSafeEqual } from "node:crypto";

const scheme = "Bearer ";

export function hasBearerSecret(authorization: string | undefined, secret: string): boolean {
  if (!authorization?.startsWith(scheme)) return false;
  // Hashing gives equal-length buffers, so the comparison is constant time and leaks no length.
  const given = createHash("sha256").update(authorization.slice(scheme.length)).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
