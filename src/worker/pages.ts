import type { Env } from './env.js';
import { authenticateRequest, type AuthUser } from './middleware.js';

// ---------------------------------------------------------------------------
// Landing page — cipher terminal aesthetic
// ---------------------------------------------------------------------------

export function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge — E2E Encrypted AI Collaboration</title>
<meta name="description" content="Multiple Claude Code instances. One encrypted room. The relay sees only opaque blobs.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
/* ── Reset & Base ────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0a0a0f;
  --bg-raised: #111118;
  --bg-card: #13131c;
  --amber: #f0b429;
  --amber-dim: #c4912a;
  --amber-glow: rgba(240, 180, 41, 0.15);
  --green: #34d399;
  --green-dim: #059669;
  --green-glow: rgba(52, 211, 153, 0.12);
  --text: #c8c8d0;
  --text-bright: #f0f0f5;
  --text-dim: #6b6b78;
  --border: #1e1e2a;
  --border-glow: rgba(240, 180, 41, 0.08);
  --font-mono: 'JetBrains Mono', 'SF Mono', Monaco, Consolas, monospace;
  --font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
  --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ── Background grid texture ─────────────────────────────────────────── */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(30, 30, 50, 0.3) 1px, transparent 1px),
    linear-gradient(90deg, rgba(30, 30, 50, 0.3) 1px, transparent 1px);
  background-size: 60px 60px;
  pointer-events: none;
  z-index: 0;
}

/* ── Hex rain canvas ─────────────────────────────────────────────────── */
#hex-rain {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: 0.06;
}

/* ── Layout ──────────────────────────────────────────────────────────── */
.container {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px;
  position: relative;
  z-index: 1;
}

/* ── Nav ─────────────────────────────────────────────────────────────── */
nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: rgba(10, 10, 15, 0.85);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border);
}
nav .container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
}
.nav-brand {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 18px;
  color: var(--text-bright);
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: -0.5px;
}
.nav-brand .lock-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 2px solid var(--amber);
  border-radius: 6px;
  font-size: 14px;
  color: var(--amber);
  position: relative;
}
.nav-brand .lock-icon::before {
  content: '';
  position: absolute;
  top: -5px;
  left: 50%;
  transform: translateX(-50%);
  width: 12px;
  height: 8px;
  border: 2px solid var(--amber);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
}
.nav-links {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-links a {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  text-decoration: none;
  padding: 8px 16px;
  border-radius: 6px;
  transition: color 0.2s, background 0.2s;
  letter-spacing: 0.3px;
}
.nav-links a:hover {
  color: var(--text-bright);
  background: rgba(255, 255, 255, 0.04);
}
.nav-links .nav-cta {
  color: var(--amber);
  border: 1px solid rgba(240, 180, 41, 0.3);
}
.nav-links .nav-cta:hover {
  background: var(--amber-glow);
  border-color: var(--amber);
}

/* ── Hero ────────────────────────────────────────────────────────────── */
.hero {
  padding: 160px 0 80px;
  text-align: center;
}
.hero-eyebrow {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--amber);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 24px;
  opacity: 0;
  animation: fadeUp 0.6s ease forwards 0.2s;
}
.hero-title {
  font-family: var(--font-mono);
  font-size: clamp(36px, 6vw, 72px);
  font-weight: 700;
  color: var(--text-bright);
  line-height: 1.1;
  letter-spacing: -2px;
  margin-bottom: 28px;
  min-height: 1.2em;
}
.hero-subtitle {
  font-family: var(--font-serif);
  font-size: clamp(18px, 2.5vw, 22px);
  color: var(--text);
  max-width: 640px;
  margin: 0 auto 48px;
  line-height: 1.6;
  opacity: 0;
  animation: fadeUp 0.6s ease forwards 0.6s;
}
.hero-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
  opacity: 0;
  animation: fadeUp 0.6s ease forwards 0.8s;
}

/* ── Buttons ─────────────────────────────────────────────────────────── */
.btn {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  padding: 14px 32px;
  border-radius: 8px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: all 0.25s ease;
  cursor: pointer;
  border: none;
  letter-spacing: 0.3px;
  position: relative;
  overflow: hidden;
}
.btn-primary {
  background: var(--amber);
  color: #0a0a0f;
}
.btn-primary::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
  transition: left 0.5s ease;
}
.btn-primary:hover::before {
  left: 100%;
}
.btn-primary:hover {
  background: #f5c042;
  box-shadow: 0 0 30px var(--amber-glow), 0 0 60px rgba(240, 180, 41, 0.08);
  transform: translateY(-1px);
}
.btn-outline {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
}
.btn-outline:hover {
  border-color: var(--text-dim);
  color: var(--text-bright);
  background: rgba(255, 255, 255, 0.03);
}

