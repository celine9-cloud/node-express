var express = require('express');
var router = express.Router();
var salesRepository = require('../db/salesRepository');

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  var next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildDashboard() {
  var now = new Date();
  var today = formatDate(now);
  var monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  var monthEnd = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  var todaySummary = salesRepository.getSalesSummary({ from: today, to: today });
  var monthSummary = salesRepository.getSalesSummary({ from: monthStart, to: monthEnd });
  var recentSales = salesRepository.listSales({ limit: 3 });
  var expectedDeposit = salesRepository.getSalesSummary({
    from: today,
    to: formatDate(addDays(now, 3)),
  });
  var monthRevenue = Number(monthSummary.approvalAmount || 0);
  var monthFee = Number(monthSummary.feeAmount || 0);
  var monthProfit = monthRevenue - monthFee;

  return {
    todaySales: Number(todaySummary.approvalAmount || 0),
    expectedDeposit: Number(expectedDeposit.depositAmount || 0),
    recentSales: recentSales,
    monthLabel: `${now.getMonth() + 1}월`,
    monthProfit: monthProfit,
    monthForecast: Math.round(monthRevenue * 1.12),
    newReviews: 3,
    news: [
      '부가세 신고 전 카드매출 누락 여부를 확인하세요.',
      '배달앱 정산 주기가 달라 입금 예정일을 함께 봐야 해요.',
      '소상공인 정책자금 접수 공고가 업데이트됐어요.',
    ],
  };
}

/* GET home page. */
router.get('/', function(req, res, next) {
  try {
    res.render('index', {
      title: '자영업 장부',
      dashboard: buildDashboard(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
