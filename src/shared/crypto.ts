import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const _sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

export const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB

let sodium: typeof _sodium;

/**
 * Initialize libsodium. Must be called once before using other crypto functions.
 * Returns the sodium instance.
 */
export async function initCrypto(): Promise<typeof _sodium> {
  await _sodium.ready;
  sodium = _sodium;
  return sodium;
}

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function assertInitialized(): asserts sodium is typeof _sodium {
  if (!sodium) throw new Error('Crypto not initialized: call await initCrypto() first');
}

/**
 * Generate an X25519 keypair for key exchange.
 */
export function generateKeypair(): Keypair {
  assertInitialized();
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  };
}

/**
 * Compute a shared secret from their public key and our private key.
 * Uses X25519 Diffie-Hellman (crypto_box_beforenm).
 */
export function computeSharedSecret(
  theirPublicKey: Uint8Array,
  myPrivateKey: Uint8Array,
): Uint8Array {
  assertInitialized();
  return sodium.crypto_box_beforenm(theirPublicKey, myPrivateKey);
}

/**
 * Encrypt plaintext using a shared secret.
 * Generates a random 24-byte nonce and prepends it to the ciphertext.
 * Returns: nonce (24 bytes) + ciphertext
 *
 * Throws if plaintext exceeds MAX_MESSAGE_SIZE.
 */
export function encrypt(
  plaintext: Uint8Array,
  sharedSecret: Uint8Array,
): Uint8Array {
  assertInitialized();
  if (plaintext.byteLength > MAX_MESSAGE_SIZE) {
    throw new Error(
      `Message size ${plaintext.byteLength} exceeds maximum ${MAX_MESSAGE_SIZE} bytes`,
    );
  }

  const nonce = sodium.randombytes_buf(
    sodium.crypto_box_NONCEBYTES, // 24 bytes
  );

  const ciphertext = sodium.crypto_box_easy_afternm(
    plaintext,
    nonce,
    sharedSecret,
  );

  // Prepend nonce to ciphertext
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

/**
 * Decrypt an encrypted message using a shared secret.
 * Expects the first 24 bytes to be the nonce, rest is ciphertext.
 */
export function decrypt(
  encrypted: Uint8Array,
  sharedSecret: Uint8Array,
): Uint8Array {
  assertInitialized();
  const minLength = sodium.crypto_box_NONCEBYTES + sodium.crypto_box_MACBYTES;
  if (encrypted.byteLength < minLength) {
    throw new Error(`Encrypted data too short: ${encrypted.byteLength} bytes, minimum is ${minLength}`);
  }

  const nonceLength = sodium.crypto_box_NONCEBYTES; // 24 bytes

  const nonce = encrypted.slice(0, nonceLength);
  const ciphertext = encrypted.slice(nonceLength);

  return sodium.crypto_box_open_easy_afternm(ciphertext, nonce, sharedSecret);
}
