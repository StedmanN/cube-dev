/** Download helpers for reporting tables. Does not fetch or recalculate billing. */
export type ExportCell = string | number;
export type ExportTable = {
  title: string;
  subtitle: string;
  headers: string[];
  rows: ExportCell[][];
  notes: string[];
  currencyColumns?: number[];
  pdfSummary?: {
    customerTotal: number;
    reportTotal: number;
    reconciliationDifference: number;
    unclassifiedCount: number;
    unclassifiedTotal: number;
    unclassifiedUtilities: string[];
    provisionalCount: number;
  };
  pdfColumnGroups?: Array<{ label: string; columns: number[] }>;
};

const encoder = new TextEncoder();
function xml(input: unknown): string {return String(input ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&apos;");}
function csvCell(value: ExportCell): string {
  let data = String(value);
  if (typeof value === "string" && /^\s*[=+@-]/.test(data)) data = `'${data}`; // spreadsheet formula injection
  return `"${data.replace(/"/g,'""')}"`;
}
export function exportCsv(table: ExportTable): Uint8Array {
  return encoder.encode("\uFEFF"+[table.title,table.subtitle,...table.notes].map(s=>csvCell(s)).join("\r\n")+"\r\n"+[table.headers,...table.rows].map(row=>row.map(csvCell).join(",")).join("\r\n"));
}
const u16 = (n:number)=>Uint8Array.of(n&255,(n>>>8)&255);
const u32 = (n:number)=>Uint8Array.of(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);
function combine(chunks:Uint8Array[]):Uint8Array {const out=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let pos=0;for(const c of chunks){out.set(c,pos);pos+=c.length;}return out;}
function crc32(data:Uint8Array):number {let n=0xffffffff;for(const b of data){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;}
function zip(parts:Array<{name:string;data:string}>):Uint8Array {
  const local:Uint8Array[]=[];const central:Uint8Array[]=[];let offset=0;
  for(const part of parts){
    const name=encoder.encode(part.name), data=encoder.encode(part.data), crc=crc32(data);
    const l=combine([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);
    local.push(l);
    central.push(combine([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));
    offset+=l.length;
  }
  const c=combine(central);return combine([...local,c,u32(0x06054b50),u16(0),u16(0),u16(parts.length),u16(parts.length),u32(c.length),u32(offset),u16(0)]);
}
function excelColumn(i:number):string {let name="";for(i++;i>0;i=Math.floor((i-1)/26))name=String.fromCharCode(65+(i-1)%26)+name;return name;}
/** OOXML workbook with real numeric money cells, exact text EEIC codes and frozen headers. */
export function exportXlsx(input: ExportTable): Uint8Array {
  const headers=input.headers;
  const currencyColumns=input.currencyColumns??[headers.length-1];
  const rows:Array<ExportCell[]>=[[input.title],[input.subtitle],["Reporting codes are candidates pending Finance approval."], ...input.notes.map(s=>[s]),[], headers, ...input.rows];
  const headerIndex=rows.length-input.rows.length;
  const body=rows.map((row,i)=>`<row r="${i+1}">${row.map((cell,j)=>{
    const addr=`${excelColumn(j)}${i+1}`;
    const safe=typeof cell==="string" && /^\s*[=+@-]/.test(cell) ? `'${cell}` : cell;
    return typeof safe==="number" && Number.isFinite(safe) ? `<c r="${addr}" s="${currencyColumns.includes(j)?1:0}"><v>${safe}</v></c>` : `<c r="${addr}" t="inlineStr"><is><t xml:space="preserve">${xml(safe)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const width=headers.map((header,j)=>`<col min="${j+1}" max="${j+1}" width="${Math.max(13,Math.min(42,header.length+9))}" customWidth="1"/>`).join("");
  const bottom=rows.length, last=excelColumn(headers.length-1);
  const sheet=`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerIndex}" topLeftCell="A${headerIndex+1}" state="frozen"/></sheetView></sheetViews><cols>${width}</cols><sheetData>${body}</sheetData><autoFilter ref="A${headerIndex}:${last}${bottom}"/></worksheet>`;
  const styles=`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="1"><font><sz val="10"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  return zip([
    {name:"[Content_Types].xml",data:`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`},
    {name:"_rels/.rels",data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:"xl/workbook.xml",data:`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="CUBE Report" sheetId="1" r:id="rId1"/></sheets></workbook>`},
    {name:"xl/_rels/workbook.xml.rels",data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:"xl/worksheets/sheet1.xml",data:sheet},{name:"xl/styles.xml",data:styles}
  ]);
}
const winAnsiBytes = new Map<string, number>([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84], ["…", 0x85],
  ["†", 0x86], ["‡", 0x87], ["ˆ", 0x88], ["‰", 0x89], ["Š", 0x8a],
  ["‹", 0x8b], ["Œ", 0x8c], ["Ž", 0x8e], ["‘", 0x91], ["’", 0x92],
  ["“", 0x93], ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
  ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b], ["œ", 0x9c],
  ["ž", 0x9e], ["Ÿ", 0x9f],
]);

function pdfText(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x3f;
    const byte = code <= 0xff ? code : winAnsiBytes.get(char);
    if (byte === undefined) {
      result += "?";
    } else if (byte > 0x7e) {
      result += `\\${byte.toString(8).padStart(3, "0")}`;
    } else if (char === "\\" || char === "(" || char === ")") {
      result += `\\${char}`;
    } else if (byte < 0x20) {
      result += `\\${byte.toString(8).padStart(3, "0")}`;
    } else {
      result += char;
    }
  }
  return result;
}

function wrapPdfText(value: unknown, maxCharacters: number): string[] {
  const input = String(value ?? "");
  const output: string[] = [];
  for (const paragraph of input.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (word.length > maxCharacters) {
        if (line) {
          output.push(line);
          line = "";
        }
        for (let offset = 0; offset < word.length; offset += maxCharacters) {
          output.push(word.slice(offset, offset + maxCharacters));
        }
        continue;
      }
      if (line && line.length + 1 + word.length > maxCharacters) {
        output.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) output.push(line);
    if (!paragraph && output.length === 0) output.push("");
  }
  return output.length ? output : [""];
}

function usd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Paginated landscape A2 PDF. Wraps every cell and carries long rows across continuation pages. */
export function exportPdf(input: ExportTable): Uint8Array {
  const currencyColumns=input.currencyColumns??[input.headers.length-1];
  type Segment = { cells: string[][]; startLine: number; lineCount: number; rowIndex: number };
  type Page = {
    segments: Segment[];
    issues: string[];
    label: string;
    headers: string[];
    widths: number[];
    xCoords: number[];
    headerLines: string[][];
    headerHeight: number;
  };
  const pageWidth = 1684;
  const pageHeight = 1191;
  const left = 30;
  const right = 30;
  const bottom = 54;
  const contentWidth = pageWidth - left - right;
  const fontSize = 6.4;
  const lineHeight = 8.4;
  const cellPadding = 5;
  const tableTop = pageHeight - 226;
  const bodyBottom = bottom + 9;
  const bodyHeight = tableTop - 28 - bodyBottom;
  const columnGroups = (input.pdfColumnGroups?.length ? input.pdfColumnGroups : [{
    label: "",
    columns: input.headers.map((_, index) => index),
  }]).filter(group => group.columns.length > 0);
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  const pages: Page[] = [];
  const charWidth = fontSize * 0.68;

  for (const group of columnGroups) {
    const headers = group.columns.map(column => input.headers[column]);
    const columnCount = headers.length;
    const minColumnWidth = Math.max(60, (contentWidth / columnCount) * 0.42);
    const desiredWidths = group.columns.map((sourceColumn, groupColumn) => {
      const maxLength = Math.max(
        headers[groupColumn].length,
        ...input.rows.slice(0, 100).map(row => String(row[sourceColumn] ?? "").length),
      );
      return Math.max(minColumnWidth, Math.min(300, maxLength * 3.5 + 16));
    });
    const extra = desiredWidths.map(width => Math.max(0, width - minColumnWidth));
    const extraTotal = extra.reduce((sum, width) => sum + width, 0);
    const remainingWidth = Math.max(0, contentWidth - minColumnWidth * columnCount);
    const widths = desiredWidths.map((_, index) =>
      minColumnWidth + (extraTotal ? extra[index] * remainingWidth / extraTotal : remainingWidth / columnCount),
    );
    const xCoords: number[] = [left];
    for (const width of widths) xCoords.push(xCoords[xCoords.length - 1] + width);
    const headerLines = headers.map((header, column) =>
      wrapPdfText(header, Math.max(8, Math.floor((widths[column] - cellPadding * 2) / charWidth))),
    );
    const headerHeight = Math.max(26, Math.max(...headerLines.map(lines => lines.length)) * lineHeight + 8);
    const maxSegmentLines = Math.max(1, Math.floor((bodyHeight - 8) / lineHeight));
    const segments: Segment[] = [];
    input.rows.forEach((row, rowIndex) => {
      const cells = group.columns.map((sourceColumn, groupColumn) => {
        const raw = row[sourceColumn];
        const formatted = currencyColumns.includes(sourceColumn) && typeof raw === "number" ? usd(raw) : String(raw ?? "");
        return wrapPdfText(formatted, Math.max(8, Math.floor((widths[groupColumn] - cellPadding * 2) / charWidth)));
      });
      const rowLineCount = Math.max(1, ...cells.map(lines => lines.length));
      for (let startLine = 0; startLine < rowLineCount; startLine += maxSegmentLines) {
        segments.push({ cells, startLine, lineCount: Math.min(maxSegmentLines, rowLineCount - startLine), rowIndex });
      }
    });

    const pageCapacity = tableTop - headerHeight - bodyBottom;
    let currentSegments: Segment[] = [];
    let usedHeight = 0;
    for (const segment of segments) {
      const segmentHeight = Math.max(17, segment.lineCount * lineHeight + 7);
      if (usedHeight + segmentHeight > pageCapacity && currentSegments.length) {
        pages.push({ segments: currentSegments, issues: [], label: group.label, headers, widths, xCoords, headerLines, headerHeight });
        currentSegments = [];
        usedHeight = 0;
      }
      currentSegments.push(segment);
      usedHeight += segmentHeight;
    }
    if (currentSegments.length || segments.length === 0) {
      pages.push({ segments: currentSegments, issues: [], label: group.label, headers, widths, xCoords, headerLines, headerHeight });
    }
  }

  const issueLines = input.notes
    .filter(note => /REVIEW:|unapproved|pending|disputed|unresolved/i.test(note))
    .flatMap(note => wrapPdfText(note, 205));
  const issuePageLineCapacity = Math.max(1, Math.floor((pageHeight - 230 - bottom) / 13));
  for (let offset = 0; offset < issueLines.length; offset += issuePageLineCapacity) {
    pages.push({ segments: [], issues: issueLines.slice(offset, offset + issuePageLineCapacity), label: "", headers: [], widths: [], xCoords: [], headerLines: [], headerHeight: 0 });
  }

  function drawText(
    message: unknown,
    x: number,
    y: number,
    size: number,
    bold = false,
    color: [number, number, number] = [0.12, 0.19, 0.29],
  ): string {
    return `${color.join(" ")} rg BT /F${bold ? 2 : 1} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(String(message))}) Tj ET`;
  }

  const summary = input.pdfSummary;
  const pageIds: number[] = [];
  let nextId = 5;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const pageId = nextId++;
    const streamId = nextId++;
    pageIds.push(pageId);
    const commands: string[] = [];
    commands.push("0.13 0.25 0.40 rg", `0 ${pageHeight - 94} ${pageWidth} 94 re f`);
    commands.push(drawText("72nd CE | CUBE - CUSTOMER BILLING REPORTING", left, pageHeight - 34, 12, true, [1, 1, 1]));
    commands.push(drawText(input.title, left, pageHeight - 63, 19, true, [1, 1, 1]));
    commands.push(drawText("PROVISIONAL CLASSIFICATIONS ARE NOT APPROVED ACCOUNTING VALUES", left, pageHeight - 115, 11, true, [0.72, 0.28, 0.08]));
    const subtitle = page.label ? `${input.subtitle} — ${page.label}` : input.subtitle;
    commands.push(drawText(subtitle, left, pageHeight - 136, 9));

    if (summary) {
      const metricY = pageHeight - 169;
      const metrics: Array<[string, string]> = [
        ["CUSTOMER BILLING TOTAL", usd(summary.customerTotal)],
        ["REPORT TOTAL", usd(summary.reportTotal)],
        ["RECONCILIATION DIFFERENCE", usd(summary.reconciliationDifference)],
      ];
      const metricWidth = contentWidth / metrics.length;
      metrics.forEach(([label, amount], metricIndex) => {
        const x = left + metricWidth * metricIndex;
        commands.push(drawText(label, x, metricY, 8, true));
        commands.push(drawText(amount, x, metricY - 16, 12, true));
      });
      const unresolvedUtilityText = summary.unclassifiedUtilities.length > 0 && summary.unclassifiedUtilities.every(utility => /produced\s*water|\bpw\b/i.test(utility))
        ? "produced-water"
        : "unresolved billed";
      const unresolvedSummary = summary.unclassifiedCount > 0
        ? `Unclassified — Review Required: ${summary.unclassifiedCount} ${unresolvedUtilityText} charge(s); aggregate ${usd(summary.unclassifiedTotal)}.`
        : "Unclassified — Review Required: no unresolved billed charges.";
      commands.push(drawText(unresolvedSummary, left, pageHeight - 211, 9, true, [0.55, 0.21, 0.08]));
      if (summary.provisionalCount > 0) {
        commands.push(drawText(`Provisional classifications in report: ${summary.provisionalCount}. Verify before official accounting use.`, left, pageHeight - 225, 8));
      }
    }

    if (page.issues.length > 0) {
      commands.push(drawText("ACCOUNTING / REPORTING REVIEW ITEMS", left, tableTop, 12, true));
      let y = tableTop - 22;
      for (const issue of page.issues) {
        commands.push(drawText(issue, left + 8, y, 8));
        y -= 13;
      }
    } else {
      const columnCount = page.headers.length;
      commands.push("0.16 0.31 0.47 rg", `${left} ${tableTop - page.headerHeight} ${contentWidth} ${page.headerHeight} re f`);
      for (let column = 0; column < columnCount; column++) {
        page.headerLines[column].forEach((line, lineIndex) => {
          commands.push(drawText(line, page.xCoords[column] + cellPadding, tableTop - 14 - lineIndex * lineHeight, 7.2, true, [1, 1, 1]));
        });
      }
      let y = tableTop - page.headerHeight;
      for (const segment of page.segments) {
        const rowHeight = Math.max(17, segment.lineCount * lineHeight + 7);
        if (segment.rowIndex % 2 === 0) commands.push(`0.95 0.97 0.99 rg ${left} ${y - rowHeight} ${contentWidth} ${rowHeight} re f`);
        for (let column = 0; column < columnCount; column++) {
          const lines = segment.cells[column].slice(segment.startLine, segment.startLine + segment.lineCount);
          lines.forEach((line, lineIndex) => {
            commands.push(drawText(line, page.xCoords[column] + cellPadding, y - 10 - lineIndex * lineHeight, fontSize));
          });
        }
        y -= rowHeight;
      }
    }

    commands.push("0.76 0.80 0.84 RG", `${left} 38 m ${pageWidth - right} 38 l S`);
    commands.push(drawText("Source: CUBE billing allocations and effective FINAL Form 3556", left, 23, 7.2));
    commands.push(drawText(`Page ${index + 1} of ${pages.length}`, pageWidth - right - 90, 23, 7.2));
    const content = commands.join("\n");
    objects[streamId] = `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`;
  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 1; index < objects.length; index++) {
    offsets[index] = encoder.encode(output).length;
    output += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(output).length;
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index++) output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return encoder.encode(output);
}
