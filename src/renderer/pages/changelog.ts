import type { ChangelogEntry, ChangelogView } from '../../shared/types';
import { requireElement } from '../utils/dom.js';

let wired = false;
let view: ChangelogView | null = null;
let currentLang: 'zh' | 'en' = 'zh';

function wire(): void {
  if (wired) return;
  wired = true;

  const dialog = requireElement<HTMLDialogElement>('#changelog-dialog');
  requireElement<HTMLButtonElement>('#close-changelog-dialog-btn').addEventListener('click', () => {
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    void window.serviceApi.markChangelogSeen().catch(() => undefined);
  });

  const zhTab = requireElement<HTMLButtonElement>('#changelog-tab-zh');
  const enTab = requireElement<HTMLButtonElement>('#changelog-tab-en');
  zhTab.addEventListener('click', () => setLang('zh'));
  enTab.addEventListener('click', () => setLang('en'));
}

function setLang(lang: 'zh' | 'en'): void {
  currentLang = lang;
  requireElement<HTMLButtonElement>('#changelog-tab-zh').setAttribute(
    'aria-selected',
    lang === 'zh' ? 'true' : 'false',
  );
  requireElement<HTMLButtonElement>('#changelog-tab-en').setAttribute(
    'aria-selected',
    lang === 'en' ? 'true' : 'false',
  );
  renderBody();
}

function renderHeader(): void {
  if (!view) return;
  requireElement<HTMLElement>('#changelog-version').textContent = view.previousVersion
    ? `v${view.currentVersion} · from v${view.previousVersion}`
    : `v${view.currentVersion}`;
}

function renderBody(): void {
  if (!view) return;
  const entries = view[currentLang];
  const body = requireElement<HTMLElement>('#changelog-body');
  body.textContent = '';

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    fragment.appendChild(renderEntry(entry));
  }
  body.appendChild(fragment);
}

function renderEntry(entry: ChangelogEntry): HTMLElement {
  const root = document.createElement('section');
  root.className = 'changelog-entry';
  if (entry.highlighted) root.classList.add('changelog-entry-highlighted');

  const heading = document.createElement('div');
  heading.className = 'changelog-entry-heading';

  const version = document.createElement('h3');
  version.className = 'changelog-entry-version';
  version.textContent = `v${entry.version}`;
  heading.appendChild(version);

  if (entry.date) {
    const date = document.createElement('span');
    date.className = 'changelog-entry-date';
    date.textContent = entry.date;
    heading.appendChild(date);
  }
  root.appendChild(heading);

  for (const section of entry.sections) {
    const title = document.createElement('h4');
    title.className = 'changelog-section-title';
    title.textContent = section.title;
    root.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'changelog-section-list';
    for (const item of section.items) {
      const listItem = document.createElement('li');
      listItem.textContent = item;
      list.appendChild(listItem);
    }
    root.appendChild(list);
  }

  return root;
}

export async function maybeShowChangelog(): Promise<void> {
  try {
    wire();
    const fetched = await window.serviceApi.getChangelog();
    if (!fetched.shouldShow) {
      return;
    }
    view = fetched;
    currentLang = 'zh';
    requireElement<HTMLButtonElement>('#changelog-tab-zh').setAttribute('aria-selected', 'true');
    requireElement<HTMLButtonElement>('#changelog-tab-en').setAttribute('aria-selected', 'false');
    renderHeader();
    renderBody();
    requireElement<HTMLDialogElement>('#changelog-dialog').showModal();
  } catch (error) {
    console.warn('[changelog] Unable to show the changelog.', error);
  }
}
