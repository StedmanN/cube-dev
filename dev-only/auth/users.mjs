import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);

export async function verifyDevCredentials(username, password) {
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.length > 100 ||
    password.length > 1024
  ) {
    return null;
  }

  let config;

  try {
    const file = resolve(process.cwd(), ".dev-auth", "users.json");
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Unable to read the dev user configuration.");
  }

  if (!Array.isArray(config.users)) {
    throw new Error("The dev user configuration needs a users array.");
  }

  const matches = config.users.filter(
    (user) =>
      typeof user?.username === "string" &&
      user.username.trim().toLowerCase() ===
        username.trim().toLowerCase(),
  );

  if (matches.length > 1) {
    throw new Error("Duplicate usernames in the dev user configuration.");
  }

  const user = matches[0];

  const parts =
    typeof user?.passwordHash === "string"
      ? user.passwordHash.match(
          /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/,
        )
      : null;

  // Perform the same expensive check for unknown or disabled accounts.
  const eligible = Boolean(user?.enabled === true && parts);
  const salt = eligible ? parts[1] : "0".repeat(32);
  const expected = Buffer.from(
    eligible ? parts[2] : "0".repeat(128),
    "hex",
  );

  const actual = await deriveKey(password, salt, 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });

  if (!timingSafeEqual(actual, expected) || !eligible) {
    return null;
  }

  return {
    username: user.username.trim(),
    name: String(user.name || user.username),
  };
}