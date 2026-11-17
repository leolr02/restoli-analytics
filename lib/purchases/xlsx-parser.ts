import { inflateRawSync } from "node:zlib";

export type XlsxPurchaseItem = {
  sourceRow: number;
  code: string;
  description: string;
  spreadsheetLine: string | null;
  quantity: number;
  discountPercent: number;
  unitPrice: number | null;
  importAmount: number;
};

export type XlsxPurchaseSummary = {
  subtotal: number | null;
  discount: number | null;
  financialDiscount: number | null;
  ieps: number | null;
  iva: number | null;
  total: number | null;
};

export type XlsxPurchaseDraft = {
  sourceSheet: string;
  sourceRows: number[];
  supplierName: string;
  purchaseDate: string;
  ticketNumber: string;
  items: XlsxPurchaseItem[];
  summary: XlsxPurchaseSummary;
  warnings: string[];
};

type ZipEntry = { name: string; data: Buffer };
type CellValue = string | number | null;
type WorksheetData = {
  name: string;
  rows: Map<number, Map<number, CellValue>>;
  styles: Map<number, Map<number, number>>;
  numberFormats: Map<number, string>;
  merged: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
};
type HeaderGroup = {
  row: number;
  quantity: number;
  code: number;
  description: number;
  line: number | null;
  discount: number;
  unitPrice: number | null;
  amount: number;
  left: number;
  right: number;
};

const MAX_ARCHIVE_ENTRIES = 4000;
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
const MAX_SHEETS = 80;
const MAX_ROWS_PER_SHEET = 20_000;

function fail(message: string): never {
  throw new Error(message);
}

function readZipEntries(archive: Buffer): Map<string, ZipEntry> {
  if (archive.length < 22) fail("El archivo no contiene un libro XLSX válido.");

  const searchStart = Math.max(0, archive.length - 65_557);
  let endRecord = -1;
  for (let offset = archive.length - 22; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) fail("No se encontró la estructura ZIP del archivo XLSX.");

  const diskNumber = archive.readUInt16LE(endRecord + 4);
  const directoryDisk = archive.readUInt16LE(endRecord + 6);
  const entriesOnDisk = archive.readUInt16LE(endRecord + 8);
  const entryCount = archive.readUInt16LE(endRecord + 10);
  const directorySize = archive.readUInt32LE(endRecord + 12);
  const directoryOffset = archive.readUInt32LE(endRecord + 16);
  if (
    diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff
  ) {
    fail("El archivo XLSX usa una variante ZIP que no está soportada.");
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES || directoryOffset + directorySize > archive.length) {
    fail("El archivo XLSX excede los límites de lectura permitidos.");
  }

  const decoder = new TextDecoder("utf-8");
  const entries = new Map<string, ZipEntry>();
  let expandedBytes = 0;
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      fail("El índice interno del archivo XLSX está dañado.");
    }

    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const expandedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > archive.length || localOffset + 30 > archive.length) {
      fail("El índice interno del archivo XLSX está incompleto.");
    }
    if ((flags & 1) !== 0 || (compression !== 0 && compression !== 8)) {
      fail("El archivo XLSX usa cifrado o compresión no compatible.");
    }
    if (expandedSize === 0xffffffff || compressedSize === 0xffffffff) {
      fail("El archivo XLSX excede el tamaño ZIP soportado.");
    }

    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    if (!name.endsWith("/")) {
      expandedBytes += expandedSize;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        fail("El contenido expandido del XLSX excede el límite de 40 MiB.");
      }

      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (dataEnd > archive.length) fail("El contenido ZIP del XLSX está incompleto.");
      const compressed = archive.subarray(dataOffset, dataEnd);
      let data: Buffer;
      try {
        data = compression === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES });
      } catch {
        fail("No se pudo descomprimir el archivo XLSX.");
      }
      if (data.length !== expandedSize) fail("El contenido expandido del XLSX no coincide con su índice.");
      entries.set(name.replaceAll("\\", "/"), { name, data });
    }
    offset = nextOffset;
  }

  if (!entries.has("xl/workbook.xml")) fail("El archivo no contiene un libro XLSX reconocible.");
  return entries;
}

function xmlDecode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributes(raw: string) {
  const result: Record<string, string> = {};
  const expression = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of raw.matchAll(expression)) {
    result[match[1]] = xmlDecode(match[2] ?? match[3] ?? "");
  }
  return result;
}

