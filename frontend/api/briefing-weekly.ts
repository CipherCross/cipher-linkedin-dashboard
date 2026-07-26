// Static cron route for the longer completed-week briefing.
import { handleBriefing } from './briefing.js'

export const maxDuration = 300

export const GET = (req: Request) => handleBriefing(req, 'weekly')
