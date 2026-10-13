# SpendGate Design System

**This file is the single source of truth.** Edit any value below, then tell Kimi
"apply the design system" — the change gets mapped into `web/tailwind.config.js`,
`web/src/components/ui.tsx`, `web/index.html`, and the pages. Don't edit those
files directly; they'll be regenerated from this document.

## 1. Colour

| Token | Hex | Used for |
|---|---|---|
| `bg` | `#0E0D0B` | Sidebar background |
| `black` | `#000000` | Main page background (pure black) |
| `panel` | `#161511` | Cards, table header rows, stat tiles |
| `line` | `#2E2B23` | Borders, dividers, table grid |
| `paper` | `#F4F1E8` | Primary text |
| `muted` | `#8A8474` | Secondary text, metadata, timestamps |
| `pending` | `#E8A020` | Pending approval status only |
| `ok` | `#4CAF50` | Allowed / approved-positive, chain-verified |
| `danger` | `#E0522A` | Denied / rejected, chain broken, destructive actions |

Badge fills are solid, vibrant tone colours with dark (`bg`-coloured) text —
no opacity washes, no gradients. Nothing glows.

## 2. Typography

One family everywhere: **Montserrat** (Google Fonts, weights 400/500/600/700),
loaded in `web/index.html`. There is no second font — "mono" text is just
Montserrat 500 with `tabular-nums`, so columns of numbers align.

| Style | Spec | Where |
|---|---|---|
| Wordmark | 600, all caps, tracked out | Sidebar "SPENDGATE" (only all-caps text on the site) |
| Page title | 22px / 600 / tight leading | Every page header |
| Eyebrow | 9px / 500 / `0.04em` tracking / sentence case / white | Above page titles, section labels |
| Body | 13–15px / 400 / white | Amounts, vendor names, descriptions |
| Data | 11px / 500 / tabular-nums / white | Timestamps, IDs, hashes, metadata |
| Stat value | 20px / 500 / tabular-nums | Overview stat tiles |

**No text is fully capitalised** — buttons, nav, labels, table headers and
metadata are all sentence/title case (keep the tracking for the small mono
styles). The `SPENDGATE` wordmark is the one exception. Parenthetical
instructions ("blank = unlimited") live in hover tooltips (`title`), never
inside the label text; labels with a hint get a dotted underline.

**All text on the site is white.** Hierarchy comes from size, weight, and
tracking only — never from text colour (the only coloured text left is
functional status: stat values, chain-verified/ broken, error messages).

## 3. Shape, spacing, borders

- **Radius:** stat tiles + agent cards `rounded-lg` (8px) · tables
  `rounded-xl` (12px, via a bordered wrapper with `overflow-hidden`) · badges
  `rounded-md` (6px) · day-picker buttons `rounded-full` · text inputs and
  action buttons `rounded-md` (6px).
  Misc chrome stays square.
- **Borders: 1px solid `line`** on every surface (`bg`, `panel`).
- **Density is compact:** table rows `py-2.5`, cards `px-4/px-5 py-3/4`,
  page gutter is a single `p-8`-ish container, sidebar fixed at 208px.
- **Grid:** stats in 2 cols (4 on `xl`); everything else reads as full-width
  stacked tables/lists.

## 4. Components

### Stat tile
Black (`bg-black`) fill to match the page background, `line` border,
`rounded-lg`. Label = eyebrow style; value = stat style in the **vibrant**
tones (`#4CAF50` / `#E8A020` / `#E0522A`) or white.

### Badge (decision tiles)
`rounded-md`, **solid vibrant fill**, white 9px sentence-case label, 4% tracking.
Vibrant hexes (not the pastel design tokens): allowed `#4CAF50` ·
approved `#4CAF50` · pending `#E8A020` · denied/rejected `#E0522A` · expired `#8A8474`.

### Buttons
- **Primary (save / register):** solid white `paper` (`#F4F1E8`), dark text,
  square, 11px sentence case, wide tracking, hover → `paper/80`.
- **Destructive:** 1px red border, red text, hover fills red.
- **Confirmations:** destructive or policy-changing actions (save policy,
  remove blocked vendor) open a centred modal on `bg-black/80` before
  committing — white Confirm for saves, red Remove for unblocking.
No amber buttons — amber is reserved for the "pending" status meaning.
No shadows, no gradients on any button.

### Budget bar
`h-1.5` rounded-full track (`line` fill) on black; progress in vibrant green
`#4CAF50`, switching to vibrant red `#E0522A` above 90%.

### Agent policy cards
Black (`bg-black`) fill to match the page, `line` border, `rounded-lg`.
Day-picker buttons are `rounded-full`; selected days use the success green
`#4CAF50` with white text.

### Tables (Ledger, Overview activity, blocked vendors)
Real `<table>`, `border-collapse`, 1px `line` outer border, row dividers,
**and vertical column lines between every column**. Header row: `panel` fill,
9px sentence case, 4% tracking. Body rows: all text white (`paper`), hover
`panel/50`. Numbers right-aligned, `tabular-nums`. No zebra striping.
The blocked-vendors table spans the full card width below the form grid, not
inside a grid column.

### Page header
No divider line, **no eyebrow** — just the 22px title left, metadata right
(`N ledger entries · chain verified`), generous bottom whitespace only. No
marketing copy, no slogans — this is an operator console, not a landing page.

### Sidebar
`bg` fill, `line` right border, wordmark top, nav in title case with subtle
(4%) tracking, active item = `paper` left edge bar + paper text, status dot +
`© 2026 Britannic & Balkan` pinned at the bottom. Sticky (`top-0 h-screen`) —
it does not scroll with the page.

## 5. Voice

Institutional, sober, terse. Labels are nouns ("Approval queue", "Signed
ledger"), metadata is quantitative ("Last 5 entries"), statuses are single
title-case words. No exclamation marks, no emojis, no "delight".

## 6. Current deviations / TODO

- Landing site (`../spendgate-landing/`) does **not** follow this system yet.

## Monochrome brand rule

No decorative gold accents. Active navigation uses a paper-coloured border, primary buttons use paper with dark text, and hashes and code labels use paper. Both allowed and human-approved decisions use green. Amber is reserved for pending approval indicators, never navigation or primary actions.

## Budget accounting controls

Agent policy cards show completed spend, reserved funds and remaining budget separately, including unlimited budgets and negative remaining values after an override. Show the daily UTC period beside balances. Permission is not proof of payment. Add a labelled Budget mode select (Hard stop / Approval override) using the existing input styling, with a terse explanation of the selected mode. Legacy reconciliation uses bordered rows and labelled controls, a plain-language attestation preserving unknown history, evidence and reason fields, and the existing confirmation modal before recording a disposition. Error copy uses the danger colour; no new visual tokens.
