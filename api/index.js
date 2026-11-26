// Vercel entry point: runs the Express API as a serverless function.
// vercel.json rewrites every /api/* request here; Express sees the original path.
import { createApp } from '../server/app.js';

export default createApp();
