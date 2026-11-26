// Shared customer RCBL PDF renderer. Input is validated saved bill data, never an unsaved preview.
function pdfEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapPdfText(value: string, maxCharacters = 90): string[] {
  const words = value.split(/\s+/).filter(Boolean).flatMap((word) => {
    if (word.length <= maxCharacters) return [word];
    const chunks: string[] = [];
    for (let offset = 0; offset < word.length; offset += maxCharacters) {
      chunks.push(word.slice(offset, offset + maxCharacters));
    }
    return chunks;
  });
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

const PAGE_CONTENT_HEIGHT = 640;
const MAX_HEADER_VALUE_LINES_PER_PAGE = 42;

function headerLineHeight(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) return 8;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const value = trimmed.slice(colon + 1).trim();
    return Math.max(17, wrapPdfText(value, 80).length * 12);
  }
  return Math.max(17, wrapPdfText(trimmed).length * 14 + 3);
}

function splitLongHeaderLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [line];
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const label = trimmed.slice(0, colon).trim();
    const valueLines = wrapPdfText(trimmed.slice(colon + 1).trim(), 80);
    if (valueLines.length <= MAX_HEADER_VALUE_LINES_PER_PAGE) return [line];
    const chunks: string[] = [];
    for (let offset = 0; offset < valueLines.length; offset += MAX_HEADER_VALUE_LINES_PER_PAGE) {
      const continued = offset > 0 ? " (continued)" : "";
      chunks.push(
        `${label}${continued}: ${valueLines.slice(offset, offset + MAX_HEADER_VALUE_LINES_PER_PAGE).join(" ")}`,
      );
    }
    return chunks;
  }

  const wrappedLines = wrapPdfText(trimmed);
  if (wrappedLines.length <= MAX_HEADER_VALUE_LINES_PER_PAGE) return [line];
  const chunks: string[] = [];
  for (let offset = 0; offset < wrappedLines.length; offset += MAX_HEADER_VALUE_LINES_PER_PAGE) {
    chunks.push(wrappedLines.slice(offset, offset + MAX_HEADER_VALUE_LINES_PER_PAGE).join(" "));
  }
  return chunks;
}

function splitIntoHeaderPages(headerLines: string[]): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let currentHeight = 0;
  for (const line of headerLines.flatMap(splitLongHeaderLine)) {
    const height = headerLineHeight(line);
    if (current.length > 0 && currentHeight + height > PAGE_CONTENT_HEIGHT) {
      pages.push(current);
      current = [];
      currentHeight = 0;
    }
    current.push(line);
    currentHeight += height;
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  return pages;
}

function billingSectionHeight(billingLines: string[]): number {
  const rowCount = billingLines.filter((line) =>
    line.trim().includes("|") && !line.trim().startsWith("TOTAL BILL:"),
  ).length;
  const hasTotal = billingLines.some((line) => line.trim().startsWith("TOTAL BILL:"));
  return 46 + rowCount * 18 + (hasTotal ? 23 : 0);
}

function continuationIdentity(headerLines: string[]): string[] {
  return headerLines.filter((line) =>
    /^(Customer ID|Billing Period|Billing Month):/.test(line.trim()),
  );
}

function paginateCustomerPdfLines(lines: string[]): string[][] {
  const billingIndex = lines.findIndex((line) => line === "BILLING");
  if (billingIndex < 0) return splitIntoHeaderPages(lines);

  const headerLines = lines.slice(0, billingIndex);
  const billingLines = lines.slice(billingIndex + 1);
  const headerPages = splitIntoHeaderPages(headerLines);
  const headerHeight = headerPages.at(-1)!.reduce(
    (sum, line) => sum + headerLineHeight(line),
    0,
  );
  const tableHeight = billingSectionHeight(billingLines);

  if (headerPages.length === 1 && headerHeight + tableHeight <= PAGE_CONTENT_HEIGHT) {
    return [[...headerPages[0], "BILLING", ...billingLines]];
  }

  const identity = continuationIdentity(headerLines);
  const identityHeight = identity.reduce((sum, line) => sum + headerLineHeight(line), 0);
  const rowLines = billingLines.filter((line) =>
    line.trim().includes("|") && !line.trim().startsWith("TOTAL BILL:"),
  );
  const totalLine = billingLines.find((line) => line.trim().startsWith("TOTAL BILL:"));
  const maxRows = Math.max(
    1,
    Math.floor((PAGE_CONTENT_HEIGHT - identityHeight - 46 - (totalLine ? 23 : 0)) / 18),
  );

  const continuationPages: string[][] = [];
  for (let offset = 0; offset < rowLines.length; offset += maxRows) {
    const pageRows = rowLines.slice(offset, offset + maxRows);
    const isLast = offset + maxRows >= rowLines.length;
    continuationPages.push([
      ...identity,
      "BILLING",
      ...pageRows,
      ...(isLast && totalLine ? [totalLine] : []),
    ]);
  }
  if (rowLines.length === 0) {
    continuationPages.push([
      ...identity,
      "BILLING",
      ...(totalLine ? [totalLine] : []),
    ]);
  }

  return [...headerPages, ...continuationPages];
}

