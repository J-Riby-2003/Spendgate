/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0E0D0B',
        panel: '#161511',
        line: '#2E2B23',
        paper: '#F4F1E8',
        muted: '#8A8474',
        gold: '#C8A96A',
        golddim: '#8A7449',
        danger: '#B4552D',
        ok: '#7D8F5C',
      },
      fontFamily: {
        display: ['Montserrat', 'sans-serif'],
        wordmark: ['Montserrat', 'sans-serif'],
        body: ['Montserrat', 'sans-serif'],
        mono: ['Montserrat', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
