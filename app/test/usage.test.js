import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUsage } from '../main/usage.js';

const ev = (info) => ({ type: 'rate_limit_event', rate_limit_info: info });

test('unifiedWindows 에서 5시간·주간을 뽑고 resetsAt 은 ms 로 맞춘다', () => {
  const u = mergeUsage(undefined, ev({
    status: 'allowed', resetsAt: 1795694400, rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: 0.21, resetsAt: 1795694400, status: 'allowed' },
      seven_day: { utilization: 0.57, resetsAt: 1795960800, status: 'allowed_warning' },
    },
  }), 100);
  assert.deepEqual(u, {
    fiveHour: { utilization: 0.21, resetsAt: 1795694400000, status: 'allowed' },
    sevenDay: { utilization: 0.57, resetsAt: 1795960800000, status: 'allowed_warning' },
    updatedAt: 100,
  });
});

test('창 정보가 없으면 그 이벤트의 rateLimitType 한 개만 갱신하고 나머지는 유지', () => {
  const prev = { fiveHour: { utilization: 0.1, resetsAt: 1, status: 'allowed' }, sevenDay: { utilization: 0.5, resetsAt: 2, status: 'allowed' }, updatedAt: 1 };
  const u = mergeUsage(prev, ev({ status: 'allowed_warning', resetsAt: 1795982400, rateLimitType: 'seven_day', utilization: 0.77 }), 9);
  assert.equal(u.sevenDay.utilization, 0.77);
  assert.equal(u.sevenDay.resetsAt, 1795982400000);
  assert.deepEqual(u.fiveHour, prev.fiveHour);
  assert.equal(u.updatedAt, 9);
});

test('읽을 값이 없으면 undefined(거절 이벤트처럼 utilization 이 없을 때)', () => {
  assert.equal(mergeUsage({}, ev({ status: 'rejected', resetsAt: 1, rateLimitType: 'five_hour' }), 1), undefined);
  assert.equal(mergeUsage({}, { type: 'rate_limit_event' }, 1), undefined);
  assert.equal(mergeUsage({}, ev({ rateLimitType: 'seven_day_opus', utilization: 0.3, resetsAt: 1 }), 1), undefined);
});
