import { createIcon, isLucideIconName } from './components/icon.js';

const titles = new Map<string, string>();
const rail = document.getElementById('panel-shell-nav')!;
const title = document.getElementById('panel-shell-title')!;
const message = document.getElementById('panel-shell-message')!;
const focus = document.getElementById('panel-shell-focus') as HTMLButtonElement;
const merge = document.getElementById('panel-shell-merge') as HTMLButtonElement;
const railMerge = document.getElementById('panel-shell-rail-merge') as HTMLButtonElement;
const error = document.getElementById('panel-shell-error')!;
let active = '';
const run = (work: Promise<unknown>): void => { void work.catch(reason => { error.textContent = String(reason); }); };
const apply = (state: import('../shared/types').PanelWindowState): void => {
  active = state.active; const detached = state.detachedPanels.includes(active);
  const shell = document.querySelector<HTMLElement>('.panel-shell')!;
  shell.inert = !detached;
  shell.setAttribute('aria-hidden', String(!detached));
  title.textContent = titles.get(active) ?? 'Service Manager';
  message.textContent = detached ? 'This panel is open in a separate window.' : 'Opening panel…';
  focus.hidden = merge.hidden = !detached;
  for (const button of Array.from(rail.querySelectorAll<HTMLButtonElement>('[data-panel]'))) {
    const selected = button.dataset.panel === active;
    button.classList.toggle('nav-item-active', selected);
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  }
};
window.panelWindowApi.onStateChanged(apply);
focus.addEventListener('click', () => run(window.panelWindowApi.focus(active)));
merge.addEventListener('click', () => run(window.panelWindowApi.merge(active)));
railMerge.addEventListener('click', () => run(window.panelWindowApi.merge(active)));
run((async () => {
  const definitions = await window.panelWindowApi.list();
  for (const definition of definitions) titles.set(definition.id, definition.title);
  for (const { id, title: label, icon } of definitions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'nav-item';
    button.appendChild(createIcon(icon && isLucideIconName(icon) ? icon : 'boxes'));  button.title = label; button.setAttribute('aria-label', label); button.dataset.panel = id;
    button.addEventListener('click', () => { active = id; run(window.panelWindowApi.activate(id)); }); rail.appendChild(button);
  }
  let saved = definitions[0].id;
  try { const value = localStorage.getItem('active-page'); if (value && titles.has(value)) saved = value; } catch { /* optional preference */ }
  await window.panelWindowApi.activate(saved);
})());
export {};
