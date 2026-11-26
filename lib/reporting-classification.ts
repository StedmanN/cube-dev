import { createHash } from "node:crypto";
import type { Final3556 } from "./3556-reporting";

export const mappingPK = (id: string) => `3556_REPORTING_MAP#${id}`;
export function fingerprint3556(record: Final3556): string {
  return createHash("sha256").update(JSON.stringify({ id: record.id, effectiveDate: record.effectiveDate, worksheet: record.worksheet })).digest("hex");
}