export function buildSimpleCustomerPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const fontId = 3;
  const boldFontId = 4;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let nextId = 5;

  for (const lines of pages.flatMap(paginateCustomerPdfLines)) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageObjectIds.push(pageId);

    const commands: string[] = [
      // Page/header frame.
      "0 0 0.55 RG",
      "1 w",
      "14 710 584 58 re S",
      "0.08 0.18 0.45 rg",
      "14 710 150 58 re f",

      // Left branding.
      "BT",
      "/F2 14 Tf",
      "1 1 1 rg",
      "20 744 Td",
      "(U.S. AIR FORCE) Tj",
      "0 -18 Td",
      "/F1 7 Tf",
      "(REIMBURSABLE CUSTOMER BILLING) Tj",
      "ET",

      // Centered title.
      "BT",
      "/F2 16 Tf",
      "0 0 0.55 rg",
      "238 744 Td",
      "(Reimbursable Customer Billing Letter) Tj",
      "ET",
    ];

    // Split source lines into customer/header fields and billing table.
    const billingIndex = lines.findIndex((line) => line === "BILLING");
    const headerLines = billingIndex >= 0 ? lines.slice(0, billingIndex) : lines;
    const billingLines = billingIndex >= 0 ? lines.slice(billingIndex + 1) : [];

    // Customer/header information with consistent label/value alignment.
    let y = 688;
    const labelX = 28;
    const valueX = 190;

    for (const line of headerLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        y -= 8;
        continue;
      }

      const colon = trimmed.indexOf(":");
      let rowHeight = 17;
      if (colon > 0) {
        const label = trimmed.slice(0, colon + 1).trim();
        const value = trimmed.slice(colon + 1).trim();
        const valueLines = wrapPdfText(value, 80);

        commands.push(
          "BT",
          "/F2 9 Tf",
          "0 0 0 rg",
          `${labelX} ${y} Td`,
          `(${pdfEscape(label)}) Tj`,
          "ET",
        );
        valueLines.forEach((valueLine, index) => {
          commands.push(
            "BT",
            "/F1 9 Tf",
            "0 0 0 rg",
            `${valueX} ${y - index * 12} Td`,
            `(${pdfEscape(valueLine)}) Tj`,
            "ET",
          );
        });
        rowHeight = Math.max(rowHeight, valueLines.length * 12);
      } else {
        for (const wrappedLine of wrapPdfText(trimmed)) {
          commands.push(
            "BT",
            "/F2 10 Tf",
            "0 0 0.35 rg",
            `${labelX} ${y} Td`,
            `(${pdfEscape(wrappedLine)}) Tj`,
            "ET",
          );
          y -= 14;
        }
        y += 14;
      }

      y -= rowHeight;
    }

    if (billingIndex >= 0) {
    // Billing section.
    y -= 10;
    commands.push(
      "BT",
      "/F2 10 Tf",
      "0 0 0.35 rg",
      `28 ${y} Td`,
      "(Billing:) Tj",
      "ET",
    );
    y -= 18;

    // Table header background.
    commands.push(
      "0.36 0.60 0.86 rg",
      `28 ${y - 3} 556 18 re f`,
      "0 0 0 rg",
    );

    const columns = [
      { x: 32, title: "Utility" },
      { x: 235, title: "Consumption" },
      { x: 340, title: "Unit" },
      { x: 405, title: "Rate / Share" },
      { x: 495, title: "Reimb. Exp." },
    ];

    for (const col of columns) {
      commands.push(
        "BT",
        "/F2 8 Tf",
        "0 0 0 rg",
        `${col.x} ${y + 2} Td`,
        `(${pdfEscape(col.title)}) Tj`,
        "ET",
      );
    }

    y -= 18;

    // Render clean billing rows into the five-column table.
    let rowIndex = 0;

    for (const line of billingLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("TOTAL BILL:")) {
        y -= 5;
        commands.push(
          "0 0 0 RG",
          "0.8 w",
          `405 ${y + 12} 179 0 re S`,
          "BT",
          "/F2 9 Tf",
          "0 0 0 rg",
          `405 ${y} Td`,
          "(Total:) Tj",
          "ET",
          "BT",
          "/F2 9 Tf",
          "0 0 0 rg",
          `510 ${y} Td`,
          `(${pdfEscape(trimmed.replace("TOTAL BILL:", "").trim())}) Tj`,
          "ET",
        );
        y -= 18;
        continue;
      }

      const parts = trimmed.split("|").map((part) => part.trim());
      if (parts.length < 5) continue;

      // Alternate row shading for readability.
      if (rowIndex % 2 === 1) {
        commands.push(
          "0.94 0.94 0.94 rg",
          `28 ${y - 5} 556 17 re f`,
        );
      }

      const values = [
        { x: 32, value: parts[0] },
        { x: 235, value: parts[1] },
        { x: 340, value: parts[2] },
        { x: 405, value: parts[3] },
        { x: 495, value: parts[4] },
      ];

      for (const cell of values) {
        commands.push(
          "BT",
          "/F1 8 Tf",
          "0 0 0 rg",
          `${cell.x} ${y} Td`,
          `(${pdfEscape(cell.value)}) Tj`,
          "ET",
        );
      }

      y -= 18;
      rowIndex += 1;
    }
    }

    const stream = commands.join("\n");
    objects[contentId] =
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`;

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
  }

  objects[2] =
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = new TextEncoder().encode(pdf).length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;

  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }

  pdf +=
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}
