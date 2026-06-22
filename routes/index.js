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

function formatKoreanDate(date) {
  var weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${weekdays[date.getDay()]}요일`;
}

function weatherInfoFromCode(code) {
  var map = {
    0: ['맑음', '☀️'],
    1: ['대체로 맑음', '🌤️'],
    2: ['구름 조금', '⛅'],
    3: ['흐림', '☁️'],
    45: ['안개', '🌫️'],
    48: ['서리 안개', '🌫️'],
    51: ['약한 이슬비', '🌦️'],
    53: ['이슬비', '🌦️'],
    55: ['강한 이슬비', '🌧️'],
    61: ['약한 비', '🌧️'],
    63: ['비', '🌧️'],
    65: ['강한 비', '🌧️'],
    71: ['약한 눈', '🌨️'],
    73: ['눈', '🌨️'],
    75: ['강한 눈', '❄️'],
    80: ['소나기', '🌦️'],
    81: ['소나기', '🌦️'],
    82: ['강한 소나기', '⛈️'],
    95: ['뇌우', '⛈️'],
  };

  return map[code] || ['날씨 확인 중', '🌡️'];
}

async function fetchWeather() {
  var city = process.env.WEATHER_CITY_NAME || '서울';
  var latitude = process.env.WEATHER_LATITUDE || '37.5665';
  var longitude = process.env.WEATHER_LONGITUDE || '126.9780';
  var params = new URLSearchParams({
    latitude: latitude,
    longitude: longitude,
    current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
    timezone: 'Asia/Seoul',
  });
  var controller = new AbortController();
  var timeout = setTimeout(function() {
    controller.abort();
  }, Number(process.env.WEATHER_TIMEOUT_MS || 1500));

  try {
    var response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error('Weather API request failed');
    }

    var payload = await response.json();
    var current = payload.current || {};
    var info = weatherInfoFromCode(current.weather_code);

    return {
      available: true,
      city: city,
      condition: info[0],
      icon: info[1],
      temperature: Math.round(Number(current.temperature_2m)),
      humidity: Math.round(Number(current.relative_humidity_2m)),
      windSpeed: Math.round(Number(current.wind_speed_10m)),
      updatedAt: current.time || '',
      source: 'Open-Meteo',
    };
  } catch (error) {
    return {
      available: false,
      city: city,
      condition: '날씨 정보를 불러오지 못했어요',
      icon: '🌡️',
      temperature: null,
      humidity: null,
      windSpeed: null,
      updatedAt: '',
      source: 'Open-Meteo',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildDashboard() {
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
    dateLabel: formatKoreanDate(now),
    storeName: process.env.DASHBOARD_STORE_NAME || '오직상점',
    todaySales: Number(todaySummary.approvalAmount || 0),
    expectedDeposit: Number(expectedDeposit.depositAmount || 0),
    weather: await fetchWeather(),
    recentSales: recentSales,
    monthLabel: `${now.getMonth() + 1}월`,
    monthProfit: monthProfit,
    monthForecast: Math.round(monthRevenue * 1.12),
    newReviews: 3,
    todoCards: [
      {
        title: '매출 연동',
        description: '카드·배달앱 데이터를 연결해요',
        href: '/integrations',
        badge: '필요',
      },
      {
        title: '입금 요청',
        description: '거래처 계좌로 지급 요청',
        href: '/transfers',
        badge: '데모',
      },
      {
        title: '리뷰 확인',
        description: '새 리뷰 3개가 도착했어요',
        href: '#reviews',
        badge: '3',
      },
    ],
    news: [
      '부가세 신고 전 카드매출 누락 여부를 확인하세요.',
      '배달앱 정산 주기가 달라 입금 예정일을 함께 봐야 해요.',
      '소상공인 정책자금 접수 공고가 업데이트됐어요.',
    ],
  };
}

/* GET home page. */
router.get('/', async function(req, res, next) {
  try {
    if (!req.session.userId) {
      res.render('home/guest', {
        title: '오직(ogik) 로그인',
      });
      return;
    }

    res.render('home/dashboard', {
      title: '오직(ogik)',
      dashboard: await buildDashboard(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
