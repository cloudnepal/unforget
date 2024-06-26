import 'dotenv/config';
import './validateEnvVars.js';

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import type * as t from '../common/types.js';
import * as db from './db.js';
import { ServerError, bytesToHexString } from '../common/util.js';
import cookieParser from 'cookie-parser';
import _ from 'lodash';

const PUBLIC = path.join(process.cwd(), 'public');
const DIST_PUBLIC = path.join(process.cwd(), 'dist/public');

// const icons = _.filter(fs.readdirSync(path.join(PUBLIC, 'icons')), name => name.endsWith('.svg'));

declare global {
  namespace Express {
    interface Locals {
      client?: t.ServerUserClient;
    }
  }
}

// declare module 'express' {
//   export interface Response {
//     locals: MyLocals;
//   }
// }

db.initDB();

const app = express();
app.use(express.json({ limit: '50MB' }));

app.use('/', express.static(PUBLIC));
app.use('/', express.static(DIST_PUBLIC));

app.use(cookieParser());

app.use((req, res, next) => {
  const token = (req.query['token'] || req.cookies.unforget_token) as string | undefined;
  let client: t.ServerUserClient | undefined;
  if (token) {
    client = db.get().prepare(`SELECT username, token FROM clients WHERE token = ?`).get(token) as
      | t.ServerUserClient
      | undefined;
    if (client) {
      db.get()
        .prepare(
          `UPDATE clients SET last_activity_date = :last_activity_date WHERE username = :username AND token = :token`,
        )
        .run({ ...client, last_activity_date: new Date().toISOString() });
    }
  }
  res.locals = { client };
  log(
    res,
    `${req.method} ${req.path} X-Service-Worker-Cache-Version: ${
      req.header('X-Service-Worker-Cache-Version') || 'unknown'
    }, X-Client-Cache-Version: ${req.header('X-Client-Cache-Version') || 'unknown'}`,
  );

  next();
});

// app.use('/api', (req, res, next) => {
//   if (req.query.apiProtocol === '2') {
//     next();
//   } else {
//     next(new ServerError('App requires update', 400, 'app_requires_update'));
//   }
// });

app.post('/api/login', async (req, res, next) => {
  try {
    let loginData = req.body as t.LoginData;
    logDebug(res, '/api/login', req.body);
    loginData = { ...loginData, username: loginData.username.toLowerCase() };
    const user = db.get().prepare(`SELECT * FROM users WHERE username = ?`).get(loginData.username) as
      | t.DBUser
      | undefined;

    if (user) {
      const password_double_hash = await calcDoublePasswordHash(loginData.password_client_hash, user.password_salt);
      if (password_double_hash === user.password_double_hash) {
        loginAndRespond(user, res);
        return;
      }
    }

    throw new ServerError('Wrong username or password.', 401);
  } catch (error) {
    next(error);
  }
});

