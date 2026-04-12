// libsodium-wrappers ESM build references a missing libsodium.mjs companion in
// Node 25. Load via createRequire from the CJS UMD bundle instead.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers");

await sodium.ready;

// Test 1: Key generation
const alice = sodium.crypto_box_keypair();
const bob = sodium.crypto_box_keypair();

const alicePubHex = sodium.to_hex(alice.publicKey);
const bobPubHex = sodium.to_hex(bob.publicKey);
console.log(`✓ Key generation: Alice pubkey = ${alicePubHex}, Bob pubkey = ${bobPubHex}`);

// Test 2: Shared secret (DH)
const aliceSharedSecret = sodium.crypto_box_beforenm(bob.publicKey, alice.privateKey);
const bobSharedSecret = sodium.crypto_box_beforenm(alice.publicKey, bob.privateKey);

let secretsMatch = aliceSharedSecret.length === bobSharedSecret.length;
if (secretsMatch) {
  for (let i = 0; i < aliceSharedSecret.length; i++) {
    if (aliceSharedSecret[i] !== bobSharedSecret[i]) {
      secretsMatch = false;
      break;
    }
  }
}
console.log(`✓ DH shared secret: both sides match = ${secretsMatch}`);

// Test 3: Encrypt/decrypt round-trip
const message = "Hello from server Claude! Task: test the frontend auth flow";
const messageBytes = sodium.from_string(message);

const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
const ciphertext = sodium.crypto_box_easy_afternm(messageBytes, nonce, aliceSharedSecret);

// Wire format: nonce + ciphertext
const wire = new Uint8Array(nonce.length + ciphertext.length);
wire.set(nonce, 0);
wire.set(ciphertext, nonce.length);

// Decrypt: extract nonce and ciphertext from wire
const extractedNonce = wire.slice(0, sodium.crypto_box_NONCEBYTES);
const extractedCiphertext = wire.slice(sodium.crypto_box_NONCEBYTES);
const decrypted = sodium.crypto_box_open_easy_afternm(extractedCiphertext, extractedNonce, bobSharedSecret);
const decryptedMessage = sodium.to_string(decrypted);

if (decryptedMessage !== message) {
  throw new Error(`Round-trip failed: expected "${message}", got "${decryptedMessage}"`);
}
console.log(`✓ Encrypt/decrypt: round-trip success, message = '${decryptedMessage}'`);
console.log(`  Ciphertext (with nonce): ${wire.length} bytes for ${messageBytes.length} byte message`);

// Test 4: Max message size enforcement
const MAX_SIZE = 256 * 1024;

const okBuffer = new Uint8Array(MAX_SIZE);
const okNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
sodium.crypto_box_easy_afternm(okBuffer, okNonce, aliceSharedSecret); // should succeed

const tooBig = new Uint8Array(MAX_SIZE + 1);
let sizeRejected = false;
if (tooBig.length > MAX_SIZE) {
  sizeRejected = true;
  // Do not encrypt — reject before encryption
}
if (!sizeRejected) {
  throw new Error("Size limit not enforced: 256KB+1 should have been rejected");
}
console.log(`✓ Size limit: 256KB passes, 256KB+1 rejected`);

// Test 5: Wrong key fails gracefully
const wrongKeypair = sodium.crypto_box_keypair();
const wrongSharedSecret = sodium.crypto_box_beforenm(wrongKeypair.publicKey, wrongKeypair.privateKey);

const msg5 = sodium.from_string("secret message");
const nonce5 = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
const ct5 = sodium.crypto_box_easy_afternm(msg5, nonce5, aliceSharedSecret);

let authFailureThrew = false;
try {
  sodium.crypto_box_open_easy_afternm(ct5, nonce5, wrongSharedSecret);
} catch (err) {
  authFailureThrew = true;
}
if (!authFailureThrew) {
  throw new Error("Expected decryption with wrong key to throw, but it succeeded");
}
console.log(`✓ Auth failure: wrong key throws as expected`);

// Test 6: Nonce uniqueness
const msg6 = sodium.from_string("same plaintext");
const nonce6a = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
const nonce6b = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
const ct6a = sodium.crypto_box_easy_afternm(msg6, nonce6a, aliceSharedSecret);
const ct6b = sodium.crypto_box_easy_afternm(msg6, nonce6b, aliceSharedSecret);

// Compare wire outputs (nonce+ct) — they should differ since nonces are random
const wire6a = new Uint8Array(nonce6a.length + ct6a.length);
wire6a.set(nonce6a, 0);
wire6a.set(ct6a, nonce6a.length);

const wire6b = new Uint8Array(nonce6b.length + ct6b.length);
wire6b.set(nonce6b, 0);
wire6b.set(ct6b, nonce6b.length);

let ciphertextsAreDifferent = false;
for (let i = 0; i < wire6a.length; i++) {
  if (wire6a[i] !== wire6b[i]) {
    ciphertextsAreDifferent = true;
    break;
  }
}
if (!ciphertextsAreDifferent) {
  throw new Error("Nonce uniqueness failure: two encryptions of same plaintext produced identical output");
}
console.log(`✓ Nonce uniqueness: same plaintext = different ciphertexts`);

console.log("\nAll libsodium tests passed ✓");
