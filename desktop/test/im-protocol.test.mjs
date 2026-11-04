import assert from 'node:assert/strict';
import { parseOAuthUrl } from '../main/imProtocol.js';

const valid = parseOAuthUrl('mjcode://im-oauth?platform=feishu&state=s1&code=c1');
assert.deepEqual(valid, { platform: 'feishu', params: { state: 's1', code: 'c1', error: '' } });
assert.equal(parseOAuthUrl('https://im-oauth?platform=feishu&state=s1&code=c1'), null);
assert.equal(parseOAuthUrl('mjcode://other?platform=feishu&state=s1&code=c1'), null);
assert.equal(parseOAuthUrl('mjcode://im-oauth?platform=feishu&state=s1'), null);
console.log('im-protocol: 4/4 通过');
