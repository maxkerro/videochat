import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authSessionSchema, type AuthSession } from '@videochat/shared';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { createPool } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { MailService } from '../src/mail/mail.service.js';

class FakeMailService {
  verifyTokens: string[] = [];
  sendVerificationEmail(_to: string, token: string) {
    this.verifyTokens.push(token);
    return Promise.resolve();
  }
  sendPasswordResetEmail() {
    return Promise.resolve();
  }
}

export interface E2eUser {
  id: string;
  session: AuthSession;
  token: string;
}

/**
 * Shared harness for the M3 call suites: a fresh database, the real AppModule (mail faked), and a
 * server that listens once for the whole file (see the comment in authorization.e2e.spec.ts on why
 * per-request listen/close is avoided). `prefix` keeps generated emails/usernames unique per file.
 */
export async function startE2eApp(prefix: string) {
  const migrationPool = createPool(process.env.TEST_DATABASE_URL!, 1);
  await resetDatabase(migrationPool);
  await runMigrations(migrationPool);
  await migrationPool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useClass(FakeMailService)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const mail = moduleRef.get(MailService) as unknown as FakeMailService;
  const server = () => app.getHttpServer();

  let counter = 0;
  async function signUp(): Promise<E2eUser> {
    counter += 1;
    const user = {
      email: `${prefix}-${counter}@test.dev`,
      username: `${prefix}${counter}`,
      displayName: `${prefix} user ${counter}`,
      password: 'correct-horse-battery-staple',
    };
    await request(server()).post('/auth/signup').send(user).expect(201);
    const token = mail.verifyTokens.at(-1)!;
    await request(server()).post('/auth/verify-email').send({ token }).expect(200);
    const loginRes = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const session = authSessionSchema.parse(loginRes.body);
    const me = await request(server()).get('/me').set(bearer(session.accessToken)).expect(200);
    return { id: me.body.id as string, session, token: session.accessToken };
  }

  return { app, server, signUp };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}
