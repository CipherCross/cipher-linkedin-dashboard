import type { ReadStream, WriteStream } from "node:tty";

import { OpsError } from "../core/errors.js";

export async function readSecretNoEcho(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  const ttyInput = input as ReadStream;
  const ttyOutput = output as WriteStream;
  if (!ttyInput.isTTY || !ttyOutput.isTTY || typeof ttyInput.setRawMode !== "function") {
    throw new OpsError(
      "secret_input_required",
      "Secret input requires an interactive terminal",
    );
  }

  ttyOutput.write(prompt);
  ttyInput.setEncoding("utf8");
  ttyInput.resume();
  ttyInput.setRawMode(true);

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      ttyInput.off("data", onData);
      ttyInput.setRawMode(false);
      ttyInput.pause();
      ttyOutput.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new OpsError("secret_input_required", "Secret input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          if (value.length === 0) {
            reject(new OpsError("secret_invalid", "Secret cannot be empty"));
          } else {
            resolve(value);
          }
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character !== "\u007f") value += character;
      }
    };
    ttyInput.on("data", onData);
  });
}
