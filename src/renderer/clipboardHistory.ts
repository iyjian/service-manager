export {};
interface Entry { id: string; kind: 'text' | 'image'; value: string; createdAt: number }
declare global {
  interface Window {
    clipboardHistory: {
      action(action: string, id?: string): Promise<Entry[] | undefined>;
      onChanged(callback: () => void): void;
    };
  }
}
const list = document.getElementById('entries')!;
const status = document.getElementById('status')!;
let version = 0;
async function act(action: string, id?: string): Promise<void> {
  try { await window.clipboardHistory.action(action, id); }
  catch { status.textContent = action === 'paste'
    ? 'Paste failed. Return to the text field and reopen clipboard history.'
    : 'Clipboard operation failed. Please try again.'; }
}
async function render(): Promise<void> {
  const current = ++version;
  const focused = (document.activeElement as HTMLElement)?.dataset.id;
  try {
    const entries = await window.clipboardHistory.action('list') ?? [];
    if (current !== version) return;
    list.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'entry';
      const paste = document.createElement('button');
      paste.className = 'paste';
      paste.dataset.id = entry.id;
      paste.title = 'Paste';
      if (entry.kind === 'image') {
        const img = document.createElement('img');
        img.src = entry.value;
        img.alt = 'Copied image';
        paste.append(img);
      } else {
        const preview = document.createElement('span');
        preview.className = 'preview';
        preview.textContent = entry.value.slice(0, 1500);
        paste.append(preview);
      }
      const time = document.createElement('time');
      time.dateTime = new Date(entry.createdAt).toISOString();
      time.textContent = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      paste.append(time);
      paste.addEventListener('click', () => { void act('paste', entry.id); });
      const remove = document.createElement('button');
      remove.className = 'delete';
      remove.textContent = '\u00d7';
      remove.title = 'Delete item';
      remove.setAttribute('aria-label', 'Delete item');
      remove.addEventListener('click', () => { void act('delete', entry.id); });
      row.append(paste, remove);
      list.append(row);
    }
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Your clipboard history is empty.';
      list.append(empty);
    }
    status.textContent = `${entries.length} / 20`;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('.paste'));
    (buttons.find(button => button.dataset.id === focused) ?? buttons[0])?.focus();
  } catch { status.textContent = 'Clipboard history could not be loaded.'; }
}
document.getElementById('close')!.addEventListener('click', () => { void act('close'); });
document.getElementById('clear')!.addEventListener('click', () => { void act('clear'); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void act('close'); }
  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('.paste'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }
  if (event.key === 'Delete' && index >= 0) { event.preventDefault(); void act('delete', buttons[index].dataset.id); }
});
window.clipboardHistory.onChanged(() => { void render(); });
void render();
