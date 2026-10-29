import { Router } from 'express';
import { getUser, searchUsers } from '../services/userService';

export const usersRouter = Router();

usersRouter.get('/users/:id', async (req, res) => {
  res.json(await getUser(req.params.id));
});

usersRouter.get('/users', async (req, res) => {
  res.json(await searchUsers(String(req.query.q ?? '')));
});
