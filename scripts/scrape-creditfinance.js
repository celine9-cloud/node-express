#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright');
const { insertSalesRows } = require('../db/salesRepository');

const DEFAULT_BASE_URL = 'https://www.cardsales.or.kr/main';

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function printHelp() {
  console.log(`
Usage:
  npm run scrape:creditfinance -- [options]

Options:
  --from=YYYY-MM-DD       Optional start date. Used only when date selectors are configured.
  --to=YYYY-MM-DD         Optional end date. Used only when date selectors are configured.
  --format=json|csv       Output format. Default: json.
  --headless              Run browser without UI. Use only after a valid session state is saved.
  --keep-open             Keep the browser open after scraping for debugging.
  --no-db                 Save only the output file and skip SQLite insert.
  --help                  Show this help.

Environment:
  Copy .env.example to .env and adjust selectors/URLs for the current site screens.
`);
}

async function ensureDir(fileOrDirPath, isFile = false) {
  const directory = isFile ? path.dirname(fileOrDirPath) : fileOrDirPath;
  await fs.mkdir(directory, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeCellText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function createCsv(rows) {
  if (!rows.length) {
    return '';
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    columns.map(escape).join(','),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(',')),
  ].join('\n');
}

function getOutputPath(outputDir, format) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outputDir, `creditfinance-sales-${timestamp}.${format}`);
}

async function prompt(message) {
  const rl = readline.createInterface({ input, output });

  try {
    await rl.question(`${message}\nPress Enter to continue... `);
  } finally {
    rl.close();
  }
}

async function waitForSelectorIfConfigured(page, selector, timeoutMs, label) {
  if (!selector) {
    return false;
  }

  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch (error) {
    console.warn(`[warn] ${label} selector was not found within ${timeoutMs}ms: ${selector}`);
    return false;
  }
}

