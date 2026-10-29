import express from 'express';
import { usersRouter } from './routes/users';
import { requireAuth } from './auth/jwt';

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', requireAuth, usersRouter);

app.listen(Number(process.env.PORT ?? 3000));
