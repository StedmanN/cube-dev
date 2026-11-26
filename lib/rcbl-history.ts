export const HISTORY_METADATA_RECORD_TYPE = "BILL_VERSION_HISTORY";

export type RcblHistoryItem = Record<string, any>;

export type HistoryArchiveMetadata = {
  billingPeriodId: number;
  sourceVersionId: string;
  sourceVersionNumber: number;
  newVersionId: string;
  newVersionNumber: number;
  archivedAt: string;
  action: string;
  actorUserId: string;
  actorDisplayName: string;
  replacementReason: string;
  sourceRecordCount: number;
  sourceCustomerCount: number;
};

export class HistoryArchiveConsistencyError extends Error {
  readonly code = "RCBL_HISTORY_ARCHIVE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "HistoryArchiveConsistencyError";
  }
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeKeyPart(value: unknown): string {
  return text(value).replace(/[^A-Za-z0-9_.-]/g, "_") || "UNKNOWN";
}

export function historyMetadataKey(sourceVersionId: string): string {
  return `VERSION#${safeKeyPart(sourceVersionId)}`;
}

export function buildHistoryMetadataRecord(
  metadata: HistoryArchiveMetadata,
): RcblHistoryItem {
  return {
    billing_period_id: metadata.billingPeriodId,
    HistoryKey: historyMetadataKey(metadata.sourceVersionId),
    RecordType: HISTORY_METADATA_RECORD_TYPE,
    VersionId: metadata.sourceVersionId,
    SourceVersionId: metadata.sourceVersionId,
    SourceVersionNumber: metadata.sourceVersionNumber,
    VersionNumber: metadata.sourceVersionNumber,
    NewVersionId: metadata.newVersionId,
    NewVersionNumber: metadata.newVersionNumber,
    Status: "COMPLETED",
    ArchivedAt: metadata.archivedAt,
    ActionAt: metadata.archivedAt,
    Action: metadata.action,
    ActorUserId: metadata.actorUserId,
    ActorDisplayName: metadata.actorDisplayName,
    ReplacementReason: metadata.replacementReason,
    SourceRecordCount: metadata.sourceRecordCount,
    SourceCustomerCount: metadata.sourceCustomerCount,
  };
}

export function isHistoryMetadataRecord(row: RcblHistoryItem): boolean {
  return text(row.RecordType) === HISTORY_METADATA_RECORD_TYPE;
}

export function historyMetadataFromRecord(
  row: RcblHistoryItem,
): HistoryArchiveMetadata | null {
  if (!isHistoryMetadataRecord(row)) return null;

  const sourceVersionId = text(row.SourceVersionId || row.VersionId);
  const newVersionId = text(row.NewVersionId);
  if (!sourceVersionId || !newVersionId) return null;

  return {
    billingPeriodId: numberValue(row.billing_period_id),
    sourceVersionId,
    sourceVersionNumber: numberValue(
      row.SourceVersionNumber ?? row.VersionNumber,
    ),
    newVersionId,
    newVersionNumber: numberValue(row.NewVersionNumber),
    archivedAt: text(row.ArchivedAt ?? row.ActionAt),
    action: text(row.Action),
    actorUserId: text(row.ActorUserId),
    actorDisplayName: text(row.ActorDisplayName),
    replacementReason: text(row.ReplacementReason),
    sourceRecordCount: numberValue(row.SourceRecordCount),
    sourceCustomerCount: numberValue(row.SourceCustomerCount),
  };
}

export function historyMetadataMatches(
  row: RcblHistoryItem,
  expected: HistoryArchiveMetadata,
): boolean {
  const actual = historyMetadataFromRecord(row);
  if (!actual) return false;

  return (
    actual.billingPeriodId === expected.billingPeriodId &&
    actual.sourceVersionId === expected.sourceVersionId &&
    actual.sourceVersionNumber === expected.sourceVersionNumber &&
    actual.newVersionId === expected.newVersionId &&
    actual.newVersionNumber === expected.newVersionNumber &&
    actual.archivedAt === expected.archivedAt &&
    actual.action === expected.action &&
    actual.actorUserId === expected.actorUserId &&
    actual.actorDisplayName === expected.actorDisplayName &&
    actual.replacementReason === expected.replacementReason &&
    actual.sourceRecordCount === expected.sourceRecordCount &&
    actual.sourceCustomerCount === expected.sourceCustomerCount &&
    text(row.Status) === "COMPLETED"
  );
}

