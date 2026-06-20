import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './globals.css'; // Tailwind 三件套 + shadcn CSS 变量（Vite 走 PostCSS → tailwindcss）

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
