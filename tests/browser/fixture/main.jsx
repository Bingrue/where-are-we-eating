// Explicitly fake transport for task 6 UI tests. Not a Supabase/RLS integration test.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GroupPolls, PollPage } from '../../../client/src/polls/Polls.jsx';
import { usePath } from '../../../client/src/router.js';
import '../../../client/src/styles.css';

const key = 'poll-test-fixture';
const pollId = '11111111-1111-4111-8111-111111111111';
const initial = { id: pollId, group_id: 'group', question: 'Where tonight?', created_by: 'host', status: 'open', saved_outcome_option_id: null, options: [], votes: {} };
const get = () => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(initial));
const put = (data) => { localStorage.setItem(key, JSON.stringify(data)); window.dispatchEvent(new Event('fixture-change')); };
const actor = new URLSearchParams(location.search).get('actor') ?? 'host';
const clone = (value) => JSON.parse(JSON.stringify(value));
let rejectVote = false;
let connected = true;
let notify = () => {};
const repository = {
  async list() { return [get()]; },
  async create(groupId, question) { const data = clone(initial); data.group_id = groupId; data.question = question; put(data); return data; },
  async read() {
    const data = get();
    data.my_option_id = data.votes[actor] ?? null;
    data.options.forEach((option) => { option.vote_count = Object.values(data.votes).filter((id) => id === option.id).length; });
    return data;
  },
  async suggest(_, values) { const data = get(); if (data.status !== 'open') throw new Error('Poll closed'); data.options.push({ id: crypto.randomUUID(), ...values }); put(data); },
  async vote(_, optionId) {
    if (rejectVote) { rejectVote = false; throw new Error('Voting is not available yet. Please try again later.'); }
    const data = get(); if (data.status !== 'open') throw new Error('Poll closed'); data.votes[actor] = optionId; put(data);
  },
  async close() { const data = get(); data.status = 'closed';
    data.saved_outcome_option_id = [...data.options].sort((a,b) => Object.values(data.votes).filter((id) => id === b.id).length - Object.values(data.votes).filter((id) => id === a.id).length)[0]?.id ?? null; put(data); },
  observe(_, changed, status) {
    const event = () => { if (connected) changed(); };
    notify = () => status(connected ? 'live' : 'reconnecting');
    queueMicrotask(notify);
    window.addEventListener('storage', event);
    window.addEventListener('fixture-change', event);
    return () => { window.removeEventListener('storage', event); window.removeEventListener('fixture-change', event); notify = () => {}; };
  },
};
window.fixture = { rejectNextVote() { rejectVote = true; }, disconnect() { connected = false; notify(); }, reconnect() { connected = true; notify(); } };
function App() {
  const path = usePath();
  return <><header><h1>Poll UI test fixture</h1><span>{actor}</span></header><main>{path.startsWith('/polls/')
    ? <PollPage pollId={pollId} userId={actor} repository={repository} />
    : <GroupPolls groupId="group" repository={repository} />}</main></>;
}
createRoot(document.getElementById('root')).render(<App />);
