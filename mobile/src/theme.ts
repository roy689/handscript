// ── HandScript Design System ────────────────────────────────────────────────
// Aesthetic: Ink & Parchment — where analog warmth meets digital precision.
// Every surface feels like aged paper; every action like a deliberate pen stroke.

export const lightColors = {
  // ── Surfaces ──────────────────────────────────────────────────────────────
  bgPage:    '#F4EFE6',   // warm parchment — like a well-used writing pad
  bgSurface: '#FDFAF4',   // cream card surface — lighter than the page
  bgInput:   '#FFFEF9',   // near-white paper for writing areas
  bgDark:    '#1C1714',   // deep warm ink for dark hero sections

  // ── Typography ────────────────────────────────────────────────────────────
  inkDark:   '#1E1812',   // warm near-black — like dried fountain pen ink
  inkMid:    '#6B5744',   // warm brown — aged manuscript tone
  inkLight:  '#9E8A78',   // light warm umber
  inkFaint:  '#C9B8A8',   // pale warm tone for placeholders

  // ── Accent: deep fountain-pen blue ───────────────────────────────────────
  accent:      '#1E3A5F',   // Prussian blue — serious, classic, not electric
  accentLight: '#E8F0F8',   // pale wash — barely-there blue tint
  accentDark:  '#142A45',   // darker navy for pressed states

  // ── Semantic ──────────────────────────────────────────────────────────────
  success:      '#2A6B3C',   // deep botanical green
  successLight: '#E6F4EC',   // pale sage wash
  warning:      '#A85A0A',   // warm amber — like sealing wax
  warningLight: '#FDF2E0',   // pale amber
  danger:       '#B91C1C',   // deep crimson
  dangerLight:  '#FDE8E8',   // pale rose

  pro:      '#6B21A8',
  proLight: '#F3E8FF',

  // ── Structure ─────────────────────────────────────────────────────────────
  border:      '#DEDAD1',   // warm linen border — visible but not harsh
  borderFaint: '#EDE9E1',   // barely-there separator
} as const;

export const darkColors = {
  // ── Surfaces — candlelit charcoal, not cold navy ──────────────────────────
  bgPage:    '#1A1714',   // warm charcoal paper
  bgSurface: '#242018',   // lighter charcoal for cards
  bgInput:   '#2A2520',   // input area — slightly warmer
  bgDark:    '#0F0D0B',   // deepest warm black

  // ── Typography ────────────────────────────────────────────────────────────
  inkDark:   '#EDE6DA',   // warm cream — like writing on aged paper
  inkMid:    '#A09484',   // warm mid
  inkLight:  '#6B5B4E',   // dim warm
  inkFaint:  '#4A3D34',   // very faint

  // ── Accent: softer blue for low-light reading ─────────────────────────────
  accent:      '#5B9BD6',   // sky-ink blue — readable on dark
  accentLight: '#1A2C40',   // dark blue wash
  accentDark:  '#78B4E6',   // lighter for pressed states

  // ── Semantic ──────────────────────────────────────────────────────────────
  success:      '#4CAF72',
  successLight: '#0D2918',
  warning:      '#F59E0B',
  warningLight: '#2D1A03',
  danger:       '#EF5350',
  dangerLight:  '#2D0A0A',

  pro:      '#A855F7',
  proLight: '#1E0A3A',

  // ── Structure ─────────────────────────────────────────────────────────────
  border:      '#3A3028',   // warm dark border
  borderFaint: '#2D2720',
} as const;

// Static fallback — components that can't use hooks import this
export const colors = lightColors;

// Heebo: exceptional Hebrew rendering + clean Latin companion
export const fonts = {
  regular:   'Heebo_400Regular',
  semiBold:  'Heebo_600SemiBold',
  bold:      'Heebo_700Bold',
  extraBold: 'Heebo_800ExtraBold',
} as const;

// Slightly tighter radii for a more artisanal, less bubbly feel
export const radius = {
  xs:  4,
  sm:  8,
  md:  12,
  lg:  18,
  xl:  26,
  full: 999,
} as const;

// Warm shadow system — tinted toward ink color, never cold gray
export const shadow = {
  card: {
    shadowColor: '#1E1812',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  medium: {
    shadowColor: '#1E1812',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.11,
    shadowRadius: 14,
    elevation: 6,
  },
  page: {
    shadowColor: '#1E1812',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 10,
  },
  btn: {
    shadowColor: '#1E3A5F',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.32,
    shadowRadius: 12,
    elevation: 6,
  },
} as const;
