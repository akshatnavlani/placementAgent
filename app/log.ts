const sensitiveKeys = [
  "password",
  "token",
  "bearerToken",
  "bearer_token",
  "otp",
  "code",
  "secret",
  "authorization",
  "apiKey",
  "serviceRoleKey",
  "refreshToken",
  "refresh_token",
  "access_token",
  "client_secret",
  "callbackSecret",
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