app.post('/api/signup', async (req, res, next) => {
  try {
    let signupData = req.body as t.SignupData;
    signupData = { ...signupData, username: signupData.username.toLowerCase() };
    if (typeof signupData.username !== 'string' || signupData.username.length < 3) {
      throw new ServerError('username must be at least 3 characters', 400);
    }
    if (/[\/\\<>&'"]/.test(signupData.username)) {
      throw new ServerError('invalid characters in username', 400);
    }

    if (signupData.username === 'demo') throw new ServerError('Username already exists.', 400);

    const user = db.get().prepare(`SELECT * FROM users WHERE username = ?`).get(signupData.username) as
      | t.DBUser
      | undefined;
    if (user) throw new ServerError('Username already exists.', 400);

    const password_salt = generateRandomCryptoString();
    const password_double_hash = await calcDoublePasswordHash(signupData.password_client_hash, password_salt);
    const newUser: t.DBUser = {
      username: signupData.username,
      password_double_hash,
      password_salt,
      encryption_salt: signupData.encryption_salt,
    };
    db.get()
      .prepare(
        `
        INSERT INTO users (username, password_double_hash, password_salt, encryption_salt)
        VALUES (:username, :password_double_hash, :password_salt, :encryption_salt)`,
      )
      .run(newUser);
    loginAndRespond(newUser, res);
  } catch (error) {
    next(error);
  }
});

function loginAndRespond(user: t.DBUser, res: express.Response) {
  const token = generateRandomCryptoString();
  const dbClient: t.DBClient = {
    username: user.username,
    token,
    sync_number: 0,
    last_activity_date: new Date().toISOString(),
  };
  db.get()
    .prepare(
      `
      INSERT INTO clients (username, token, sync_number, last_activity_date)
      VALUES (:username, :token, :sync_number, :last_activity_date)
      `,
    )
    .run(dbClient);
  const maxAge = 10 * 365 * 24 * 3600 * 1000; // 10 years in milliseconds
  res.cookie('unforget_token', token, { maxAge, path: '/' });
  // res.cookie('unforget_username', user.username, { maxAge, path: '/' });
  const loginResponse: t.LoginResponse = { username: user.username, token, encryption_salt: user.encryption_salt };
  res.send(loginResponse);
}

app.post('/api/error', (req, res) => {
  const { message } = req.body as { message: string };
  logError(res, 'client error: ' + message);
  res.send({ ok: true });
});

app.post('/api/log', (req, res) => {
  const { message } = req.body as { message: string };
  log(res, 'client log: ' + message);
  res.send({ ok: true });
});

app.post('/api/partial-sync', (_req, _res, next) => {
  next(new ServerError('App requires update', 400, 'app_requires_update'));
});

app.post('/api/delta-sync', authenticate, (req, res) => {
  logDebug(res, req.body);
  const client = res.locals.client!;
  const deltaSyncReq: t.DeltaSyncReq = req.body;
  const syncNumber = db.getSyncNumber(client);

  // Require queue sync if the sync numbers differ.
  if (syncNumber !== deltaSyncReq.syncNumber) {
    const queueSyncRes: t.DeltaSyncRes = { type: 'require_queue_sync' };
    res.send(queueSyncRes);
    return;
  }

  // When the sync number is 0, send all the notes, otherwise only the queued notes.
  const notes = syncNumber === 0 ? db.getNotes(client) : db.getQueuedNotes(client);
  const deltaSyncRes: t.DeltaSyncRes = { type: 'ok', notes, syncNumber };

  db.mergeSyncData(client, deltaSyncReq, deltaSyncRes, true);
  res.send(deltaSyncRes);
});

app.post('/api/full-sync', (_req, _res, next) => {
  next(new ServerError('App requires update', 400, 'app_requires_update'));
});

app.post('/api/queue-sync', authenticate, (req, res, _next) => {
  const client = res.locals.client!;
  const queueSyncReq: t.QueueSyncReq = req.body;
  const syncNumber = db.getSyncNumber(client);

  logDebug(res, 'sync number from db: ', syncNumber);

  const queueSyncRes: t.QueueSyncRes = { noteHeads: db.getNoteHeads(client), syncNumber };

  db.mergeSyncHeadsData(client, queueSyncReq, queueSyncRes);
  res.send(queueSyncRes);
});

app.post('/api/get-notes', authenticate, (req, res) => {
  let ids: string[] | undefined;
  if (req.body?.ids) ids = req.body.ids;

  const client = res.locals.client!;
  const notes = db.getNotes(client, ids);
  res.set('Cache-Control', 'no-cache').send(notes);
});

app.post('/api/merge-notes', authenticate, (req, res, _next) => {
  logDebug(res, req.body);
  const client = res.locals.client!;
  const { notes } = req.body as { notes: t.EncryptedNote[] };

  const syncNumber = 0;
  const deltaSyncReq: t.DeltaSyncReq = { notes, syncNumber };
  const deltaSyncRes: t.DeltaSyncRes = { type: 'ok', notes: [], syncNumber };

  db.mergeSyncData(client, deltaSyncReq, deltaSyncRes, false);
  res.send({ ok: true });
});

app.post('/api/logout', (_req, res, next) => {
  const token = res.locals.client?.token;
  if (!token) return next(new Error('Missing token'));
  db.logout(token);
  res.send({ ok: true });
});

app.get(['/', '/import', '/export', '/about', '/archive', '/n/:noteId', '/login', '/demo'], (_req, res) => {
  // const preload = _.map(icons, icon => `<link rel="preload" href="/icons/${icon}" as="image">`).join('\n');
  // const preload = '';
  res.send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>Unforget</title>
    <link rel="stylesheet" href="/style.css">
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" href="/icon-256x256.png" type="image/png" />
	  <script src="/index.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`);
});

app.use((req, res, next) => {
  logError(res, `Page not found: ${req.url}`);
  next(new ServerError(`Page not found: ${req.url}`, 404));
});

app.use(((error, _req, res, _next) => {
  if (!(error instanceof ServerError)) {
    error = new ServerError(error.message, 500, 'generic');
  }
  logError(res, error);
  res.status(error.code).send(error.toJSON());
}) as express.ErrorRequestHandler);

app.listen(Number(process.env.PORT), () => {
  console.log(`Listening on port ${process.env.PORT}`);
});

async function calcDoublePasswordHash(password_client_hash: string, password_salt: string) {
  const salted = password_salt + password_client_hash;
  return computeSHA256(new TextEncoder().encode(salted));
}

async function computeSHA256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bytesToHexString(new Uint8Array(hashBuffer));
}

function authenticate(_req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!res.locals.client) {
    next(new ServerError('Unauthorized', 401));
  } else {
    next();
  }
}

function generateRandomCryptoString(): string {
  return Array.from(crypto.randomBytes(64))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

function log(res: express.Response, ...args: any[]) {
  console.log(getClientStr(res), ...args);
}

function logDebug(res: express.Response, ...args: any[]) {
  if (process.env.NODE_ENV === 'development') {
    log(res, ...args);
  }
}

function logError(res: express.Response, ...args: any[]) {
  console.error(getClientStr(res), ...args);
}

function getClientStr(res: express.Response): string {
  if (process.env.NODE_ENV === 'development') return '';

  const client = res.locals?.client;
  return `${client ? `${client.username} (${client.token.slice(0, 5)}):` : 'anonymous:'}`;
}
