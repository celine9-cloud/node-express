var express = require('express');
var router = express.Router();

var appRepository = require('../db/appRepository');

function renderSignup(res, values, errors) {
  res.status(errors.length ? 400 : 200).render('auth/signup', {
    title: '회원가입',
    values: values || {},
    errors: errors || [],
  });
}

function renderLogin(res, values, errors) {
  res.status(errors.length ? 400 : 200).render('auth/login', {
    title: '로그인',
    values: values || {},
    errors: errors || [],
  });
}

function renderTerms(res, values, errors) {
  res.status(errors.length ? 400 : 200).render('auth/terms', {
    title: '약관 동의',
    values: values || {},
    errors: errors || [],
  });
}

function signIn(req, user, callback) {
  req.session.regenerate(function(error) {
    if (error) {
      callback(error);
      return;
    }

    req.session.userId = user.id;
    req.session.save(callback);
  });
}

function termsFromSession(req) {
  return req.session.termsConsent || {};
}

function hasRequiredTerms(source) {
  return Boolean(source.termsAccepted && source.privacyAccepted);
}

function kakaoRedirectUri(req) {
  return process.env.KAKAO_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/kakao/callback`;
}

async function fetchKakaoProfile(req) {
  var tokenResponse = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.KAKAO_CLIENT_ID,
      redirect_uri: kakaoRedirectUri(req),
      code: req.query.code,
      ...(process.env.KAKAO_CLIENT_SECRET ? { client_secret: process.env.KAKAO_CLIENT_SECRET } : {}),
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error('카카오 토큰 발급에 실패했습니다.');
  }

  var token = await tokenResponse.json();
  var profileResponse = await fetch('https://kapi.kakao.com/v2/user/me', {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  if (!profileResponse.ok) {
    throw new Error('카카오 사용자 정보를 불러오지 못했습니다.');
  }

  return profileResponse.json();
}

function createKakaoUserFromProfile(profile, consent) {
  var account = profile.kakao_account || {};
  var profileInfo = account.profile || {};

  return appRepository.findOrCreateKakaoUser({
    kakaoId: profile.id || `dev-${Date.now()}`,
    email: account.email || `kakao-${profile.id}@kakao.local`,
    name: profileInfo.nickname || account.name || '카카오 사용자',
    termsAccepted: consent.termsAccepted,
    privacyAccepted: consent.privacyAccepted,
    marketingAccepted: consent.marketingAccepted,
  });
}

router.get('/signup', function(req, res) {
  renderSignup(res, {}, []);
});

router.post('/signup', function(req, res, next) {
  var values = {
    email: String(req.body.email || '').trim(),
    name: String(req.body.name || '').trim(),
    businessName: String(req.body.businessName || '').trim(),
    termsAccepted: req.body.termsAccepted === 'on',
    privacyAccepted: req.body.privacyAccepted === 'on',
    marketingAccepted: req.body.marketingAccepted === 'on',
  };
  var password = String(req.body.password || '');
  var errors = [];

  if (!values.email || !values.email.includes('@')) {
    errors.push('이메일을 정확히 입력해 주세요.');
  }

  if (!values.name) {
    errors.push('이름을 입력해 주세요.');
  }

  if (password.length < 8) {
    errors.push('비밀번호는 8자 이상으로 입력해 주세요.');
  }

  if (!values.termsAccepted || !values.privacyAccepted) {
    errors.push('서비스 이용약관과 개인정보 처리방침에 동의해 주세요.');
  }

  if (errors.length) {
    renderSignup(res, values, errors);
    return;
  }

  try {
    var user = appRepository.createUser({
      email: values.email,
      name: values.name,
      businessName: values.businessName,
      password: password,
      termsAccepted: values.termsAccepted,
      privacyAccepted: values.privacyAccepted,
      marketingAccepted: values.marketingAccepted,
    });

    signIn(req, user, function(error) {
      if (error) {
        next(error);
        return;
      }

      res.redirect('/checkout/customer');
    });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      renderSignup(res, values, ['이미 가입된 이메일입니다. 로그인해 주세요.']);
      return;
    }

    next(error);
  }
});

router.get('/terms', function(req, res) {
  renderTerms(res, {
    provider: req.query.provider || 'email',
    next: req.query.next || '',
  }, []);
});

router.post('/terms', function(req, res) {
  var values = {
    provider: req.body.provider || 'email',
    next: req.body.next || '',
    termsAccepted: req.body.termsAccepted === 'on',
    privacyAccepted: req.body.privacyAccepted === 'on',
    marketingAccepted: req.body.marketingAccepted === 'on',
  };

  if (!hasRequiredTerms(values)) {
    renderTerms(res, values, ['서비스 이용약관과 개인정보 처리방침에 동의해 주세요.']);
    return;
  }

  req.session.termsConsent = values;

  if (values.provider === 'kakao') {
    res.redirect('/auth/kakao');
    return;
  }

  res.redirect('/auth/signup');
});

router.get('/kakao', function(req, res, next) {
  var consent = termsFromSession(req);

  if (!hasRequiredTerms(consent)) {
    res.redirect('/auth/terms?provider=kakao');
    return;
  }

  if (!process.env.KAKAO_CLIENT_ID) {
    var devUser = appRepository.findOrCreateKakaoUser({
      kakaoId: 'dev-kakao-user',
      email: 'kakao-demo@example.com',
      name: '카카오 데모',
      termsAccepted: consent.termsAccepted,
      privacyAccepted: consent.privacyAccepted,
      marketingAccepted: consent.marketingAccepted,
    });

    signIn(req, devUser, function(error) {
      if (error) {
        next(error);
        return;
      }

      res.redirect(consent.next || '/checkout');
    });
    return;
  }

  req.session.kakaoState = require('crypto').randomBytes(12).toString('hex');
  req.session.save(function(error) {
    if (error) {
      next(error);
      return;
    }

    var params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.KAKAO_CLIENT_ID,
      redirect_uri: kakaoRedirectUri(req),
      state: req.session.kakaoState,
    });

    res.redirect(`https://kauth.kakao.com/oauth/authorize?${params.toString()}`);
  });
});

router.get('/kakao/callback', async function(req, res, next) {
  try {
    if (req.session.kakaoState && req.query.state !== req.session.kakaoState) {
      throw new Error('카카오 로그인 상태값이 맞지 않습니다.');
    }

    var consent = termsFromSession(req);
    if (!hasRequiredTerms(consent)) {
      res.redirect('/auth/terms?provider=kakao');
      return;
    }

    var profile = await fetchKakaoProfile(req);
    var user = createKakaoUserFromProfile(profile, consent);

    signIn(req, user, function(error) {
      if (error) {
        next(error);
        return;
      }

      res.redirect(consent.next || '/checkout');
    });
  } catch (error) {
    next(error);
  }
});

router.get('/login', function(req, res) {
  renderLogin(res, { next: req.query.next || '' }, []);
});

router.post('/login', function(req, res, next) {
  var values = {
    email: String(req.body.email || '').trim(),
    next: String(req.body.next || ''),
  };
  var user = appRepository.verifyUser(values.email, req.body.password);

  if (!user) {
    renderLogin(res, values, ['이메일 또는 비밀번호가 맞지 않습니다.']);
    return;
  }

  signIn(req, user, function(error) {
    if (error) {
      next(error);
      return;
    }

    res.redirect(values.next || '/checkout');
  });
});

router.post('/logout', function(req, res, next) {
  req.session.destroy(function(error) {
    if (error) {
      next(error);
      return;
    }

    res.redirect('/');
  });
});

module.exports = router;
