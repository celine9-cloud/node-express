require('dotenv').config({ quiet: true });

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');

var appRepository = require('./db/appRepository');
var authRouter = require('./routes/auth');
var checkoutRouter = require('./routes/checkout');
var indexRouter = require('./routes/index');
var integrationsRouter = require('./routes/integrations');
var salesRouter = require('./routes/sales');
var transfersRouter = require('./routes/transfers');
var usersRouter = require('./routes/users');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  name: 'ledger.sid',
  secret: process.env.SESSION_SECRET || 'local-development-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));
app.use(function(req, res, next) {
  res.locals.currentUser = req.session.userId ? appRepository.findUserById(req.session.userId) : null;
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/auth', authRouter);
app.use('/checkout', checkoutRouter);
app.use('/integrations', integrationsRouter);
app.use('/sales', salesRouter);
app.use('/transfers', transfersRouter);
app.use('/users', usersRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
