import { Router } from 'express';
import { tasksFor } from '../services/tasks.js';

export const tasksRouter = Router();

tasksRouter.get('/', async (req, res) => {
  res.json(await tasksFor(req.user!));
});

tasksRouter.get('/summary', async (req, res) => {
  res.json((await tasksFor(req.user!)).summary);
});
