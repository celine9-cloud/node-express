const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'ledger.sqlite');

const FIELD_ALIASES = {
  transactionDate: [
    '거래일자',
    '거래일',
    '거래일시',
    '승인거래일자',
    '승인거래일시',
    '승인일자',
    '승인일',
    '매출일자',
    '매출일',
    '결제일자',
    '매입일자',
    '일자',
    '날짜',
  ],
  settlementDate: ['입금일자', '입금일', '지급일자', '지급일', '입금예정일', '지급예정일', '대금지급일자'],
  cardCompany: ['카드사', '카드사명', '매입카드사', '매입사', '카드종류', '카드명', '발급사'],
  approvalNumber: ['승인번호', '승인No', '승인NO', '매출번호', '거래번호', '전표번호'],
  merchantNumber: ['가맹점번호', '가맹점 번호', '가맹점No', '가맹점NO', '가맹점ID'],
  approvalAmount: [
    '승인금액',
    '매출금액',
    '결제금액',
    '거래금액',
    '합계금액',
    '승인합계',
    '카드매출',
    '총매출액',
  ],
  feeAmount: ['수수료', '수수료액', '가맹점수수료', '수수료금액', '공제금액'],
  depositAmount: ['실입금액', '입금액', '지급금액', '실지급액', '입금예정금액', '대금입금액', '정산금액'],
};

const FIELD_ENV_NAMES = {
  transactionDate: 'SALES_TRANSACTION_DATE_ALIASES',
  settlementDate: 'SALES_SETTLEMENT_DATE_ALIASES',
  cardCompany: 'SALES_CARD_COMPANY_ALIASES',
  approvalNumber: 'SALES_APPROVAL_NUMBER_ALIASES',
  merchantNumber: 'SALES_MERCHANT_NUMBER_ALIASES',
  approvalAmount: 'SALES_APPROVAL_AMOUNT_ALIASES',
  feeAmount: 'SALES_FEE_AMOUNT_ALIASES',
  depositAmount: 'SALES_DEPOSIT_AMOUNT_ALIASES',
};

function normalizeKey(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[()[\]{}._/-]/g, '')
    .toLowerCase();
}

function parseAliasList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAliasJson(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function getFieldAliases(field, meta = {}) {
  const jsonAliases = parseAliasJson(process.env.SALES_FIELD_ALIASES_JSON);
  const envAliases = parseAliasList(process.env[FIELD_ENV_NAMES[field]]);
  const metaAliases = meta.fieldAliases && Array.isArray(meta.fieldAliases[field]) ? meta.fieldAliases[field] : [];

  return [
    ...metaAliases,
    ...(Array.isArray(jsonAliases[field]) ? jsonAliases[field] : []),
    ...envAliases,
    ...(FIELD_ALIASES[field] || []),
  ];
}

function createKeyMap(row) {
  return Object.keys(row || {}).reduce((map, key) => {
    map.set(normalizeKey(key), key);
    return map;
  }, new Map());
}

function pickValue(row, aliases) {
  const keyMap = createKeyMap(row);
  const normalizedAliases = aliases.map(normalizeKey);

  for (const alias of normalizedAliases) {
    if (keyMap.has(alias)) {
      return row[keyMap.get(alias)];
    }
  }

  for (const [normalizedKey, originalKey] of keyMap.entries()) {
    if (normalizedAliases.some((alias) => normalizedKey.includes(alias))) {
      return row[originalKey];
    }
  }

  return '';
}

function parseAmount(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const text = String(value).trim();
  const isNegative = /^\(.*\)$/.test(text) || text.includes('-');
  const numeric = text.replace(/[^0-9.]/g, '');

  if (!numeric) {
    return 0;
  }

  const parsed = Math.round(Number(numeric));
  return Number.isFinite(parsed) ? (isNegative ? -parsed : parsed) : 0;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const text = String(value).trim();
  const separated = text.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);

  if (separated) {
    return `${separated[1]}-${separated[2].padStart(2, '0')}-${separated[3].padStart(2, '0')}`;
  }

  const compact = text.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  return null;
}

function normalizeSalesRow(row, meta = {}) {
  const rawJson = JSON.stringify(row || {});
  const rawHash = crypto
    .createHash('sha256')
    .update(`${meta.source || 'creditfinance'}:${meta.sourceUrl || ''}:${rawJson}`)
    .digest('hex');

  return {
    source: meta.source || 'creditfinance',
    sourceUrl: meta.sourceUrl || '',
    collectedAt: meta.collectedAt || new Date().toISOString(),
    transactionDate: parseDate(pickValue(row, getFieldAliases('transactionDate', meta))),
    settlementDate: parseDate(pickValue(row, getFieldAliases('settlementDate', meta))),
    cardCompany: String(pickValue(row, getFieldAliases('cardCompany', meta)) || '').trim(),
    approvalNumber: String(pickValue(row, getFieldAliases('approvalNumber', meta)) || '').trim(),
    merchantNumber: String(pickValue(row, getFieldAliases('merchantNumber', meta)) || '').trim(),
    approvalAmount: parseAmount(pickValue(row, getFieldAliases('approvalAmount', meta))),
    feeAmount: parseAmount(pickValue(row, getFieldAliases('feeAmount', meta))),
    depositAmount: parseAmount(pickValue(row, getFieldAliases('depositAmount', meta))),
    rawJson,
    rawHash,
  };
}

function resolveDbPath() {
  return path.resolve(process.env.SALES_DB_PATH || DEFAULT_DB_PATH);
}