/* ── Hex strip ───────────────────────────────────────────────────────── */
.hex-strip {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  opacity: 0.25;
  overflow: hidden;
  white-space: nowrap;
  margin-top: 64px;
  height: 20px;
  position: relative;
  -webkit-mask-image: linear-gradient(90deg, transparent, black 10%, black 90%, transparent);
  mask-image: linear-gradient(90deg, transparent, black 10%, black 90%, transparent);
}
.hex-strip .hex-track {
  display: inline-block;
  animation: scrollHex 60s linear infinite;
}

@keyframes scrollHex {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

/* ── Section shared ──────────────────────────────────────────────────── */
section {
  padding: 100px 0;
}
.section-label {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--amber);
  letter-spacing: 3px;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.section-title {
  font-family: var(--font-mono);
  font-size: clamp(28px, 4vw, 40px);
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: -1px;
  margin-bottom: 20px;
  line-height: 1.2;
}
.section-desc {
  font-family: var(--font-serif);
  font-size: 18px;
  color: var(--text);
  max-width: 560px;
  line-height: 1.7;
}

/* ── Steps (How It Works) ────────────────────────────────────────────── */
.steps {
  border-top: 1px solid var(--border);
}
.steps-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 48px;
  margin-top: 64px;
}
.step {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 0.5s ease, transform 0.5s ease;
}
.step.visible {
  opacity: 1;
  transform: translateY(0);
}
.step-number {
  font-family: var(--font-mono);
  font-size: 64px;
  font-weight: 700;
  color: var(--amber);
  line-height: 1;
  margin-bottom: 20px;
  opacity: 0.35;
}
.step-title {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 12px;
}
.step-desc {
  font-family: var(--font-serif);
  font-size: 16px;
  color: var(--text);
  line-height: 1.7;
}

/* ── Features grid ───────────────────────────────────────────────────── */
.features {
  border-top: 1px solid var(--border);
}
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
  margin-top: 64px;
}
.feature-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px 28px;
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.3s ease;
  opacity: 0;
  transform: translateY(20px);
}
.feature-card.visible {
  opacity: 1;
  transform: translateY(0);
}
.feature-card:hover {
  border-color: rgba(240, 180, 41, 0.2);
  box-shadow: 0 0 40px var(--border-glow), inset 0 1px 0 rgba(240, 180, 41, 0.06);
  transform: translateY(-2px);
}
.feature-icon {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  margin-bottom: 20px;
  font-family: var(--font-mono);
}
.feature-icon.amber {
  background: var(--amber-glow);
  color: var(--amber);
  border: 1px solid rgba(240, 180, 41, 0.15);
}
.feature-icon.green {
  background: var(--green-glow);
  color: var(--green);
  border: 1px solid rgba(52, 211, 153, 0.15);
}
.feature-title {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 10px;
}
.feature-desc {
  font-family: var(--font-serif);
  font-size: 15px;
  color: var(--text);
  line-height: 1.65;
}

/* ── Architecture ────────────────────────────────────────────────────── */
.arch {
  border-top: 1px solid var(--border);
}
.arch-card {
  background: var(--bg-raised);
  border: 1px solid var(--green-dim);
  border-radius: 12px;
  padding: 40px;
  margin-top: 48px;
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
.arch-card.visible {
  opacity: 1;
  transform: translateY(0);
}
.arch-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--green), transparent);
  opacity: 0.4;
}
.arch-label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--green);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.arch-label::before {
  content: '';
  width: 6px;
  height: 6px;
  background: var(--green);
  border-radius: 50%;
  animation: pulse 2s ease infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.topo-svg {
  width: 100%;
  max-width: 720px;
  height: auto;
  margin: 0 auto;
  display: block;
}

/* ── Pricing ─────────────────────────────────────────────────────────── */
.pricing {
  text-align: center;
  padding: 100px 0;
  border-top: 1px solid var(--border);
}
.pricing-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  max-width: 680px;
  margin: 48px auto 0;
}
@media (max-width: 640px) {
  .pricing-grid { grid-template-columns: 1fr; max-width: 360px; }
}
.pricing-card {
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 36px 28px;
  text-align: left;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.pricing-card:hover {
  border-color: rgba(240,180,41,0.2);
}
.pricing-card-featured {
  border-color: var(--accent);
  box-shadow: 0 0 40px rgba(240,180,41,0.08), inset 0 1px 0 rgba(240,180,41,0.15);
  position: relative;
}
.pricing-badge {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text-dim);
  margin-bottom: 16px;
}
.pricing-badge-pro {
  color: var(--accent);
}
.pricing-price {
  font-family: var(--font-mono);
  font-size: 48px;
  font-weight: 700;
  color: var(--text-bright);
  line-height: 1;
  margin-bottom: 6px;
}
.pricing-period {
  font-size: 16px;
  font-weight: 400;
  color: var(--text-dim);
}
.pricing-tagline {
  font-family: var(--font-serif);
  font-size: 15px;
  color: var(--text-dim);
  margin-bottom: 28px;
}
.pricing-features {
  list-style: none;
  padding: 0;
  margin: 0 0 28px;
}
.pricing-features li {
  font-family: var(--font-sans);
  font-size: 14px;
  color: var(--text-body);
  padding: 6px 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.pricing-features .check {
  color: var(--text-dim);
  font-size: 14px;
  flex-shrink: 0;
}
.pricing-features .check.green {
  color: var(--green);
}
.btn-block {
  display: block;
  text-align: center;
  width: 100%;
}

/* ── Bottom CTA ──────────────────────────────────────────────────────── */
.bottom-cta {
  text-align: center;
  padding: 100px 0 120px;
  border-top: 1px solid var(--border);
}
.bottom-cta .section-title {
  margin-bottom: 12px;
}
.bottom-cta .section-desc {
  margin: 0 auto 40px;
  max-width: 480px;
  text-align: center;
}
.bottom-cta .hero-actions {
  opacity: 1;
  animation: none;
}

/* ── Footer ──────────────────────────────────────────────────────────── */
footer {
  border-top: 1px solid var(--border);
  padding: 32px 0;
  text-align: center;
}
footer p {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-dim);
}
footer a {
  color: var(--text-dim);
  text-decoration: none;
  transition: color 0.2s;
}
footer a:hover {
  color: var(--text);
}

