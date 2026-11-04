explain (analyze, buffers, timing off)
select id, question, status, winner_option_id
from public.polls
where group_id = :'sample_group'::uuid
order by created_at desc, id
limit 20;

explain (analyze, buffers, timing off)
select o.id, o.name, coalesce(totals.vote_count, 0) as vote_count
from public.options o
left join (
  select option_id, count(*) as vote_count
  from public.votes
  where poll_id = :'sample_poll'::uuid
  group by option_id
) totals on totals.option_id = o.id
where o.poll_id = :'sample_poll'::uuid
order by vote_count desc, o.created_at, o.id;
