const crypto = require('crypto');

const TOSS_API_BASE_URL = process.env.TOSS_PAYOUT_API_BASE_URL || 'https://api.tosspayments.com';
const DEFAULT_PHONE = process.env.TOSS_PAYOUT_DEFAULT_PHONE || '01000000000';
const DEFAULT_EMAIL = process.env.TOSS_PAYOUT_DEFAULT_EMAIL || 'partner@example.com';

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function compactDate() {
  const date = new Date();
  const offsetMs = 9 * 60 * 60 * 1000;
  return new Date(date.getTime() + offsetMs).toISOString().replace('Z', '+09:00');
}

function createBasicAuth(secretKey) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

function normalizeDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function parseAmount(value) {
  return Number(normalizeDigits(value));
}

function maskAccountNumber(value) {
  const digits = normalizeDigits(value);

  if (digits.length <= 5) {
    return digits ? `${digits.slice(0, 2)}***` : '';
  }

  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(digits.length - 6, 3))}${digits.slice(-3)}`;
}

function validateTransferInput(input) {
  const errors = [];
  const amount = parseAmount(input.amount);
  const accountNumber = normalizeDigits(input.accountNumber);
  const bankCode = normalizeDigits(input.bankCode);
  const holderName = String(input.holderName || '').trim();
  const recipientName = String(input.recipientName || holderName).trim();
  const transactionDescription = String(input.transactionDescription || '오직송금').trim().slice(0, 7);

  if (!recipientName) {
    errors.push('거래처명을 입력해 주세요.');
  }

  if (!bankCode || bankCode.length < 2 || bankCode.length > 3) {
    errors.push('은행 코드는 2~3자리 숫자로 입력해 주세요.');
  }

  if (!accountNumber || accountNumber.length < 8 || accountNumber.length > 20) {
    errors.push('계좌번호는 숫자 8~20자리로 입력해 주세요.');
  }

  if (!holderName) {
    errors.push('예금주명을 입력해 주세요.');
  }

  if (!amount || amount < 1000) {
    errors.push('송금 금액은 1,000원 이상으로 입력해 주세요.');
  }

  if (amount >= 1000000000) {
    errors.push('토스페이먼츠 지급대행 1건 금액은 10억 원 미만이어야 합니다.');
  }

  return {
    errors,
    value: {
      recipientName,
      bankCode,
      accountNumber,
      accountNumberMasked: maskAccountNumber(accountNumber),
      holderName,
      amount,
      transactionDescription,
      recipientEmail: String(input.recipientEmail || DEFAULT_EMAIL).trim(),
      recipientPhone: normalizeDigits(input.recipientPhone || DEFAULT_PHONE),
      memo: String(input.memo || '').trim(),
      scheduleType: input.scheduleType === 'SCHEDULED' ? 'SCHEDULED' : 'EXPRESS',
      payoutDate: String(input.payoutDate || '').trim(),
    },
  };
}

function getSecurityKeyBuffer(securityKey) {
  const key = String(securityKey || '').trim();

  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('TOSS_PAYOUT_SECURITY_KEY must be a 64-character hexadecimal string.');
  }

  return Buffer.from(key, 'hex');
}

function encryptJwe(payload, securityKey) {
  const key = getSecurityKeyBuffer(securityKey);
  const header = {
    alg: 'dir',
    enc: 'A256GCM',
    iat: compactDate(),
    nonce: crypto.randomUUID(),
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  cipher.setAAD(Buffer.from(encodedHeader));

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    encodedHeader,
    '',
    base64UrlEncode(iv),
    base64UrlEncode(ciphertext),
    base64UrlEncode(tag),
  ].join('.');
}

function decryptJwe(compactJwe, securityKey) {
  const key = getSecurityKeyBuffer(securityKey);
  const parts = String(compactJwe || '').split('.');

  if (parts.length !== 5) {
    throw new Error('Invalid JWE response format.');
  }

  const [encodedHeader, encryptedKey, encodedIv, encodedCiphertext, encodedTag] = parts;
  if (encryptedKey !== '') {
    throw new Error('Unsupported JWE encrypted key.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, base64UrlDecode(encodedIv));
  decipher.setAAD(Buffer.from(encodedHeader));
  decipher.setAuthTag(base64UrlDecode(encodedTag));

  const plaintext = Buffer.concat([
    decipher.update(base64UrlDecode(encodedCiphertext)),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext);
}

function buildSellerPayload(input, refSellerId) {
  return {
    refSellerId,
    businessType: 'INDIVIDUAL',
    individual: {
      name: input.recipientName,
      email: input.recipientEmail,
      phone: input.recipientPhone,
    },
    account: {
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      holderName: input.holderName,
    },
    metadata: {
      service: 'ogik',
      memo: input.memo.slice(0, 200),
    },
  };
}

function buildPayoutPayload(input, sellerId, refPayoutId) {
  return {
    refPayoutId,
    destination: sellerId,
    scheduleType: input.scheduleType,
    ...(input.scheduleType === 'SCHEDULED' ? { payoutDate: input.payoutDate } : {}),
    amount: {
      currency: 'KRW',
      value: input.amount,
    },
    transactionDescription: input.transactionDescription,
    metadata: {
      service: 'ogik',
      memo: input.memo.slice(0, 200),
    },
  };
}

async function postEncrypted(path, payload, config) {
  const encryptedRequest = encryptJwe(payload, config.securityKey);
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: createBasicAuth(config.secretKey),
      'Content-Type': 'text/plain',
      'TossPayments-api-security-mode': 'ENCRYPTION',
    },
    body: encryptedRequest,
  });
  const encryptedResponse = await response.text();
  const parsedResponse = decryptJwe(encryptedResponse, config.securityKey);

  if (!response.ok) {
    const error = new Error(parsedResponse.message || 'Toss Payments payout request failed.');
    error.response = parsedResponse;
    error.status = response.status;
    throw error;
  }

  return parsedResponse;
}

function shouldUseDemoMode(config) {
  return config.demoMode || !config.secretKey || !config.securityKey;
}

async function requestPayout(input, options = {}) {
  const normalized = validateTransferInput(input);

  if (normalized.errors.length) {
    return {
      ok: false,
      mode: 'validation',
      errors: normalized.errors,
      input: normalized.value,
    };
  }

  const value = normalized.value;
  const refSellerId = options.refSellerId || `ogik-seller-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const refPayoutId = options.refPayoutId || `ogik-payout-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const sellerPayload = buildSellerPayload(value, refSellerId);
  const config = {
    secretKey: options.secretKey || process.env.TOSS_PAYOUT_SECRET_KEY,
    securityKey: options.securityKey || process.env.TOSS_PAYOUT_SECURITY_KEY,
    apiBaseUrl: options.apiBaseUrl || TOSS_API_BASE_URL,
    demoMode: options.demoMode || process.env.TOSS_PAYOUT_DEMO_MODE !== 'false',
  };

  if (shouldUseDemoMode(config)) {
    const demoSellerId = `seller_demo_${refSellerId.slice(-12)}`;
    const payoutPayload = buildPayoutPayload(value, demoSellerId, refPayoutId);

    return {
      ok: true,
      mode: 'demo',
      status: 'REQUESTED',
      sellerId: demoSellerId,
      payoutId: `payout_demo_${refPayoutId.slice(-12)}`,
      refSellerId,
      refPayoutId,
      input: value,
      accountNumberMasked: value.accountNumberMasked,
      sellerPayload: Object.assign({}, sellerPayload, {
        account: Object.assign({}, sellerPayload.account, {
          accountNumber: value.accountNumberMasked,
        }),
      }),
      payoutPayload,
      response: {
        message: 'Demo payout request recorded. Set Toss Payments payout keys to send a live request.',
      },
    };
  }

  const sellerResponse = await postEncrypted('/v2/sellers', sellerPayload, config);
  const seller = sellerResponse.entityBody || sellerResponse;
  const sellerId = seller.id;

  if (!sellerId) {
    throw new Error('Toss Payments seller registration response did not include seller id.');
  }

  const payoutPayload = buildPayoutPayload(value, sellerId, refPayoutId);
  const payoutResponse = await postEncrypted('/v2/payouts', [payoutPayload], config);
  const items = payoutResponse.entityBody && payoutResponse.entityBody.items ? payoutResponse.entityBody.items : [];
  const payout = items[0] || payoutResponse.entityBody || payoutResponse;

  return {
    ok: true,
    mode: 'live',
    status: payout.status || 'REQUESTED',
    sellerId,
    payoutId: payout.id || '',
    refSellerId,
    refPayoutId,
    input: value,
    accountNumberMasked: value.accountNumberMasked,
    sellerPayload: Object.assign({}, sellerPayload, {
      account: Object.assign({}, sellerPayload.account, {
        accountNumber: value.accountNumberMasked,
      }),
    }),
    payoutPayload,
    response: payoutResponse,
  };
}

module.exports = {
  buildPayoutPayload,
  buildSellerPayload,
  decryptJwe,
  encryptJwe,
  maskAccountNumber,
  parseAmount,
  requestPayout,
  validateTransferInput,
};