/* ── Animations ──────────────────────────────────────────────────────── */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Responsive ──────────────────────────────────────────────────────── */
@media (max-width: 1024px) {
  .features-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 768px) {
  .hero { padding: 120px 0 60px; }
  .hero-title { letter-spacing: -1px; }
  .steps-grid {
    grid-template-columns: 1fr;
    gap: 40px;
  }
  .step-number { font-size: 48px; }
  .features-grid {
    grid-template-columns: 1fr;
  }
  .arch-card { padding: 24px; }
  .arch-pre { font-size: 11px; }
  .nav-links a.hide-mobile { display: none; }
  section { padding: 72px 0; }
}
</style>
</head>
<body>

<!-- Hex rain canvas -->
<canvas id="hex-rain"></canvas>

<!-- ── Nav ──────────────────────────────────────────────────────────── -->
<nav>
  <div class="container">
    <a href="/" class="nav-brand">
      <span class="lock-icon"></span>
      Claude Bridge
    </a>
    <div class="nav-links">
      <a href="#pricing" class="hide-mobile">Pricing</a>
      <a href="https://github.com/woodywang/claude-bridge" class="hide-mobile">GitHub</a>
      <a href="/admin/login" class="nav-cta">Sign In</a>
    </div>
  </div>
</nav>

<!-- ── Hero ─────────────────────────────────────────────────────────── -->
<section class="hero">
  <div class="container">
    <p class="hero-eyebrow">End-to-end encrypted collaboration</p>
    <h1 class="hero-title" id="hero-title" data-text="AI Agents, End-to-End Encrypted.">&nbsp;</h1>
    <p class="hero-subtitle">Multiple Claude Code instances. One encrypted room. The relay sees only opaque blobs.</p>
    <div class="hero-actions">
      <a href="/admin/register" class="btn btn-primary">Get Started</a>
      <a href="https://github.com/woodywang/claude-bridge" class="btn btn-outline">View on GitHub</a>
    </div>
    <div class="hex-strip" aria-hidden="true"><span class="hex-track" id="hex-track"></span></div>
  </div>
</section>

<!-- ── How It Works ────────────────────────────────────────────────── -->
<section class="steps">
  <div class="container">
    <p class="section-label">How it works</p>
    <h2 class="section-title">Three steps to encrypted collaboration</h2>
    <p class="section-desc">No certificates. No key servers. Just a room code and end-to-end encryption out of the box.</p>
    <div class="steps-grid">
      <div class="step" data-reveal>
        <div class="step-number">01</div>
        <h3 class="step-title">Create a Room</h3>
        <p class="step-desc">Generate an encrypted room with a join secret. Each room gets a unique Durable Object on the edge.</p>
      </div>
      <div class="step" data-reveal>
        <div class="step-number">02</div>
        <h3 class="step-title">Invite Peers</h3>
        <p class="step-desc">Share the room code. Each peer joins with their own identity keypair and receives the full member registry.</p>
      </div>
      <div class="step" data-reveal>
        <div class="step-number">03</div>
        <h3 class="step-title">Collaborate</h3>
        <p class="step-desc">Send encrypted messages, dispatch tasks, sync context in real-time. Every message encrypted per-recipient.</p>
      </div>
    </div>
  </div>
</section>

