/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        surface: {
          800: 'rgb(30 41 59 / 0.8)',
          900: 'rgb(15 23 42 / 0.95)',
        },
      },
      boxShadow: {
        'card': '0 4px 24px -4px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.04)',
        'card-hover': '0 12px 40px -8px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(34 197 94 / 0.15)',
      },
    },
  },
  plugins: [],
}
