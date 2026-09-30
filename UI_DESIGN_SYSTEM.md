# RESUMEAUTO 3D TITAN — UI DESIGN SYSTEM & ARCHITECTURE
**Version:** 8.0-3D-TITAN  
**Target Performance:** 60 FPS Constant | Sub-16ms Frame Times | Zero Main-Thread Blocking  
**Design Identity:** AI Command Center × Modern 3D Glassmorphic SaaS  

---

## 1. DESIGN PHILOSOPHY: ZERO-LAG 3D DEPTH

ResumeAuto is a professional AI-driven outreach platform. The 3D UI is engineered to communicate **depth, hierarchy, and system state** without feeling like a gaming interface or introducing GPU/CPU latency.

### Core Principles
1. **Volumetric Hierarchy Over Flat Surfaces:** Use subtle layered z-depth, soft colored ambient occlusions, and hairline glass borders instead of heavy opaque containers.
2. **Deterministic Frame Budget (60 FPS):** All motion is composited directly on the GPU. Never trigger layout recalculation (reflow) during interaction.
3. **Restrained Motion (The 3-Degree Rule):** Maximum 3D card tilt angle is strictly capped at **±3.0 degrees** on `rotateX` and `rotateY`. Maximum hover displacement is **-4px** on `translate3d`.
4. **Adaptive Context:** 3D tilt and continuous ambient animations are completely disabled on mobile devices, touch screens, and when `prefers-reduced-motion` is active.

---

## 2. COLOR PALETTE & TOKENS

The color palette leverages an obsidian deep-space backdrop with high-contrast electric cyber accents.

### 2.1 Base & Surfaces
| Token | Value | Role |
| :--- | :--- | :--- |
| `--bg-space` | `#030712` | Root deep space background |
| `--bg-surface` | `rgba(8, 12, 24, 0.82)` | Primary command layout surface |
| `--card-glass` | `rgba(13, 19, 36, 0.65)` | Standard glassmorphic card fill |
| `--card-solid` | `#0d1324` | Opaque fallback for high-density tables |
| `--card-hover` | `rgba(18, 26, 48, 0.85)` | Elevated card hover state |
| `--border-subtle` | `rgba(99, 102, 241, 0.14)` | Hairline container border |
| `--border-bright` | `rgba(99, 102, 241, 0.35)` | Interactive focus & hover border |
| `--border-glass` | `rgba(255, 255, 255, 0.08)` | Top edge specular light reflection |

### 2.2 Cybernetic Accents
| Token | Value | Role |
| :--- | :--- | :--- |
| `--accent-cyan` | `#22d3ee` | AI Telemetry, primary action highlights |
| `--accent-violet` | `#a78bfa` | Autonomous engine, system brand |
| `--accent-purple` | `#c084fc` | Dynamic variable & AI drafting |
| `--accent-magenta`| `#f472b6` | High-priority recruiter actions |
| `--status-green` | `#34d399` | System Healthy, Sent, Eligible lead |
| `--status-yellow` | `#fbbf24` | Cooldown, Paused worker, Warning |
| `--status-red` | `#f87171` | Emergency Stop, Blocked, Bounce |
| `--status-blue` | `#60a5fa` | Queued, RFC validating, Info |

### 2.3 Command Gradients
```css
--grad-ai: linear-gradient(135deg, #22d3ee 0%, #818cf8 50%, #c084fc 100%);
--grad-shield: linear-gradient(135deg, #34d399 0%, #22d3ee 100%);
--grad-danger: linear-gradient(135deg, #f87171 0%, #fb923c 100%);
--grad-surface: linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0%, rgba(255, 255, 255, 0) 100%);
--grad-orb: radial-gradient(circle at 35% 35%, #22d3ee 0%, #818cf8 45%, #030712 90%);
```

---

## 3. GLASS & ELEVATION MATRIX

Layering uses a 4-tier elevation system where higher tiers feature elevated z-index, lighter fill, and deeper soft shadows.

```
TIER 4: Floating Overlays / Command Palette (z: 1000)
   ↑ [blur: 20px | background: rgba(8,12,24,0.92) | border: rgba(99,102,241,0.3)]
TIER 3: Elevated 3D Cards / Autopilot Hero (z: 10)
   ↑ [blur: 14px | background: rgba(16,23,44,0.78) | shadow: 0 16px 40px -8px rgba(0,0,0,0.6)]
TIER 2: Standard Dashboard Cards (z: 1)
   ↑ [blur: 10px | background: rgba(12,18,34,0.62) | shadow: 0 8px 24px -4px rgba(0,0,0,0.45)]
TIER 1: Deep Canvas Background & Grid (z: 0)
   [background: #030712 + subtle 44px isometric grid]
```

### Hairline Specular Edge (`::before`)
Every glass card employs a pseudo-element overlay simulating ambient edge lighting without layout overhead:
```css
.card-3d::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.12), transparent 45%, transparent 60%, rgba(99, 102, 241, 0.1));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
```

---

## 4. 3D TILT ENGINE SPECIFICATION

To guarantee **60 FPS** with zero layout thrashing, the 3D tilt engine adheres to strict rules:

