var express = require('express');
var router = express.Router();

var appRepository = require('../db/appRepository');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
    return;
  }

  next();
}

function parseAmount(value) {
  var digits = String(value || '').replace(/[^0-9]/g, '');
  return Number(digits) || 0;
}

function normalizeCardNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function luhnCheck(cardNumber) {
  var sum = 0;
  var shouldDouble = false;

  for (var index = cardNumber.length - 1; index >= 0; index -= 1) {
    var digit = Number(cardNumber[index]);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function parseExpiry(value) {
  var match = String(value || '').trim().match(/^(\d{2})\s*\/?\s*(\d{2})$/);

  if (!match) {
    return null;
  }

  var month = Number(match[1]);
  var year = 2000 + Number(match[2]);

  if (month < 1 || month > 12) {
    return null;
  }

  return { month: month, year: year };
}

function isFutureExpiry(expiry) {
  if (!expiry) {
    return false;
  }

  var now = new Date();
  var endOfMonth = new Date(expiry.year, expiry.month, 0, 23, 59, 59, 999);
  return endOfMonth >= now;
}

function detectCardBrand(cardNumber) {
  if (/^4/.test(cardNumber)) {
    return 'Visa';
  }

  if (/^5[1-5]/.test(cardNumber) || /^2[2-7]/.test(cardNumber)) {
    return 'Mastercard';
  }

  if (/^3[47]/.test(cardNumber)) {
    return 'American Express';
  }

  if (/^9/.test(cardNumber)) {
    return 'Local Card';
  }

  return 'Card';
}

function renderCustomer(res, values, errors) {
  res.status(errors.length ? 400 : 200).render('checkout/customer', {
    title: '고객정보 입력',
    values: values || {},
    errors: errors || [],
  });
}

function renderPayment(res, values, errors) {
  res.status(errors.length ? 400 : 200).render('checkout/payment', {
    title: '카드 결제',
    values: values || {},
    errors: errors || [],
  });
}

router.use(requireAuth);

router.get('/', function(req, res) {
  var customer = appRepository.getCustomerProfile(req.session.userId);
  var payments = appRepository.listPayments(req.session.userId);

  res.render('checkout/dashboard', {
    title: '내 서비스',
    customer: customer,
    payments: payments,
  });
});

router.get('/customer', function(req, res) {
  renderCustomer(res, appRepository.getCustomerProfile(req.session.userId) || {}, []);
});

router.post('/customer', function(req, res, next) {
  var values = {
    companyName: String(req.body.companyName || '').trim(),
    ownerName: String(req.body.ownerName || '').trim(),
    businessNumber: String(req.body.businessNumber || '').trim(),
    phone: String(req.body.phone || '').trim(),
    email: String(req.body.email || '').trim(),
    address: String(req.body.address || '').trim(),
    memo: String(req.body.memo || '').trim(),
  };
  var errors = [];

  if (!values.companyName) {
    errors.push('상호명을 입력해 주세요.');
  }

  if (!values.ownerName) {
    errors.push('대표자명을 입력해 주세요.');
  }

  if (values.email && !values.email.includes('@')) {
    errors.push('고객 이메일 형식을 확인해 주세요.');
  }

  if (errors.length) {
    renderCustomer(res, values, errors);
    return;
  }

  try {
    appRepository.upsertCustomerProfile(req.session.userId, values);
    res.redirect('/checkout/payment');
  } catch (error) {
    next(error);
  }
});

router.get('/payment', function(req, res) {
  var customer = appRepository.getCustomerProfile(req.session.userId);

  if (!customer) {
    res.redirect('/checkout/customer');
    return;
  }

  renderPayment(res, { amount: '55000', cardHolder: customer.ownerName }, []);
});

router.post('/payment', function(req, res, next) {
  var customer = appRepository.getCustomerProfile(req.session.userId);

  if (!customer) {
    res.redirect('/checkout/customer');
    return;
  }

  var amount = parseAmount(req.body.amount);
  var cardNumber = normalizeCardNumber(req.body.cardNumber);
  var expiry = parseExpiry(req.body.expiry);
  var values = {
    amount: req.body.amount,
    cardHolder: String(req.body.cardHolder || '').trim(),
    expiry: String(req.body.expiry || '').trim(),
    installments: String(req.body.installments || '0'),
  };
  var errors = [];

  if (amount < 1000) {
    errors.push('결제금액은 1,000원 이상으로 입력해 주세요.');
  }

  if (!values.cardHolder) {
    errors.push('카드 소유자명을 입력해 주세요.');
  }

  if (cardNumber.length < 13 || cardNumber.length > 19 || !luhnCheck(cardNumber)) {
    errors.push('테스트 카드번호 형식을 확인해 주세요.');
  }

  if (!isFutureExpiry(expiry)) {
    errors.push('카드 유효기간을 MM/YY 형식으로 입력해 주세요.');
  }

  if (errors.length) {
    renderPayment(res, values, errors);
    return;
  }

  try {
    var payment = appRepository.createPayment(req.session.userId, {
      amount: amount,
      cardBrand: detectCardBrand(cardNumber),
      cardLast4: cardNumber.slice(-4),
    });

    res.redirect('/integrations?paymentId=' + encodeURIComponent(payment.id));
  } catch (error) {
    next(error);
  }
});

router.get('/payment/:id', function(req, res, next) {
  try {
    var payment = appRepository.getPaymentById(req.params.id);

    if (!payment || payment.userId !== req.session.userId) {
      res.status(404).render('error', {
        message: '결제 내역을 찾을 수 없습니다.',
        error: {},
      });
      return;
    }

    res.render('checkout/payment-result', {
      title: '결제 완료',
      payment: payment,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