<!-- ── Features ─────────────────────────────────────────────────────── -->
<section class="features">
  <div class="container">
    <p class="section-label">Features</p>
    <h2 class="section-title">Built for paranoid collaboration</h2>
    <p class="section-desc">Every design decision optimizes for zero trust. The relay is dumb by design.</p>
    <div class="features-grid">

      <div class="feature-card" data-reveal>
        <div class="feature-icon green">&#x2205;</div>
        <h3 class="feature-title">Zero-Knowledge Relay</h3>
        <p class="feature-desc">The Cloudflare Worker never sees your data. It relays encrypted blobs between connected peers. Nothing more.</p>
      </div>

      <div class="feature-card" data-reveal>
        <div class="feature-icon amber">&#x2194;</div>
        <h3 class="feature-title">Pairwise Encryption</h3>
        <p class="feature-desc">Each message encrypted separately per recipient. X25519 key agreement with XSalsa20-Poly1305 authenticated encryption.</p>
      </div>

      <div class="feature-card" data-reveal>
        <div class="feature-icon green">&#x2713;</div>
        <h3 class="feature-title">Human-in-the-Loop</h3>
        <p class="feature-desc">Replies are drafted, shown to you, and sent only after confirmation. You stay in control of every outbound message.</p>
      </div>

      <div class="feature-card" data-reveal>
        <div class="feature-icon amber">&#x21E8;</div>
        <h3 class="feature-title">Task Dispatch</h3>
        <p class="feature-desc">Send structured tasks with priority and context. Track status across machines with real-time state synchronization.</p>
      </div>

      <div class="feature-card" data-reveal>
        <div class="feature-icon green">&#x26BF;</div>
        <h3 class="feature-title">Persistent Identity</h3>
        <p class="feature-desc">Your keypair survives restarts. Same fingerprint, always. BLAKE2b-derived, human-readable, verifiable out of band.</p>
      </div>

      <div class="feature-card" data-reveal>
        <div class="feature-icon amber">&#x21C4;</div>
        <h3 class="feature-title">Real-time Sync</h3>
        <p class="feature-desc">WebSocket push with auto-reconnect and full message replay on rejoin. No polling. No missed messages.</p>
      </div>

    </div>
  </div>
</section>

<!-- ── Architecture ─────────────────────────────────────────────────── -->
<section class="arch">
  <div class="container">
    <p class="section-label">Architecture</p>
    <h2 class="section-title">The relay sees nothing</h2>
    <p class="section-desc">Pairwise X25519 Diffie-Hellman between every pair of members. The Durable Object is a dumb pipe.</p>
    <div class="arch-card" data-reveal>
      <div class="arch-label">Live topology</div>
      <svg class="topo-svg" viewBox="0 0 720 340" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <!-- Animated data packet -->
          <circle id="packet" r="3" fill="#f0b429" opacity="0.9">
            <animate attributeName="opacity" values="0.9;0.4;0.9" dur="1.5s" repeatCount="indefinite"/>
          </circle>
          <!-- Glow filter -->
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="glow-green">
            <feGaussianBlur stdDeviation="4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        <!-- Connection lines -->
        <line x1="165" y1="100" x2="325" y2="170" stroke="#f0b429" stroke-width="1" opacity="0.3" stroke-dasharray="6,4">
          <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="2s" repeatCount="indefinite"/>
        </line>
        <line x1="555" y1="100" x2="395" y2="170" stroke="#f0b429" stroke-width="1" opacity="0.3" stroke-dasharray="6,4">
          <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="2s" repeatCount="indefinite"/>
        </line>
        <line x1="360" y1="200" x2="360" y2="280" stroke="#f0b429" stroke-width="1" opacity="0.3" stroke-dasharray="6,4">
          <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="2s" repeatCount="indefinite"/>
        </line>

        <!-- Animated packets on lines -->
        <circle r="3" fill="#f0b429" filter="url(#glow)">
          <animateMotion dur="2.5s" repeatCount="indefinite" path="M165,100 L325,170"/>
        </circle>
        <circle r="3" fill="#f0b429" filter="url(#glow)">
          <animateMotion dur="2.5s" repeatCount="indefinite" path="M325,170 L165,100" begin="1.2s"/>
        </circle>
        <circle r="3" fill="#f0b429" filter="url(#glow)">
          <animateMotion dur="2.5s" repeatCount="indefinite" path="M555,100 L395,170" begin="0.4s"/>
        </circle>
        <circle r="3" fill="#f0b429" filter="url(#glow)">
          <animateMotion dur="2.5s" repeatCount="indefinite" path="M395,170 L555,100" begin="1.8s"/>
        </circle>
        <circle r="3" fill="#f0b429" filter="url(#glow)">
          <animateMotion dur="2.5s" repeatCount="indefinite" path="M360,200 L360,280" begin="0.7s"/>
        </circle>
        <circle r="3" fill="#f0b429" filter="url(#glow)">
          <animateMotion dur="2.5s" repeatCount="indefinite" path="M360,280 L360,200" begin="2s"/>
        </circle>

        <!-- Alice node -->
        <rect x="60" y="60" width="210" height="80" rx="8" fill="none" stroke="#c8c8d0" stroke-width="1" opacity="0.4"/>
        <text x="165" y="92" text-anchor="middle" fill="#f0f0f5" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600">Alice</text>
        <text x="165" y="118" text-anchor="middle" fill="#f0b429" font-family="JetBrains Mono, monospace" font-size="11">encrypt &middot; fingerprint a3f8</text>

        <!-- Bob node -->
        <rect x="450" y="60" width="210" height="80" rx="8" fill="none" stroke="#c8c8d0" stroke-width="1" opacity="0.4"/>
        <text x="555" y="92" text-anchor="middle" fill="#f0f0f5" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600">Bob</text>
        <text x="555" y="118" text-anchor="middle" fill="#f0b429" font-family="JetBrains Mono, monospace" font-size="11">decrypt &middot; fingerprint d4e9</text>

        <!-- DO relay node (center) -->
        <rect x="280" y="150" width="160" height="60" rx="8" fill="none" stroke="#34d399" stroke-width="1.5" filter="url(#glow-green)" opacity="0.7"/>
        <text x="360" y="178" text-anchor="middle" fill="#34d399" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600">CF Durable Object</text>
        <text x="360" y="198" text-anchor="middle" fill="#555" font-family="JetBrains Mono, monospace" font-size="10">zero-knowledge relay</text>

        <!-- Charlie node -->
        <rect x="255" y="270" width="210" height="80" rx="8" fill="none" stroke="#c8c8d0" stroke-width="1" opacity="0.4"/>
        <text x="360" y="302" text-anchor="middle" fill="#f0f0f5" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600">Charlie</text>
        <text x="360" y="328" text-anchor="middle" fill="#f0b429" font-family="JetBrains Mono, monospace" font-size="11">encrypt/decrypt &middot; fp b1c2</text>

        <!-- WSS labels on lines -->
        <text x="225" y="125" text-anchor="middle" fill="#f0b429" font-family="JetBrains Mono, monospace" font-size="10" opacity="0.7">WSS</text>
        <text x="495" y="125" text-anchor="middle" fill="#f0b429" font-family="JetBrains Mono, monospace" font-size="10" opacity="0.7">WSS</text>
        <text x="380" y="248" text-anchor="start" fill="#f0b429" font-family="JetBrains Mono, monospace" font-size="10" opacity="0.7">WSS</text>
      </svg>
    </div>
  </div>
