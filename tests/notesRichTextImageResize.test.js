const assert = require('node:assert/strict');
const test = require('node:test');

async function loadResizeHelpers() {
  return import('../dist/renderer/notesRichTextImageResize.js');
}

test('rich text image resize follows the dragged west or east edge', async () => {
  const { calculateRichTextImageDisplayWidth } = await loadResizeHelpers();

  assert.equal(calculateRichTextImageDisplayWidth(320, 45, 'east', 800), 365);
  assert.equal(calculateRichTextImageDisplayWidth(320, -45, 'east', 800), 275);
  assert.equal(calculateRichTextImageDisplayWidth(320, 45, 'west', 800), 275);
  assert.equal(calculateRichTextImageDisplayWidth(320, -45, 'west', 800), 365);
  assert.equal(calculateRichTextImageDisplayWidth(320.4, 20.3, 'east', 800), 341);
});

test('rich text image resize clamps previews to its UI minimum and available width', async () => {
  const {
    RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
    calculateRichTextImageDisplayWidth,
  } = await loadResizeHelpers();

  assert.equal(RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH, 96);
  assert.equal(calculateRichTextImageDisplayWidth(120, -100, 'east', 800), 96);
  assert.equal(calculateRichTextImageDisplayWidth(120, 100, 'west', 800), 96);
  assert.equal(calculateRichTextImageDisplayWidth(790, 100, 'east', 800), 800);
  assert.equal(calculateRichTextImageDisplayWidth(790, -100, 'west', 800), 800);
  assert.equal(calculateRichTextImageDisplayWidth(320, 0, 'east', 80), 96);
});

test('rich text image resize contains non-finite layout inputs', async () => {
  const {
    RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
    calculateRichTextImageDisplayWidth,
  } = await loadResizeHelpers();

  assert.equal(
    calculateRichTextImageDisplayWidth(Number.NaN, Number.NaN, 'east', Number.POSITIVE_INFINITY),
    RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
  );
  assert.equal(calculateRichTextImageDisplayWidth(300, Number.POSITIVE_INFINITY, 'east', 500), 300);
  assert.equal(calculateRichTextImageDisplayWidth(-100, 0, 'west', 500), RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH);
});
