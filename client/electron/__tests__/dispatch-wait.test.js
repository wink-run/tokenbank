'use strict';
// 子任务等待：有进展就续上，停住或超过总时长才超时

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taskWaitAlive, taskActivityMark } = require('../agent-executor');

test('a task that just did something is still waited on', () => {
  assert.equal(taskWaitAlive({ now: 1_000, start: 0, lastActivity: 900, idleMs: 600_000, hardMs: 1_800_000 }), true);
});

test('a task with no new progress past the idle limit is given up', () => {
  assert.equal(taskWaitAlive({ now: 700_000, start: 0, lastActivity: 0, idleMs: 600_000, hardMs: 1_800_000 }), false);
});

test('fresh progress keeps a long task alive until the hard limit', () => {
  assert.equal(taskWaitAlive({ now: 1_200_000, start: 0, lastActivity: 1_190_000, idleMs: 600_000, hardMs: 1_800_000 }), true);
  assert.equal(taskWaitAlive({ now: 1_800_000, start: 0, lastActivity: 1_799_000, idleMs: 600_000, hardMs: 1_800_000 }), false);
});

test('activity mark changes when a new step arrives or its text grows', () => {
  const a = taskActivityMark({ status: 'running', steps: [{ id: 's1', content: 'hi' }] });
  const b = taskActivityMark({ status: 'running', steps: [{ id: 's1', content: 'hi' }, { id: 's2', content: 'x' }] });
  const c = taskActivityMark({ status: 'running', steps: [{ id: 's1', content: 'hi!!' }] });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, taskActivityMark({ status: 'running', steps: [{ id: 's1', content: 'hi' }] }));
});
