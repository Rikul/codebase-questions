import { describe, it, expect } from 'vitest';
import { getUser } from '../src/services/userService';

describe('users', () => {
  it('exports getUser', () => expect(typeof getUser).toBe('function'));
});
