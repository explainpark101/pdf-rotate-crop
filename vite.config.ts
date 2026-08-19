import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
const basePath = process.env.VITE_BASE_PATH || '/';
const path = require('path');


export default defineConfig({
  base: basePath,
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