function xmlText(raw: string, tag: string) {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...raw.matchAll(expression)].map((match) => xmlDecode(match[1].replace(/<[^>]+>/g, ""))).join("");
}

function parseSharedStrings(entries: Map<string, ZipEntry>) {
  const entry = entries.get("xl/sharedStrings.xml");
  if (!entry) return [];
  const strings: string[] = [];
  for (const match of entry.data.toString("utf8").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    strings.push(xmlText(match[1], "t"));
  }
  return strings;
}

function columnNumber(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return 0;
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function parseCellValue(body: string, type: string | undefined, sharedStrings: string[]): CellValue {
  if (type === "inlineStr") return xmlText(body, "t");
  const raw = xmlText(body, "v");
  if (!raw) return null;
  if (type === "s") return sharedStrings[Number(raw)] ?? null;
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "str" || type === "e") return raw;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

function parseNumberFormats(entries: Map<string, ZipEntry>) {
  const formats = new Map<number, string>();
  const source = entries.get("xl/styles.xml")?.data.toString("utf8") ?? "";
  const customFormats = new Map<number, string>();
  const numFmts = source.match(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/)?.[1] ?? "";
  for (const match of numFmts.matchAll(/<numFmt\b([^>]*?)\/?\s*>/g)) {
    const attrs = attributes(match[1]);
    const id = Number(attrs.numFmtId);
    if (Number.isSafeInteger(id)) customFormats.set(id, attrs.formatCode ?? "");
  }
  const cellXfs = source.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  for (const [index, match] of [...cellXfs.matchAll(/<xf\b([^>]*?)\/?\s*>/g)].entries()) {
    const id = Number(attributes(match[1]).numFmtId ?? 0);
    formats.set(index, customFormats.get(id) ?? "");
  }
  return formats;
}

function parseWorksheet(name: string, source: string, sharedStrings: string[], numberFormats: Map<number, string>): WorksheetData {
  const rows = new Map<number, Map<number, CellValue>>();
  const styles = new Map<number, Map<number, number>>();
  for (const rowMatch of source.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attributes(rowMatch[1]).r);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS_PER_SHEET) continue;
    const values = new Map<number, CellValue>();
    const rowStyles = new Map<number, number>();
    const rowBody = rowMatch[2] ?? "";
    for (const cellMatch of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cellMatch[1]);
      const col = columnNumber(attrs.r ?? "");
      if (!col) continue;
      values.set(col, parseCellValue(cellMatch[2] ?? "", attrs.t, sharedStrings));
      if (attrs.s !== undefined) rowStyles.set(col, Number(attrs.s));
    }
    rows.set(rowNumber, values);
    styles.set(rowNumber, rowStyles);
  }

  const merged = [...source.matchAll(/<mergeCell\b([^>]*?)\/?\s*>/g)].flatMap((match) => {
    const ref = attributes(match[1]).ref;
    const cells = ref?.split(":");
    if (!cells || cells.length !== 2) return [];
    const parseRef = (cell: string) => {
      const row = Number(cell.match(/\d+/)?.[0]);
      const col = columnNumber(cell);
      return { row, col };
    };
    const start = parseRef(cells[0]);
    const end = parseRef(cells[1]);
    if (!start.row || !end.row || !start.col || !end.col) return [];
    return [{
      startRow: Math.min(start.row, end.row),
      startCol: Math.min(start.col, end.col),
      endRow: Math.max(start.row, end.row),
      endCol: Math.max(start.col, end.col),
    }];
  });

  for (const range of merged) {
    const topLeft = rows.get(range.startRow)?.get(range.startCol);
    if (topLeft === null || topLeft === undefined) continue;
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      if (row - range.startRow > 1000) break;
      const rowValues = rows.get(row) ?? new Map<number, CellValue>();
      for (let col = range.startCol; col <= range.endCol; col += 1) {
        if (col - range.startCol > 1000) break;
        if (!rowValues.has(col)) rowValues.set(col, topLeft);
      }
      rows.set(row, rowValues);
    }
  }

  return { name, rows, styles, numberFormats, merged };
}

