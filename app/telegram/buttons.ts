export type DriveCallbackKind = "prepare" | "applied" | "skip";

export type ProfileCallbackAction = "redo" | "latex" | "github" | "ok";

export type CallbackDecoded =
  | { kind: DriveCallbackKind; driveId: string }
  | { kind: "approve" }
  | { kind: "profile"; action: ProfileCallbackAction }
  | { kind: "github"; action: "ok" | "no"; index: number }
  | { kind: "ask"; optionIndex: number }
  | { kind: "mail"; mailId: string; driveId: string };

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
  const profile = /^prof:(redo|latex|github|ok)$/.exec(data);
  if (profile) {
    return { kind: "profile", action: profile[1] as ProfileCallbackAction };
  }
  const github = /^g:(ok|no):(\d+)$/.exec(data);
  if (github) {
    return { kind: "github", action: github[1] as "ok" | "no", index: Number(github[2]) };
  }
  const ask = /^ask:(\d+)$/.exec(data);
  if (ask) {
    return { kind: "ask", optionIndex: Number(ask[1]) };
  }
  const mail = /^m:([^:]+):(.+)$/.exec(data);
  if (mail) {
    const mailId = mail[1] ?? "";
    const driveId = mail[2] ?? "";
    if (mailId && driveId) {
      return { kind: "mail", mailId, driveId };
    }
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

/** Dropdown options for prepare_ask (indices into field.options). */
export function askChoiceKeyboard(options: string[]): Record<string, unknown> {
  const rows = options.slice(0, 20).map((opt, i) => [
    {
      text: opt.slice(0, 40),
      callback_data: `ask:${i}`,
    },
  ]);
  return { inline_keyboard: rows };
}

/** Ambiguous mail → choose drive. Uses m:<mailId>:<driveId> (≤64 bytes for uuid+ObjectId). */
export function encodeMailCallback(mailId: string, driveId: string): string {
  const data = `m:${mailId}:${driveId}`;
  if (data.length > 64) {
    throw new Error("callback_data exceeds Telegram 64-byte limit");
  }
  return data;
}

export function chooseMailDriveKeyboard(
  mailId: string,
  drives: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  return {
    inline_keyboard: drives.slice(0, 8).map((drive) => [
      {
        text: drive.label.slice(0, 40),
        callback_data: encodeMailCallback(mailId, drive.id),
      },
    ]),
  };
}
