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
    accountNumber: '',
    holderName: '',
    amount: '',
    transactionDescription: '오직송금',
    memo: '',
    recipientEmail: '',
    recipientPhone: '',
  };
}

function renderTransferForm(req, res, values, errors, result) {
  res.status(errors.length ? 400 : 200).render('transfers/index', {
    title: '송금 요청',
    values: values || emptyValues(),
    errors: errors || [],
    result: result || null,
    transfers: appRepository.listTransferRequests(req.session.userId),
    demoMode: process.env.TOSS_PAYOUT_DEMO_MODE !== 'false' || !process.env.TOSS_PAYOUT_SECRET_KEY,
  });
}

router.use(requireAuth);

router.get('/', function(req, res) {
  renderTransferForm(req, res, emptyValues(), [], null);
});

router.post('/', async function(req, res, next) {
  var values = {
    recipientName: String(req.body.recipientName || '').trim(),
    bankCode: String(req.body.bankCode || '').trim(),
    accountNumber: String(req.body.accountNumber || '').trim(),
    holderName: String(req.body.holderName || '').trim(),
    amount: String(req.body.amount || '').trim(),
    transactionDescription: String(req.body.transactionDescription || '오직송금').trim(),
    memo: String(req.body.memo || '').trim(),
    recipientEmail: String(req.body.recipientEmail || '').trim(),
    recipientPhone: String(req.body.recipientPhone || '').trim(),
  };

  try {
    var payoutResult = await tossPayoutClient.requestPayout(values);

    if (!payoutResult.ok) {
      renderTransferForm(req, res, values, payoutResult.errors, null);
      return;
    }

    var saved = appRepository.createTransferRequest(req.session.userId, payoutResult.input, payoutResult);

    renderTransferForm(req, res, emptyValues(), [], {
      transfer: saved,
      response: payoutResult.response,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
