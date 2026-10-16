export type DriveCallbackKind = "prepare" | "applied";

export function encodeCallback(kind: DriveCallbackKind, driveId: string): string {
  const prefix = kind === "prepare" ? "p" : "a";
  const data = `${prefix}:${driveId}`;
  if (data.length > 64) {
    throw new Error("callback_data exceeds Telegram 64-byte limit");
  }
  return data;
}

export function decodeCallback(data: string): { kind: DriveCallbackKind; driveId: string } | null {
  const match = /^(p|a):(.+)$/.exec(data);
  if (!match) {
    return null;
  }
  const kind = match[1] === "p" ? "prepare" : "applied";
  const driveId = match[2] ?? "";
  if (!driveId) {
    return null;
  }
  return { kind, driveId };
}

export function driveActionKeyboard(driveId: string): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Prepare", callback_data: encodeCallback("prepare", driveId) },
        { text: "I applied", callback_data: encodeCallback("applied", driveId) },
      ],
    ],
  };
}
