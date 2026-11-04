import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';

const id = z.uuid();
const text = (max) => z.string().trim().min(1).max(max);
const invite = z.string().trim().regex(/^[0-9a-f]{32}$/i).transform((code) => code.toLowerCase());
const empty = z.strictObject({});
const errorBody = (message) => ({ error: message });

export function createApp({ gateway, supabaseUrl, clientDist, trustProxy = 0 }) {
  const app = express();
  const upstream = new URL(supabaseUrl);
  const websocket = upstream.origin.replace(/^http/, 'ws');
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        connectSrc: ["'self'", upstream.origin, websocket],
        upgradeInsecureRequests: upstream.protocol === 'http:' ? null : [],
      },
    },
  }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  const api = express.Router();
  app.use('/api', api);
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: errorBody('Too many requests. Try again in a minute.'),
  }));
  api.use(express.json({ limit: '8kb' }));
  api.use(async (req, res, next) => {
    const token = /^Bearer ([^\s,]+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!token || !(await gateway.authenticate(token))) {
      return res.status(401).json(errorBody('Sign in to continue.'));
    }
    req.accessToken = token;
    next();
  });

  function command(method, path, paramName, schema, rpc, toArgs, status = 200) {
    api[method](path, async (req, res) => {
      const parsed = schema.safeParse(req.body ?? {});
      const pathId = paramName ? id.safeParse(req.params.id) : undefined;
      if (!parsed.success || pathId?.success === false) {
        return res.status(400).json(errorBody('Check the submitted fields and try again.'));
      }

      const { data, error } = await gateway.run(
        req.accessToken, rpc, toArgs(parsed.data, pathId?.data),
      );
      if (error) {
        const code = /^PT(400|401|403|404|409)$/.exec(error.code ?? '');
        if (code) return res.status(Number(code[1])).json(errorBody(error.message));
        console.error('Database command failed', rpc, error.code);
        return res.status(502).json(errorBody('The database could not complete the request.'));
      }
      res.status(status).json({ data });
    });
  }

  command('post', '/groups', null, z.strictObject({ name: text(80) }),
    'create_dining_group', ({ name }) => ({ p_name: name }), 201);
  command('post', '/groups/join', null, z.strictObject({ invite }),
    'join_dining_group', ({ invite: code }) => ({ p_invite: code }));
  command('get', '/groups/:id/invite', 'group', empty,
    'dining_group_invite', (_, group) => ({ p_group: group }));
  command('post', '/groups/:id/polls', 'group', z.strictObject({ question: text(160) }),
    'create_dining_poll', ({ question }, group) => ({ p_group: group, p_question: question }), 201);
  command('post', '/polls/:id/options', 'poll',
    z.strictObject({ name: text(100), category: text(60), priceLevel: z.int().min(1).max(4) }),
    'suggest_restaurant', ({ name, category, priceLevel }, poll) => ({
      p_poll: poll, p_name: name, p_category: category, p_price: priceLevel,
    }), 201);
  command('post', '/polls/:id/votes', 'poll', z.strictObject({ optionId: id }),
    'cast_dining_vote', ({ optionId }, poll) => ({ p_poll: poll, p_option: optionId }), 201);
  command('post', '/polls/:id/close', 'poll', empty,
    'close_dining_poll', (_, poll) => ({ p_poll: poll }));

  api.use((_req, res) => res.status(404).json(errorBody('Endpoint not found.')));
  if (clientDist) {
    app.use(express.static(clientDist, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: clientDist }));
  }
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') {
      return res.status(413).json(errorBody('Request is too large.'));
    }
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json(errorBody('Send valid JSON.'));
    }
    console.error('Request failed', error.code ?? error.name);
    res.status(500).json(errorBody('An unexpected error occurred.'));
  });

  return app;
}
