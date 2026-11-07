/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        tactical: {
          bg: "#0B0F19",
          panel: "#111827",
          border: "#1F2937",
          accent: "#EF4444",
          cyber: "#06B6D4",
          beacon: "#F59E0B",
          ok: "#10B981",
        }
      }
    },
  },
  plugins: [],
}

