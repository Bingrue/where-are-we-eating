import { Router } from 'express';
import { sendSupabaseError } from '../errors.js';

// Every query here runs as the signed-in user (req.supabase), so row level security
// decides what is visible. These routes never filter by membership themselves: a group
// you do not belong to is simply not returned by Supabase.
export const groupsRouter = Router();

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invitePattern = /[0-9a-f]{32}/i;

function readName(body) {
  const name = String(body?.name ?? '').trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

groupsRouter.param('groupId', (req, res, next, groupId) => {
  if (!uuidPattern.test(groupId)) return res.status(404).json({ error: 'Group not found.' });
  return next();
});

// Groups I belong to, with my role and the member count.
groupsRouter.get('/', async (req, res) => {
  const { data, error } = await req.supabase
    .from('group_members')
    .select('role, joined_at, group:groups(id, name, invite_code, created_at, members:group_members(count))')
    .eq('user_id', req.user.id)
    .order('joined_at', { ascending: false });
  if (error) return sendSupabaseError(res, error);

  return res.json(data.map(({ role, joined_at, group }) => ({
    id: group.id,
    name: group.name,
    invite_code: group.invite_code,
    created_at: group.created_at,
    member_count: group.members?.[0]?.count ?? 0,
    my_role: role,
    joined_at,
  })));
});

// Create a group. created_by defaults to auth.uid() and a trigger makes me its admin.
groupsRouter.post('/', async (req, res) => {
  const name = readName(req.body);
  if (!name) return res.status(400).json({ error: 'Enter a group name up to 80 characters.' });

  const { data, error } = await req.supabase
    .from('groups')
    .insert({ name })
    .select('id, name, invite_code, created_at')
    .single();
  if (error) return sendSupabaseError(res, error);
  return res.status(201).json({ ...data, my_role: 'admin', member_count: 1 });
});

// Join with an invite code or a full invite link.
groupsRouter.post('/join', async (req, res) => {
  const code = invitePattern.exec(String(req.body?.code ?? ''))?.[0];
  if (!code) return res.status(400).json({ error: 'Paste an invite link or code.' });

  const { data: groupId, error } = await req.supabase.rpc('join_group', { p_invite_code: code });
  if (error) return sendSupabaseError(res, error);
  return res.json({ id: groupId });
});

// One group with its members. Returns 404 for groups I am not in, because RLS hides them.
groupsRouter.get('/:groupId', async (req, res) => {
  const { data, error } = await req.supabase
    .from('groups')
    .select(`id, name, invite_code, created_by, created_at,
      members:group_members(user_id, role, joined_at, profile:profiles(username, display_name))`)
    .eq('id', req.params.groupId)
    .maybeSingle();
  if (error) return sendSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'Group not found.' });

  const me = data.members.find((member) => member.user_id === req.user.id);
  if (!me) return res.status(404).json({ error: 'Group not found.' });
  data.members.sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  return res.json({ ...data, my_role: me.role });
});

// Rename (admins only; RLS turns anyone else's update into "no rows changed").
groupsRouter.patch('/:groupId', async (req, res) => {
  const name = readName(req.body);
  if (!name) return res.status(400).json({ error: 'Enter a group name up to 80 characters.' });

  const { data, error } = await req.supabase
    .from('groups')
    .update({ name })
    .eq('id', req.params.groupId)
    .select('id, name');
  if (error) return sendSupabaseError(res, error);
  if (data.length === 0) return res.status(403).json({ error: 'Only a group admin can rename the group.' });
  return res.json(data[0]);
});

// Delete the group and everything in it (admins only).
groupsRouter.delete('/:groupId', async (req, res) => {
  const { data, error } = await req.supabase
    .from('groups')
    .delete()
    .eq('id', req.params.groupId)
    .select('id');
  if (error) return sendSupabaseError(res, error);
  if (data.length === 0) return res.status(403).json({ error: 'Only a group admin can delete the group.' });
  return res.status(204).end();
});

// New invite code; old links stop working (admins only).
groupsRouter.post('/:groupId/invite', async (req, res) => {
  const { data, error } = await req.supabase.rpc('rotate_group_invite', {
    p_group_id: req.params.groupId,
  });
  if (error) return sendSupabaseError(res, error);
  return res.json({ invite_code: data });
});

// Leave the group (userId "me") or, as an admin, remove someone.
groupsRouter.delete('/:groupId/members/:userId', async (req, res) => {
  const userId = req.params.userId === 'me' ? req.user.id : req.params.userId;
  if (!uuidPattern.test(userId)) return res.status(404).json({ error: 'Member not found.' });

  const { data, error } = await req.supabase
    .from('group_members')
    .delete()
    .eq('group_id', req.params.groupId)
    .eq('user_id', userId)
    .select('user_id');
  if (error) return sendSupabaseError(res, error);
  if (data.length === 0) return res.status(403).json({ error: 'You cannot remove that member.' });
  return res.status(204).end();
});
