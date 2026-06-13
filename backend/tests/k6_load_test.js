/**
 * HandScript k6 load test — REWRITE_PLAN §5
 *
 * Target: 100 concurrent virtual users, 30 seconds.
 * Pass criteria:
 *   • No HTTP 5xx errors (4xx including 429 are acceptable — graceful degradation)
 *   • /layout   p95 < 500 ms
 *   • /convert-both p99 < 15 s
 *
 * Usage:
 *   BACKEND_URL=https://your-railway-app.up.railway.app \
 *   TEST_TOKEN=eyJhbGciO... \
 *   TEST_USER_ID=uid123 \
 *   k6 run backend/tests/k6_load_test.js
 *
 * Install k6: https://k6.io/docs/get-started/installation/
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// ── Custom metrics ────────────────────────────────────────────────────────────
const layoutDuration  = new Trend('layout_duration',  true);   // ms
const renderDuration  = new Trend('render_duration',  true);   // ms
const cacheHitRate    = new Rate('render_cache_hit');          // fraction
const errorRate       = new Rate('error_5xx');

// ── Options ───────────────────────────────────────────────────────────────────
export const options = {
  vus:      100,
  duration: '30s',
  thresholds: {
    // Hard failure criteria
    error_5xx:              ['rate<0.01'],          // <1% server errors
    layout_duration:        ['p(95)<500'],          // /layout p95 < 500 ms
    render_duration:        ['p(99)<15000'],        // /convert-both p99 < 15 s
    // Soft — informational
    http_req_failed:        ['rate<0.01'],
    'checks{type:no5xx}':   ['rate>0.99'],
  },
};

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL    = __ENV.BACKEND_URL   || 'http://localhost:8000';
const TOKEN       = __ENV.TEST_TOKEN    || '';
const USER_ID     = __ENV.TEST_USER_ID  || 'test-user-k6';

const HEADERS = {
  'Content-Type':  'application/json',
  'Authorization': TOKEN ? `Bearer ${TOKEN}` : '',
};

// Short Hebrew text so the layout/render is representatively realistic but
// completes in a reasonable time even on a cold instance.
const SAMPLE_TEXT = 'שלום עולם. זהו טקסט בדיקה קצר לבדיקת עומס.';

const STYLE = {
  char_height:     85,
  letter_spacing:  7,
  word_spacing:    50,
  baseline_jitter: 10,
  slant:           5,
  ink_blobs:       0.15,
};

// ── VU script ────────────────────────────────────────────────────────────────
export default function () {
  // ── 1. /layout  (fast, no rasterisation) ───────────────────────────────────
  const layoutBody = JSON.stringify({
    text:    SAMPLE_TEXT,
    user_id: USER_ID,
    preview: true,
    style:   STYLE,
  });

  const layoutRes = http.post(`${BASE_URL}/layout`, layoutBody, {
    headers: HEADERS,
    tags:    { endpoint: 'layout' },
  });

  check(layoutRes, {
    'layout: no 5xx':   (r) => r.status < 500,
    'layout: ok or 429': (r) => r.status === 200 || r.status === 429 || r.status === 401,
  }, { type: 'no5xx' });

  if (layoutRes.status >= 500) errorRate.add(1);
  else                         errorRate.add(0);

  if (layoutRes.status === 200) layoutDuration.add(layoutRes.timings.duration);

  sleep(0.5);   // brief pause between the two calls per VU

  // ── 2. /convert-both  (preview=true, may hit cache) ────────────────────────
  const renderBody = JSON.stringify({
    text:       SAMPLE_TEXT,
    user_id:    USER_ID,
    background: 'lines',
    ink_color:  'black',
    preview:    true,
    style:      STYLE,
  });

  const renderRes = http.post(`${BASE_URL}/convert-both`, renderBody, {
    headers: HEADERS,
    timeout: '20s',                // generous client timeout
    tags:    { endpoint: 'convert-both' },
  });

  const renderOk = check(renderRes, {
    'render: no 5xx':         (r) => r.status < 500,
    'render: ok or 429':      (r) => r.status === 200 || r.status === 429 || r.status === 401,
    'render: response has ok': (r) => {
      if (r.status !== 200) return true;   // non-200 checked above
      try { return JSON.parse(r.body).ok === true; } catch { return false; }
    },
  }, { type: 'no5xx' });

  if (renderRes.status >= 500) errorRate.add(1);
  else                         errorRate.add(0);

  if (renderRes.status === 200) {
    renderDuration.add(renderRes.timings.duration);
    try {
      // The response does not expose a cache-hit field directly, but a very fast
      // render (<300 ms) is almost certainly a cache hit.
      cacheHitRate.add(renderRes.timings.duration < 300 ? 1 : 0);
    } catch (_) {}
  }

  // Stagger requests so we don't all fire simultaneously on the same tick.
  sleep(Math.random() * 0.3);
}