async function maybeFillQueryForm(page, fromDate, toDate) {
  const fromSelector = env('CFIA_DATE_FROM_SELECTOR');
  const toSelector = env('CFIA_DATE_TO_SELECTOR');
  const searchSelector = env('CFIA_SEARCH_BUTTON_SELECTOR');

  if (fromSelector && fromDate) {
    await page.locator(fromSelector).fill(fromDate);
  }

  if (toSelector && toDate) {
    await page.locator(toSelector).fill(toDate);
  }

  if (searchSelector) {
    await page.locator(searchSelector).click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
}

async function maybeDownloadExport(page, outputDir) {
  const downloadSelector = env('CFIA_DOWNLOAD_SELECTOR');

  if (!downloadSelector) {
    return null;
  }

  console.log(`[info] Waiting for download from selector: ${downloadSelector}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(downloadSelector).click(),
  ]);

  const suggestedName = download.suggestedFilename();
  const savePath = path.join(outputDir, suggestedName || `creditfinance-export-${Date.now()}`);
  await ensureDir(savePath, true);
  await download.saveAs(savePath);

  return savePath;
}

async function extractTableRows(page, tableSelector) {
  return page.locator(tableSelector).first().evaluate((table) => {
    const clean = (value) => value.replace(/\s+/g, ' ').trim();
    const allRows = Array.from(table.querySelectorAll('tr'));

    if (!allRows.length) {
      return [];
    }

    const explicitHeaders = Array.from(table.querySelectorAll('thead th')).map((cell) =>
      clean(cell.textContent || '')
    );
    const firstRowCells = Array.from(allRows[0].querySelectorAll('th,td')).map((cell) =>
      clean(cell.textContent || '')
    );
    const firstRowHasHeader = allRows[0].querySelectorAll('th').length > 0;
    const headers = (explicitHeaders.length ? explicitHeaders : firstRowHasHeader ? firstRowCells : [])
      .map((header, index) => header || `column${index + 1}`);
    const dataRows = firstRowHasHeader || explicitHeaders.length ? allRows.slice(1) : allRows;

    return dataRows
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((cell) =>
          clean(cell.textContent || '')
        );

        if (!cells.some(Boolean)) {
          return null;
        }

        return cells.reduce((record, value, index) => {
          const key = headers[index] || `column${index + 1}`;
          record[key] = value;
          return record;
        }, {});
      })
      .filter(Boolean);
  });
}

async function main() {
  if (hasFlag('help')) {
    printHelp();
    return;
  }

  const baseUrl = env('CFIA_BASE_URL', DEFAULT_BASE_URL);
  const targetUrl = env('CFIA_TARGET_URL');
  const outputDir = path.resolve(env('CFIA_OUTPUT_DIR', 'data/card-sales'));
  const storageStatePath = path.resolve(env('CFIA_STORAGE_STATE', '.auth/cardsales-state.json'));
  const tableSelector = env('CFIA_RESULT_TABLE_SELECTOR', 'table');
  const loginReadySelector = env('CFIA_LOGIN_READY_SELECTOR', 'text=/로그아웃|마이페이지|회원정보/');
  const manualTimeoutMs = Number(env('CFIA_MANUAL_TIMEOUT_MS', '180000'));
  const fromDate = readArg('from', env('CFIA_DATE_FROM'));
  const toDate = readArg('to', env('CFIA_DATE_TO'));
  const format = readArg('format', env('CFIA_OUTPUT_FORMAT', 'json')).toLowerCase();
  const headless = hasFlag('headless') || parseBool(env('CFIA_HEADLESS'), false);
  const keepOpen = hasFlag('keep-open') || parseBool(env('CFIA_KEEP_OPEN'), false);
  const saveToDb = !hasFlag('no-db') && parseBool(env('CFIA_SAVE_TO_DB'), true);

  if (!['json', 'csv'].includes(format)) {
    throw new Error(`Unsupported format: ${format}. Use json or csv.`);
  }

  await ensureDir(outputDir);
  await ensureDir(storageStatePath, true);

  const hasStorageState = await fileExists(storageStatePath);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: hasStorageState ? storageStatePath : undefined,
  });
  const page = await context.newPage();

  try {
    console.log(`[info] Opening ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const loginReady = await waitForSelectorIfConfigured(
      page,
      loginReadySelector,
      Math.min(manualTimeoutMs, 10000),
      'login-ready'
    );

    if (!loginReady && !headless) {
      await prompt(
        'Complete login, certificate/MFA, and any required merchant selection in the opened browser.'
      );
    } else if (!loginReady && headless) {
      throw new Error(
        'Login session is not ready in headless mode. Run once without --headless and complete login manually.'
      );
    }

    if (targetUrl) {
      console.log(`[info] Opening target page ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    } else if (!headless) {
      await prompt('Move to the sales result screen, set the query period, and run the search.');
    }

    await maybeFillQueryForm(page, fromDate, toDate);

    const downloadedPath = await maybeDownloadExport(page, outputDir);
    if (downloadedPath) {
      await context.storageState({ path: storageStatePath });
      console.log(`[done] Download saved: ${downloadedPath}`);
      console.log(`[done] Session state saved: ${storageStatePath}`);
      return;
    }

    await waitForSelectorIfConfigured(page, tableSelector, manualTimeoutMs, 'result-table');
    const rows = (await extractTableRows(page, tableSelector)).map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeCellText(key), value]))
    );

    const outputPath = getOutputPath(outputDir, format);
    const collectedAt = new Date().toISOString();
    const payload =
      format === 'json'
        ? JSON.stringify(
            {
              collectedAt,
              sourceUrl: page.url(),
              rowCount: rows.length,
              rows,
            },
            null,
            2
          )
        : createCsv(rows);

    await fs.writeFile(outputPath, payload, 'utf8');
    await context.storageState({ path: storageStatePath });

    console.log(`[done] Extracted ${rows.length} rows`);
    console.log(`[done] Output saved: ${outputPath}`);
    console.log(`[done] Session state saved: ${storageStatePath}`);

    if (saveToDb) {
      const importResult = insertSalesRows(rows, {
        source: 'creditfinance',
        sourceUrl: page.url(),
        collectedAt,
      });
      console.log(
        `[done] SQLite saved: ${importResult.inserted}/${importResult.total} rows (${importResult.ignored} duplicates ignored)`
      );
      console.log(`[done] Database: ${importResult.dbPath}`);
    }

    if (keepOpen && !headless) {
      await prompt('Browser is still open for inspection.');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exitCode = 1;
});
