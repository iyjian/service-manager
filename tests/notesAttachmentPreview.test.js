const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createNotesAttachmentPreview,
  noteAttachmentPreviewKind,
  validateNotesAttachmentPreview,
} = require('../dist/main/notes/notesAttachmentPreview');

function png() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

function pdf() {
  const beforeXref = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xrefOffset = Buffer.byteLength(beforeXref, 'latin1');
  return Buffer.from(`${beforeXref}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

function reference(fileName, mimeType, byteLength) {
  return { fileName, mimeType, byteLength };
}

test('attachment View uses a narrow size-aware PDF, image, and text allowlist', () => {
  assert.equal(noteAttachmentPreviewKind(reference('guide.pdf', 'application/pdf', 1024)), 'pdf');
  assert.equal(noteAttachmentPreviewKind(reference('photo.png', 'image/png', 1024)), 'image');
  assert.equal(noteAttachmentPreviewKind(reference('README.md', 'text/markdown', 1024)), 'text');
  assert.equal(noteAttachmentPreviewKind(reference('data.json', 'application/octet-stream', 1024)), 'text');
  assert.equal(noteAttachmentPreviewKind(reference('large.png', 'image/png', 10 * 1024 * 1024 + 1)), undefined);
  assert.equal(noteAttachmentPreviewKind(reference('large.txt', 'text/plain', 4 * 1024 * 1024 + 1)), undefined);

  for (const candidate of [
    reference('shortcut.lnk', 'application/octet-stream', 1024),
    reference('screen.scr', 'application/octet-stream', 1024),
    reference('control.cpl', 'application/octet-stream', 1024),
    reference('page.hta', 'text/html', 1024),
    reference('page.html', 'text/html', 1024),
    reference('vector.svg', 'image/svg+xml', 1024),
    reference('macro.docm', 'application/vnd.ms-word.document.macroenabled.12', 1024),
    reference('archive.zip', 'application/zip', 1024),
    reference('script.sh', 'text/x-shellscript', 1024),
  ]) {
    assert.equal(noteAttachmentPreviewKind(candidate), undefined, candidate.fileName);
  }
});

test('attachment View verifies exact bytes and builds inert in-memory preview payloads', () => {
  const pdfBytes = pdf();
  assert.equal(validateNotesAttachmentPreview(
    reference('guide.pdf', 'application/pdf', pdfBytes.byteLength),
    pdfBytes,
  ), true);
  const spoofedPdf = Buffer.from('<html>spoofed PDF</html>');
  assert.equal(validateNotesAttachmentPreview(
    reference('guide.pdf', 'application/pdf', spoofedPdf.byteLength),
    spoofedPdf,
  ), false);

  const pngBytes = png();
  assert.equal(validateNotesAttachmentPreview(
    reference('photo.png', 'image/png', pngBytes.byteLength),
    pngBytes,
  ), true);
  assert.equal(validateNotesAttachmentPreview(
    reference('photo.png', 'image/png', 24),
    pngBytes.subarray(0, 24),
  ), false);
  const spoofedImage = Buffer.from('<svg onload=alert(1)>');
  assert.equal(validateNotesAttachmentPreview(
    reference('photo.png', 'image/png', spoofedImage.byteLength),
    spoofedImage,
  ), false);

  const textBytes = Buffer.from('# Safe UTF-8 中文\n');
  assert.equal(validateNotesAttachmentPreview(
    reference('README.md', 'text/markdown', textBytes.byteLength),
    textBytes,
  ), true);
  assert.equal(validateNotesAttachmentPreview(
    reference('README.md', 'text/markdown', 4),
    Buffer.from([0xff, 0xfe, 0x00, 0x01]),
  ), false);

  assert.deepEqual(
    createNotesAttachmentPreview(reference('README.md', 'text/markdown', textBytes.byteLength), textBytes),
    { kind: 'text', text: '# Safe UTF-8 中文\n' },
  );
  const imagePreview = createNotesAttachmentPreview(
    reference('photo.png', 'application/octet-stream', pngBytes.byteLength),
    pngBytes,
  );
  assert.equal(imagePreview?.kind, 'image');
  assert.equal(imagePreview?.mimeType, 'image/png');
  assert.equal(imagePreview?.bytes, pngBytes);
  assert.equal(validateNotesAttachmentPreview(
    reference('photo.png', 'image/png', pngBytes.byteLength + 1),
    pngBytes,
  ), false);
});

test('attachment View rejects MIME-extension disagreement instead of trusting either field alone', () => {
  assert.equal(noteAttachmentPreviewKind(reference('payload.pdf', 'text/html', 1024)), undefined);
  assert.equal(noteAttachmentPreviewKind(reference('payload.html', 'application/pdf', 1024)), undefined);
  assert.equal(noteAttachmentPreviewKind(reference('payload.png', 'image/jpeg', 1024)), undefined);
  assert.equal(noteAttachmentPreviewKind(reference('payload.txt', 'application/pdf', 1024)), undefined);
});
