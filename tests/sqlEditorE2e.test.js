const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const distRenderer = path.join(root, 'dist', 'renderer');
const e2eEnabled = process.env.SERVICE_MANAGER_E2E === '1';

function sqlHarnessHtml(sqlSource) {
  return `
<script type="module">
  import { registerSqlPage } from './sqlPage.js';
  import { initNav } from './pages/nav.js';

  const schema = {
    environment: 'production',
    tables: [{
      name: 't_test_paper',
      columns: [
        { name: 'id', dataType: 'bigint' },
        {
          name: 'status',
          dataType: 'int',
          enum: {
            comment: '状态-0 - 未审核 1 - 审核不通过 2 - 审核通过',
            nullable: false,
            defaultValue: '0',
          },
        },
        {
          name: 'isProject',
          dataType: 'tinyint',
          enum: {
            comment: '是否项目-0 - 否 1 - 是',
            nullable: false,
            defaultValue: '0',
          },
        },
      ],
    }],
  };

  localStorage.setItem('active-page', 'sql');
  localStorage.setItem('sql:active-environment', 'production');
  localStorage.setItem('sql:untitled-drafts:v1', JSON.stringify({
    version: 1,
    environments: {
      production: { sources: [${JSON.stringify(sqlSource)}], activeIndex: 0 },
      development: { sources: [], activeIndex: 0 },
    },
  }));

  Object.defineProperty(window, 'serviceApi', {
    configurable: true,
    value: {
      onCloseShortcutRequested: () => () => undefined,
      writeClipboardText: async () => undefined,
      confirmAction: async () => false,
    },
  });
  Object.defineProperty(window, 'sqlApi', {
    configurable: true,
    value: {
      getAuthState: async (environment) => ({
        environment,
        status: 'signed-in',
        hasSavedCredentials: false,
        user: { id: 1, name: 'Harness', userName: 'harness' },
      }),
      login: async (input) => ({
        environment: input.environment,
        status: 'signed-in',
        hasSavedCredentials: false,
        user: { id: 1, name: 'Harness', userName: input.userName },
      }),
      logout: async (environment) => ({ environment, status: 'signed-out', hasSavedCredentials: false }),
      listQueries: async () => [],
      getQuery: async () => { throw new Error('unused'); },
      createQuery: async (_environment, draft) => ({ id: 1, name: draft.name, sql: draft.sql }),
      updateQuery: async (_environment, id, draft) => ({ id, name: draft.name, sql: draft.sql }),
      renameQuery: async (_environment, id, name) => ({ id, name, sql: '' }),
      deleteQuery: async () => undefined,
      execute: async () => ({ value: undefined, executedAt: new Date().toISOString(), durationMs: 0 }),
      getSchema: async (environment) => {
        window.__sqlHarnessSchemaLoaded = true;
        return { ...schema, environment };
      },
    },
  });

  document.querySelector('#app-startup-sync')?.classList.add('hidden');
  const layout = document.querySelector('#app-layout');
  if (layout) {
    layout.inert = false;
    layout.removeAttribute('aria-hidden');
  }
  document.body.removeAttribute('data-startup-sync');

  registerSqlPage();
  initNav('sql');
  window.__sqlHarnessReady = true;
</script>`;
}

function textNodePointExpression(text, occurrence = 0) {
  return `(() => {
    const content = document.querySelector('#sql-editor .cm-content');
    const target = ${JSON.stringify(text)};
    const targetOccurrence = ${JSON.stringify(occurrence)};
    if (!content || !target) return null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let seen = 0;
    while (node) {
      const nodeText = node.nodeValue || '';
      let index = nodeText.indexOf(target);
      while (index >= 0) {
        if (seen === targetOccurrence) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + target.length);
          const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 && candidate.height > 0);
          range.detach();
          if (!rect) return null;
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: target };
        }
        seen += 1;
        index = nodeText.indexOf(target, index + target.length);
      }
      node = walker.nextNode();
    }
    return null;
  })()`;
}

