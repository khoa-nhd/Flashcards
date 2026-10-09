/**
 * Vercel entry point. vercel.json rewrites every /api/* request here; the Hono
 * app then routes on the original path. Environment variables come from the
 * Vercel project settings, never from a file.
 */
import { getApp } from '../server/bootstrap.js';

export default {
  fetch(request: Request) {
    return getApp().app.fetch(request);
  },
};
