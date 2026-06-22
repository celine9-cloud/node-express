var express = require('express');
var router = express.Router();

var appRepository = require('../db/appRepository');
var tossPayoutClient = require('../services/tossPayoutClient');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
    return;
  }

  next();
}

function emptyValues() {
  return {
    recipientName: '',
    bankCode: '',
    bankName: '',
    bankConfidence: '',
    accountNumber: '',
    accountNumberMasked: '',
    holderName: '',
    amount: '',
    transactionDescription: '오직송금',
    memo: '',
    recipientEmail: '',
    recipientPhone: '',
  };
}

function transferDraft(req) {
  req.session.transferDraft = req.session.transferDraft || {};
  return req.session.transferDraft;
}

function demoMode() {
  return process.env.TOSS_PAYOUT_DEMO_MODE !== 'false' || !process.env.TOSS_PAYOUT_SECRET_KEY;
}

function normalizeDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function parseAmount(value) {
  return Number(normalizeDigits(value));
}

function formatValues(draft) {
  return Object.assign(emptyValues(), draft || {});
}

function validateRecipient(values) {
  var errors = [];
  var accountNumber = normalizeDigits(values.accountNumber);
  var inferredBank = tossPayoutClient.inferBankFromAccountNumber(accountNumber);

  if (!accountNumber || accountNumber.length < 8 || accountNumber.length > 20) {
    errors.push('계좌번호는 숫자 8~20자리로 입력해 주세요.');
  }

  return {
    errors: errors,
    value: {
      recipientName: `${inferredBank.name || '거래처'} 계좌`,
      bankCode: inferredBank.code,
      bankName: inferredBank.name,
      bankConfidence: inferredBank.confidence,
      accountNumber: accountNumber,
      accountNumberMasked: tossPayoutClient.maskAccountNumber(accountNumber),
      holderName: '계좌확인필요',
    },
  };
}

function validateAmount(values) {
  var errors = [];
  var amount = parseAmount(values.amount);
  var transactionDescription = String(values.transactionDescription || '오직송금').trim().slice(0, 7);

  if (!amount || amount < 1000) {
    errors.push('입금 금액은 1,000원 이상으로 입력해 주세요.');
  }

  if (amount >= 1000000000) {
    errors.push('토스페이먼츠 지급대행 1건 금액은 10억 원 미만이어야 합니다.');
  }

  return {
    errors: errors,
    value: {
      amount: amount,
      transactionDescription: transactionDescription,
      memo: String(values.memo || '').trim(),
      recipientEmail: String(values.recipientEmail || '').trim(),
      recipientPhone: normalizeDigits(values.recipientPhone || ''),
    },
  };
}

function ensureRecipient(req, res) {
  if (!req.session.transferDraft || !req.session.transferDraft.accountNumber) {
    res.redirect('/transfers/recipient');
    return false;
  }

  return true;
}

function ensureAmount(req, res) {
  if (!ensureRecipient(req, res)) {
    return false;
  }

  if (!req.session.transferDraft.amount) {
    res.redirect('/transfers/amount');
    return false;
  }

  return true;
}

function renderRecipient(req, res, values, errors) {
  res.status(errors.length ? 400 : 200).render('transfers/recipient', {
    title: '받는 계좌',
    values: values || formatValues(transferDraft(req)),
    errors: errors || [],
    transfers: appRepository.listTransferRequests(req.session.userId),
    step: 1,
  });
}

function renderAmount(req, res, values, errors) {
  res.status(errors.length ? 400 : 200).render('transfers/amount', {
    title: '입금 금액',
    values: values || formatValues(transferDraft(req)),
    errors: errors || [],
    step: 2,
  });
}

function renderConfirm(req, res, errors) {
  res.status(errors && errors.length ? 400 : 200).render('transfers/confirm', {
    title: '입금 확인',
    values: formatValues(transferDraft(req)),
    demoMode: demoMode(),
    errors: errors || [],
    step: 3,
  });
}

router.use(requireAuth);

router.get('/', function(req, res) {
  res.redirect('/transfers/recipient');
});

router.get('/recipient', function(req, res) {
  renderRecipient(req, res, formatValues(transferDraft(req)), []);
});

router.post('/recipient', function(req, res) {
  var values = {
    accountNumber: String(req.body.accountNumber || '').trim(),
  };
  var result = validateRecipient(values);

  if (result.errors.length) {
    renderRecipient(req, res, values, result.errors);
    return;
  }

  req.session.transferDraft = Object.assign({}, transferDraft(req), result.value);
  res.redirect('/transfers/amount');
});

router.get('/amount', function(req, res) {
  if (!ensureRecipient(req, res)) {
    return;
  }

  renderAmount(req, res, formatValues(transferDraft(req)), []);
});

router.post('/amount', function(req, res) {
  if (!ensureRecipient(req, res)) {
    return;
  }

  var values = Object.assign(formatValues(transferDraft(req)), {
    amount: String(req.body.amount || '').trim(),
    transactionDescription: String(req.body.transactionDescription || '오직송금').trim(),
    memo: String(req.body.memo || '').trim(),
    recipientEmail: String(req.body.recipientEmail || '').trim(),
    recipientPhone: String(req.body.recipientPhone || '').trim(),
  });
  var result = validateAmount(values);

  if (result.errors.length) {
    renderAmount(req, res, values, result.errors);
    return;
  }

  req.session.transferDraft = Object.assign({}, transferDraft(req), result.value);
  res.redirect('/transfers/confirm');
});

router.get('/confirm', function(req, res) {
  if (!ensureAmount(req, res)) {
    return;
  }

  renderConfirm(req, res, []);
});

router.post('/confirm', async function(req, res, next) {
  if (!ensureAmount(req, res)) {
    return;
  }

  try {
    if (!demoMode()) {
      renderConfirm(req, res, ['실제 지급대행은 예금주/셀러 KYC 검증 API 연동 후에만 요청할 수 있습니다.']);
      return;
    }

    var payoutResult = await tossPayoutClient.requestPayout(transferDraft(req));

    if (!payoutResult.ok) {
      renderAmount(req, res, formatValues(transferDraft(req)), payoutResult.errors);
      return;
    }

    var saved = appRepository.createTransferRequest(req.session.userId, payoutResult.input, payoutResult);

    delete req.session.transferDraft;
    res.redirect('/transfers/done/' + saved.id);
  } catch (error) {
    next(error);
  }
});

router.get('/done/:id', function(req, res, next) {
  try {
    var transfer = appRepository.getTransferRequestById(req.params.id);

    if (!transfer || transfer.userId !== req.session.userId) {
      res.status(404).render('error', {
        message: '입금 요청 내역을 찾을 수 없습니다.',
        error: {},
      });
      return;
    }

    res.render('transfers/done', {
      title: '입금 요청 완료',
      transfer: transfer,
      transfers: appRepository.listTransferRequests(req.session.userId),
      step: 4,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset', function(req, res) {
  delete req.session.transferDraft;
  res.redirect('/transfers/recipient');
});

module.exports = router;
