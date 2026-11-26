export type ImportCustomerRecord = Record<string, unknown>;

export type ImportCustomerResolution = {
  customer: ImportCustomerRecord | null;
  cubeCustomer: ImportCustomerRecord | null;
  nextGenCustomer: ImportCustomerRecord | null;
  error: string | null;
};

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function normalizeImportCustomerName(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, " ");
}

function customerId(customer: ImportCustomerRecord | null): string {
  return text(customer?.CustomerID);
}

function customerLabel(customer: ImportCustomerRecord): string {
  return text(customer.CustomerName) || text(customer.UMMName) || "Unnamed customer";
}

export function resolveRealPropertyImportCustomer(input: {
  cubeCustomerName: unknown;
  nextGenCustomerName: unknown;
  customerByAlias: ReadonlyMap<string, ImportCustomerRecord>;
}): ImportCustomerResolution {
  const cubeName = text(input.cubeCustomerName);
  const nextGenName = text(input.nextGenCustomerName);
  const cubeCustomer =
    input.customerByAlias.get(normalizeImportCustomerName(cubeName)) ?? null;
  const nextGenCustomer =
    input.customerByAlias.get(normalizeImportCustomerName(nextGenName)) ?? null;
  const cubeId = customerId(cubeCustomer);
  const nextGenId = customerId(nextGenCustomer);

  if (cubeCustomer && nextGenCustomer && cubeId !== nextGenId) {
    return {
      customer: null,
      cubeCustomer,
      nextGenCustomer,
      error:
        `Customer-name conflict: NextGen customer "${nextGenName}" resolves to ` +
        `${customerLabel(nextGenCustomer)} (${nextGenId || "missing CustomerID"}), while ` +
        `CUBE customer "${cubeName}" resolves to ${customerLabel(cubeCustomer)} ` +
        `(${cubeId || "missing CustomerID"}). Correct the source names before importing.`,
    };
  }

  return {
    customer: nextGenCustomer ?? cubeCustomer,
    cubeCustomer,
    nextGenCustomer,
    error: null,
  };
}
