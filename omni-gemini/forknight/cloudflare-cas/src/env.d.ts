declare namespace Cloudflare {
  interface Env {
    API_TOKEN: string;
    GITHUB_WEBHOOK_SECRET: string;
    TESTING_HANDOFF_QUEUE: Queue<unknown>;
  }
}