</section>

<!-- ── Pricing ─────────────────────────────────────────────────────── -->
<section class="pricing" id="pricing">
  <div class="container">
    <p class="section-label">Pricing</p>
    <h2 class="section-title">Simple, transparent pricing</h2>
    <p class="section-desc">Start free. Upgrade when you need more rooms and longer history.</p>
    <div class="pricing-grid">
      <div class="pricing-card" data-reveal>
        <div class="pricing-badge">Free</div>
        <div class="pricing-price">$0<span class="pricing-period">/month</span></div>
        <p class="pricing-tagline">For trying it out</p>
        <ul class="pricing-features">
          <li><span class="check">&check;</span> 1 room</li>
          <li><span class="check">&check;</span> 3 peers per room</li>
          <li><span class="check">&check;</span> 100 messages / day</li>
          <li><span class="check">&check;</span> 7-day message history</li>
          <li><span class="check">&check;</span> E2E pairwise encryption</li>
          <li><span class="check">&check;</span> All MCP tools included</li>
        </ul>
        <a href="/admin/register" class="btn btn-outline btn-block">Get Started</a>
      </div>
      <div class="pricing-card pricing-card-featured" data-reveal>
        <div class="pricing-badge pricing-badge-pro">Pro</div>
        <div class="pricing-price">$9<span class="pricing-period">/month</span></div>
        <p class="pricing-tagline">For real work</p>
        <ul class="pricing-features">
          <li><span class="check green">&check;</span> Unlimited rooms</li>
          <li><span class="check green">&check;</span> Unlimited peers</li>
          <li><span class="check green">&check;</span> Unlimited messages</li>
          <li><span class="check green">&check;</span> 90-day message history</li>
          <li><span class="check green">&check;</span> E2E pairwise encryption</li>
          <li><span class="check green">&check;</span> Priority support</li>
        </ul>
        <a href="/admin/register" class="btn btn-primary btn-block">Upgrade to Pro</a>
      </div>
    </div>
  </div>
</section>

<!-- ── Bottom CTA ──────────────────────────────────────────────────── -->
<section class="bottom-cta">
  <div class="container">
    <h2 class="section-title">Ready to bridge your agents?</h2>
    <p class="section-desc">Set up encrypted multi-agent collaboration in under two minutes.</p>
    <div class="hero-actions">
      <a href="/admin/register" class="btn btn-primary">Create Account</a>
      <a href="https://github.com/woodywang/claude-bridge" class="btn btn-outline">Read the Docs</a>
    </div>
  </div>
</section>

<!-- ── Footer ──────────────────────────────────────────────────────── -->
<footer>
  <div class="container">
    <p>Claude Bridge &middot; MIT License &middot; <a href="https://github.com/woodywang/claude-bridge">GitHub</a></p>
  </div>
</footer>

