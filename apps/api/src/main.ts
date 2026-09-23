// Must be the first import: sets up error reporting and tracing before anything else loads.
import './instrument.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.factory.js';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
const env = configureApp(app);
await app.listen(env.PORT, '0.0.0.0');
