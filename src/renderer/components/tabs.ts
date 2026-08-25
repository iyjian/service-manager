export type TabOrientation = 'horizontal' | 'vertical' | 'both';

export interface TabItem<T extends string> {
  id: T;
  button: HTMLButtonElement;
  panel?: HTMLElement;
}

export interface ActivateTabSetOptions {
  focus?: boolean;
  hiddenClass?: string;
}

export interface TextTabItem<T extends string> {
  id: T;
  label: string;
  title?: string;
}

export interface RenderTextTabsOptions<T extends string> {
  container: HTMLElement;
  tabs: readonly TextTabItem<T>[];
  activeId: T;
  buttonClassName: string;
  activeClassName?: string;
  orientation?: TabOrientation;
  onSelect(id: T): void;
}

export function tabIndexForKey(
  key: string,
  currentIndex: number,
  total: number,
  orientation: TabOrientation = 'horizontal',
): number | undefined {
  if (total <= 0 || currentIndex < 0 || currentIndex >= total) return undefined;
  const usesHorizontal = orientation === 'horizontal' || orientation === 'both';
  const usesVertical = orientation === 'vertical' || orientation === 'both';
  if (usesHorizontal && key === 'ArrowRight') return (currentIndex + 1) % total;
  if (usesHorizontal && key === 'ArrowLeft') return (currentIndex - 1 + total) % total;
  if (usesVertical && key === 'ArrowDown') return (currentIndex + 1) % total;
  if (usesVertical && key === 'ArrowUp') return (currentIndex - 1 + total) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return undefined;
}

export function setTabButtonState(button: HTMLButtonElement, selected: boolean): void {
  button.setAttribute('aria-selected', String(selected));
  button.tabIndex = selected ? 0 : -1;
}

export function activateTabSet<T extends string>(
  tabs: readonly TabItem<T>[],
  activeId: T,
  options: ActivateTabSetOptions = {},
): void {
  for (const tab of tabs) {
    const selected = tab.id === activeId;
    setTabButtonState(tab.button, selected);
    if (tab.panel) {
      if (options.hiddenClass) {
        tab.panel.classList.toggle(options.hiddenClass, !selected);
      } else {
        tab.panel.hidden = !selected;
      }
    }
    if (selected && options.focus) tab.button.focus();
  }
}

export function bindTabButtons<T extends string>(
  tabs: readonly TabItem<T>[],
  activate: (id: T, focus: boolean) => void,
  orientation: TabOrientation = 'horizontal',
): void {
  tabs.forEach((tab, index) => {
    tab.button.addEventListener('click', () => activate(tab.id, false));
    tab.button.addEventListener('keydown', (event) => {
      const nextIndex = tabIndexForKey(event.key, index, tabs.length, orientation);
      if (nextIndex === undefined) return;
      event.preventDefault();
      const next = tabs[nextIndex];
      if (next) activate(next.id, true);
    });
  });
}

export function renderTextTabs<T extends string>(options: RenderTextTabsOptions<T>): void {
  const nodes = options.tabs.map((tab, index) => {
    const button = document.createElement('button');
    const selected = tab.id === options.activeId;
    button.type = 'button';
    button.className = options.buttonClassName;
    if (options.activeClassName) button.classList.toggle(options.activeClassName, selected);
    button.textContent = tab.label;
    button.title = tab.title ?? tab.label;
    button.setAttribute('role', 'tab');
    setTabButtonState(button, selected);
    button.addEventListener('click', () => options.onSelect(tab.id));
    button.addEventListener('keydown', (event) => {
      const targetIndex = tabIndexForKey(
        event.key,
        index,
        options.tabs.length,
        options.orientation ?? 'horizontal',
      );
      const target = targetIndex === undefined ? undefined : options.tabs[targetIndex];
      if (!target) return;
      event.preventDefault();
      options.onSelect(target.id);
      window.requestAnimationFrame(() => {
        options.container.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      });
    });
    return button;
  });
  options.container.replaceChildren(...nodes);
}
