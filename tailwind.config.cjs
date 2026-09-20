/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,ts}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        surface: 'var(--color-bg-surface)',
        subtle: 'var(--color-bg-subtle)',
        primary: 'var(--color-fg-primary)',
        secondary: 'var(--color-fg-secondary)',
        tertiary: 'var(--color-fg-tertiary)',
        accent: 'var(--color-accent)',
        success: 'var(--color-success-500)',
        warning: 'var(--color-warning-500)',
        error: 'var(--color-error-500)',
      },
      fontFamily: {
        sans: ['var(--font-family-ui)'],
        mono: ['var(--font-family-mono)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
    },
  },
};
