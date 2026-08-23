import type { Editor } from '@tiptap/core';

type TableMenuKind = 'row' | 'column' | 'table';

type TableOperation =
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteRow'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteColumn'
  | 'deleteTable';

interface TableTarget {
  table: HTMLTableElement;
  wrapper: HTMLElement;
  row: HTMLTableRowElement;
  cell: HTMLTableCellElement;
}

interface TableMenuItem {
  label: string;
  operation: TableOperation;
  danger?: boolean;
}

const TABLE_MENU_ITEMS: Readonly<Record<TableMenuKind, readonly TableMenuItem[]>> = {
  row: [
    { label: 'Add Row Above', operation: 'addRowBefore' },
    { label: 'Add Row Below', operation: 'addRowAfter' },
    { label: 'Delete Row', operation: 'deleteRow', danger: true },
  ],
  column: [
    { label: 'Add Column Left', operation: 'addColumnBefore' },
    { label: 'Add Column Right', operation: 'addColumnAfter' },
    { label: 'Delete Column', operation: 'deleteColumn', danger: true },
  ],
  table: [
    { label: 'Delete Table', operation: 'deleteTable', danger: true },
  ],
};

const TABLE_HANDLE_CLASSES: Readonly<Record<TableMenuKind, string>> = {
  row: 'notes-richtext-table-row-handle',
  column: 'notes-richtext-table-column-handle',
  table: 'notes-richtext-table-table-handle',
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function createTableIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.4');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  for (const pathData of [
    'M3.75 2.5h8.5c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25z',
    'M8 2.5v11',
    'M2.5 6.25h11',
    'M2.5 9.75h11',
  ]) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
  }
  return icon;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function cellPosition(editor: Editor, cell: HTMLTableCellElement): number | undefined {
  let position: number;
  try {
    position = editor.view.posAtDOM(cell, 0);
  } catch {
    return undefined;
  }
  const resolved = editor.state.doc.resolve(
    clamp(position, 0, editor.state.doc.content.size),
  );
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const type = resolved.node(depth).type.name;
    if (type === 'tableCell' || type === 'tableHeader') return resolved.before(depth);
  }
  return undefined;
}

function tableTarget(host: HTMLElement, source: Element): TableTarget | undefined {
  const cell = source.closest<HTMLTableCellElement>('td, th');
  const row = cell?.closest<HTMLTableRowElement>('tr');
  const table = cell?.closest<HTMLTableElement>('table');
  const wrapper = table?.closest<HTMLElement>('.tableWrapper');
  if (!cell || !row || !table || !wrapper || !host.contains(wrapper)) return undefined;
  return { table, wrapper, row, cell };
}

function selectionTableTarget(editor: Editor, host: HTMLElement): TableTarget | undefined {
  const nativeSelection = document.getSelection();
  const anchor = nativeSelection?.anchorNode;
  const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (anchorElement) {
    const nativeTarget = tableTarget(host, anchorElement);
    if (nativeTarget) return nativeTarget;
  }

  const positions = [editor.state.selection.from];
  if (editor.state.selection.from < editor.state.doc.content.size) {
    positions.push(editor.state.selection.from + 1);
  }
  for (const position of positions) {
    const resolved = editor.state.doc.resolve(position);
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const type = resolved.node(depth).type.name;
      if (type !== 'tableCell' && type !== 'tableHeader') continue;
      const dom = editor.view.nodeDOM(resolved.before(depth));
      if (dom instanceof Element) return tableTarget(host, dom);
    }
    const nodeAfterType = resolved.nodeAfter?.type.name;
    if (nodeAfterType === 'tableCell' || nodeAfterType === 'tableHeader') {
      const dom = editor.view.nodeDOM(resolved.pos);
      if (dom instanceof Element) return tableTarget(host, dom);
    }
  }
  return undefined;
}

/**
 * A small DOM-only adapter around Tiptap's official table commands. The table
 * schema, selection, editing, clipboard behavior, and column resizing remain
 * owned by TableKit.
 */
