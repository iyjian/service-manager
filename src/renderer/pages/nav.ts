export interface AppPage {
  id: string;
  title: string;
  icon: string;
  onShow?: () => void;
  onHide?: () => void;
}

const ACTIVE_PAGE_STORAGE_KEY = 'active-page';
const managedPanel = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search).get('panel') : null;

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
  if (managedPanel && pageId !== managedPanel) {
    void window.panelWindowApi.activate(pageId);
    return;
  }
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
  activatePage(managedPanel && pages.has(managedPanel) ? managedPanel : saved && pages.has(saved) ? saved : defaultPageId);
  if (managedPanel) {
    const rail = getNavRail();
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'nav-item panel-window-toggle';
    button.textContent = '↗';
    button.setAttribute('aria-label', 'Open panel in window');
    rail.insertBefore(button, rail.firstElementChild?.nextSibling ?? null);
    let detached = false;
    const apply = (state: import('../../shared/types').PanelWindowState): void => {
      detached = state.detached;
      button.textContent = detached ? '⇤' : '↗';
      button.setAttribute('aria-label', detached ? 'Merge into main window' : 'Open panel in window');
      button.title = detached ? 'Move this panel back without reloading' : 'Move this panel to a separate window';
      document.documentElement.classList.toggle('panel-detached', detached);
    };
    window.panelWindowApi.onStateChanged(apply);
    void window.panelWindowApi.getState().then(apply);
    button.addEventListener('click', () => {
      button.disabled = true;
      void (detached ? window.panelWindowApi.merge() : window.panelWindowApi.detach())
        .catch(error => window.dispatchEvent(new CustomEvent('service-manager:toast', { detail: { text: String(error), level: 'error' } })))
        .finally(() => { button.disabled = false; });
    });
  }
}
