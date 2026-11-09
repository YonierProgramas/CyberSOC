import { expect, it } from 'vitest';
import { Stack } from '../src/core/structures/Stack';

it('comes out in reverse order of entry', () => {
  const stack = new Stack<number>();
  stack.push(1);
  stack.push(2);
  stack.push(3);
  expect(stack.peek()).toBe(3);
  expect(stack.size).toBe(3);
  expect([stack.pop(), stack.pop(), stack.pop()]).toEqual([3, 2, 1]);
  expect(stack.isEmpty()).toBe(true);
});

it('pop and peek on empty return undefined', () => {
  const stack = new Stack<string>();
  expect(stack.pop()).toBeUndefined();
  expect(stack.peek()).toBeUndefined();
  expect(stack.size).toBe(0);
  expect(stack.peakSize).toBe(0);
});

it('peakSize does not drop when popping', () => {
  const stack = new Stack<number>();
  stack.push(1);
  stack.push(2);
  stack.push(3);
  stack.pop();
  expect(stack.size).toBe(2);
  expect(stack.peek()).toBe(2);
  expect(stack.peakSize).toBe(3);
  stack.pop();
  stack.pop();
  expect(stack.isEmpty()).toBe(true);
  expect(stack.peakSize).toBe(3);
});
