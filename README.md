# example-node-express

Express 기본 앱에 Node.js + Playwright 기반 스크래핑 샘플을 함께 둔 예제입니다.

## Install

```bash
npm i
```

Playwright가 사용할 Chromium 브라우저를 설치합니다.

```bash
npm run playwright:install
```

## Running

```bash
npm start
```

## 사용자 화면: 회원가입, 로그인, 고객정보, 카드 결제

서버 실행 후 다음 화면을 사용할 수 있습니다.

```text
http://localhost:3000/auth/signup
http://localhost:3000/auth/login
http://localhost:3000/checkout
```

기본 흐름:

1. `/auth/signup`에서 회원가입
2. `/checkout/customer`에서 고객정보 입력
3. `/checkout/payment`에서 테스트 카드 결제
4. `/checkout`에서 최근 결제 내역 확인

앱 DB는 기본적으로 `data/app.sqlite`에 저장됩니다.

```env
APP_DB_PATH=data/app.sqlite
SESSION_SECRET=change-this-long-random-secret
```

카드 결제 화면은 실제 과금이 없는 테스트 승인 화면입니다. 카드번호는 서버에 저장하지 않고, 결제 기록에는
카드 브랜드와 끝 4자리만 저장합니다. 실제 서비스에서는 Toss Payments, PortOne, NICE Payments 같은
PG사의 결제창 또는 카드 토큰 SDK로 교체해야 합니다.

테스트 입력 예:

```text
카드번호: 4242 4242 4242 4242
유효기간: 미래 MM/YY
CVC: 임의 3자리
```

## 여신금융협회 카드매출 수집 샘플

`scripts/scrape-creditfinance.js`는 여신금융협회 가맹점 매출거래정보 통합조회시스템
(`https://www.cardsales.or.kr`)에서 본인 또는 명시적으로 권한을 받은 사업자 계정의 매출 데이터를
가져오기 위한 Playwright 기본 예시입니다.

중요한 원칙:

- 보안문자, 공동인증서, OTP, MFA 같은 인증 절차를 우회하지 않습니다.
- 첫 로그인과 추가 인증은 열린 브라우저에서 사람이 직접 완료합니다.
- 아이디/비밀번호를 코드에 저장하지 않습니다.
- 세션 파일(`.auth/`)과 수집 결과(`data/`)는 `.gitignore`로 제외됩니다.
- 사이트 약관, robots 정책, 제공자가 허용한 사용 범위를 먼저 확인하세요. 공식 API나 엑셀 다운로드가
  제공된다면 화면 파싱보다 그 방식을 우선합니다.

### 1. 환경변수 파일 만들기

```bash
cp .env.example .env
```

처음에는 기본값으로 실행해도 됩니다. 실제 업무 화면의 URL이나 버튼/테이블 선택자가 바뀌면
브라우저 개발자도구에서 CSS 선택자를 확인해 `.env` 값을 조정합니다.

주로 바꾸는 값:

```env
CFIA_TARGET_URL=
CFIA_RESULT_TABLE_SELECTOR=table
CFIA_DATE_FROM_SELECTOR=
CFIA_DATE_TO_SELECTOR=
CFIA_SEARCH_BUTTON_SELECTOR=
CFIA_DOWNLOAD_SELECTOR=
```

`CFIA_DOWNLOAD_SELECTOR`를 설정하면 화면 테이블을 파싱하지 않고, 사이트가 제공하는 엑셀/CSV 다운로드
파일을 그대로 저장합니다.

### 2. 첫 실행: 브라우저에서 직접 로그인

```bash
npm run scrape:creditfinance
```

실행 후 Chromium 창이 열리면:

1. 여신금융협회 사이트에서 직접 로그인합니다.
2. 공동인증서/OTP/추가 인증이 있으면 직접 완료합니다.
3. 매출 조회 화면으로 이동해 기간을 선택하고 조회합니다.
4. 터미널에서 Enter를 눌러 결과를 저장합니다.

성공하면 다음 파일이 생성됩니다.

- `.auth/cardsales-state.json`: 다음 실행에 재사용할 로그인 세션
- `data/card-sales/creditfinance-sales-*.json`: 수집된 결과
- `data/ledger.sqlite`: 장부 화면에서 사용하는 SQLite DB

### 3. 기간과 출력 형식 지정

날짜 입력칸과 조회 버튼 선택자를 `.env`에 설정해 두면 CLI 인자로 기간을 넘길 수 있습니다.

```bash
npm run scrape:creditfinance -- --from=2026-06-01 --to=2026-06-30 --format=csv
```

지원 형식은 `json`, `csv`입니다.

