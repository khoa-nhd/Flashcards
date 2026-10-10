/**
 * Signs a script in to Supabase as an ordinary user, with the public key.
 * Scripts get exactly the access that user has in the app: no privileged key
 * is used, so Row Level Security applies to everything they do.
 */
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../../server/env.js';
import type { Database } from '../../server/supabase/database.types.js';
import {
  createSupabaseDatabase,
  createUserClient,
  type VocabularyDatabase,
} from '../../server/supabase/supabase-database.js';

export interface ProjectConfig {
  url: string;
  publicKey: string;
}

/** The project address and public key, or an explanation of what is missing. */
export function readProjectConfig(): ProjectConfig {
  const config = loadConfig({ ...process.env, DATA_MODE: 'supabase' });
  if (config.supabase === null) {
    throw new Error(`Supabase is not configured. ${config.issues.join(' ')}`);
  }
  return config.supabase;
}

/** Asks a question on the terminal. With `hidden`, what is typed is not shown. */
export function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error(`Cannot ask "${question.trim()}" without a terminal. Set it in the environment instead.`));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0 && !hidden) stdout.write('\b \b');
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
          if (!hidden) stdout.write(char);
        }
      }
    };
    stdin.on('data', onData);
  });
}

export interface SignedInSession {
  userId: string;
  email: string;
  accessToken: string;
  database: VocabularyDatabase;
  /** The raw client acting as this user, for checks the app interface does not expose. */
  client: ReturnType<typeof createUserClient>;
}

/**
 * Signs in with an email and password taken from the named environment
 * variables, or asked for on the terminal when they are not set. The password
 * is used once to obtain a session and is never stored or printed.
 */
export async function signIn(
  project: ProjectConfig,
  emailVariable: string,
  passwordVariable: string,
  /** What to call this account when asking for it on the terminal. */
  label = 'Account',
): Promise<SignedInSession> {
  const email = process.env[emailVariable]?.trim() || (await ask(`${label} - email: `)).trim();
  const password = process.env[passwordVariable] || (await ask(`${label} - password (not shown while typing): `, true));
  if (email === '' || password === '') throw new Error('An email and a password are needed to sign in.');

  const auth = createClient<Database>(project.url, project.publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || data.session === null) {
    // The SDK's own message is safe to show: it never contains the password.
    throw new Error(`Could not sign in as ${email}: ${error?.message ?? 'no session was returned'}.`);
  }
  const client = createUserClient(project.url, project.publicKey, data.session.access_token);
  return {
    userId: data.session.user.id,
    email,
    accessToken: data.session.access_token,
    database: createSupabaseDatabase(client),
    client,
  };
}

/** A client that is not signed in at all, as a stranger on the internet would be. */
export function createAnonymousClient(project: ProjectConfig) {
  return createClient<Database>(project.url, project.publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
