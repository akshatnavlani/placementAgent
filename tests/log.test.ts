import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "../app/log.ts";

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = Fastify({ logger: { ...loggerOptions("info"), stream } });
  return { log: app.log, lines };
}

describe("logger redaction", () => {
  it("censors credentials at the top level and when nested", () => {
    const { log, lines } = captureLogger();
    log.info(
      {
        password: "pw-value",
        token: "token-value",
        login: { otp: "123456", studentID: "PES1UG00XX000" },
        call: { request: { authorization: "Bearer abc" } },
      },
      "login attempt",
    );

    const output = lines.join("");
    for (const value of ["pw-value", "token-value", "123456", "Bearer abc"]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain("[redacted]");
    expect(output).toContain("PES1UG00XX000");
  });
});
