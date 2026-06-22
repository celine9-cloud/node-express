#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const { insertSalesRows } = require('../db/salesRepository');

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

function getInputFile() {
  var args = process.argv.slice(2);
  var optionsWithValues = new Set(['--source', '--source-url']);

  for (var index = 0; index < args.length; index += 1) {
    var arg = args[index];

    if (arg.startsWith('--')) {
      if (optionsWithValues.has(arg)) {
        index += 1;
      }

      continue;
    }

    return arg;
  }

  return '';
}

function printHelp() {
  console.log(`
Usage:
  npm run import:sales -- <path-to-creditfinance-json> [options]

Options:
  --source=NAME       Data source label. Default: creditfinance.
  --source-url=URL    Optional source page URL.
  --help              Show this help.

Example:
  npm run import:sales -- data/card-sales/creditfinance-sales-2026-06-22.json
`);
}

async function readRows(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    return {
      rows: parsed,
      collectedAt: new Date().toISOString(),
      sourceUrl: '',
    };
  }

  return {
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    collectedAt: parsed.collectedAt || new Date().toISOString(),
    sourceUrl: parsed.sourceUrl || '',
  };
}

async function main() {
  if (hasFlag('help')) {
    printHelp();
    return;
  }

  const inputFile = getInputFile();

  if (!inputFile) {
    printHelp();
    throw new Error('Missing JSON file path.');
  }

  const filePath = path.resolve(inputFile);
  const { rows, collectedAt, sourceUrl } = await readRows(filePath);

  const result = insertSalesRows(rows, {
    source: readArg('source', 'creditfinance'),
    sourceUrl: readArg('source-url', sourceUrl),
    collectedAt,
  });

  console.log(`[done] Imported ${result.inserted}/${result.total} rows`);
  console.log(`[done] Ignored duplicates: ${result.ignored}`);
  console.log(`[done] Database: ${result.dbPath}`);
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exitCode = 1;
});
