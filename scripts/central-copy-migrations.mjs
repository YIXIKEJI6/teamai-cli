import { cpSync } from 'node:fs';
cpSync('src/central/migrations', 'dist/migrations', { recursive: true });
