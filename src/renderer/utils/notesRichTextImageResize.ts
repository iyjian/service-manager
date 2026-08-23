export const RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH = 96;

export function calculateRichTextImageDisplayWidth(
  startWidth: number,
  pointerDeltaX: number,
  direction: 'west' | 'east',
  maximumWidth: number,
): number {
  const safeStart = Number.isFinite(startWidth) ? startWidth : RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH;
  const safeDelta = Number.isFinite(pointerDeltaX) ? pointerDeltaX : 0;
  const safeMaximum = Math.max(
    RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH,
    Math.floor(Number.isFinite(maximumWidth) ? maximumWidth : RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH),
  );
  const directionalDelta = direction === 'west' ? -safeDelta : safeDelta;
  return Math.round(Math.min(
    safeMaximum,
    Math.max(RICH_TEXT_IMAGE_MIN_DISPLAY_WIDTH, safeStart + directionalDelta),
  ));
}
