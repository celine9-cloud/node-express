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

router.get('/signup', function(req, res) {
  renderSignup(res, {}, []);
});

router.post('/signup', function(req, res, next) {
  var values = {
    email: String(req.body.email || '').trim(),
    name: String(req.body.name || '').trim(),
    businessName: String(req.body.businessName || '').trim(),
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