function openDatabase(dbPath = resolveDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'creditfinance',
      source_url TEXT,
      collected_at TEXT NOT NULL,
      transaction_date TEXT,
      settlement_date TEXT,
      card_company TEXT,
      approval_number TEXT,
      merchant_number TEXT,
      approval_amount INTEGER NOT NULL DEFAULT 0,
      fee_amount INTEGER NOT NULL DEFAULT 0,
      deposit_amount INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT NOT NULL,
      raw_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_card_sales_transaction_date ON card_sales(transaction_date);
    CREATE INDEX IF NOT EXISTS idx_card_sales_card_company ON card_sales(card_company);
    CREATE INDEX IF NOT EXISTS idx_card_sales_collected_at ON card_sales(collected_at);
  `);

  return db;
}

function buildDateFilter({ from, to } = {}) {
  const clauses = [];
  const params = {};

  if (from) {
    clauses.push('transaction_date >= @from');
    params.from = from;
  }

  if (to) {
    clauses.push('transaction_date <= @to');
    params.to = to;
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function insertSalesRows(rows, meta = {}) {
  const db = openDatabase(meta.dbPath);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO card_sales (
      source,
      source_url,
      collected_at,
      transaction_date,
      settlement_date,
      card_company,
      approval_number,
      merchant_number,
      approval_amount,
      fee_amount,
      deposit_amount,
      raw_json,
      raw_hash
    ) VALUES (
      @source,
      @sourceUrl,
      @collectedAt,
      @transactionDate,
      @settlementDate,
      @cardCompany,
      @approvalNumber,
      @merchantNumber,
      @approvalAmount,
      @feeAmount,
      @depositAmount,
      @rawJson,
      @rawHash
    )
  `);

  const saveMany = db.transaction((items) => {
    let inserted = 0;

    for (const row of items) {
      const result = insert.run(normalizeSalesRow(row, meta));
      inserted += result.changes;
    }

    return inserted;
  });

  const inserted = saveMany(Array.isArray(rows) ? rows : []);
  const total = Array.isArray(rows) ? rows.length : 0;
  db.close();

  return {
    inserted,
    ignored: total - inserted,
    total,
    dbPath: meta.dbPath || resolveDbPath(),
  };
}

function getSalesSummary(filters = {}) {
  const db = openDatabase(filters.dbPath);
  const { where, params } = buildDateFilter(filters);
  const summary = db
    .prepare(`
      SELECT
        COUNT(*) AS rowCount,
        COALESCE(SUM(approval_amount), 0) AS approvalAmount,
        COALESCE(SUM(fee_amount), 0) AS feeAmount,
        COALESCE(SUM(deposit_amount), 0) AS depositAmount
      FROM card_sales
      ${where}
    `)
    .get(params);

  db.close();
  return summary;
}

function listSales(filters = {}) {
  const db = openDatabase(filters.dbPath);
  const { where, params } = buildDateFilter(filters);
  const rows = db
    .prepare(`
      SELECT
        id,
        transaction_date AS transactionDate,
        settlement_date AS settlementDate,
        card_company AS cardCompany,
        approval_number AS approvalNumber,
        approval_amount AS approvalAmount,
        fee_amount AS feeAmount,
        deposit_amount AS depositAmount,
        collected_at AS collectedAt
      FROM card_sales
      ${where}
      ORDER BY transaction_date DESC, id DESC
      LIMIT @limit
    `)
    .all({
      ...params,
      limit: Math.min(Number(filters.limit) || 100, 500),
    });

  db.close();
  return rows;
}

function groupSalesByDay(filters = {}) {
  const db = openDatabase(filters.dbPath);
  const { where, params } = buildDateFilter(filters);
  const rows = db
    .prepare(`
      SELECT
        transaction_date AS period,
        COUNT(*) AS rowCount,
        COALESCE(SUM(approval_amount), 0) AS approvalAmount,
        COALESCE(SUM(fee_amount), 0) AS feeAmount,
        COALESCE(SUM(deposit_amount), 0) AS depositAmount
      FROM card_sales
      ${where}
      GROUP BY transaction_date
      ORDER BY transaction_date DESC
      LIMIT @limit
    `)
    .all({
      ...params,
      limit: Math.min(Number(filters.limit) || 90, 366),
    });

  db.close();
  return rows;
}

function groupSalesByMonth(filters = {}) {
  const db = openDatabase(filters.dbPath);
  const { where, params } = buildDateFilter(filters);
  const rows = db
    .prepare(`
      SELECT
        SUBSTR(transaction_date, 1, 7) AS period,
        COUNT(*) AS rowCount,
        COALESCE(SUM(approval_amount), 0) AS approvalAmount,
        COALESCE(SUM(fee_amount), 0) AS feeAmount,
        COALESCE(SUM(deposit_amount), 0) AS depositAmount
      FROM card_sales
      ${where}
      GROUP BY SUBSTR(transaction_date, 1, 7)
      ORDER BY period DESC
      LIMIT @limit
    `)
    .all({
      ...params,
      limit: Math.min(Number(filters.limit) || 24, 120),
    });

  db.close();
  return rows;
}

module.exports = {
  FIELD_ALIASES,
  getFieldAliases,
  getSalesSummary,
  groupSalesByDay,
  groupSalesByMonth,
  insertSalesRows,
  listSales,
  normalizeSalesRow,
  openDatabase,
  parseAmount,
  parseDate,
  resolveDbPath,
};
