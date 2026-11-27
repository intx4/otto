// AWS Signature Version 4 for a single request, using WebCrypto only.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

const encoder = new TextEncoder();

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256 = (data) => crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data);

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(searchParams) {
  return [...searchParams]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

// Returns `headers` plus host, x-amz-date, x-amz-security-token (when a session token is set) and authorization.
// Every header passed in is signed. Leave out headers the client cannot control, such as content-length in fetch.
export async function signV4({ method, url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const { host, pathname, searchParams } = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;

  const signed = { ...headers, host, 'x-amz-date': amzDate, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) };
  const entries = Object.entries(signed)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = entries.map(([k]) => k).join(';');

  const canonicalRequest = [
    method,
    pathname.split('/').map(encodeRfc3986).join('/'),
    canonicalQuery(searchParams),
    entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    hex(await sha256(body)),
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await sha256(canonicalRequest))].join('\n');

  let key = `AWS4${secretAccessKey}`;
  for (const part of [day, region, service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  const { host: _host, ...sent } = signed;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
