import { config } from './config.js';
import { createApp } from './app.js';

const missing = ['supabaseUrl', 'supabaseServiceKey', 'cronSecret'].filter((k) => !config[k]);
if (missing.length) {
  console.error(
    `Missing required environment variables for: ${missing.join(', ')}.\n` +
      'Copy backend/.env.example to backend/.env and fill it in.',
  );
  process.exit(1);
}

// Never let one bad promise take the whole process down silently.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

createApp().listen(config.port, () => console.log(`API listening on :${config.port}`));
