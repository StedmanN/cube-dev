const hash = (name, type) => ({ name, type, keyType: "HASH" });
const range = (name, type) => ({ name, type, keyType: "RANGE" });
const gsi = (indexName, name, type) => ({ indexName, key: hash(name, type) });

function table(TableName, primaryKey, secondaryIndexes = []) {
  const attributes = new Map();
  for (const key of primaryKey) attributes.set(key.name, key.type);
  for (const index of secondaryIndexes) attributes.set(index.key.name, index.key.type);

  return {
    TableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: Array.from(attributes, ([AttributeName, AttributeType]) => ({
      AttributeName,
      AttributeType,
    })),
    KeySchema: primaryKey.map(({ name: AttributeName, keyType: KeyType }) => ({
      AttributeName,
      KeyType,
    })),
    ...(secondaryIndexes.length > 0
      ? {
          GlobalSecondaryIndexes: secondaryIndexes.map(({ indexName: IndexName, key }) => ({
            IndexName,
            KeySchema: [{ AttributeName: key.name, KeyType: key.keyType }],
            Projection: { ProjectionType: "ALL" },
          })),
        }
      : {}),
  };
}

export const TABLE_DEFINITIONS = [
  table("p72-CUBE-CUSTOMERS", [hash("CustomerID", "S")]),
  table("p72-CUBE-FACILITIES", [hash("FacilityID", "S")]),
  table("p72-CUBE-METERS", [hash("meterid", "S")]),
  table("p72-CUBE-INV-READ-METHODS", [hash("inv_read_method_id", "N")]),
  table("p72-CUBE-METER-MAPPINGS", [
    hash("source_meterid", "S"),
    range("source_facility_nbr", "S"),
  ]),
  table("p72-CUBE-METER-CORRECTION-RULES", [hash("correction_rule_cd", "S")]),
  table("p72-CUBE-CATEGORY-CODES", [hash("category_cd", "S")]),
  table("p72-CUBE-SPACE-TYPES", [hash("space_type_id", "S")]),
  table("p72-CUBE-INTENSITY-VALUES", [hash("intensityid", "S")]),
  table(
    "p72-CUBE-METER-READINGS",
    [hash("meterid", "S"), range("billing_period_id", "N")],
    [
      gsi("billing-period-index", "billing_period_id", "N"),
      gsi("fy-index", "fy", "N"),
    ],
  ),
  table(
    "p72-CUBE-INVOICES",
    [hash("invoiceid", "S")],
    [
      gsi("billing-period-index", "billing_period_id", "N"),
      gsi("fy-index", "fy", "N"),
    ],
  ),
  table("p72-CUBE-RP-LEGACY", [hash("LegacyRPID", "S")]),
  table(
    "p72-CUBE-RP-MONTHLY",
    [hash("MonthlyRPID", "S")],
    [gsi("billing-period-index", "billing_period_id", "N")],
  ),
  table(
    "p72-CUBE-ESTIMATES",
    [hash("EstimateID", "S")],
    [gsi("billing-period-index", "billing_period_id", "N")],
  ),
  table(
    "p72-CUBE-RP-PROPQ",
    [hash("PropQID", "S")],
    [gsi("billing-period-index", "billing_period_id", "N")],
  ),
  table(
    "p72-CUBE-PLANT-UNIT",
    [hash("PlantUnitID", "S")],
    [gsi("billing-period-index", "billing_period_id", "N")],
  ),
  table("p72-CUBE-MONTHLY-RECONCILIATION", [
    hash("billing_period_id", "N"),
    range("ReconciliationID", "S"),
  ]),
  table("p72-CUBE-3556", [hash("PK", "S"), range("SK", "S")]),
  table("p72-CUBE-RCBL-SHORT", [hash("RCBLShortID", "S")]),
  table("p72-CUBE-RCBL-SHORT-HISTORY", [
    hash("billing_period_id", "N"),
    range("HistoryKey", "S"),
  ]),
];

export const TABLE_NAMES = TABLE_DEFINITIONS.map(({ TableName }) => TableName);
