export interface AppPage {
  id: string;
  title: string;
  icon: string;
  onShow?: () => void;
  onHide?: () => void;
}

const ACTIVE_PAGE_STORAGE_KEY = 'active-page';

const pages = new Map<string, AppPage>();
let activePageId: string | null = null;

function getNavRail(): HTMLElement {
  const rail = document.querySelector<HTMLElement>('#nav-rail');
  if (!rail) throw new Error('Missing required element: #nav-rail');
  return rail;
}

function getPageRoot(pageId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`main[data-page="${pageId}"]`);
}

export function registerPage(page: AppPage): void {
  if (pages.has(page.id)) {
    return;
  }
  pages.set(page.id, page);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item';
  button.dataset.pageTarget = page.id;
  button.title = page.title;
  button.setAttribute('aria-label', page.title);
  button.innerHTML = page.icon;
  button.addEventListener('click', () => activatePage(page.id));
  getNavRail().appendChild(button);
}

export function activatePage(pageId: string): void {
  const next = pages.get(pageId);
  if (!next || activePageId === pageId) {
    return;
  }

  const previous = activePageId ? pages.get(activePageId) : undefined;
  activePageId = pageId;

  for (const id of pages.keys()) {
    getPageRoot(id)?.classList.toggle('hidden', id !== pageId);
  }

  for (const item of Array.from(getNavRail().querySelectorAll<HTMLElement>('.nav-item'))) {
    const active = item.dataset.pageTarget === pageId;
    item.classList.toggle('nav-item-active', active);
    if (item.dataset.pageTarget) {
      item.setAttribute('aria-current', active ? 'page' : 'false');
    }
  }

  try {
    localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, pageId);
  } catch {
    // localStorage may be unavailable; page switching still works.
  }

  previous?.onHide?.();
  next.onShow?.();
}

export function initNav(defaultPageId: string): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY);
  } catch {
    // ignore
  }
  activatePage(saved && pages.has(saved) ? saved : defaultPageId);
}
