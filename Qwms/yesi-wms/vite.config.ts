import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins:[react()], root:'web', build:{outDir:'../public',emptyOutDir:true}, server:{host:'0.0.0.0',port:5173,allowedHosts:true,proxy:{'/api':{target:'http://127.0.0.1:3000',changeOrigin:false},'/ws':{target:'http://127.0.0.1:3000',ws:true}}}, test:{include:['../tests/**/*.test.ts'],fileParallelism:false,hookTimeout:20000,testTimeout:20000} });
