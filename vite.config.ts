import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // 按依赖来源拆包：业务代码改动不会让浏览器缓存的第三方库一起失效
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('/codemirror/')) return 'codemirror';
          if (id.includes('lucide')) return 'icons';
          if (id.includes('marked')) return 'marked';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'react';
          return 'vendor';
        },
      },
    },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:4321' },
  },
});