### Controller Contract: `Interactive3DCardEngine`
1. **Zero DOM Polling:** Elements register once via class `.card-3d`.
2. **RAF Throttling:** Raw `pointermove` events only store `clientX` and `clientY` coordinates. Transform calculations execute strictly inside `requestAnimationFrame`.
3. **CSS Variable Drive:** The engine modifies CSS custom properties (`--tilt-x`, `--tilt-y`, `--sheen-x`, `--sheen-y`) directly on the element style object. No `innerHTML`, `className`, or stylesheet mutations.
4. **Transform Rule:**
   ```css
   .card-3d {
     transform-style: preserve-3d;
     will-change: transform;
     transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.22s ease, border-color 0.22s ease;
     transform: perspective(1000px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg)) translate3d(0, var(--lift-y, 0px), 0);
   }
   .card-3d:hover {
     --lift-y: -4px;
     border-color: var(--border-bright);
     box-shadow: 0 20px 48px -10px rgba(0, 0, 0, 0.7), 0 0 24px -4px var(--accent-glow);
   }
   ```
5. **Safety Clamps:**
   - `tiltX = clamp(-3.0, (mouseY / rect.height - 0.5) * -6.0, 3.0)`
   - `tiltY = clamp(-3.0, (mouseX / rect.width - 0.5) * 6.0, 3.0)`
6. **Graceful Exit:** On `pointerleave`, variables smoothly animate back to `0deg` using CSS transition.

---

## 5. REUSABLE UI COMPONENT INVENTORY

| Component | Responsibility | Tech Implementation |
| :--- | :--- | :--- |
| `Interactive3DCard` | Reusable 3D tilt container for metrics and status blocks | CSS 3D + RAF pointer driver |
| `AIOrb` | 3D holographic sphere representing Autopilot state | Multi-stop radial gradient + dual SVG counter-rotating rings |
| `CommandPalette` | Floating modal for rapid navigation and actions (`Ctrl+K`) | Glass overlay + keyboard event trap (`↑`, `↓`, `Enter`, `Esc`) |
| `MetricTile` | Volumetric single-metric tile with live animated counter | CSS preserve-3d + `animateNumber()` driver |
| `CyberProgress` | Fluid glowing progress track with animated laser beam | Glass track + gradient bar + CSS shimmer sweep |
| `MilestoneTimeline`| Multi-checkpoint visual journey line | Flex sequence with glowing node states (Active, Done, Dim) |
| `ShieldBadge` | Cybernetic security status indicator | Micro-badge with radial status glow and tooltips |
| `CommandHeader` | 3D perspective logo, telemetry capsule, live controls | Perspective text gradient + dynamic status pills |

---

## 6. TYPOGRAPHY & SPACING SYSTEM

- **Primary Display & Interface:** `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
  - Font weights: 400 (Regular), 500 (Medium), 600 (Semibold), 700 (Bold), 900 (Black).
- **Telemetry & Numbers:** `'JetBrains Mono', 'Fira Code', monospace`
  - Used for counters, timestamps, email addresses, verdict codes, and JSON previews.

### Spacing Scale
| Step | Size | Standard Application |
| :--- | :--- | :--- |
| `--sp-1` | `4px` | Badge padding, micro gaps |
| `--sp-2` | `8px` | Icon-to-text spacing, button gap |
| `--sp-3` | `12px` | Input internal padding, card headers |
| `--sp-4` | `16px` | Grid column gap, card padding (compact) |
| `--sp-5` | `20px` | Card internal padding (standard) |
| `--sp-6` | `24px` | Section margins, hero padding |
| `--sp-8` | `32px` | Major panel separators |

---

## 7. ANIMATION BUDGET & PERFORMANCE RULES

To prevent CPU/GPU exhaustion:

1. **Composite-Only Properties:**
   - ✅ `transform: translate3d(), rotateX(), rotateY(), scale()`
   - ✅ `opacity: 0 to 1`
   - ❌ **NEVER ANIMATE:** `width`, `height`, `top`, `left`, `margin`, `padding`, `filter`
2. **IntersectionObserver Auto-Pausing:**
   - Any continuous visual effect (e.g. AI Orb pulse, chart updates, particle motion) must register with an `IntersectionObserver`. When off-screen, CSS animation class or RAF step is paused.
3. **Global Animation Limits:**
   - Background: 1 ambient gradient drift (30-second loop).
   - AI Orb: 1 pulse (4-second loop) + 1 ring rotation (8-second loop).
   - Metric Cards: 0 continuous animations (only activates upon user hover).
   - Tables: Pulse animations allowed strictly on **active/sending** rows.
4. **Hardware Acceleration Flags:**
   - Applied selectively to moving containers using `will-change: transform`.
   - Never apply `will-change` globally to avoid VRAM bloat.

---

## 8. ACCESSIBILITY & MOTION COMPLIANCE

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transform: none !important;
  }
  .card-3d {
    transform: none !important;
  }
  body::before, body::after {
    animation: none !important;
  }
}

@media (pointer: coarse), (max-width: 768px) {
  /* Disable 3D tilt engine on touch screens and mobile */
  .card-3d {
    transform: none !important;
    transition: transform 0.15s ease !important;
  }
  .card-3d:hover {
    transform: translateY(-2px) !important;
  }
}
```

---

## 9. BREAKPOINTS MATRIX

| Breakpoint | Viewport Width | 3D Experience Level | Layout Configuration |
| :--- | :--- | :--- | :--- |
| **Ultra / Desktop** | `≥ 1280px` | **Full 3D Titan** (3° tilt, dual orb rings, dynamic sheen) | Multi-column grid, expanded command center |
| **Laptop** | `1024px – 1279px` | **Full 3D Titan** (3° tilt, dual orb rings) | Standard 2-column grid |
| **Tablet** | `768px – 1023px` | **Subtle 3D** (hover lift -3px, static sheen) | Condensed 2-column to 1-column |
| **Mobile** | `< 768px` | **Flat Glass Fast** (zero 3D tilt, fast 150ms transitions) | Stacked 1-column, horizontal scroll tabs |

---

*Verified & Enforced for ResumeAuto v8.0 Architecture.*