function parseWorksheets(entries: Map<string, ZipEntry>, sharedStrings: string[]) {
  const workbook = entries.get("xl/workbook.xml")!.data.toString("utf8");
  const relationships = entries.get("xl/_rels/workbook.xml.rels")?.data.toString("utf8") ?? "";
  const relationTargets = new Map<string, string>();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.Id && attrs.Target) {
      const target = attrs.Target.startsWith("/")
        ? attrs.Target.slice(1)
        : `xl/${attrs.Target}`.replace(/\/\.\//g, "/");
      relationTargets.set(attrs.Id, target.replace(/\/[^/]+\/\.\.\//g, "/"));
    }
  }

  const sheets: WorksheetData[] = [];
  const numberFormats = parseNumberFormats(entries);
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)) {
    const attrs = attributes(match[1]);
    const target = relationTargets.get(attrs["r:id"] ?? "");
    if (!target) continue;
    const entry = entries.get(target);
    if (entry) sheets.push(parseWorksheet(attrs.name ?? `Hoja ${sheets.length + 1}`, entry.data.toString("utf8"), sharedStrings, numberFormats));
    if (sheets.length > MAX_SHEETS) fail("El libro contiene más de 80 hojas.");
  }
  if (sheets.length === 0) fail("El libro no contiene hojas de cálculo legibles.");
  return sheets;
}

