const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DEFAULT_APP_DB_PATH = path.join(process.cwd(), 'data', 'app.sqlite');

function resolveAppDbPath() {
  return path.resolve(process.env.APP_DB_PATH || DEFAULT_APP_DB_PATH);
}

function openAppDatabase(dbPath = resolveAppDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      business_name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      company_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      business_number TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      memo TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_profile_id INTEGER REFERENCES customer_profiles(id) ON DELETE SET NULL,
      order_id TEXT NOT NULL UNIQUE,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KRW',
      status TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'test',
      card_brand TEXT,
      card_last4 TEXT,
      auth_code TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS integration_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      login_id_masked TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected',
      connected_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider_key)
    );

    CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_integration_accounts_user_id ON integration_accounts(user_id);
  `);

  return db;
}

function sanitizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function maskLoginId(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  if (text.includes('@')) {
    const parts = text.split('@');
    const name = parts[0];
    const domain = parts.slice(1).join('@');
    return `${name.slice(0, 2)}${'*'.repeat(Math.max(name.length - 2, 2))}@${domain}`;
  }

  if (text.length <= 3) {
    return `${text[0]}**`;
  }

  return `${text.slice(0, 2)}${'*'.repeat(Math.max(text.length - 4, 3))}${text.slice(-2)}`;
}

function publicUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    businessName: row.business_name || '',
    createdAt: row.created_at,
  };
}

function createUser({ email, name, businessName, password }) {
  const db = openAppDatabase();
  const passwordHash = bcrypt.hashSync(String(password || ''), 12);

  try {
    const result = db
      .prepare(
        `
          INSERT INTO users (email, name, business_name, password_hash)
          VALUES (@email, @name, @businessName, @passwordHash)
        `
      )
      .run({
        email: sanitizeEmail(email),
        name: String(name || '').trim(),
        businessName: String(businessName || '').trim(),
        passwordHash,
      });

    return findUserById(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

function findUserByEmail(email) {
  const db = openAppDatabase();

  try {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(sanitizeEmail(email));
  } finally {
    db.close();
  }
}

function findUserById(id) {
  const db = openAppDatabase();

  try {
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  } finally {
    db.close();
  }
}

function verifyUser(email, password) {
  const row = findUserByEmail(email);

  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    return null;
  }

  return publicUser(row);
}

function getCustomerProfile(userId) {
  const db = openAppDatabase();

  try {
    const row = db.prepare('SELECT * FROM customer_profiles WHERE user_id = ?').get(userId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      userId: row.user_id,
      companyName: row.company_name,
      ownerName: row.owner_name,
      businessNumber: row.business_number || '',
      phone: row.phone || '',
      email: row.email || '',
      address: row.address || '',
      memo: row.memo || '',
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

function upsertCustomerProfile(userId, input) {
  const db = openAppDatabase();
  const payload = {
    userId,
    companyName: String(input.companyName || '').trim(),
    ownerName: String(input.ownerName || '').trim(),
    businessNumber: String(input.businessNumber || '').trim(),
    phone: String(input.phone || '').trim(),
    email: String(input.email || '').trim(),
    address: String(input.address || '').trim(),
    memo: String(input.memo || '').trim(),
  };

  try {
    db.prepare(
      `
        INSERT INTO customer_profiles (
          user_id,
          company_name,
          owner_name,
          business_number,
          phone,
          email,
          address,
          memo
        ) VALUES (
          @userId,
          @companyName,
          @ownerName,
          @businessNumber,
          @phone,
          @email,
          @address,
          @memo
        )
        ON CONFLICT(user_id) DO UPDATE SET
          company_name = excluded.company_name,
          owner_name = excluded.owner_name,
          business_number = excluded.business_number,
          phone = excluded.phone,
          email = excluded.email,
          address = excluded.address,
          memo = excluded.memo,
          updated_at = CURRENT_TIMESTAMP
      `
    ).run(payload);
  } finally {
    db.close();
  }

  return getCustomerProfile(userId);
}

function createPayment(userId, input) {
  const db = openAppDatabase();
  const customer = getCustomerProfile(userId);
  const now = new Date().toISOString();
  const orderId = `ORDER-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const authCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const payment = {
    userId,
    customerProfileId: customer ? customer.id : null,
    orderId,
    amount: Number(input.amount) || 0,
    currency: 'KRW',
    status: 'paid',
    provider: 'test',
    cardBrand: input.cardBrand || '카드',
    cardLast4: input.cardLast4 || '',
    authCode,
    paidAt: now,
  };

  try {
    const result = db
      .prepare(
        `
          INSERT INTO payments (
            user_id,
            customer_profile_id,
            order_id,
            amount,
            currency,
            status,
            provider,
            card_brand,
            card_last4,
            auth_code,
            paid_at
          ) VALUES (
            @userId,
            @customerProfileId,
            @orderId,
            @amount,
            @currency,
            @status,
            @provider,
            @cardBrand,
            @cardLast4,
            @authCode,
            @paidAt
          )
        `
      )
      .run(payment);

    return getPaymentById(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

function getPaymentById(id) {
  const db = openAppDatabase();

  try {
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      userId: row.user_id,
      orderId: row.order_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      provider: row.provider,
      cardBrand: row.card_brand || '',
      cardLast4: row.card_last4 || '',
      authCode: row.auth_code || '',
      paidAt: row.paid_at,
      createdAt: row.created_at,
    };
  } finally {
    db.close();
  }
}

function listPayments(userId, limit = 10) {
  const db = openAppDatabase();

  try {
    return db
      .prepare(
        `
          SELECT
            id,
            order_id AS orderId,
            amount,
            currency,
            status,
            provider,
            card_brand AS cardBrand,
            card_last4 AS cardLast4,
            auth_code AS authCode,
            paid_at AS paidAt,
            created_at AS createdAt
          FROM payments
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(userId, Math.min(Number(limit) || 10, 50));
  } finally {
    db.close();
  }
}

function listIntegrationAccounts(userId) {
  const db = openAppDatabase();

  try {
    return db
      .prepare(
        `
          SELECT
            provider_key AS providerKey,
            login_id_masked AS loginIdMasked,
            status,
            connected_at AS connectedAt,
            updated_at AS updatedAt
          FROM integration_accounts
          WHERE user_id = ?
        `
      )
      .all(userId)
      .reduce((map, row) => {
        map[row.providerKey] = row;
        return map;
      }, {});
  } finally {
    db.close();
  }
}

function upsertIntegrationAccount(userId, input) {
  const db = openAppDatabase();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `
        INSERT INTO integration_accounts (
          user_id,
          provider_key,
          login_id_masked,
          status,
          connected_at
        ) VALUES (
          @userId,
          @providerKey,
          @loginIdMasked,
          'connected',
          @connectedAt
        )
        ON CONFLICT(user_id, provider_key) DO UPDATE SET
          login_id_masked = excluded.login_id_masked,
          status = 'connected',
          connected_at = excluded.connected_at,
          updated_at = CURRENT_TIMESTAMP
      `
    ).run({
      userId,
      providerKey: input.providerKey,
      loginIdMasked: maskLoginId(input.loginId),
      connectedAt: now,
    });
  } finally {
    db.close();
  }

  return listIntegrationAccounts(userId)[input.providerKey];
}

module.exports = {
  createPayment,
  createUser,
  findUserById,
  getCustomerProfile,
  getPaymentById,
  listPayments,
  listIntegrationAccounts,
  maskLoginId,
  openAppDatabase,
  resolveAppDbPath,
  upsertIntegrationAccount,
  upsertCustomerProfile,
  verifyUser,
};
