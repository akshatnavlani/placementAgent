const sensitiveKeys = [
  "password",
  "token",
  "bearerToken",
  "otp",
  "secret",
  "authorization",
  "apiKey",
  "serviceRoleKey",
  "refreshToken",
];

export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-telegram-bot-api-secret-token"]',
  ...sensitiveKeys,
  ...sensitiveKeys.map((key) => `*.${key}`),
  ...sensitiveKeys.map((key) => `*.*.${key}`),
];

export function loggerOptions(level: string) {
  return { level, redact: { paths: redactPaths, censor: "[redacted]" } };
}