export function historyMetadataIsComplete(
  metadata: HistoryArchiveMetadata,
  sourceRecords: RcblHistoryItem[],
  activeVersionId: string,
  allMetadata: HistoryArchiveMetadata[],
  availableVersionIds: Set<string>,
): boolean {
  if (
    !metadata.archivedAt ||
    !metadata.action ||
    !metadata.newVersionId ||
    metadata.sourceRecordCount !== sourceRecords.length ||
    metadata.sourceCustomerCount !==
      sourceRecords.filter((row) => text(row.RecordType) === "CUSTOMER_BILL")
        .length ||
    activeVersionId === metadata.sourceVersionId ||
    !availableVersionIds.has(metadata.newVersionId)
  ) {
    return false;
  }

  const nextBySource = new Map(
    allMetadata.map((entry) => [entry.sourceVersionId, entry]),
  );
  const visited = new Set<string>();
  let versionId = metadata.newVersionId;

  while (versionId !== activeVersionId) {
    if (visited.has(versionId)) return false;
    visited.add(versionId);
    const next = nextBySource.get(versionId);
    if (!next) return false;
    versionId = next.newVersionId;
  }

  return true;
}

const ARCHIVE_FIELDS = new Set([
  "HistoryKey",
  "SourceRCBLShortID",
  "VersionId",
  "VersionNumber",
  "ArchivedAt",
  "ActionAt",
  "Action",
  "ActorUserId",
  "ActorDisplayName",
  "ReplacementReason",
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function originalRecordBody(record: RcblHistoryItem): string {
  const original = Object.fromEntries(
    Object.entries(record).filter(([key]) => !ARCHIVE_FIELDS.has(key)),
  );
  return JSON.stringify(canonical(original));
}

function auditMetadata(record: RcblHistoryItem) {
  return {
    versionId: text(record.VersionId),
    versionNumber: numberValue(record.VersionNumber),
    archivedAt: text(record.ArchivedAt),
    action: text(record.Action),
    actorUserId: text(record.ActorUserId),
    actorDisplayName: text(record.ActorDisplayName),
    replacementReason: text(record.ReplacementReason),
  };
}

export function historyRecordsMatch(
  existing: RcblHistoryItem,
  expected: RcblHistoryItem,
): boolean {
  return (
    text(existing.billing_period_id) === text(expected.billing_period_id) &&
    text(existing.HistoryKey) === text(expected.HistoryKey) &&
    text(existing.SourceRCBLShortID) === text(expected.SourceRCBLShortID) &&
    originalRecordBody(existing) === originalRecordBody(expected) &&
    JSON.stringify(auditMetadata(existing)) ===
      JSON.stringify(auditMetadata(expected))
  );
}

/**
 * Compatibility check for history rows written by the former full-copy
 * workflow. New replacements use metadata records and immutable source rows
 * instead of entering this path.
 */
export function historyVersionIsComplete(
  historyRows: RcblHistoryItem[],
  sourceRecords: RcblHistoryItem[],
  sourceVersionId: string,
  billingPeriodId: number,
  activeVersionId?: string,
): boolean {
  if (
    historyRows.length === 0 ||
    sourceRecords.length === 0 ||
    !activeVersionId ||
    activeVersionId === sourceVersionId
  ) {
    return false;
  }

  const sourceById = new Map(
    sourceRecords.map((record) => [text(record.RCBLShortID), record]),
  );
  const seenSourceIds = new Set<string>();
  const first = historyRows[0];

  for (const row of historyRows) {
    if (
      text(row.VersionId) !== sourceVersionId ||
      text(row.billing_period_id) !== text(billingPeriodId) ||
      JSON.stringify(auditMetadata(row)) !== JSON.stringify(auditMetadata(first))
    ) {
      return false;
    }

    const sourceId = text(row.SourceRCBLShortID);
    const source = sourceById.get(sourceId);
    if (!source || seenSourceIds.has(sourceId)) return false;
    seenSourceIds.add(sourceId);

    if (
      !historyRecordsMatch(row, {
        ...source,
        billing_period_id: billingPeriodId,
        HistoryKey: row.HistoryKey,
        SourceRCBLShortID: sourceId,
        VersionId: sourceVersionId,
        VersionNumber: row.VersionNumber,
        ArchivedAt: row.ArchivedAt,
        Action: row.Action,
        ActorUserId: row.ActorUserId,
        ActorDisplayName: row.ActorDisplayName,
        ReplacementReason: row.ReplacementReason,
      })
    ) {
      return false;
    }
  }

  return seenSourceIds.size === sourceById.size;
}
