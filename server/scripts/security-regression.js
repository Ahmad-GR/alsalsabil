const http = require('node:http');
const https = require('node:https');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:5001';
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function fail(message) {
  throw new Error(message);
}

async function request(path, options = {}) {
  const url = new URL(path, baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function jsonBody(value) {
  return JSON.stringify(value);
}

main();

async function main() {
  const target = new URL(baseUrl);
  if (!allowedHosts.has(target.hostname)) {
    fail(`Blocked: TEST_BASE_URL must target localhost. Received: ${target.hostname}`);
  }

  const report = [];
  const pass = (name, details) => report.push({ name, status: 'PASS', details });
  const failCheck = (name, details) => report.push({ name, status: 'FAIL', details });

  try {
    const health = await request('/api/health');
    if (health.status === 200) pass('Health endpoint reachable', `HTTP ${health.status}`);
    else failCheck('Health endpoint reachable', `HTTP ${health.status}`);

    for (const header of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) {
      if (health.headers[header]) pass(`Security header: ${header}`, health.headers[header]);
      else failCheck(`Security header: ${header}`, 'Header missing');
    }

    for (const path of ['/api/site/admin/users', '/api/videos/bunny-info/demo']) {
      const response = await request(path);
      if (response.status === 401 || response.status === 403) pass(`Protected route denies anonymous access: ${path}`, `HTTP ${response.status}`);
      else failCheck(`Protected route denies anonymous access: ${path}`, `HTTP ${response.status}`);
    }

    const cors = await request('/api/site/courses', { headers: { Origin: 'https://attacker.invalid' } });
    if (!cors.headers['access-control-allow-origin']) pass('Untrusted CORS origin rejected', 'No ACAO response header');
    else failCheck('Untrusted CORS origin rejected', `ACAO=${cors.headers['access-control-allow-origin']}`);

    const injectionPayloads = [
      "' OR 1=1 --",
      "<img src=x onerror=alert(document.domain)>",
      '../../../etc/passwd',
    ];

    for (const payload of injectionPayloads) {
      const login = await request('/api/site/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody({ login: payload, password: 'x' }),
      });
      if ([400, 401, 429].includes(login.status)) pass('Malicious input returned safe rejection', payload.slice(0, 48));
      else failCheck('Malicious input returned unexpected response', `HTTP ${login.status}: ${payload.slice(0, 48)}`);
    }

    const rateLimitResponses = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await request('/api/site/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody({ login: 'nonexistent-user', password: 'x' }),
      });
      rateLimitResponses.push(response.status);
    }
    if (rateLimitResponses.includes(429)) pass('Login rate limiting activates', `Statuses: ${rateLimitResponses.join(', ')}`);
    else failCheck('Login rate limiting activates', `No 429 observed; statuses: ${rateLimitResponses.join(', ')}`);

    for (const path of ['/.env', '/.git/config', '/server/.env']) {
      const response = await request(path);
      const secretMarkers = /(DATABASE_URL|JWT_SECRET|CLOUDINARY_API_SECRET|TAP_SECRET_KEY|EMAILJS_PRIVATE_KEY|PAYPAL_CLIENT_SECRET|BUNNY_STREAM_TOKEN_SECRET)/i.test(response.body);
      if (response.status === 404 || !secretMarkers) pass(`Sensitive file not exposed: ${path}`, `HTTP ${response.status}`);
      else failCheck(`Sensitive file not exposed: ${path}`, 'Secret marker detected in response');
    }
  } catch (error) {
    failCheck('Regression runner connection', error.message);
  }

  console.log(JSON.stringify({ baseUrl, timestamp: new Date().toISOString(), report }, null, 2));
  process.exitCode = report.some((item) => item.status === 'FAIL') ? 1 : 0;
}
