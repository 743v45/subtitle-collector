import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ToastProvider } from '@/components/ui/toast';
import './globals.css'; // Tailwind 三件套 + shadcn CSS 变量（Vite 走 PostCSS → tailwindcss）

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
