var express = require('express');
var router = express.Router();

var salesRepository = require('../db/salesRepository');

function readFilters(req) {
  return {
    from: req.query.from || '',
    to: req.query.to || '',
  };
}

router.get('/', function(req, res, next) {
  try {
    var filters = readFilters(req);
    var summary = salesRepository.getSalesSummary(filters);
    var daily = salesRepository.groupSalesByDay(filters);
    var monthly = salesRepository.groupSalesByMonth(filters);
    var rows = salesRepository.listSales(Object.assign({}, filters, { limit: 100 }));

    res.render('sales', {
      title: '매출 장부',
      filters: filters,
      summary: summary,
      daily: daily,
      monthly: monthly,
      rows: rows,
      dbPath: salesRepository.resolveDbPath(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api', function(req, res, next) {
  try {
    var filters = readFilters(req);

    res.json({
      filters: filters,
      summary: salesRepository.getSalesSummary(filters),
      daily: salesRepository.groupSalesByDay(filters),
      monthly: salesRepository.groupSalesByMonth(filters),
      rows: salesRepository.listSales(Object.assign({}, filters, { limit: req.query.limit || 100 })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
