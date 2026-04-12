import { describe, it, expect, beforeAll } from 'vitest';
import {
  initCrypto,
  generateKeypair,
  computeSharedSecret,
  encrypt,
  decrypt,
  MAX_MESSAGE_SIZE,
} from './crypto.js';

describe('crypto', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it('generates valid keypairs with 32-byte keys', () => {
    const kp = generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('computes the same shared secret from both sides (DH symmetry)', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();

    const sharedAlice = computeSharedSecret(bob.publicKey, alice.privateKey);
    const sharedBob = computeSharedSecret(alice.publicKey, bob.privateKey);

    expect(sharedAlice).toEqual(sharedBob);
    expect(sharedAlice.length).toBe(32);
  });

  it('encrypts and decrypts round-trip: plaintext matches', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new TextEncoder().encode('Hello, bridge!');
    const encrypted = encrypt(plaintext, shared);
    const decrypted = decrypt(encrypted, shared);

    expect(decrypted).toEqual(plaintext);
    expect(new TextDecoder().decode(decrypted)).toBe('Hello, bridge!');
  });

  it('encrypts and decrypts empty plaintext', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new Uint8Array(0);
    const encrypted = encrypt(plaintext, shared);
    const decrypted = decrypt(encrypted, shared);

    expect(decrypted).toEqual(plaintext);
    expect(decrypted.length).toBe(0);
  });

  it('allows exactly MAX_MESSAGE_SIZE (256KB)', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new Uint8Array(MAX_MESSAGE_SIZE);
    plaintext.fill(0x42);

    const encrypted = encrypt(plaintext, shared);
    const decrypted = decrypt(encrypted, shared);

    expect(decrypted).toEqual(plaintext);
  });

  it('rejects plaintext exceeding MAX_MESSAGE_SIZE (256KB + 1)', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new Uint8Array(MAX_MESSAGE_SIZE + 1);

    expect(() => encrypt(plaintext, shared)).toThrow(
      /exceeds maximum/,
    );
  });

  it('throws when decrypting with wrong key', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const eve = generateKeypair();

    const sharedAliceBob = computeSharedSecret(bob.publicKey, alice.privateKey);
    const sharedAliceEve = computeSharedSecret(eve.publicKey, alice.privateKey);

    const plaintext = new TextEncoder().encode('Secret message');
    const encrypted = encrypt(plaintext, sharedAliceBob);

    expect(() => decrypt(encrypted, sharedAliceEve)).toThrow();
  });

  it('throws when decrypting tampered ciphertext', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new TextEncoder().encode('Do not tamper');
    const encrypted = encrypt(plaintext, shared);

    // Tamper with a byte in the ciphertext portion (after the 24-byte nonce)
    encrypted[encrypted.length - 1] ^= 0xff;

    expect(() => decrypt(encrypted, shared)).toThrow();
  });

  it('throws when decrypting truncated ciphertext', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new TextEncoder().encode('Full message here');
    const encrypted = encrypt(plaintext, shared);

    // Truncate: keep only nonce + a few bytes
    const truncated = encrypted.slice(0, 26);

    expect(() => decrypt(truncated, shared)).toThrow();
  });

  it('produces different ciphertexts for the same plaintext (nonce uniqueness)', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const shared = computeSharedSecret(bob.publicKey, alice.privateKey);

    const plaintext = new TextEncoder().encode('Same message twice');
    const encrypted1 = encrypt(plaintext, shared);
    const encrypted2 = encrypt(plaintext, shared);

    // Ciphertexts should differ (different random nonce each time)
    expect(encrypted1).not.toEqual(encrypted2);

    // But both should decrypt to the same plaintext
    expect(decrypt(encrypted1, shared)).toEqual(plaintext);
    expect(decrypt(encrypted2, shared)).toEqual(plaintext);
  });
});
