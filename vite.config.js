import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ローカル開発(npm run dev)で /api を Vercel の関数に通すための簡易プロキシは不要。
// 本番(Vercel)では /api/claude.js がそのままサーバーレス関数として動く。
export default defineConfig({
  plugins: [react()],
});