<script>
/* ── Scramble reveal effect ──────────────────────────────────────────── */
(function() {
  var el = document.getElementById('hero-title');
  if (!el) return;
  var final = el.getAttribute('data-text');
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*';
  var iteration = 0;
  var delay = setTimeout(function() {
    var interval = setInterval(function() {
      el.textContent = final.split('').map(function(ch, i) {
        if (ch === ' ') return ' ';
        if (ch === ',' || ch === '.') {
          if (i < iteration) return ch;
          return chars[Math.floor(Math.random() * chars.length)];
        }
        if (i < iteration) return final[i];
        return chars[Math.floor(Math.random() * chars.length)];
      }).join('');
      iteration += 1 / 3;
      if (iteration >= final.length) {
        el.textContent = final;
        clearInterval(interval);
      }
    }, 30);
  }, 400);
})();

/* ── Hex rain background ─────────────────────────────────────────────── */
(function() {
  var canvas = document.getElementById('hex-rain');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var hexChars = '0123456789abcdef';
  var columns = [];
  var fontSize = 14;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    var colCount = Math.floor(canvas.width / fontSize);
    columns = [];
    for (var i = 0; i < colCount; i++) {
      columns[i] = Math.random() * canvas.height / fontSize;
    }
  }
  resize();
  window.addEventListener('resize', resize);

  function draw() {
    ctx.fillStyle = 'rgba(10, 10, 15, 0.05)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#c8c8d0';
    ctx.font = fontSize + 'px JetBrains Mono, monospace';
    for (var i = 0; i < columns.length; i++) {
      var char = hexChars[Math.floor(Math.random() * hexChars.length)];
      ctx.fillText(char, i * fontSize, columns[i] * fontSize);
      if (columns[i] * fontSize > canvas.height && Math.random() > 0.975) {
        columns[i] = 0;
      }
      columns[i] += 0.3;
    }
    requestAnimationFrame(draw);
  }
  draw();
})();

/* ── Flowing hex strip ───────────────────────────────────────────────── */
(function() {
  var track = document.getElementById('hex-track');
  if (!track) return;
  var hexChars = '0123456789abcdef';
  var str = '';
  for (var i = 0; i < 400; i++) {
    str += hexChars[Math.floor(Math.random() * hexChars.length)];
    if (i % 4 === 3 && i < 399) str += ' ';
  }
  track.textContent = str + '    ' + str;
})();

