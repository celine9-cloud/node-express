var express = require('express');
var router = express.Router();

var appRepository = require('../db/appRepository');

var PROVIDERS = [
  {
    key: 'creditfinance',
    name: '여신금융협회',
    shortName: '여',
    category: '카드매출',
    description: '카드 승인, 매입, 입금 데이터를 불러옵니다.',
    accent: 'from-blue-500 to-indigo-500',
  },
  {
    key: 'baemin',
    name: '배달의민족',
    shortName: '배',
    category: '배달앱',
    description: '배민 주문과 정산 내역을 장부에 연결합니다.',
    accent: 'from-cyan-400 to-sky-500',
  },
  {
    key: 'yogiyo',
    name: '요기요',
    shortName: '요',
    category: '배달앱',
    description: '요기요 매출과 수수료 데이터를 연결합니다.',
    accent: 'from-rose-400 to-red-500',
  },
  {
    key: 'coupang',
    name: '쿠팡이츠',
    shortName: '쿠',
    category: '배달앱',
    description: '쿠팡이츠 주문과 정산 내역을 가져옵니다.',
    accent: 'from-violet-500 to-purple-600',
  },
];

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
    return;
  }

  next();
}

function getProvider(key) {
  return PROVIDERS.find(function(provider) {
    return provider.key === key;
  });
}

function buildProviders(userId) {
  var accounts = appRepository.listIntegrationAccounts(userId);

  return PROVIDERS.map(function(provider) {
    var account = accounts[provider.key];

    return Object.assign({}, provider, {
      status: account ? account.status : 'needed',
      connected: Boolean(account),
      loginIdMasked: account ? account.loginIdMasked : '',
      connectedAt: account ? account.connectedAt : '',
    });
  });
}

router.use(requireAuth);

router.get('/', function(req, res) {
  var providers = buildProviders(req.session.userId);
  var completedCount = providers.filter(function(provider) {
    return provider.connected;
  }).length;

  res.render('integrations/index', {
    title: '서비스 연동',
    providers: providers,
    completedCount: completedCount,
    totalCount: providers.length,
    justPaid: Boolean(req.query.paymentId),
    connectedProvider: req.query.connected || '',
    errors: [],
  });
});

router.post('/:providerKey', function(req, res, next) {
  var provider = getProvider(req.params.providerKey);

  if (!provider) {
    res.status(404).render('error', {
      message: '연동 서비스를 찾을 수 없습니다.',
      error: {},
    });
    return;
  }

  var loginId = String(req.body.loginId || '').trim();
  var password = String(req.body.password || '');

  if (!loginId || !password) {
    var providers = buildProviders(req.session.userId);
    res.status(400).render('integrations/index', {
      title: '서비스 연동',
      providers: providers,
      completedCount: providers.filter(function(item) { return item.connected; }).length,
      totalCount: providers.length,
      justPaid: false,
      connectedProvider: '',
      errors: [provider.name + ' 아이디와 비밀번호를 입력해 주세요.'],
    });
    return;
  }

  try {
    appRepository.upsertIntegrationAccount(req.session.userId, {
      providerKey: provider.key,
      loginId: loginId,
    });

    res.redirect('/integrations?connected=' + encodeURIComponent(provider.key));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
