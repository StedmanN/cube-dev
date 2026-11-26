export type RealPropertyCategoryCodeOption = {
  category_cd: string;
  category_nm?: string;
  category_desc?: string;
  space_type_id?: string | number;
  space_type?: string;
};

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function validateRealPropertyCategoryCode(
  categoryCode: unknown,
  categories: unknown[],
): string | null {
  const code = text(categoryCode);
  if (!code || categories.some((value) => {
    if (!value || typeof value !== "object") return false;
    return text((value as Record<string, unknown>).category_cd) === code;
  })) {
    return null;
  }
  return `Category Code "${code}" is not in the Category Codes table. Add the approved code first or correct the Real Property record.`;
}

export function searchRealPropertyCategoryCodes(
  categories: RealPropertyCategoryCodeOption[],
  query: string,
  limit = 5,
): RealPropertyCategoryCodeOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || limit <= 0) return [];

  return categories
    .filter((category) => {
      const code = text(category.category_cd).toLowerCase();
      const name = text(category.category_nm).toLowerCase();
      const description = text(category.category_desc).toLowerCase();
      return (
        code.startsWith(normalizedQuery) ||
        name.includes(normalizedQuery) ||
        description.includes(normalizedQuery)
      );
    })
    .sort((a, b) => {
      const aCode = text(a.category_cd).toLowerCase();
      const bCode = text(b.category_cd).toLowerCase();
      const aPrefix = aCode.startsWith(normalizedQuery) ? 0 : 1;
      const bPrefix = bCode.startsWith(normalizedQuery) ? 0 : 1;
      return aPrefix - bPrefix || aCode.localeCompare(bCode);
    })
    .slice(0, limit);
}