async function runElectronSqlEditorHarness(options) {
  const electron = require('electron');
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'service-manager-sql-e2e-'));
  const mainPath = path.join(temporaryDirectory, 'main.cjs');
  const harnessPath = path.join(
    distRenderer,
    `__sql_editor_e2e_${process.pid}_${path.basename(temporaryDirectory)}.html`,
  );
  const indexHtml = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const harnessHtml = indexHtml.replace(
    '<script type="module" src="./renderer.js"></script>',
    sqlHarnessHtml(options.sqlSource || ''),
  );

  const contentPointExpression = `(() => {
    const content = document.querySelector('#sql-editor .cm-content');
    if (!content) return null;
    const rect = content.getBoundingClientRect();
    return { x: rect.left + 20, y: rect.top + 20 };
  })()`;
  const completionExpression = `(() => {
    const tooltip = document.querySelector('.cm-tooltip-autocomplete');
    if (!tooltip) return null;
    const items = Array.from(tooltip.querySelectorAll('li'))
      .map((item) => item.textContent?.trim() || '');
    return {
      items,
      text: tooltip.textContent || '',
      doc: document.querySelector('#sql-editor .cm-content')?.innerText || '',
    };
  })()`;
  const tablePointExpression = options.tableText
    ? textNodePointExpression(options.tableText, options.tableOccurrence || 0)
    : 'null';
  const tableTooltipExpression = `(() => {
    const tooltip = document.querySelector('.sql-table-enum-tooltip');
    if (!tooltip) return null;
    const rows = Array.from(tooltip.querySelectorAll('.sql-table-enum-tooltip-row')).map((row) => (
      {
        cells: Array.from(row.children).slice(0, 4).map((cell) => cell.textContent?.trim() || ''),
        values: Array.from(row.querySelectorAll('.sql-table-enum-tooltip-value')).map((item) => ({
          text: item.textContent?.trim() || '',
          isDefault: item.classList.contains('default'),
        })),
      }
    ));
    return {
      rows,
      text: tooltip.textContent || '',
      doc: document.querySelector('#sql-editor .cm-content')?.innerText || '',
    };
  })()`;

  const mainSource = `
const { app, BrowserWindow } = require('electron');
const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const harnessPath = ${JSON.stringify(harnessPath)};
const userDataPath = ${JSON.stringify(path.join(temporaryDirectory, 'user-data'))};
const action = ${JSON.stringify(options.action)};
const textToType = ${JSON.stringify(options.textToType || '')};
const completionSteps = ${JSON.stringify(options.completionSteps || null)};
const contentPointExpression = ${JSON.stringify(contentPointExpression)};
const completionExpression = ${JSON.stringify(completionExpression)};
const tablePointExpression = ${JSON.stringify(tablePointExpression)};
const tableTooltipExpression = ${JSON.stringify(tableTooltipExpression)};

app.setPath('userData', userDataPath);

async function waitFor(webContents, expression, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await webContents.executeJavaScript(expression, true);
    if (value) return value;
    await timeout(50);
  }
  throw new Error('Timed out waiting for: ' + expression);
}

async function sendMouse(webContents, type, x, y, clickCount) {
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount,
  });
}

async function insertTextByCharacter(webContents, text) {
  for (const character of text) {
    await webContents.debugger.sendCommand('Input.insertText', { text: character });
    await timeout(5);
  }
}

async function sendKey(webContents, key) {
  const keyCodes = { Escape: 27 };
  await webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: key,
    windowsVirtualKeyCode: keyCodes[key] || 0,
  });
  await webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: keyCodes[key] || 0,
  });
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1230,
    height: 820,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadFile(harnessPath);
    const webContents = window.webContents;
    await waitFor(webContents, 'window.__sqlHarnessReady === true');
    await waitFor(webContents, 'window.__sqlHarnessSchemaLoaded === true');
    await waitFor(webContents, 'Boolean(document.querySelector("#sql-page:not(.hidden) .cm-content"))');
    await waitFor(webContents, 'Boolean(document.querySelector("#sql-query-workspace:not(.hidden)"))');
    await timeout(250);

    webContents.debugger.attach('1.3');
    if (action === 'completion') {
      const point = await webContents.executeJavaScript(contentPointExpression, true);
      if (!point) throw new Error('Could not locate the SQL editor content area.');

      await sendMouse(webContents, 'mouseMoved', point.x, point.y, 0);
      await sendMouse(webContents, 'mousePressed', point.x, point.y, 1);
      await sendMouse(webContents, 'mouseReleased', point.x, point.y, 1);
      await timeout(100);

      if (completionSteps) {
        for (const step of completionSteps) {
          if (typeof step === 'string') {
            await insertTextByCharacter(webContents, step);
          } else if (step && step.key) {
            await sendKey(webContents, step.key);
            await timeout(100);
          }
        }
      } else {
        await insertTextByCharacter(webContents, textToType);
      }
      const completion = await waitFor(webContents, completionExpression, 5000);
      console.log(JSON.stringify({ ok: true, completion }));
    } else if (action === 'table-tooltip') {
      const point = await webContents.executeJavaScript(tablePointExpression, true);
      if (!point) throw new Error('Could not locate the requested table token.');

      await sendMouse(webContents, 'mouseMoved', point.x, point.y, 0);
      await sendMouse(webContents, 'mousePressed', point.x, point.y, 1);
      await sendMouse(webContents, 'mouseReleased', point.x, point.y, 1);
      await timeout(60);
      await sendMouse(webContents, 'mousePressed', point.x, point.y, 2);
      await sendMouse(webContents, 'mouseReleased', point.x, point.y, 2);

      const tableTooltip = await waitFor(webContents, tableTooltipExpression, 5000);
      console.log(JSON.stringify({ ok: true, tableTooltip }));
    } else {
      throw new Error('Unknown SQL editor E2E action: ' + action);
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
    }));
    process.exitCode = 1;
  } finally {
    try {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    } catch {
      // ignore debugger detach races during test shutdown
    }
    window.destroy();
    app.quit();
  }
});
`;

  await writeFile(harnessPath, harnessHtml, 'utf8');
  await writeFile(mainPath, mainSource, 'utf8');

  return await new Promise((resolve, reject) => {
    const child = spawn(electron, [mainPath], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Electron SQL editor E2E timed out.'));
    }, 20_000);

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(new Error(`Electron SQL editor E2E failed with code ${code ?? 'null'} signal ${signal ?? 'null'}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      const line = stdout.trim().split('\n').findLast((entry) => entry.trim().startsWith('{'));
      if (!line) {
        reject(new Error(`Electron SQL editor E2E did not print a JSON result.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`Electron SQL editor E2E printed invalid JSON: ${line}\n${error.message}`));
      }
    });
  }).finally(async () => {
    if (existsSync(harnessPath)) await rm(harnessPath, { force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
}

async function runElectronCompletionHarness(textToType) {
  return runElectronSqlEditorHarness({
    action: 'completion',
    textToType,
  });
}

async function runElectronCompletionSequenceHarness(completionSteps) {
  return runElectronSqlEditorHarness({
    action: 'completion',
    completionSteps,
  });
}

async function runElectronTableTooltipHarness(sqlSource, tableOccurrence = 0) {
  return runElectronSqlEditorHarness({
    action: 'table-tooltip',
    sqlSource,
    tableText: 't_test_paper',
    tableOccurrence,
  });
}

test('SQL editor E2E opens enum completions after typing an enum comparison', {
  skip: e2eEnabled ? false : 'set SERVICE_MANAGER_E2E=1 to run Electron E2E tests',
  timeout: 25_000,
}, async () => {
  const result = await runElectronCompletionHarness('select * from t_test_paper where status = ');

  assert.equal(result.ok, true);
  assert.equal(result.completion.doc, 'select * from t_test_paper where status = ');
  assert.deepEqual(result.completion.items.slice(0, 3), [
    '0未审核 default',
    '1审核不通过',
    '2审核通过',
  ]);
});

test('SQL editor E2E opens enum completions when equals is typed after completion was closed', {
  skip: e2eEnabled ? false : 'set SERVICE_MANAGER_E2E=1 to run Electron E2E tests',
  timeout: 25_000,
}, async () => {
  const result = await runElectronCompletionSequenceHarness([
    'select * from t_test_paper where status',
    { key: 'Escape' },
    ' = ',
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.completion.doc, 'select * from t_test_paper where status = ');
  assert.deepEqual(result.completion.items.slice(0, 3), [
    '0未审核 default',
    '1审核不通过',
    '2审核通过',
  ]);
});

test('SQL editor E2E opens table enum tooltip from a double-click after a leading SQL comment', {
  skip: e2eEnabled ? false : 'set SERVICE_MANAGER_E2E=1 to run Electron E2E tests',
  timeout: 25_000,
}, async () => {
  const source = [
    '-- 把已售卖的课程标记为项目式单元',
    'update t_test_paper set isProject =1 where courseId in (select id from t_course where saleStatus=1) and type = 4;',
    '',
    'select * from t_test_paper where status',
  ].join('\n');
  const result = await runElectronTableTooltipHarness(source, 0);

  assert.equal(result.ok, true);
  assert.match(result.tableTooltip.doc, /update t_test_paper set isProject =1/);
  assert.match(result.tableTooltip.doc, /select \* from t_test_paper where status/);
  assert.deepEqual(result.tableTooltip.rows, [
    {
      cells: ['status', 'int', 'No', '状态'],
      values: [
        { text: '0 未审核', isDefault: true },
        { text: '1 审核不通过', isDefault: false },
        { text: '2 审核通过', isDefault: false },
      ],
    },
    {
      cells: ['isProject', 'tinyint', 'No', '是否项目'],
      values: [
        { text: '0 否', isDefault: true },
        { text: '1 是', isDefault: false },
      ],
    },
  ]);
});
