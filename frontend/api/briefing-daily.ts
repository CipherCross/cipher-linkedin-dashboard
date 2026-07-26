// Static cron route; keeping the kind out of a query string makes the deployed
// Vercel cron target explicit and independently visible in cron logs.
import { handleBriefing } from './briefing.js'

export const maxDuration = 300

export const GET = (req: Request) => handleBriefing(req, 'daily')
