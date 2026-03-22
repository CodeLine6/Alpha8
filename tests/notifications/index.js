/**
 * Stub module: used only as a mock target by tests/manual-login-trigger.test.js.
 * The real implementation lives at src/notifications/index.js.
 */
export class TelegramBot {
  constructor() {
    this.enabled = false;
  }
  setCommands() {}
  onCommand() {}
  sendRaw() { return Promise.resolve(); }
  startPolling() {}
}
