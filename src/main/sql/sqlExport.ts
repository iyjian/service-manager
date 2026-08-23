import { app, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { stringify } from 'csv/sync';
import * as XLSX from 'xlsx';
import type { SqlExportInput, SqlExportResult } from '../../shared/types';

const EXCEL_HEADER_FILL = 'FF000066';
const EXCEL_HEADER_TEXT = 'FFFFFFFF';
const EXCEL_MIN_COLUMN_WIDTH = 10;
const EXCEL_MAX_COLUMN_WIDTH = 80;
const EXCEL_COLUMN_PADDING = 3;

const EXPORT_MAX_ROWS = 1_000_000;
const EXPORT_MAX_COLUMNS = 10_000;
const EXPORT_MAX_NAME_LENGTH = 200;

/** Parses and validates an untrusted IPC payload into a safe export request. */
export function parseSqlExportInput(value: unknown): SqlExportInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The SQL export request is invalid.');
  }
  const input = value as Record<string, unknown>;
  if (input.format !== 'excel' && input.format !== 'csv') {
    throw new Error('The SQL export request is invalid.');
  }
  if (
    !Array.isArray(input.columns)
    || input.columns.length > EXPORT_MAX_COLUMNS
    || input.columns.some((column) => typeof column !== 'string')
  ) {
    throw new Error('The SQL export request is invalid.');
  }
  if (
    !Array.isArray(input.rows)
    || input.rows.length > EXPORT_MAX_ROWS
    || input.rows.some((row) => (
      !Array.isArray(row)
      || row.length > EXPORT_MAX_COLUMNS
      || row.some((cell) => typeof cell !== 'string')
    ))
  ) {
    throw new Error('The SQL export request is invalid.');
  }
  if (
    typeof input.suggestedName !== 'string'
    || input.suggestedName.length === 0
    || input.suggestedName.length > EXPORT_MAX_NAME_LENGTH
  ) {
    throw new Error('The SQL export request is invalid.');
  }
  return {
    format: input.format,
    columns: input.columns as string[],
    rows: input.rows as string[][],
    suggestedName: input.suggestedName,
  };
}

/** Prompts for a save location and writes the exported result file. */
export async function exportSqlResult(
  input: SqlExportInput,
  parentWindow: BrowserWindow | undefined,
): Promise<SqlExportResult> {
  const extension = input.format === 'excel' ? 'xlsx' : 'csv';
  const options = {
    title: input.format === 'excel' ? 'Export Results as Excel' : 'Export Results as CSV',
    defaultPath: path.join(app.getPath('downloads'), withExtension(input.suggestedName, extension)),
    filters: [{
      name: input.format === 'excel' ? 'Excel Workbook' : 'CSV File',
      extensions: [extension],
    }],
  };
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { status: 'cancelled' };

  const bytes = input.format === 'excel'
    ? buildExcel(input.columns, input.rows)
    : buildCsv(input.columns, input.rows);
  await fs.writeFile(result.filePath, bytes, { mode: 0o600 });
  return { status: 'saved', path: result.filePath };
}

function withExtension(name: string, extension: string): string {
  return /\.(xlsx|csv)$/i.test(name) ? name : `${name}.${extension}`;
}

function buildCsv(columns: string[], rows: string[][]): Buffer {
  const content = stringify([columns, ...rows]);
  // Prepend a UTF-8 BOM so Excel decodes non-ASCII text correctly.
  return Buffer.from(`﻿${content}`, 'utf8');
}

function buildExcel(columns: string[], rows: string[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([columns, ...rows.map((row) => columns.map(
    (_column, index) => row[index] ?? '',
  ))]);
  sheet['!cols'] = columns.map((column, index) => ({
    wch: excelColumnWidth(column, index, rows),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Result');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return applyExcelHeaderStyle(buffer);
}

/**
 * Column width in Excel character units: the longest cell (or header) in the
 * column plus a small padding, clamped to a sane range. CJK code points count
 * as two character widths so wide text is not clipped.
 */
function excelColumnWidth(header: string, index: number, rows: string[][]): number {
  let maxWidth = displayWidth(header);
  for (const row of rows) {
    maxWidth = Math.max(maxWidth, displayWidth(row[index] ?? ''));
  }
  return Math.min(EXCEL_MAX_COLUMN_WIDTH, Math.max(EXCEL_MIN_COLUMN_WIDTH, maxWidth + EXCEL_COLUMN_PADDING));
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  }
  return width;
}

/**
 * SheetJS community edition writes column widths but not cell fills/fonts, so
 * the navy header fill and white text are injected into the generated XLSX
 * (a zip of XML) after the fact.
 */
function applyExcelHeaderStyle(buffer: Buffer): Buffer {
  const zip = new AdmZip(buffer);
  const stylesPath = 'xl/styles.xml';
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const styles = zip.readAsText(stylesPath);
  const sheet = zip.readAsText(sheetPath);
  if (!styles || !sheet) return buffer;

  const fillId = countOf(styles, 'fills');
  const fontId = countOf(styles, 'fonts');
  const xfId = countOf(styles, 'cellXfs');

  zip.updateFile(stylesPath, Buffer.from(injectStyles(styles, fillId, fontId), 'utf8'));
  zip.updateFile(sheetPath, Buffer.from(injectHeaderStyle(sheet, xfId), 'utf8'));
  return zip.toBuffer();
}

function countOf(xml: string, container: string): number {
  const match = xml.match(new RegExp(`<${container} count="(\\d+)"`));
  return match ? Number(match[1]) : 0;
}

function injectStyles(
  styles: string,
  fillId: number,
  fontId: number,
): string {
  let out = styles;

  out = out.replace(
    /<fills count="(\d+)">/,
    (_match, count) => `<fills count="${Number(count) + 1}">`,
  );
  out = out.replace(
    '</fills>',
    `<fill><patternFill patternType="solid"><fgColor rgb="${EXCEL_HEADER_FILL}"/><bgColor indexed="64"/></patternFill></fill></fills>`,
  );

  out = out.replace(
    /<fonts count="(\d+)">/,
    (_match, count) => `<fonts count="${Number(count) + 1}">`,
  );
  out = out.replace(
    '</fonts>',
    `<font><sz val="12"/><color rgb="${EXCEL_HEADER_TEXT}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>`,
  );

  out = out.replace(
    /<cellXfs count="(\d+)">/,
    (_match, count) => `<cellXfs count="${Number(count) + 1}">`,
  );
  out = out.replace(
    '</cellXfs>',
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFill="1" applyFont="1"/></cellXfs>`,
  );

  return out;
}

function injectHeaderStyle(sheet: string, styleId: number): string {
  const headerRow = sheet.match(/<row[^>]*>[\s\S]*?<\/row>/);
  if (!headerRow) return sheet;
  const styled = headerRow[0].replace(/<c(?=[\s>])/g, `<c s="${styleId}"`);
  return sheet.replace(headerRow[0], styled);
}
