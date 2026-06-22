#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const { getFieldAliases, normalizeSalesRow } = require('../db/salesRepository');

const FIELDS = [
  ['transactionDate', '거래일'],
  ['settlementDate', '입금일'],
  ['cardCompany', '카드사'],
  ['approvalNumber', '승인번호'],
  ['merchantNumber', '가맹점번호'],
  ['approvalAmount', '승인금액'],
  ['feeAmount', '수수료'],
  ['depositAmount', '실입금액'],
];

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Usage:
  npm run inspect:sales -- <path-to-creditfinance-json>

Example:
  npm run inspect:sales -- data/card-sales/creditfinance-sales-2026-06-22.json
`);
}

async function readRows(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    return parsed;
  }

  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function collectColumns(rows) {
  return Array.from(
    rows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
}

async function main() {
  if (hasFlag('help')) {
    printHelp();
    return;
  }

  const inputFile = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

  if (!inputFile) {
    printHelp();
    throw new Error('Missing JSON file path.');
  }

  const filePath = path.resolve(inputFile);
  const rows = await readRows(filePath);
  const columns = collectColumns(rows);
  const normalized = normalizeSalesRow(rows[0] || {});

  console.log(`Rows: ${rows.length}`);
  console.log(`Columns (${columns.length}):`);
  columns.forEach((column) => console.log(`- ${column}`));
  console.log('');
  console.log('Current mapping preview from first row:');

  FIELDS.forEach(([field, label]) => {
    const value = normalized[field];
    const aliases = getFieldAliases(field).slice(0, 8).join(', ');
    console.log(`- ${label} (${field}): ${value || '(empty)'}`);
    console.log(`  aliases: ${aliases}`);
  });
}

main().catch((error) => {
  console.error('[error]', error.message);
  process.exitCode = 1;
});
