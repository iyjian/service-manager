const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export interface SvgIconOptions {
  viewBox?: string;
  strokeWidth?: number;
  className?: string;
}

/**
 * Builds a stroke-based inline icon. Paths use `currentColor` and are marked
 * `aria-hidden` so callers only need to provide the drawing data.
 */
export function createIcon(
  paths: string | readonly string[],
  options: SvgIconOptions = {},
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', options.viewBox ?? '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(options.strokeWidth ?? 1.5));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (options.className) svg.classList.add(options.className);

  const values = typeof paths === 'string' ? [paths] : paths;
  for (const pathData of values) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  return svg;
}
