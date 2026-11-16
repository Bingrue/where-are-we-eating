import { Router } from 'express';
import { sendSupabaseError } from '../errors.js';

export const meRouter = Router();

// The signed-in user's profile (created by the on_auth_user_created trigger).
meRouter.get('/', async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('id, username, display_name, created_at')
    .eq('id', req.user.id)
    .single();
  if (error) return sendSupabaseError(res, error);
  return res.json({ ...data, email: req.user.email });
});

meRouter.patch('/', async (req, res) => {
  const changes = {};
  for (const field of ['username', 'display_name']) {
    if (req.body?.[field] === undefined) continue;
    const value = String(req.body[field] ?? '').trim();
    if (value.length > 60) {
      return res.status(400).json({ error: `${field.replace('_', ' ')} must be 60 characters or fewer.` });
    }
    changes[field] = value || null;
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const { data, error } = await req.supabase
    .from('profiles')
    .update(changes)
    .eq('id', req.user.id)
    .select('id, username, display_name, created_at')
    .single();
  if (error) return sendSupabaseError(res, error);
  return res.json({ ...data, email: req.user.email });
});
