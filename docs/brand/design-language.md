# ManaWG design language

Source: [Brandbook v1.0](brandbook.html), supplied by the product owner on 2026-09-12. This is the product design reference; its institutional approval procedures are not execution instructions for development tools.

## Implementation contract

- shadcn `base-nova`, Neutral, CSS variables; reuse existing component anatomy and application flows.
- Inter UI, Inter Tight 600 headings/wordmark, JetBrains Mono 500 for amounts and labels. Latin WOFF2 files are extracted from the supplied book and self-hosted; OFL licenses accompany them.
- Exact chapter 10 light/dark tokens. Only `settled` adds a semantic color; debt/destructive uses `destructive`. Zero balances stay neutral. Charts use a neutral ramp; amount signs and wording carry meaning independently of color.
- One radius source (`0.625rem`) with multiplicative steps. Cards use xl, controls lg. Mobile margins 16px, grouped spacing 8/16/24px, accessible touch regions at least 44px.
- Web content and navigation are opaque and bordered. Chapter 11.4's native glass examples are not a web rendering requirement. Preserve Start, Haushalt, Finanzen, Austausch and the existing icon-only account control; no header search.
- Supplied eight-circle organism and off-center aperture replace the former keyhole everywhere in the app identity. Reproduce the source filter/mask geometry without invented motifs. Icons are white on Neutral 950, no baked rounding, shadows, or gradients.
- No button scaling, tab bounce, or page entrance animations. Loading uses the organism, 1200ms, and becomes static for reduced motion. No artificial startup delay.
- Plain German, no guilt, advertising badges or decorative status colors. Labels above fields; visible focus and invalid states retained.

## Explicit handset transition exception

For the requested WG app-feel update, subpage navigation may use a 120 ms opacity-only fade. Reduced-motion preferences skip the fade; sliding, bounce, and startup delay remain disallowed.

## Explicit navigation glass exception

On 2026-09-23 the product owner requested Liquid Glass for the bottom navigation in light and dark mode. `.glass-bar` may use a tinted translucent background with backdrop blur on the navigation layer only, never on content. Reduced-transparency, increased-contrast and browsers without `backdrop-filter` fall back to the opaque bordered bar.

## Explicit handset touch-feedback exception

For the same update, shared buttons and tappable list/card surfaces may scale to 0.97 for an 80 ms pressed state. Reduced-motion preferences disable the scale; 44 px touch targets remain required.

## Explicit member avatar color exception

On 2026-09-26 the product owner requested colored member avatars; the color is intentional. `memberTint(name)` in `src/components/wg/MemberAvatar.tsx` picks one of eight oklch hues from the member's name and mixes it with `--background`/`--foreground`, so every avatar of a person (members, chat, Pinnwand, balances) matches in light and dark with initials contrast of at least 5.9:1. This is the only decorative color; do not neutralize avatars back to `bg-muted`, and do not reuse the hues for status or other surfaces.

## Responsive control contract

- Component sizes belong to the shared primitives, not a phone-only global
  override. Button variants use visible 24/32/36/40px minimum heights and grow
  when text wraps. Their hit regions extend to 44px without enlarging the painted
  box; adjacent grouped controls reserve their own width to avoid overlapping hits.
- Native inputs, selects and single-line input groups use 44px actual height and
  16px text on phones and tablets. This is an explicit accessibility resolution
  of chapter 11.3's 36px visual reference against chapter 15's 44px touch floor:
  native controls cannot reliably use pseudo-elements to extend their hit area.
  Do not use zoom, transforms or clipped focus rings to simulate smaller fields.
- The owner's explicit mobile icon-only Plus preference takes precedence over
  the general icon-plus-text rule. Every such action keeps its accessible name.
- Tablet Home uses balanced columns; phone Home remains a single column. Forms
  retain internal scrolling and reachable actions on short viewports.

## Resolved source inconsistencies

Specific component references take precedence over broad summaries: chapter 10 white background over chapter 7's FAFAFA; chapter 11.5 neutral zero over general settled wording; chapter 12 Lucide 1.5px over chapter 9's 1.75px; chapter 30 keeps eight favicon bodies over chapter 25's removal of tiny satellites. Use 1200ms loader from the repeated product contract rather than the 1600ms showcase. The 44px interaction region is separate from smaller visual icons. Explicit switch geometry is a documented component exception. Floating navigation retains 20px outer and 16px inner curves on the web with an opaque surface; platform material and geometry are separate.

The current app remains a mobile-first shared household interface. Native Icon Composer/Android app packages, Lottie exports, print, social, and marketing-site work are outside this web-app change.

## Sources in code

`apps/web/src/shared/globals.css` owns colors, type roles, radius and basic motion. `apps/web/components.json` owns registry configuration. `src/shared/lib/brand-mark.json` holds the supplied geometry; `src/shared/components/ui/LogoMark.tsx` renders it. `scripts/generate-brand-assets.mjs` derives browser/PWA assets. Do not revive former forest/mint/blue palettes or the keyhole mark.
