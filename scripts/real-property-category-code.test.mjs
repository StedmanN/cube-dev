import assert from "node:assert/strict";
import test from "node:test";

import {
  searchRealPropertyCategoryCodes,
  validateRealPropertyCategoryCode,
} from "../lib/real-property-category-code.ts";

const categories = Array.from({ length: 8 }, (_, index) => ({
  category_cd: `83${String(index).padStart(4, "0")}`,
  category_nm: index === 6 ? "Warehouse Annex" : `Category ${index}`,
  category_desc: `Facilities category ${index}`,
  space_type_id: "2",
  space_type: "Warehouse",
}));

test("category-code validation allows blank or a code present in the reference table only", () => {
  assert.equal(validateRealPropertyCategoryCode("", categories), null);
  assert.equal(validateRealPropertyCategoryCode(" 830000 ", categories), null);
  assert.match(validateRealPropertyCategoryCode("738421", categories), /not in the Category Codes table/);
});

test("category-code typeahead searches code, name, and description, capped at five suggestions", () => {
  assert.equal(searchRealPropertyCategoryCodes(categories, "83").length, 5);
  assert.equal(searchRealPropertyCategoryCodes(categories, "warehouse")[0].category_cd, "830006");
  assert.equal(searchRealPropertyCategoryCodes(categories, "Facilities category 7")[0].category_cd, "830007");
  assert.deepEqual(searchRealPropertyCategoryCodes(categories, ""), []);
});

test("unknown pasted category codes are rejected by upload validation with the source row", async () => {
  const uploadRoute = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/api/monthly-data/real-property/upload/route.ts", import.meta.url), "utf8"),
  );
  assert.match(uploadRoute, /validateRealPropertyCategoryCode\([\s\S]{0,100}categoryCode[\s\S]{0,100}categories/);
  assert.match(uploadRoute, /errors\.push\(`Row \$\{sourceRow\}: \$\{categoryCodeError\}`\)/);
});

test("Real Property editor presents a five-result category typeahead and blocks unknown values before confirmation", async () => {
  const client = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/monthly-data/monthly-data-client.tsx", import.meta.url), "utf8"),
  );
  assert.match(client, /role="combobox"/);
  assert.match(client, /searchRealPropertyCategoryCodes\(categoryCodes, categorySearchText\)/);
  assert.match(client, /validateRealPropertyCategoryCode\(categoryCode, categoryCodes\)/);
  assert.match(client, /Choose a Category Code from the suggestions/);
});

test("manual Real Property API validates category codes server-side", async () => {
  const manageRoute = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/api/monthly-data/real-property/manage/route.ts", import.meta.url), "utf8"),
  );
  assert.match(manageRoute, /validateRealPropertyCategoryCode\([\s\S]{0,80}editor\.CategoryCode[\s\S]{0,80}categories/);
  assert.match(manageRoute, /if \(categoryCodeError\) \{[\s\S]{0,140}badRequest\("Real Property validation failed\."/);
});