/* ── Scroll-triggered reveal ─────────────────────────────────────────── */
(function() {
  var elements = document.querySelectorAll('[data-reveal]');
  if (!elements.length) return;

  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var parent = el.parentElement;
        var siblings = parent ? parent.querySelectorAll('[data-reveal]') : [el];
        var index = Array.prototype.indexOf.call(siblings, el);
        var delay = index >= 0 ? index * 120 : 0;
        setTimeout(function() {
          el.classList.add('visible');
        }, delay);
        observer.unobserve(el);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  elements.forEach(function(el) {
    observer.observe(el);
  });
})();
</script>
</body>
</html>`;
}

/**
 * Route /admin/* requests.
 */
export async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/admin/login' && request.method === 'GET') {
    // If already authenticated, redirect to dashboard
    const user = await authenticateRequest(request, env);
    if (user) {
      return Response.redirect(`${env.ADMIN_ORIGIN}/admin/dashboard`, 302);
    }
    const error = url.searchParams.get('error');
    return htmlResponse(loginPage(error));
  }

  if (path === '/admin/register' && request.method === 'GET') {
    const user = await authenticateRequest(request, env);
    if (user) {
      return Response.redirect(`${env.ADMIN_ORIGIN}/admin/dashboard`, 302);
    }
    const error = url.searchParams.get('error');
    return htmlResponse(registerPage(error));
  }

  if (path === '/admin/dashboard' && request.method === 'GET') {
    const user = await authenticateRequest(request, env);
    if (!user) {
      return Response.redirect(`${env.ADMIN_ORIGIN}/admin/login`, 302);
    }
    return htmlResponse(dashboardPage(user));
  }

  return null;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

function loginPage(error: string | null): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge - Sign In</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    padding: 48px 40px;
    text-align: center;
    max-width: 400px;
    width: 100%;
  }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 32px; }
  .btn-google {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 24px;
    background: #fff;
    border: 1px solid #dadce0;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    color: #3c4043;
    cursor: pointer;
    text-decoration: none;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .btn-google:hover { background: #f7f8f8; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .btn-google svg { width: 20px; height: 20px; }
  .divider { display: flex; align-items: center; gap: 16px; margin: 24px 0; color: #999; font-size: 13px; }
  .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #e5e5e5; }
  .form-group { margin-bottom: 14px; text-align: left; }
  .form-group label { display: block; font-size: 13px; font-weight: 500; color: #555; margin-bottom: 4px; }
  .form-group input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 14px;
  }
  .form-group input:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,0.15); }
  .btn-submit {
    width: 100%;
    padding: 10px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    margin-top: 4px;
  }
  .btn-submit:hover { background: #1557b0; }
  .error { color: #d93025; font-size: 13px; margin-bottom: 16px; background: #fce8e6; padding: 8px 12px; border-radius: 6px; }
  .link { color: #1a73e8; text-decoration: none; font-size: 13px; }
  .link:hover { text-decoration: underline; }
  .footer { margin-top: 20px; }
</style>
</head>
<body>
<div class="card">
  <h1>Claude Bridge</h1>
  <p class="subtitle">E2E encrypted multi-party collaboration</p>
  ${errorHtml}
  <a href="/auth/google" class="btn-google">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Sign in with Google
  </a>
  <div class="divider">or</div>
  <form method="POST" action="/auth/login">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username">
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
    </div>
    <button type="submit" class="btn-submit">Sign in</button>
  </form>
  <div class="footer">
    <a href="/admin/register" class="link">Don't have an account? Register</a>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Register page
// ---------------------------------------------------------------------------

function registerPage(error: string | null): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge - Register</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    padding: 48px 40px;
    max-width: 400px;
    width: 100%;
  }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; text-align: center; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; text-align: center; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 13px; font-weight: 500; color: #555; margin-bottom: 4px; }
  .form-group input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 14px;
  }
  .form-group input:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,0.15); }
  .hint { font-size: 12px; color: #888; margin-top: 4px; }
  .btn-submit {
    width: 100%;
    padding: 10px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    margin-top: 8px;
  }
  .btn-submit:hover { background: #1557b0; }
  .error { color: #d93025; font-size: 13px; margin-bottom: 16px; background: #fce8e6; padding: 8px 12px; border-radius: 6px; }
  .link { color: #1a73e8; text-decoration: none; font-size: 13px; }
  .link:hover { text-decoration: underline; }
  .footer { margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>Create Account</h1>
  <p class="subtitle">Register for Claude Bridge</p>
  ${errorHtml}
  <form method="POST" action="/auth/register">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required minlength="3" maxlength="30" pattern="[a-zA-Z0-9_-]+" autocomplete="username">
      <p class="hint">3-30 characters, letters, numbers, _ and -</p>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="6" autocomplete="new-password">
      <p class="hint">At least 6 characters</p>
    </div>
    <div class="form-group">
      <label for="confirm">Confirm Password</label>
      <input type="password" id="confirm" name="confirm" required minlength="6" autocomplete="new-password">
    </div>
    <button type="submit" class="btn-submit">Create Account</button>
  </form>
  <div class="footer">
    <a href="/admin/login" class="link">Already have an account? Sign in</a>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

function dashboardPage(user: AuthUser): string {
  const avatarHtml = user.picture
    ? `<img src="${escapeHtml(user.picture)}" alt="" class="avatar">`
    : `<div class="avatar avatar-placeholder">${escapeHtml(user.name.charAt(0).toUpperCase())}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge - Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
    line-height: 1.5;
  }
  header {
    background: #fff;
    border-bottom: 1px solid #e5e5e5;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  .user-info { display: flex; align-items: center; gap: 12px; font-size: 14px; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; }
  .avatar-placeholder {
    background: #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
    color: #666;
  }
  .btn-logout {
    padding: 6px 14px;
    background: none;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    color: #555;
  }
  .btn-logout:hover { background: #f5f5f5; }
  main { max-width: 800px; margin: 24px auto; padding: 0 24px; }
  section { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); padding: 24px; margin-bottom: 20px; }
  section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  .btn {
    padding: 8px 18px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    font-weight: 500;
  }
  .btn:hover { background: #1557b0; }
  .btn-danger { background: #d93025; }
  .btn-danger:hover { background: #b3261e; }
  .btn-sm { padding: 4px 12px; font-size: 12px; }
  input[type="text"] {
    padding: 8px 12px;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 14px;
    width: 240px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #555; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .result-box {
    margin-top: 12px;
    padding: 12px 16px;
    background: #f8f9fa;
    border-radius: 8px;
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 13px;
    word-break: break-all;
    display: none;
  }
  .result-box.visible { display: block; }
  .secret-toggle { cursor: pointer; color: #1a73e8; font-size: 12px; user-select: none; }
  .secret-value { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 13px; }
  pre.cli {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 16px 20px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre;
  }
  .empty { color: #999; font-size: 14px; font-style: italic; }
  .row { display: flex; align-items: center; gap: 10px; }
</style>
</head>
<body>
<header>
  <h1>Claude Bridge</h1>
  <div class="user-info">
    ${avatarHtml}
    <span>${escapeHtml(user.name)} (${escapeHtml(user.email)})</span>
    <form method="POST" action="/auth/logout" style="margin:0">
      <button type="submit" class="btn-logout">Sign out</button>
    </form>
  </div>
</header>
<main>

<!-- Create Room -->
<section>
  <h2>Create Room</h2>
  <button class="btn" onclick="createRoom()">Create New Room</button>
  <div id="room-result" class="result-box"></div>
</section>

<!-- My Rooms -->
<section>
  <h2>My Rooms</h2>
  <div id="rooms-list"><p class="empty">Loading...</p></div>
</section>

<!-- API Tokens -->
<section>
  <h2>API Tokens</h2>
  <div class="row" style="margin-bottom: 12px;">
    <input type="text" id="token-label" placeholder="Token label (e.g. laptop)">
    <button class="btn" onclick="createToken()">Create Token</button>
  </div>
  <div id="token-result" class="result-box"></div>
  <div id="tokens-list"><p class="empty">Loading...</p></div>
</section>

<!-- CLI Quick Start -->
<section>
  <h2>CLI Quick Start</h2>
  <pre class="cli"># On your machine (room creator)
claude-bridge host &lt;CODE&gt; --secret &lt;SECRET&gt; --name &lt;your-alias&gt;

# On peer machines (share code + secret with them)
npx claude-bridge join &lt;CODE&gt; --secret &lt;SECRET&gt; --name &lt;their-alias&gt;

# Then restart Claude Code on all machines</pre>
</section>

</main>

<script>
async function createRoom() {
  const res = await fetch('/api/room/create', { method: 'POST' });
  if (!res.ok) { alert('Failed to create room'); return; }
  const data = await res.json();
  const el = document.getElementById('room-result');
  el.classList.add('visible');
  el.innerHTML = '<strong>Room Code:</strong> ' + esc(data.code) +
    '<br><strong>Join Secret:</strong> ' + esc(data.joinSecret) +
    '<br><br><strong>Install on your machine:</strong>' +
    '<pre class="cli" style="margin-top:8px">claude-bridge host ' + esc(data.code) + ' --secret ' + esc(data.joinSecret) + ' --name &lt;your-alias&gt;</pre>' +
    '<strong>Share with peers:</strong>' +
    '<pre class="cli" style="margin-top:8px">npx claude-bridge join ' + esc(data.code) + ' --secret ' + esc(data.joinSecret) + ' --name &lt;their-alias&gt;</pre>';
  loadRooms();
}

async function loadRooms() {
  const res = await fetch('/api/rooms');
  if (!res.ok) return;
  const data = await res.json();
  const el = document.getElementById('rooms-list');
  if (!data.rooms.length) {
    el.innerHTML = '<p class="empty">No rooms yet. Create one above.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Code</th><th>Join Secret</th><th>Created</th><th></th></tr></thead><tbody>';
  for (const r of data.rooms) {
    const date = new Date(r.createdAt).toLocaleDateString();
    const joinCmd = 'npx claude-bridge join ' + r.code + ' --secret ' + r.joinSecret + ' --name <alias>';
    html += '<tr><td><strong>' + esc(r.code) + '</strong></td>' +
      '<td><span class="secret-value" data-secret="' + esc(r.joinSecret) + '">' +
      dots(r.joinSecret.length) + '</span> ' +
      '<span class="secret-toggle" onclick="toggleSecret(this)">[show]</span></td>' +
      '<td>' + esc(date) + '</td>' +
      '<td><button class="btn btn-sm" onclick="copyCmd(this, &quot;' + esc(joinCmd) + '&quot;)">Copy join cmd</button></td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function createToken() {
  const label = document.getElementById('token-label').value.trim() || 'Untitled';
  const res = await fetch('/api/tokens/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) { alert('Failed to create token'); return; }
  const data = await res.json();
  const el = document.getElementById('token-result');
  el.classList.add('visible');
  el.innerHTML = '<strong>Token created!</strong> Copy it now (you will not see it again):<br>' +
    '<code>' + esc(data.token) + '</code>';
  document.getElementById('token-label').value = '';
  loadTokens();
}

async function loadTokens() {
  const res = await fetch('/api/tokens');
  if (!res.ok) return;
  const data = await res.json();
  const el = document.getElementById('tokens-list');
  if (!data.tokens.length) {
    el.innerHTML = '<p class="empty">No API tokens yet.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Label</th><th>Token</th><th>Created</th><th></th></tr></thead><tbody>';
  for (const t of data.tokens) {
    const date = new Date(t.createdAt).toLocaleDateString();
    html += '<tr><td>' + esc(t.label) + '</td>' +
      '<td class="secret-value">...' + esc(t.last4) + '</td>' +
      '<td>' + esc(date) + '</td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="deleteToken(&quot;' + esc(t.id) + '&quot;)">Delete</button></td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function deleteToken(id) {
  if (!confirm('Delete this token? This cannot be undone.')) return;
  const res = await fetch('/api/tokens/' + id, { method: 'DELETE' });
  if (!res.ok) { alert('Failed to delete token'); return; }
  loadTokens();
}

function toggleSecret(el) {
  const span = el.previousElementSibling;
  const secret = span.getAttribute('data-secret');
  if (el.textContent === '[show]') {
    span.textContent = secret;
    el.textContent = '[hide]';
  } else {
    span.textContent = dots(secret.length);
    el.textContent = '[show]';
  }
}

function copyCmd(btn, cmd) {
  navigator.clipboard.writeText(cmd).then(function() {
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy join cmd'; }, 2000);
  });
}

function dots(n) { return '\\u2022'.repeat(Math.min(n, 16)); }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Load on page init
loadRooms();
loadTokens();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
