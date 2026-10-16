export type DriveCallbackKind = "prepare" | "applied" | "skip";

export type CallbackDecoded =
  | { kind: DriveCallbackKind; driveId: string }
  | { kind: "approve" };

export function encodeCallback(kind: DriveCallbackKind, driveId: string): string {
  const prefix = kind === "prepare" ? "p" : kind === "applied" ? "a" : "s";
  const data = `${prefix}:${driveId}`;
  if (data.length > 64) {
    throw new Error("callback_data exceeds Telegram 64-byte limit");
  }
  return data;
}

export function decodeCallback(data: string): CallbackDecoded | null {
  if (data === "ok") {
    return { kind: "approve" };
  }
  const match = /^(p|a|s):(.+)$/.exec(data);
  if (!match) {
    return null;
  }
  const kind = match[1] === "p" ? "prepare" : match[1] === "a" ? "applied" : "skip";
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
      [{ text: "Skip", callback_data: encodeCallback("skip", driveId) }],
    ],
  };
}

export function approveKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [[{ text: "Approve", callback_data: "ok" }]],
  };
}

/** One I applied button per New drive (capped by caller). */
export function chooseDriveKeyboard(
  drives: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  return {
    inline_keyboard: drives.map((drive) => [
      {
        text: drive.label.slice(0, 40),
        callback_data: encodeCallback("applied", drive.id),
      },
    ]),
  };
}

/** One Skip button per New drive (capped by caller). */
export function chooseSkipDriveKeyboard(
  drives: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  return {
    inline_keyboard: drives.map((drive) => [
      {
        text: drive.label.slice(0, 40),
        callback_data: encodeCallback("skip", drive.id),
      },
    ]),
  };
}