DB 저장을 잠시 끄고 파일만 만들고 싶으면 `--no-db`를 붙입니다.

```bash
npm run scrape:creditfinance -- --no-db
```

### 4. 기존 JSON 결과를 DB로 가져오기

이미 저장된 JSON 파일이 있다면 import 명령으로 SQLite DB에 넣을 수 있습니다.

```bash
npm run import:sales -- data/card-sales/creditfinance-sales-2026-06-22.json
```

먼저 실제 컬럼명이 어떻게 잡혔는지 보고 싶으면 다음 명령을 실행합니다.

```bash
npm run inspect:sales -- data/card-sales/creditfinance-sales-2026-06-22.json
```

이 명령은 JSON 안의 컬럼 목록과 현재 DB 매핑 결과를 보여줍니다. 값이 `(empty)`로 나오면 아래 alias
환경변수에 실제 컬럼명을 추가하면 됩니다.

DB 경로는 기본적으로 `data/ledger.sqlite`입니다. 바꾸고 싶으면 `.env`에 설정합니다.

```env
SALES_DB_PATH=data/ledger.sqlite
```

실제 파일의 컬럼명이 기본 매핑과 다르면 `.env`에서 후보 컬럼명을 추가합니다. 쉼표로 여러 이름을 넣을 수
있고, 앞에 적은 이름일수록 우선 사용됩니다.

```env
SALES_TRANSACTION_DATE_ALIASES=승인거래일자,거래일시
SALES_SETTLEMENT_DATE_ALIASES=입금예정일,대금지급일자
SALES_CARD_COMPANY_ALIASES=카드사명,매입카드사
SALES_APPROVAL_NUMBER_ALIASES=승인번호,전표번호
SALES_MERCHANT_NUMBER_ALIASES=가맹점번호
SALES_APPROVAL_AMOUNT_ALIASES=승인금액,매출금액
SALES_FEE_AMOUNT_ALIASES=수수료,가맹점수수료
SALES_DEPOSIT_AMOUNT_ALIASES=실입금액,지급금액
```

컬럼명이 더 많거나 JSON으로 관리하고 싶으면 다음처럼 한 번에 지정할 수도 있습니다.

```env
SALES_FIELD_ALIASES_JSON={"transactionDate":["승인거래일자"],"approvalAmount":["총승인금액"]}
```

### 5. 장부 화면 확인

서버를 실행합니다.

```bash
npm start
```

브라우저에서 다음 주소를 엽니다.

```text
http://localhost:3000/sales
```

제공되는 화면/엔드포인트:

- `/sales`: 일별/월별 합계와 최근 매출 테이블
- `/sales/api`: 같은 데이터를 JSON으로 반환

### 6. 세션 저장 후 headless 실행

한 번 수동 로그인으로 `.auth/cardsales-state.json`이 만들어진 뒤에는 headless 실행을 시도할 수 있습니다.
다만 사이트가 세션을 자주 만료하거나 추가 인증을 요구하면 다시 headed 모드로 실행해야 합니다.

```bash
npm run scrape:creditfinance -- --headless
```

### 7. 선택자 찾는 방법

1. 열린 Chromium에서 원하는 입력칸, 조회 버튼, 결과 테이블을 우클릭합니다.
2. "검사"를 눌러 개발자도구를 엽니다.
3. 안정적인 `id`, `name`, `data-*` 속성이 있으면 우선 사용합니다.
4. 예:

```env
CFIA_DATE_FROM_SELECTOR=input[name="startDate"]
CFIA_DATE_TO_SELECTOR=input[name="endDate"]
CFIA_SEARCH_BUTTON_SELECTOR=button:has-text("조회")
CFIA_RESULT_TABLE_SELECTOR=table.sales-list
CFIA_DOWNLOAD_SELECTOR=button:has-text("엑셀")
```

사이트 화면 구조는 바뀔 수 있으므로 위 선택자는 예시입니다. 현재 화면에 맞게 확인한 값으로 바꿔야 합니다.

### 8. 운영 시 보안 체크리스트

- `.env`, `.auth/`, `data/`를 깃에 올리지 않습니다.
- 실제 서비스에서는 수집 결과를 암호화된 저장소에 저장하고 접근 권한을 제한합니다.
- 로그에 사업자번호, 카드번호, 승인번호, 계좌번호, 고객 식별정보가 남지 않게 합니다.
- 과도한 반복 요청을 피하고, 필요한 기간만 작은 단위로 조회합니다.
- 실패 재시도는 보수적으로 두고, 사이트 장애나 점검 화면이 나오면 자동화를 멈춥니다.
