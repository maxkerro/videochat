import { existsSync } from 'node:fs';

// Tests never touch the development database: point DATABASE_URL at TEST_DATABASE_URL.
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'warn';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
