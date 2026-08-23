import {
  noteAttachmentPreviewImageMimeType,
  noteAttachmentPreviewKind,
} from '../../shared/noteRichText';
import type {
  NoteAttachmentPreview,
  NoteAttachmentReference,
} from '../../shared/types';
import { inspectNotesImage } from './notesImageS3';

export { noteAttachmentPreviewKind } from '../../shared/noteRichText';

function validPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 64) return false;
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefix = body.subarray(0, Math.min(body.byteLength, 16)).toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(prefix)) return false;
  const tailOffset = Math.max(0, body.byteLength - 16_384);
  const trailer = body.subarray(tailOffset).toString('latin1');
  const start = /startxref[\t ]*(?:\r\n|\r|\n)[\t ]*(\d+)[\t ]*(?:\r\n|\r|\n)[\t ]*%%EOF[\t\r\n ]*$/.exec(trailer);
  if (!start) return false;
  const xrefOffset = Number(start[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < prefix.length || xrefOffset >= tailOffset + start.index) {
    return false;
  }
  if (body.indexOf(Buffer.from(' obj', 'ascii')) < 0 || body.indexOf(Buffer.from('endobj', 'ascii')) < 0) {
    return false;
  }
  const xref = body.subarray(xrefOffset, Math.min(body.byteLength, xrefOffset + 64 * 1024)).toString('latin1');
  if (/^xref(?:\r\n|\r|\n)/.test(xref)) return /(?:\r\n|\r|\n)trailer\b/.test(xref);
  return /^\d+[\t ]+\d+[\t ]+obj\b/.test(xref)
    && /\/Type[\t\r\n ]*\/XRef\b/.test(xref)
    && /\bstream(?:\r\n|\r|\n)/.test(xref);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < PNG_CRC_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  PNG_CRC_TABLE[value] = crc >>> 0;
}

function pngCrc32(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0xffffffff;
  for (let offset = from; offset < to; offset += 1) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 57 || !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunkIndex = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset, false);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) return false;
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (view.getUint32(dataEnd, false) !== pngCrc32(bytes, offset + 4, dataEnd)) return false;
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) return false;
    if (type === 'IDAT') sawImageData = true;
    if (type === 'IEND') return length === 0 && sawImageData && chunkEnd === bytes.byteLength;
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
}

function jpegMarkerHasLength(marker: number): boolean {
  return marker !== 0x01 && marker !== 0xd8 && marker !== 0xd9 && (marker < 0xd0 || marker > 0xd7);
}

function jpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function validJpeg(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let pendingMarker: number | undefined;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.byteLength) {
    let marker = pendingMarker;
    pendingMarker = undefined;
    if (marker === undefined) {
      if (bytes[offset] !== 0xff) return false;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.byteLength) return false;
      marker = bytes[offset++];
    }
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.byteLength;
    if (marker === 0x00 || marker === 0xd8) return false;
    if (!jpegMarkerHasLength(marker)) continue;
    if (offset + 2 > bytes.byteLength) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) return false;
    if (jpegStartOfFrame(marker)) sawFrame = true;
    const segmentEnd = offset + length;
    if (marker !== 0xda) {
      offset = segmentEnd;
      continue;
    }
    sawScan = true;
    offset = segmentEnd;
    while (offset < bytes.byteLength) {
      if (bytes[offset++] !== 0xff) continue;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.byteLength) return false;
      const scanMarker = bytes[offset++];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) continue;
      pendingMarker = scanMarker;
      break;
    }
  }
  return false;
}

function validWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20) return false;
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WEBP') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return false;
  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = body.toString('ascii', offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const dataEnd = offset + 8 + length;
    const chunkEnd = dataEnd + (length & 1);
    if (!/^[\x20-\x7e]{4}$/.test(type) || dataEnd < offset || chunkEnd > bytes.byteLength) return false;
    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') sawImageChunk = true;
    offset = chunkEnd;
  }
  return sawImageChunk && offset === bytes.byteLength;
}

function validUtf8Text(bytes: Uint8Array): boolean {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  } catch {
    return false;
  }
}

export function validateNotesAttachmentPreview(
  reference: Pick<NoteAttachmentReference, 'fileName' | 'mimeType' | 'byteLength'>,
  bytes: Uint8Array,
): boolean {
  if (bytes.byteLength !== reference.byteLength) return false;
  const kind = noteAttachmentPreviewKind(reference);
  if (kind === 'pdf') return validPdf(bytes);
  if (kind === 'text') return validUtf8Text(bytes);
  if (kind === 'image') {
    const expectedMimeType = noteAttachmentPreviewImageMimeType(reference);
    try {
      inspectNotesImage(bytes, expectedMimeType);
      if (expectedMimeType === 'image/png') return validPng(bytes);
      if (expectedMimeType === 'image/jpeg') return validJpeg(bytes);
      if (expectedMimeType === 'image/webp') return validWebp(bytes);
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

/** Builds inert renderer preview data only after exact structural validation. */
export function createNotesAttachmentPreview(
  reference: Pick<NoteAttachmentReference, 'fileName' | 'mimeType' | 'byteLength'>,
  bytes: Uint8Array,
): NoteAttachmentPreview | undefined {
  if (!validateNotesAttachmentPreview(reference, bytes)) return undefined;
  const kind = noteAttachmentPreviewKind(reference);
  if (kind === 'pdf') return { kind, bytes };
  if (kind === 'image') {
    const mimeType = noteAttachmentPreviewImageMimeType(reference);
    return mimeType ? { kind, mimeType, bytes } : undefined;
  }
  if (kind === 'text') {
    return { kind, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }
  return undefined;
}
