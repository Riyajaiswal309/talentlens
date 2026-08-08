import { PasswordService } from './password.service';

describe('PasswordService (PRD §24.1 Argon2id)', () => {
  const service = new PasswordService();

  it('produces an Argon2id hash, not any other algorithm', async () => {
    const hash = await service.hash('DevPassword123!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('never stores the plaintext anywhere in the hash', async () => {
    const plaintext = 'CorrectHorseBattery1!';
    const hash = await service.hash(plaintext);
    expect(hash).not.toContain(plaintext);
    expect(hash).not.toContain('CorrectHorse');
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('DevPassword123!');
    await expect(service.verify(hash, 'DevPassword123!')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('DevPassword123!');
    await expect(service.verify(hash, 'DevPassword123?')).resolves.toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const a = await service.hash('DevPassword123!');
    const b = await service.hash('DevPassword123!');
    expect(a).not.toBe(b);
    // Both still verify — the salt is embedded in the encoded hash.
    await expect(service.verify(a, 'DevPassword123!')).resolves.toBe(true);
    await expect(service.verify(b, 'DevPassword123!')).resolves.toBe(true);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(service.verify('not-a-hash', 'DevPassword123!')).resolves.toBe(false);
  });

  it('verifyDummy completes so a missing user costs the same as a real one', async () => {
    await expect(service.verifyDummy('anything')).resolves.toBeUndefined();
  });
});
