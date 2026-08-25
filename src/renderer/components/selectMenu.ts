export interface DropdownOpenOptions {
  disabled?: boolean;
  beforeOpen?: () => void;
}

export function isDropdownMenuOpen(menu: HTMLElement): boolean {
  return !menu.classList.contains('hidden');
}

export function setDropdownMenuOpen(
  toggle: HTMLButtonElement,
  menu: HTMLElement,
  open: boolean,
  options: DropdownOpenOptions = {},
): boolean {
  const visible = open && !toggle.disabled && !options.disabled;
  if (visible) options.beforeOpen?.();
  menu.classList.toggle('hidden', !visible);
  toggle.setAttribute('aria-expanded', String(visible));
  return visible;
}

export function shouldCloseDropdownMenu(
  control: Pick<HTMLElement, 'contains'>,
  target: Node | null,
): boolean {
  return target !== null && !control.contains(target);
}

export function focusSelectedMenuOption(menu: HTMLElement, optionSelector: string): void {
  window.requestAnimationFrame(() => {
    if (!isDropdownMenuOpen(menu)) return;
    (
      menu.querySelector<HTMLElement>(`${optionSelector}[aria-selected="true"]`)
      ?? menu.querySelector<HTMLElement>(optionSelector)
    )?.focus();
  });
}

export function bindListboxKeyboardNavigation(menu: HTMLElement, optionSelector: string): void {
  menu.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(menu.querySelectorAll<HTMLElement>(optionSelector));
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + options.length) % options.length
          : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  });
}

export function closeDropdownOnFocusOut(control: HTMLElement, close: () => void): void {
  control.addEventListener('focusout', () => {
    window.requestAnimationFrame(() => {
      if (!control.contains(document.activeElement)) close();
    });
  });
}
