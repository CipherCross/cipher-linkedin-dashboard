// Read-only snapshot through public.ai_execute_sql, keyset-paged (1000-row cap).
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { Client } = require('pg')
const env = Object.fromEntries(fs.readFileSync(process.env.NEON_ENV_FILE || process.env.HOME + '/.config/neon-s28-production.env', 'utf8')
  .split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]))
const c = new Client({ connectionString: env.NEON_AI_DATABASE_URL, ssl: { rejectUnauthorized: false }, query_timeout: 60000, connectionTimeoutMillis: 15000 })
await c.connect()
async function run(sql) {
  await c.query('BEGIN READ ONLY')
  try {
    await c.query("SELECT set_config('statement_timeout','15000',true), set_config('timezone','UTC',true), set_config('app.actor_id','00000000-0000-0000-0000-000000000000',true), set_config('role','app_system',true)")
    const r = await c.query('SELECT public.ai_execute_sql($1) AS result', [sql])
    await c.query('COMMIT'); return r.rows[0].result
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
}
async function paged(name, cols, from, key, quote, field) {
  let all = [], last = null
  for (;;) {
    const where = last == null ? '' : `${from.includes(' where ') ? 'and' : 'where'} ${key} > ${quote ? `'${last}'` : last}`
    const rows = await run(`select ${cols} from ${from} ${where} order by ${key} limit 1000`)
    all = all.concat(rows)
    if (rows.length < 1000) break
    last = rows[rows.length - 1][field]; console.error(name, all.length)
  }
  fs.writeFileSync(`data/${name}.json`, JSON.stringify(all))
  console.log(name, all.length)
}
fs.mkdirSync('data', { recursive: true })
await paged('leads', `id::text as id, instance_id, campaign_id, profile_url, headline, company, status, added_at, invited_at, connected_at, first_message_at, replied_at, last_action_at, pipeline_stage, pipeline_substatus, lost_reason, pipeline_stage_changed_at, (assigned_to is not null) as assigned, education_start_year, first_job_start_year, birth_year_min, birth_year_max, age_source, gender, gender_confidence, demo_model, (photo_path is not null) as has_photo, photo_synced_at`, 'leads', 'id::text', true, 'id')
await paged('messages', `m.id, m.instance_id, m.campaign_id, m.profile_url, m.direction, m.body, m.sent_at, m.source, (m.external_id is not null) as has_ext, m.message_type, m.sentiment, m.intent_level`, `messages m where exists (select 1 from leads l where l.instance_id=m.instance_id and l.profile_url=m.profile_url)`, 'm.id', false, 'id')
fs.writeFileSync('data/campaigns.json', JSON.stringify(await run(`select c.id, c.instance_id, c.name, c.status, c.created_at, hc.hypothesis_id from campaigns c left join hypothesis_campaigns hc on hc.campaign_id=c.id`)))
fs.writeFileSync('data/campaign_steps.json', JSON.stringify(await run(`select campaign_id, step_index, step_label, step_type, template_body, sent_count, replied_count, current_count from campaign_steps order by campaign_id, step_index`)))
fs.writeFileSync('data/pipeline_events.json', JSON.stringify(await run(`select lead_id::text lead_id, kind, actor, from_stage, to_stage, lost_reason, occurred_at from pipeline_events order by id`).catch(async () => run(`select lead_id::text lead_id, kind, actor, occurred_at from pipeline_events order by id`))))
fs.writeFileSync('data/instances.json', JSON.stringify(await run(`select id, label, account_name from instances`)))
await c.end()
console.log('done')