function cellText(value: CellValue | undefined) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formattedCellText(sheet: WorksheetData, row: number, col: number) {
  const value = sheet.rows.get(row)?.get(col);
  if (typeof value !== "number") return cellText(value);
  const styleId = sheet.styles.get(row)?.get(col);
  const format = styleId === undefined ? "" : sheet.numberFormats.get(styleId)?.split(";")[0] ?? "";
  if (/^0{2,}$/.test(format)) return String(Math.trunc(value)).padStart(format.length, "0");
  return String(value);
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleUpperCase("es-MX")
    .replace(/[^A-Z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function numericValue(value: CellValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let raw = cellText(value).replace(/[$\s%]/g, "");
  if (!raw) return null;
  if (raw.includes(",") && raw.includes(".")) {
    const comma = raw.lastIndexOf(",");
    const dot = raw.lastIndexOf(".");
    raw = comma > dot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (raw.includes(",")) {
    const lastComma = raw.lastIndexOf(",");
    const decimals = raw.length - lastComma - 1;
    raw = decimals > 0 && decimals <= 2 ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentageValue(sheet: WorksheetData, row: number, col: number) {
  const value = sheet.rows.get(row)?.get(col);
  const parsed = numericValue(value);
  if (parsed === null) return null;
  const styleId = sheet.styles.get(row)?.get(col);
  const format = styleId === undefined ? "" : sheet.numberFormats.get(styleId) ?? "";
  return typeof value === "number" && format.includes("%") ? parsed * 100 : parsed;
}

function dateValue(value: CellValue | undefined): string | null {
  const text = cellText(value);
  const match = text.match(/(?:^|\D)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\D|$)/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  if (typeof value === "number" && value >= 1 && value < 100_000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  return null;
}

function headerLabel(value: string, kind: "quantity" | "code" | "description" | "line" | "discount" | "price" | "amount") {
  const normalized = normalizeText(value);
  switch (kind) {
    case "quantity": return normalized === "CANTIDAD" || normalized === "CANT";
    case "code": return normalized === "CLAVE" || normalized === "CODIGO" || normalized === "COD";
    case "description": return normalized === "DESCRIPCION" || normalized === "PRODUCTO";
    case "line": return normalized === "LINEA" || normalized === "DEPARTAMENTO";
    case "discount": return normalized === "DESC" || normalized === "% DESC" || normalized.includes("% DESC");
    case "price": return normalized === "P U" || normalized === "P U C" || normalized.includes("PRECIO UNITARIO") || normalized === "P UNITARIO";
    case "amount": return normalized === "IMPORTE" || normalized === "MONTO";
  }
}

function isMergedContinuation(sheet: WorksheetData, row: number, col: number) {
  return sheet.merged.some((range) =>
    row >= range.startRow && row <= range.endRow &&
    col >= range.startCol && col <= range.endCol &&
    (row !== range.startRow || col !== range.startCol),
  );
}

function findHeaderGroups(sheet: WorksheetData): HeaderGroup[] {
  const groups: HeaderGroup[] = [];
  const rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b);

  for (const rowNumber of rowNumbers) {
    const row = sheet.rows.get(rowNumber)!;
    const sorted = [...row.entries()]
      .filter(([col]) => !isMergedContinuation(sheet, rowNumber, col))
      .sort((a, b) => a[0] - b[0]);
    const quantities = sorted.filter(([, value]) => headerLabel(cellText(value), "quantity"));
    for (let quantityIndex = 0; quantityIndex < quantities.length; quantityIndex += 1) {
      const quantityCol = quantities[quantityIndex][0];
      const right = quantityIndex + 1 < quantities.length ? quantities[quantityIndex + 1][0] - 1 : Number.MAX_SAFE_INTEGER;
      const getNext = (kind: HeaderGroupKey, after: number) =>
        sorted.find(([col, value]) => col > after && col < right && headerLabel(cellText(value), kind))?.[0] ?? null;

      const code = getNext("code", quantityCol);
      const description = code === null ? null : getNext("description", code);
      const line = description === null ? null : getNext("line", description);
      const discount = (line === null ? null : getNext("discount", line)) ??
        (description === null ? null : getNext("discount", description));
      const price = discount === null ? null : getNext("price", discount);
      const amount = discount === null ? null : getNext("amount", price ?? discount);
      if (code === null || description === null || discount === null || amount === null) continue;
      groups.push({
        row: rowNumber,
        quantity: quantityCol,
        code,
        description,
        line,
        discount,
        unitPrice: price,
        amount,
        left: quantityCol,
        right,
      });
    }
  }
  return groups;
}

type HeaderGroupKey = "code" | "description" | "line" | "discount" | "price" | "amount";

function isLabel(value: string) {
  const normalized = normalizeText(value);
  return normalized === "FECHA" || normalized.startsWith("NOTA NO") || normalized.startsWith("NOTA NUM") ||
    normalized.startsWith("FOLIO") || normalized === "VENDEDOR" || normalized.startsWith("ENVIAR A") ||
    normalized.startsWith("VERACRUZ RFC") || normalized === "RFC";
}

function cellAt(sheet: WorksheetData, row: number, col: number) {
  return formattedCellText(sheet, row, col);
}

function labelValue(sheet: WorksheetData, rowNumber: number, group: HeaderGroup, kind: "date" | "ticket") {
  const row = sheet.rows.get(rowNumber);
  if (!row) return null;
  const candidates = [...row.entries()]
    .filter(([col]) => col >= group.left - 1 && col <= group.right)
    .sort((a, b) => Math.abs(a[0] - group.left) - Math.abs(b[0] - group.left));

  for (const [col, value] of candidates) {
    const text = formattedCellText(sheet, rowNumber, col);
    const normalized = normalizeText(text);
    const isLabelCell = kind === "date"
      ? normalized === "FECHA" || normalized.startsWith("FECHA ")
      : normalized.startsWith("NOTA NO") || normalized.startsWith("NOTA NUM") || normalized.startsWith("FOLIO");
    if (!isLabelCell) continue;

    if (kind === "date") {
      const parsedInline = dateValue(text.replace(/^.*?FECHA\s*:?\s*/i, ""));
      if (parsedInline) return parsedInline;
      for (let nextCol = col + 1; nextCol <= Math.min(col + 3, group.right); nextCol += 1) {
        const parsed = dateValue(row.get(nextCol));
        if (parsed) return parsed;
      }
    } else {
      const inline = text.match(/(?:NOTA\s*NO\.?|FOLIO)\s*:?\s*(.*)$/i)?.[1]?.trim();
      if (inline && inline !== ":") return inline.replace(/^[:#\s]+/, "").trim();
      for (let nextCol = col + 1; nextCol <= Math.min(col + 3, group.right + 1); nextCol += 1) {
      const candidate = cellAt(sheet, rowNumber, nextCol);
        if (candidate) return candidate.replace(/^[:#\s]+/, "").trim();
      }
    }
  }
  return null;
}

function findMetadata(sheet: WorksheetData, group: HeaderGroup, startRow: number) {
  const endRow = group.row - 1;
  let dateRow: number | null = null;
  let purchaseDate: string | null = null;
  let ticketNumber: string | null = null;

  for (let row = endRow; row >= Math.max(startRow, endRow - 35); row -= 1) {
    const parsedDate = labelValue(sheet, row, group, "date");
    if (!purchaseDate && parsedDate) {
      purchaseDate = parsedDate;
      dateRow = row;
    }
    const parsedTicket = labelValue(sheet, row, group, "ticket");
    if (!ticketNumber && parsedTicket) ticketNumber = parsedTicket;
  }

  const supplierEnd = dateRow ?? endRow;
  const supplierStart = Math.max(startRow, supplierEnd - 5);
  let supplierName = "";
  for (let row = supplierEnd; row >= supplierStart && !supplierName; row -= 1) {
    const values = [...(sheet.rows.get(row)?.entries() ?? [])]
      .filter(([col]) => col >= group.left && col <= group.right)
      .sort((a, b) => a[0] - b[0]);
    for (const [col, value] of values) {
      const text = formattedCellText(sheet, row, col);
      if (!text || isLabel(text) || dateValue(value)) continue;
      if (/^[\p{L}][\p{L}\p{M}\p{N}\s.,'&()-]{2,}$/u.test(text)) {
        supplierName = text;
        break;
      }
    }
  }

  return {
    supplierName,
    purchaseDate: purchaseDate ?? "",
    ticketNumber: ticketNumber ?? "",
  };
}

function amountForGroupRow(sheet: WorksheetData, rowNumber: number, group: HeaderGroup, labelCol: number) {
  const row = sheet.rows.get(rowNumber);
  if (!row) return null;
  const candidates = [...row.entries()]
    .filter(([col]) => col > labelCol && col <= Math.min(group.right + 1, labelCol + 4))
    .sort((a, b) => a[0] - b[0]);
  for (const [, value] of candidates) {
    const parsed = numericValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseSummary(sheet: WorksheetData, group: HeaderGroup, startRow: number, endRow: number): XlsxPurchaseSummary {
  const summary: XlsxPurchaseSummary = {
    subtotal: null,
    discount: null,
    financialDiscount: null,
    ieps: null,
    iva: null,
    total: null,
  };
  const labels: Array<[keyof XlsxPurchaseSummary, RegExp]> = [
    ["subtotal", /^SUBTOTAL$/],
    ["discount", /^DESCUENTO$/],
    ["financialDiscount", /^DESC FIN(?:ANCIERO)?$/],
    ["ieps", /^IEPS$/],
    ["iva", /^IVA$/],
    ["total", /^TOTAL$/],
  ];
  const candidateRows = [...sheet.rows.keys()].filter((row) => row >= startRow && row <= endRow).sort((a, b) => a - b);
  for (const rowNumber of candidateRows) {
    const row = sheet.rows.get(rowNumber)!;
    for (const [col, value] of row) {
      if (col < group.left || col > group.right) continue;
      const label = normalizeText(cellText(value));
      const compactLabel = label.replace(/\s+/g, "");
      if (label === "TOTAL") {
        const hasSummaryContext = candidateRows.some((nearby) =>
          Math.abs(nearby - rowNumber) <= 5 && [...(sheet.rows.get(nearby)?.entries() ?? [])]
            .some(([nearbyCol, nearbyValue]) => {
              if (nearbyCol < group.left || nearbyCol > group.right) return false;
              const nearbyLabel = normalizeText(cellText(nearbyValue));
              const compactNearbyLabel = nearbyLabel.replace(/\s+/g, "");
              return ["SUBTOTAL", "DESCUENTO", "DESC FIN", "DESC FINANCIERO"].includes(nearbyLabel) ||
                compactNearbyLabel === "IEPS" || compactNearbyLabel === "IVA";
            }),
        );
        if (!hasSummaryContext) continue;
      }
      const match = labels.find(([key, expression]) =>
        key === "ieps" ? compactLabel === "IEPS" : key === "iva" ? compactLabel === "IVA" : expression.test(label),
      );
      if (!match) continue;
      const amount = amountForGroupRow(sheet, rowNumber, group, col);
      if (amount !== null) summary[match[0]] = amount;
    }
  }
  return summary;
}

function itemsForGroup(sheet: WorksheetData, group: HeaderGroup, startRow: number, endRow: number): XlsxPurchaseItem[] {
  const result: XlsxPurchaseItem[] = [];
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = sheet.rows.get(rowNumber);
    if (!row) continue;
    const quantity = numericValue(row.get(group.quantity));
    const code = formattedCellText(sheet, rowNumber, group.code);
    const description = cellText(row.get(group.description));
    const importedAmount = numericValue(row.get(group.amount));
    if (!code || !description || quantity === null || quantity <= 0 || importedAmount === null) continue;
    if (normalizeText(code) === "CLAVE" || normalizeText(description).startsWith("TOTAL")) continue;

    const discountPercent = percentageValue(sheet, rowNumber, group.discount) ?? 0;
    const priceValue = group.unitPrice === null ? null : numericValue(row.get(group.unitPrice));
    result.push({
      sourceRow: rowNumber,
      code,
      description,
      spreadsheetLine: group.line === null ? null : cellText(row.get(group.line)) || null,
      quantity,
      discountPercent,
      unitPrice: priceValue,
      importAmount: importedAmount,
    });
  }
  return result;
}

function mergeSummary(target: XlsxPurchaseSummary, source: XlsxPurchaseSummary) {
  for (const key of Object.keys(target) as Array<keyof XlsxPurchaseSummary>) {
    if (source[key] !== null) target[key] = source[key];
  }
}

function stableKey(value: string) {
  return normalizeText(value);
}

export function parsePurchaseWorkbookXlsx(archive: Buffer): XlsxPurchaseDraft[] {
  const entries = readZipEntries(archive);
  const sharedStrings = parseSharedStrings(entries);
  const sheets = parseWorksheets(entries, sharedStrings);
  const purchases = new Map<string, XlsxPurchaseDraft>();

  for (const sheet of sheets) {
    const groups = findHeaderGroups(sheet);
    for (const [index, group] of groups.entries()) {
      const previousGroup = groups.slice(0, index).filter((candidate) =>
        candidate.row < group.row && candidate.left <= group.right && candidate.right >= group.left,
      ).at(-1);
      const nextGroup = groups.slice(index + 1).find((candidate) =>
        candidate.row > group.row && candidate.left <= group.right && candidate.right >= group.left,
      );
      const metadataStart = previousGroup?.row ?? 1;
      const metadata = findMetadata(sheet, group, metadataStart);
      const dataStart = group.row + 1;
      const dataEnd = Math.min(nextGroup ? nextGroup.row - 1 : MAX_ROWS_PER_SHEET, MAX_ROWS_PER_SHEET);
      const items = itemsForGroup(sheet, group, dataStart, dataEnd);
      if (items.length === 0 && !metadata.supplierName && !metadata.ticketNumber) continue;

      const hasPurchaseIdentity = Boolean(metadata.supplierName && metadata.purchaseDate && metadata.ticketNumber);
      const key = hasPurchaseIdentity
        ? [stableKey(metadata.supplierName), metadata.purchaseDate, stableKey(metadata.ticketNumber)].join("|")
        : `${sheet.name}|row:${group.row}`;
      const purchase = purchases.get(key) ?? {
        sourceSheet: sheet.name,
        sourceRows: [],
        supplierName: metadata.supplierName,
        purchaseDate: metadata.purchaseDate,
        ticketNumber: metadata.ticketNumber,
        items: [],
        summary: { subtotal: null, discount: null, financialDiscount: null, ieps: null, iva: null, total: null },
        warnings: [],
      };
      purchase.sourceRows.push(group.row, ...items.map((item) => item.sourceRow));
      purchase.items.push(...items);
      mergeSummary(purchase.summary, parseSummary(sheet, group, dataStart, dataEnd));
      if (!purchase.supplierName) purchase.supplierName = metadata.supplierName;
      if (!purchase.purchaseDate) purchase.purchaseDate = metadata.purchaseDate;
      if (!purchase.ticketNumber) purchase.ticketNumber = metadata.ticketNumber;
      if (!metadata.supplierName) purchase.warnings.push(`No se identificó el proveedor antes de la tabla en ${sheet.name}, fila ${group.row}.`);
      if (!metadata.purchaseDate) purchase.warnings.push(`No se identificó la fecha antes de la tabla en ${sheet.name}, fila ${group.row}.`);
      if (!metadata.ticketNumber) purchase.warnings.push(`No se identificó el folio antes de la tabla en ${sheet.name}, fila ${group.row}.`);
      purchases.set(key, purchase);
    }
  }

  const result = [...purchases.values()]
    .map((purchase) => ({
      ...purchase,
      sourceRows: [...new Set(purchase.sourceRows)].sort((a, b) => a - b),
      items: purchase.items.sort((a, b) => a.sourceRow - b.sourceRow),
      warnings: [...new Set(purchase.warnings)],
    }))
    .filter((purchase) => purchase.items.length > 0);
  if (result.length === 0) fail("No se encontraron compras con encabezados y productos reconocibles.");
  return result;
}
