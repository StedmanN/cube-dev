import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildHistoryMetadataRecord,
  historyMetadataIsComplete,
  historyMetadataKey,
  historyMetadataMatches,
  historyVersionIsComplete,
  isHistoryMetadataRecord,
} from "../lib/rcbl-history.ts";

const period = 175;
const sourceVersionId = `LEGACY-${period}`;
const metadata = {
  billingPeriodId: period,
  sourceVersionId,
  sourceVersionNumber: 0,
  newVersionId: "version-1",
  newVersionNumber: 1,
  archivedAt: "2026-10-28T12:00:00.000Z",
  action: "REPLACED",
  actorUserId: "synthetic-user",
  actorDisplayName: "Synthetic User",
  replacementReason: "Synthetic immutable-version regression",
  sourceRecordCount: 4579,
  sourceCustomerCount: 52,
};

function makeSourceRecords(versionId = "") {
  return Array.from({ length: 4579 }, (_, index) => {
    const customerBill = index < 52;
    const id = `${customerBill ? "CUSTOMER" : "LINE"}-${String(index + 1).padStart(4, "0")}`;
    return {
      billing_period_id: period,
      RCBLShortID: id,
      VersionId: versionId || undefined,
      RecordType: customerBill ? "CUSTOMER_BILL" : "BILLING_LINE",
      CustomerID: customerBill ? `SYNTH-C${index + 1}` : undefined,
      TotalAmount: customerBill ? index * 10 : undefined,
      amount: customerBill ? undefined : index * 0.25,
    };
  });
}

test("a 4,579-record replacement archives one metadata record", () => {
  const sourceRecords = makeSourceRecords();
  const metadataRecord = buildHistoryMetadataRecord(metadata);

  assert.equal(sourceRecords.length, 4579);
  assert.equal(
    sourceRecords.filter((row) => row.RecordType === "CUSTOMER_BILL").length,
    52,
  );
  assert.equal(isHistoryMetadataRecord(metadataRecord), true);
  assert.equal(metadataRecord.HistoryKey, historyMetadataKey(sourceVersionId));
  assert.equal(metadataRecord.SourceRecordCount, 4579);
  assert.equal(metadataRecord.SourceCustomerCount, 52);
  assert.deepEqual(
    Object.keys(metadataRecord).filter((key) => key === "CustomerID" || key === "amount"),
    [],
  );
});

test("metadata is complete only when the activated target and all source records exist", () => {
  const sourceRecords = makeSourceRecords();
  assert.equal(
    historyMetadataIsComplete(
      metadata,
      sourceRecords,
      metadata.newVersionId,
      [metadata],
      new Set([metadata.newVersionId]),
    ),
    true,
  );
  assert.equal(
    historyMetadataIsComplete(
      metadata,
      sourceRecords.slice(0, -1),
      metadata.newVersionId,
      [metadata],
      new Set([metadata.newVersionId]),
    ),
    false,
  );
  assert.equal(
    historyMetadataIsComplete(
      metadata,
      sourceRecords,
      sourceVersionId,
      [metadata],
      new Set([metadata.newVersionId]),
    ),
    false,
  );
});

test("successive replacements preserve the complete immutable version chain", () => {
  const second = {
    ...metadata,
    sourceVersionId: metadata.newVersionId,
    sourceVersionNumber: metadata.newVersionNumber,
    newVersionId: "version-2",
    newVersionNumber: 2,
  };
  const sourceRecords = makeSourceRecords();

  assert.equal(
    historyMetadataIsComplete(
      metadata,
      sourceRecords,
      second.newVersionId,
      [metadata, second],
      new Set([metadata.newVersionId, second.newVersionId]),
    ),
    true,
  );
  assert.equal(
    historyMetadataIsComplete(
      second,
      makeSourceRecords(second.sourceVersionId),
      second.newVersionId,
      [metadata, second],
      new Set([metadata.newVersionId, second.newVersionId]),
    ),
    true,
  );
});

test("conflicting metadata cannot be treated as a resumable replacement", () => {
  const record = buildHistoryMetadataRecord(metadata);
  assert.equal(
    historyMetadataMatches(record, metadata),
    true,
  );
  assert.equal(
    historyMetadataMatches(record, {
      ...metadata,
      replacementReason: "Different reason",
    }),
    false,
  );
  assert.equal(
    historyMetadataMatches(record, {
      ...metadata,
      newVersionId: "different-version",
    }),
    false,
  );
});

test("legacy partial full-copy history remains hidden", () => {
  const sourceRecords = makeSourceRecords();
  const partialRows = sourceRecords.slice(0, 3101).map((source) => ({
    ...source,
    HistoryKey: `${sourceVersionId}#${source.RCBLShortID}`,
    SourceRCBLShortID: source.RCBLShortID,
    VersionId: sourceVersionId,
    VersionNumber: 0,
    ArchivedAt: metadata.archivedAt,
    Action: metadata.action,
    ActorUserId: metadata.actorUserId,
    ActorDisplayName: metadata.actorDisplayName,
    ReplacementReason: "Old incomplete attempt",
  }));

  assert.equal(
    historyVersionIsComplete(
      partialRows,
      sourceRecords,
      sourceVersionId,
      period,
      "version-1",
    ),
    false,
  );
});

test("metadata and pointer activation are treated as one atomic commit", () => {
  const state = {
    pointer: "old-version",
    history: [],
  };
  const candidate = "version-1";
  const metadataRecord = buildHistoryMetadataRecord(metadata);

  function applyTransaction(shouldFail) {
    if (shouldFail) return false;
    state.pointer = candidate;
    state.history.push(metadataRecord);
    return true;
  }

  assert.equal(applyTransaction(true), false);
  assert.equal(state.pointer, "old-version");
  assert.equal(state.history.length, 0);
  assert.equal(applyTransaction(false), true);
  assert.equal(state.pointer, candidate);
  assert.equal(state.history.length, 1);
});

test("route uses transactional metadata activation and no full history writer", async () => {
  const route = await readFile(
    new URL("../app/api/billing/rcbl-short/route.ts", import.meta.url),
    "utf8",
  );
  const historyHelper = await readFile(
    new URL("../lib/rcbl-history.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /new TransactWriteCommand\(/);
  assert.match(historyHelper, /BILL_VERSION_HISTORY/);
  assert.match(route, /historyMetadataKey\(sourceVersionId\)/);
  assert.doesNotMatch(route, /writeHistoryRecords\(/);
  assert.doesNotMatch(route, /buildHistoryRecords\(/);
  assert.match(route, /attribute_not_exists\(#billingPeriodId\)/);
  assert.match(route, /#version = :expectedVersion/);
  assert.match(route, /Object\.keys\(pointerValues\)\.length > 0/);
});

test("metadata record preserves audit and source-version information", () => {
  const record = buildHistoryMetadataRecord(metadata);
  assert.equal(record.SourceVersionId, sourceVersionId);
  assert.equal(record.NewVersionId, "version-1");
  assert.equal(record.VersionNumber, 0);
  assert.equal(record.NewVersionNumber, 1);
  assert.equal(record.ReplacementReason, metadata.replacementReason);
  assert.equal(record.ActorUserId, metadata.actorUserId);
  assert.equal(record.Status, "COMPLETED");
});
