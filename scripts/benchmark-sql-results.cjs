const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const mode = process.argv[2] === 'baseline' ? 'baseline' : 'virtual';
const rowCount = Math.max(1, Number.parseInt(process.argv[3] ?? '1000', 10) || 1_000);
const columnCount = Math.max(1, Number.parseInt(process.argv[4] ?? '40', 10) || 40);

function rendererMemory(pid) {
  const metric = app.getAppMetrics().find((item) => item.pid === pid);
  return metric
    ? {
      workingSetMb: Number((metric.memory.workingSetSize / 1024).toFixed(1)),
      peakWorkingSetMb: Number((metric.memory.peakWorkingSetSize / 1024).toFixed(1)),
    }
    : {};
}

app.whenReady().then(async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'service-manager-sql-benchmark-'));
  const harnessPath = join(temporaryDirectory, 'index.html');
  const baseStyles = pathToFileURL(join(root, 'dist', 'renderer', 'styles.css')).href;
  const componentStyles = pathToFileURL(join(root, 'dist', 'renderer', 'tailwind.css')).href;
  writeFileSync(
    harnessPath,
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${baseStyles}"><link rel="stylesheet" href="${componentStyles}"></head><body><div id="host" class="sql-result-content" style="width:912px;height:340px"></div></body></html>`,
    'utf8',
  );

  const window = new BrowserWindow({
    show: false,
    width: 912,
    height: 340,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await window.loadFile(harnessPath);
    const virtualModuleUrl = pathToFileURL(
      join(root, 'dist', 'renderer', 'sqlVirtualResultTable.js'),
    ).href;
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const mode = ${JSON.stringify(mode)};
        const rowCount = ${rowCount};
        const columnCount = ${columnCount};
        const columns = Array.from({ length: columnCount }, (_, index) => \`column_\${index}\`);
        const dataStartedAt = performance.now();
        const rows = Array.from({ length: rowCount }, (_, rowIndex) =>
          Object.fromEntries(columns.map((column, columnIndex) => [
            column,
            \`row \${rowIndex} value \${columnIndex}\`,
          ]))
        );
        const dataMs = performance.now() - dataStartedAt;
        const host = document.querySelector('#host');
        const renderStartedAt = performance.now();

        const createCell = (row, rowIndex, column, columnIndex) => {
          const cell = document.createElement('td');
          const content = document.createElement('div');
          content.className = 'sql-result-cell';
          const text = document.createElement('span');
          text.className = 'sql-result-cell-value';
          text.textContent = row[column];
          const detail = document.createElement('button');
          detail.type = 'button';
          detail.className = 'sql-result-cell-detail hidden';
          detail.dataset.sqlCellDetail = 'true';
          detail.dataset.sqlRowIndex = String(rowIndex);
          detail.dataset.sqlColumnIndex = String(columnIndex);
          detail.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.25" cy="8" r="1.15"></circle><circle cx="8" cy="8" r="1.15"></circle><circle cx="12.75" cy="8" r="1.15"></circle></svg>';
          content.append(text, detail);
          cell.append(content);
          return cell;
        };

        if (mode === 'baseline') {
          const wrap = document.createElement('div');
          wrap.className = 'sql-result-table-wrap';
          const table = document.createElement('table');
          table.className = 'sql-result-table';
          const head = document.createElement('thead');
          const headRow = document.createElement('tr');
          for (const column of columns) {
            const cell = document.createElement('th');
            const label = document.createElement('span');
            label.className = 'sql-result-column-name';
            label.textContent = column;
            cell.append(label);
            headRow.append(cell);
          }
          head.append(headRow);
          const body = document.createElement('tbody');
          rows.forEach((row, rowIndex) => {
            const rowNode = document.createElement('tr');
            columns.forEach((column, columnIndex) => {
              rowNode.append(createCell(row, rowIndex, column, columnIndex));
            });
            body.append(rowNode);
          });
          table.append(head, body);
          wrap.append(table);
          host.replaceChildren(wrap);
        } else {
          const { SqlVirtualResultTable } = await import(${JSON.stringify(virtualModuleUrl)});
          new SqlVirtualResultTable({
            host,
            result: { kind: 'table', title: 'Result', rows, columns },
            onOpenValue: () => {},
            onWindowRendered: () => {},
          });
        }

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const cells = Array.from(host.querySelectorAll('.sql-result-cell'));
        const overflow = cells.map((cell) => {
          const text = cell.querySelector('.sql-result-cell-value');
          const detail = cell.querySelector('.sql-result-cell-detail');
          return { detail, overflowing: text.scrollWidth > text.clientWidth };
        });
        for (const item of overflow) item.detail.classList.toggle('hidden', !item.overflowing);
        const settledMs = performance.now() - renderStartedAt;
        let finalWindow;
        if (mode === 'virtual') {
          host.scrollTop = host.scrollHeight;
          host.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const renderedIndexes = Array.from(
            host.querySelectorAll('tbody tr[data-sql-result-row]'),
            (row) => Number(row.dataset.sqlResultRow),
          );
          finalWindow = {
            first: renderedIndexes[0],
            last: renderedIndexes[renderedIndexes.length - 1],
          };
        }
        return {
          mode,
          rowCount,
          columnCount,
          dataMs: Number(dataMs.toFixed(1)),
          settledMs: Number(settledMs.toFixed(1)),
          domNodes: host.querySelectorAll('*').length,
          renderedRows: host.querySelectorAll('tbody tr[data-sql-result-row]').length
            || host.querySelectorAll('tbody tr').length,
          renderedCells: host.querySelectorAll('tbody td:not([colspan])').length,
          scrollHeight: host.scrollHeight,
          scrollWidth: host.scrollWidth,
          finalWindow,
        };
      })()
    `, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log(JSON.stringify({
      ...result,
      ...rendererMemory(window.webContents.getOSProcessId()),
    }));
  } finally {
    window.destroy();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