export class NotesRichTextTableControls {
  private readonly element = document.createElement('div');
  private readonly rowHandle = document.createElement('button');
  private readonly columnHandle = document.createElement('button');
  private readonly tableHandle = document.createElement('button');
  private readonly menu = document.createElement('div');
  private hoveredTarget: TableTarget | undefined;
  private pinnedTarget: TableTarget | undefined;
  private menuKind: TableMenuKind | undefined;
  private replacingMenuItems = false;

  public constructor(
    private readonly editor: Editor,
    private readonly host: HTMLElement,
    private readonly overlayRoot: HTMLElement,
  ) {
    this.element.className = 'notes-richtext-table-ui';
    this.element.setAttribute('aria-hidden', 'false');

    this.configureHandle(this.rowHandle, 'row', 'Row options');
    this.rowHandle.setAttribute('aria-keyshortcuts', 'Alt+F10 Shift+F10');
    const rowGrip = document.createElement('span');
    rowGrip.className = 'notes-richtext-table-row-grip';
    rowGrip.textContent = '⋮⋮';
    rowGrip.setAttribute('aria-hidden', 'true');
    this.rowHandle.append(rowGrip);

    this.configureHandle(this.columnHandle, 'column', 'Column options');
    const columnGrip = document.createElement('span');
    columnGrip.className = 'notes-richtext-table-column-grip';
    columnGrip.textContent = '⋯';
    columnGrip.setAttribute('aria-hidden', 'true');
    this.columnHandle.append(columnGrip);

    this.configureHandle(this.tableHandle, 'table', 'Table options');
    this.tableHandle.append(createTableIcon());

    this.menu.className = 'notes-richtext-table-menu hidden';
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-label', 'Table actions');
    this.element.append(this.rowHandle, this.columnHandle, this.tableHandle, this.menu);
    this.element.addEventListener('mousedown', this.handleMouseDown);
    this.element.addEventListener('click', this.handleClick);
    this.element.addEventListener('focusin', this.handleControlsFocusIn);
    this.element.addEventListener('focusout', this.handleControlsFocusOut);
    this.element.addEventListener('pointerleave', this.handleControlsPointerLeave);
    this.host.addEventListener('pointermove', this.handlePointerMove);
    this.host.addEventListener('pointerleave', this.handleHostPointerLeave);
    this.host.addEventListener('blur', this.handleHostBlur, true);
    this.host.addEventListener('scroll', this.handleScroll, true);
    document.addEventListener('pointerdown', this.handleDocumentPointerDown);
    window.addEventListener('keydown', this.handleWindowKeyDown);
    window.addEventListener('resize', this.handleViewportChange);
    this.overlayRoot.append(this.element);
  }

  public sync(): void {
    if (this.editor.isDestroyed || !this.editor.isEditable) {
      this.hideAll();
      return;
    }
    const target = this.menuKind
      ? this.pinnedTarget
      : this.hoveredTarget ?? (this.editor.isFocused
        ? selectionTableTarget(this.editor, this.host)
        : undefined);
    if (!target || !this.isConnectedTarget(target)) {
      this.hideAll();
      return;
    }
    this.positionHandles(target);
    if (this.menuKind) this.positionMenu(this.menuKind);
  }

  public handleKeyDown(event: KeyboardEvent): boolean {
    if (
      event.key !== 'F10'
      || (!event.altKey && !event.shiftKey)
      || event.ctrlKey
      || event.metaKey
    ) {
      return false;
    }
    const target = selectionTableTarget(this.editor, this.host);
    if (!target || !this.isConnectedTarget(target)) return false;
    this.hoveredTarget = target;
    this.positionHandles(target);
    if (this.rowHandle.classList.contains('hidden')) return false;
    event.preventDefault();
    this.rowHandle.focus({ preventScroll: true });
    return true;
  }

  public destroy(): void {
    this.element.removeEventListener('mousedown', this.handleMouseDown);
    this.element.removeEventListener('click', this.handleClick);
    this.element.removeEventListener('focusin', this.handleControlsFocusIn);
    this.element.removeEventListener('focusout', this.handleControlsFocusOut);
    this.element.removeEventListener('pointerleave', this.handleControlsPointerLeave);
    this.host.removeEventListener('pointermove', this.handlePointerMove);
    this.host.removeEventListener('pointerleave', this.handleHostPointerLeave);
    this.host.removeEventListener('blur', this.handleHostBlur, true);
    this.host.removeEventListener('scroll', this.handleScroll, true);
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
    window.removeEventListener('keydown', this.handleWindowKeyDown);
    window.removeEventListener('resize', this.handleViewportChange);
    this.element.remove();
  }

