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
        sans: ['STM UI', 'ui-sans-serif', '-apple-system', 'Segoe UI', 'PingFang SC', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'JetBrains Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
    },
  },
};
