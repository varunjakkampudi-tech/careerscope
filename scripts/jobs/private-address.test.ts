import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateOrReservedIp } from './check-lead-liveness.js';

// applyUrl is provider data, so the liveness checker must refuse every address that is not a public
// unicast web host (Stage 01 SSRF review, S1-F018).
test('private, loopback, link-local, carrier-grade NAT, multicast and reserved addresses are refused', () => {
  for (const ip of [
    '10.1.2.3',
    '127.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.254',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.1.2.3',
    '240.0.0.1',
    '255.255.255.255',
    '0.0.0.0',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    'not-an-ip',
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
});

test('public unicast addresses are allowed, including the edges of the private ranges', () => {
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '198.17.255.255',
    '223.255.255.255',
    '2606:4700:4700::1111',
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), false, ip);
  }
});