  private configureHandle(
    handle: HTMLButtonElement,
    kind: TableMenuKind,
    label: string,
  ): void {
    handle.type = 'button';
    handle.className = `notes-richtext-table-handle ${TABLE_HANDLE_CLASSES[kind]} hidden`;
    handle.dataset.tableHandle = kind;
    handle.setAttribute('aria-label', label);
    handle.setAttribute('aria-haspopup', 'menu');
    handle.setAttribute('aria-expanded', 'false');
    handle.title = label;
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.menuKind) return;
    const source = event.target;
    if (!(source instanceof Element)) return;
    const target = tableTarget(this.host, source);
    if (!target) {
      this.hoveredTarget = undefined;
      this.hideHandles();
      return;
    }
    this.hoveredTarget = target;
    this.sync();
  };

  private readonly handleHostPointerLeave = (event: PointerEvent): void => {
    if (this.menuKind) return;
    const destination = event.relatedTarget;
    if (destination instanceof Node && this.element.contains(destination)) return;
    this.hoveredTarget = undefined;
    this.hideHandles();
  };

  private readonly handleControlsPointerLeave = (event: PointerEvent): void => {
    if (this.menuKind) return;
    const destination = event.relatedTarget;
    this.hoveredTarget = destination instanceof Element
      ? tableTarget(this.host, destination)
      : undefined;
    if (this.hoveredTarget) this.sync();
    else this.hideHandles();
  };

  private readonly handleHostBlur = (event: FocusEvent): void => {
    const destination = event.relatedTarget;
    if (!(destination instanceof Node) || !this.element.contains(destination)) return;
    const target = this.hoveredTarget ?? selectionTableTarget(this.editor, this.host);
    if (target && this.isConnectedTarget(target)) this.hoveredTarget = target;
  };

  private readonly handleViewportChange = (): void => {
    this.sync();
  };

  private readonly handleScroll = (): void => {
    if (this.menuKind) {
      this.sync();
      return;
    }
    this.hoveredTarget = undefined;
    if (this.editor.isFocused) this.sync();
    else this.hideHandles();
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly handleControlsFocusIn = (event: FocusEvent): void => {
    const source = event.target;
    if (!(source instanceof Element) || !source.closest('[data-table-handle]')) return;
    const target = this.hoveredTarget
      ?? this.pinnedTarget
      ?? selectionTableTarget(this.editor, this.host);
    if (!target || !this.isConnectedTarget(target)) return;
    this.hoveredTarget = target;
    this.positionHandles(target);
  };

  private readonly handleControlsFocusOut = (event: FocusEvent): void => {
    if (this.replacingMenuItems || !this.menuKind) return;
    const destination = event.relatedTarget;
    if (destination instanceof Node && this.menu.contains(destination)) return;
    this.closeMenu();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const source = event.target;
    if (!(source instanceof Element)) return;
    const handle = source.closest<HTMLElement>('[data-table-handle]');
    const kind = handle?.dataset.tableHandle;
    if (kind === 'row' || kind === 'column' || kind === 'table') {
      event.preventDefault();
      this.openMenu(kind);
      return;
    }
    const item = source.closest<HTMLElement>('[data-table-operation]');
    const operation = item?.dataset.tableOperation;
    if (!this.isOperation(operation)) return;
    event.preventDefault();
    this.runOperation(operation);
  };

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    const source = event.target;
    if (source instanceof Node && this.element.contains(source)) return;
    this.hoveredTarget = source instanceof Element
      ? tableTarget(this.host, source)
      : undefined;
    this.closeMenu();
  };

  private readonly handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this.menuKind || !this.menu.contains(document.activeElement)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      const trigger = this.handleForKind(this.menuKind);
      this.closeMenu();
      trigger.focus({ preventScroll: true });
      return;
    }
    const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    const activeIndex = document.activeElement instanceof HTMLButtonElement
      ? items.indexOf(document.activeElement)
      : -1;
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
    else if (event.key === 'ArrowUp') nextIndex = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    items[nextIndex].focus({ preventScroll: true });
  };

  private openMenu(kind: TableMenuKind): void {
    const target = this.hoveredTarget ?? selectionTableTarget(this.editor, this.host);
    if (!target || !this.isConnectedTarget(target)) return;
    this.hoveredTarget = target;
    this.pinnedTarget = target;
    this.menuKind = kind;
    this.renderMenu(kind);
    for (const handle of [this.rowHandle, this.columnHandle, this.tableHandle]) {
      handle.setAttribute('aria-expanded', String(handle.dataset.tableHandle === kind));
    }
    this.menu.classList.remove('hidden');
    this.positionHandles(target);
    this.positionMenu(kind);
    this.menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }

  private renderMenu(kind: TableMenuKind): void {
    const items = TABLE_MENU_ITEMS[kind].map((definition) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-richtext-table-menu-item';
      button.dataset.tableOperation = definition.operation;
      button.setAttribute('role', 'menuitem');
      if (definition.danger) button.dataset.danger = 'true';
      button.textContent = definition.label;
      return button;
    });
    // Removing the currently focused menu item emits `focusout` synchronously.
    // Suppress its close path while replacing items so it cannot recursively
    // empty the menu in the middle of `replaceChildren`.
    this.replacingMenuItems = true;
    try {
      this.menu.replaceChildren(...items);
    } finally {
      this.replacingMenuItems = false;
    }
    this.menu.setAttribute('aria-label', `${kind[0].toUpperCase()}${kind.slice(1)} actions`);
  }

  private runOperation(operation: TableOperation): void {
    const target = this.pinnedTarget;
    if (!target || !this.isConnectedTarget(target)) {
      this.closeMenu();
      return;
    }
    const position = cellPosition(this.editor, target.cell);
    if (position === undefined) {
      this.closeMenu();
      return;
    }
    const chain = this.editor.chain().focus().setCellSelection({ anchorCell: position });
    switch (operation) {
      case 'addRowBefore': chain.addRowBefore().run(); break;
      case 'addRowAfter': chain.addRowAfter().run(); break;
      case 'deleteRow': chain.deleteRow().run(); break;
      case 'addColumnBefore': chain.addColumnBefore().run(); break;
      case 'addColumnAfter': chain.addColumnAfter().run(); break;
      case 'deleteColumn': chain.deleteColumn().run(); break;
      case 'deleteTable': chain.deleteTable().run(); break;
    }
    this.closeMenu();
    window.requestAnimationFrame(() => this.sync());
  }

  private isOperation(value: string | undefined): value is TableOperation {
    return value === 'addRowBefore'
      || value === 'addRowAfter'
      || value === 'deleteRow'
      || value === 'addColumnBefore'
      || value === 'addColumnAfter'
      || value === 'deleteColumn'
      || value === 'deleteTable';
  }

  private positionHandles(target: TableTarget): void {
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const viewportBounds = this.host.getBoundingClientRect();
    const wrapperBounds = target.wrapper.getBoundingClientRect();
    const rowBounds = target.row.getBoundingClientRect();
    const cellBounds = target.cell.getBoundingClientRect();
    const inset = 4;
    const leftRail = clamp(
      wrapperBounds.left - overlayBounds.left - 26,
      inset,
      Math.max(inset, overlayBounds.width - 26 - inset),
    );

    const rowVisible = rowBounds.bottom > viewportBounds.top && rowBounds.top < viewportBounds.bottom;
    this.rowHandle.classList.toggle('hidden', !rowVisible);
    if (rowVisible) {
      this.rowHandle.style.left = `${leftRail}px`;
      this.rowHandle.style.top = `${clamp(
        rowBounds.top - overlayBounds.top + (rowBounds.height - 24) / 2,
        inset,
        Math.max(inset, overlayBounds.height - 24 - inset),
      )}px`;
    }

    const columnVisible = target.table.rows.item(0) === target.row
      && cellBounds.right > wrapperBounds.left
      && cellBounds.left < wrapperBounds.right
      && cellBounds.bottom > viewportBounds.top
      && cellBounds.top < viewportBounds.bottom;
    this.columnHandle.classList.toggle('hidden', !columnVisible);
    if (columnVisible) {
      this.columnHandle.style.left = `${clamp(
        cellBounds.left - overlayBounds.left + (cellBounds.width - 30) / 2,
        inset,
        Math.max(inset, overlayBounds.width - 30 - inset),
      )}px`;
      this.columnHandle.style.top = `${clamp(
        wrapperBounds.top - overlayBounds.top - 26,
        inset,
        Math.max(inset, overlayBounds.height - 24 - inset),
      )}px`;
    }

    const tableTopVisible = wrapperBounds.top >= viewportBounds.top
      && wrapperBounds.top < viewportBounds.bottom;
    this.tableHandle.classList.toggle('hidden', !tableTopVisible);
    if (tableTopVisible) {
      this.tableHandle.style.left = `${leftRail}px`;
      this.tableHandle.style.top = `${clamp(
        wrapperBounds.top - overlayBounds.top - 26,
        inset,
        Math.max(inset, overlayBounds.height - 24 - inset),
      )}px`;
    }
  }

  private positionMenu(kind: TableMenuKind): void {
    const trigger = this.handleForKind(kind);
    if (trigger.classList.contains('hidden')) {
      const restoreEditorFocus = this.menu.contains(document.activeElement);
      this.closeMenu();
      if (restoreEditorFocus) this.focusEditor();
      return;
    }
    const overlayBounds = this.overlayRoot.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const menuBounds = this.menu.getBoundingClientRect();
    const inset = 8;
    const preferredLeft = kind === 'column'
      ? triggerBounds.left - overlayBounds.left
      : triggerBounds.right - overlayBounds.left + 6;
    const preferredTop = kind === 'column'
      ? triggerBounds.bottom - overlayBounds.top + 6
      : triggerBounds.top - overlayBounds.top;
    this.menu.style.left = `${clamp(
      preferredLeft,
      inset,
      Math.max(inset, overlayBounds.width - menuBounds.width - inset),
    )}px`;
    this.menu.style.top = `${clamp(
      preferredTop,
      inset,
      Math.max(inset, overlayBounds.height - menuBounds.height - inset),
    )}px`;
  }

  private closeMenu(): void {
    this.menuKind = undefined;
    this.pinnedTarget = undefined;
    this.menu.classList.add('hidden');
    this.menu.replaceChildren();
    this.resetExpandedState();
    if (this.hoveredTarget && this.isConnectedTarget(this.hoveredTarget)) this.sync();
    else this.hideHandles();
  }

  private hideHandles(): void {
    this.rowHandle.classList.add('hidden');
    this.columnHandle.classList.add('hidden');
    this.tableHandle.classList.add('hidden');
  }

  private hideAll(): void {
    const restoreEditorFocus = this.menu.contains(document.activeElement);
    this.hoveredTarget = undefined;
    this.menuKind = undefined;
    this.pinnedTarget = undefined;
    this.menu.classList.add('hidden');
    this.menu.replaceChildren();
    this.resetExpandedState();
    this.hideHandles();
    if (restoreEditorFocus) this.focusEditor();
  }

  private handleForKind(kind: TableMenuKind): HTMLButtonElement {
    return kind === 'row'
      ? this.rowHandle
      : kind === 'column'
        ? this.columnHandle
        : this.tableHandle;
  }

  private resetExpandedState(): void {
    for (const handle of [this.rowHandle, this.columnHandle, this.tableHandle]) {
      handle.setAttribute('aria-expanded', 'false');
    }
  }

  private focusEditor(): void {
    if (!this.editor.isDestroyed && this.editor.isEditable) this.editor.commands.focus();
  }

  private isConnectedTarget(target: TableTarget): boolean {
    return target.cell.isConnected
      && target.row.isConnected
      && target.table.isConnected
      && target.wrapper.isConnected
      && this.host.contains(target.wrapper);
  }
}
