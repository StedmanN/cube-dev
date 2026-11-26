import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

if (!process.stdin.isTTY) {
  throw new Error("Run this from an interactive terminal.");
}

let hidden = false;

const output = new Writable({
  write(chunk, encoding, callback) {
    if (!hidden) process.stdout.write(chunk, encoding);
    callback();
  },
});

const terminal = createInterface({
  input: process.stdin,
  output,
  terminal: true,
});

terminal.on("SIGINT", () => {
  terminal.close();
  process.stdout.write("\n");
  process.exit(130);
});

async function askPassword(prompt) {
  process.stdout.write(prompt);
  hidden = true;

  try {
    return await terminal.question("");
  } finally {
    hidden = false;
    process.stdout.write("\n");
  }
}

try {
  const password = await askPassword("New password: ");
  const confirmation = await askPassword("Confirm password: ");

  if (password.length < 12) {
    throw new Error("Use at least 12 characters.");
  }

  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  const salt = randomBytes(16).toString("hex");

  const hash = scryptSync(password, salt, 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  }).toString("hex");

  console.log("\nPassword hash:");
  console.log(`scrypt$131072$8$1$${salt}$${hash}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  terminal.close();
}