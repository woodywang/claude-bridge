export interface Env {
  ROOM: DurableObjectNamespace;
  SESSIONS: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_REDIRECT_URI: string;
  ADMIN_ORIGIN: string;
}
