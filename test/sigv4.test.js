// Expected values come from the AWS SigV4 test suite:
// https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV4 } from '../src/sigv4.js';

const context = {
  region: 'us-east-1',
  service: 'service',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  now: new Date('2015-08-30T12:36:00Z'),
};
const TOKEN =
  'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==';

test('get-vanilla', async () => {
  const headers = await signV4({ ...context, method: 'GET', url: 'https://example.amazonaws.com/' });
  assert.deepEqual(headers, {
    'x-amz-date': '20150830T123600Z',
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  });
});

test('post-x-www-form-urlencoded signs the body and every given header', async () => {
  const headers = await signV4({
    ...context,
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': '13',
      'x-amz-content-sha256': '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
    },
    body: 'Param1=value1',
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b',
  );
});

test('post-sts-header-before signs the session token', async () => {
  const headers = await signV4({ ...context, method: 'POST', url: 'https://example.amazonaws.com/', sessionToken: TOKEN });
  assert.deepEqual(headers, {
    'x-amz-date': '20150830T123600Z',
    'x-amz-security-token': TOKEN,
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead',
  });
});
